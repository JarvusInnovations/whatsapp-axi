package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/identity"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/scope"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/settings"
)

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// ResolveChat turns any accepted chat form (identity.md "Accept either") into the id of a chat
// with kept content.
func (a *Account) ResolveChat(ctx context.Context, ref string) (string, error) {
	return a.resolveChat(ctx, a.db, ref)
}

func (a *Account) resolveChat(ctx context.Context, q querier, ref string) (string, error) {
	var candidates []string
	switch {
	case identity.IsGroup(ref), identity.IsLID(ref):
		candidates = []string{ref}
		if identity.IsLID(ref) {
			if pn := a.client.PNForLID(ctx, ref); pn != "" {
				candidates = append(candidates, pn)
			}
		}
	case identity.IsPN(ref), identity.IsPhone(ref):
		pn := ref
		if identity.IsPhone(ref) {
			pn = identity.PNOfPhone(ref)
		}
		candidates = []string{pn}
		if lid := a.client.LIDForPN(ctx, pn); lid != "" {
			candidates = append([]string{lid}, candidates...)
		}
	default:
		return "", badRequest("%q is not a chat: use a group id, a hidden id, a phone-number id or a phone number (+15550100001)", ref)
	}
	for _, c := range candidates {
		var id string
		err := q.QueryRowContext(ctx, `SELECT id FROM chats WHERE id=? UNION ALL SELECT chat_id FROM chat_aliases WHERE alias=? LIMIT 1`, c, c).Scan(&id)
		if err == nil {
			return id, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
	}
	return "", notFound("No kept chat %s.", ref)
}

// canonicalChatKey is the id a settings override is stored under: the chat's id when it has kept
// content, else the hidden id when known, else the phone-number or group id.
func (a *Account) canonicalChatKey(ctx context.Context, ref string) (string, error) {
	id, err := a.resolveChat(ctx, a.db, ref)
	if err == nil {
		return id, nil
	}
	var ae *APIError
	if !errors.As(err, &ae) || ae.Code != "not_found" {
		return "", err
	}
	switch {
	case identity.IsGroup(ref), identity.IsLID(ref):
		return ref, nil
	default:
		pn := ref
		if identity.IsPhone(ref) {
			pn = identity.PNOfPhone(ref)
		}
		if lid := a.client.LIDForPN(ctx, pn); lid != "" {
			return lid, nil
		}
		return pn, nil
	}
}

// Status is GET /v1/status.
type Status struct {
	Protocol                int     `json:"protocol"`
	Account                 string  `json:"account"`
	State                   string  `json:"state"`
	Since                   string  `json:"since"`
	Reason                  string  `json:"reason"`
	Me                      *User   `json:"me"`
	DaemonVersion           string  `json:"daemon_version"`
	LibraryVersion          string  `json:"library_version"`
	LastPhoneActivity       *string `json:"last_phone_activity"`
	LastPhoneActivityApprox bool    `json:"last_phone_activity_approximate"`
	Counts                  Counts  `json:"counts"`
}

// Counts are the store totals in a status.
type Counts struct {
	Chats     int64 `json:"chats"`
	Messages  int64 `json:"messages"`
	Discarded int64 `json:"discarded"`
	LastSeq   int64 `json:"last_seq"`
}

func (a *Account) Status(ctx context.Context) (*Status, error) {
	st, reason, since := a.State()
	s := &Status{
		Protocol:                Protocol,
		Account:                 a.layout.Account,
		State:                   st,
		Since:                   rfc3339(since),
		Reason:                  reason,
		DaemonVersion:           a.versions[0],
		LibraryVersion:          a.versions[1],
		LastPhoneActivityApprox: true,
	}
	own := a.own()
	if own.UserID() != "" {
		u := User{ID: own.UserID(), LID: own.LID, PN: identity.PhoneOf(own.PN), Me: true}
		s.Me = &u
	}
	if v, err := a.meta(ctx, "last_phone_activity"); err != nil {
		return nil, err
	} else if v != "" {
		s.LastPhoneActivity = &v
	}
	err := a.db.QueryRowContext(ctx, `SELECT
  (SELECT count(*) FROM chats WHERE EXISTS (SELECT 1 FROM messages WHERE chat_id=chats.id)),
  (SELECT count(*) FROM messages),
  (SELECT coalesce(sum(n),0) FROM discard_counters),
  (SELECT coalesce(max(seq),0) FROM events)`).Scan(&s.Counts.Chats, &s.Counts.Messages, &s.Counts.Discarded, &s.Counts.LastSeq)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (a *Account) summary(ctx context.Context, q querier, id string) (ChatSummary, error) {
	var c ChatSummary
	var last sql.NullInt64
	err := q.QueryRowContext(ctx, `SELECT c.id, c.name, c.type, c.last_kept_at,
  coalesce((SELECT n FROM discard_counters WHERE chat_key=c.id),0),
  (SELECT count(*) FROM messages WHERE chat_id=c.id)
FROM chats c WHERE c.id=?`, id).Scan(&c.ID, &c.Name, &c.Type, &last, &c.Discarded, &c.Messages)
	if err != nil {
		return c, err
	}
	if last.Valid {
		v := rfc3339(fromMS(last.Int64))
		c.LastKept = &v
	}
	s := a.Settings()
	c.Override = s.Chats[c.ID]
	c.Scope = scope.EffectiveScope(s.Scope, c.Override)
	return c, nil
}

// Chats is GET /v1/chats: chats with kept content, most recently kept first.
func (a *Account) Chats(ctx context.Context) ([]ChatSummary, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT id FROM chats c WHERE EXISTS (SELECT 1 FROM messages WHERE chat_id=c.id) ORDER BY coalesce(last_kept_at,0) DESC, id`)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []ChatSummary{}
	for _, id := range ids {
		c, err := a.summary(ctx, a.db, id)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

// GroupSummary is one row of GET /v1/groups.
type GroupSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Scope     string `json:"scope"`
	Override  string `json:"override,omitempty"`
	Members   int    `json:"members"`
	Discarded int64  `json:"discarded"`
}

// Groups is GET /v1/groups: every group the account is a member of, kept content or not, asked
// of WhatsApp now (scopes.md "Membership is not content"). Member lists are not stored.
func (a *Account) Groups(ctx context.Context) ([]GroupSummary, error) {
	gs, err := a.client.JoinedGroups(ctx)
	if err != nil {
		return nil, a.clientErr(err, "Listing groups")
	}
	s := a.Settings()
	out := make([]GroupSummary, 0, len(gs))
	for _, g := range gs {
		row := GroupSummary{ID: g.ID, Name: g.Name, Members: g.Members, Override: s.Chats[g.ID]}
		row.Scope = scope.EffectiveScope(s.Scope, row.Override)
		if err := a.db.QueryRowContext(ctx, `SELECT coalesce((SELECT n FROM discard_counters WHERE chat_key=?),0)`, g.ID).Scan(&row.Discarded); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// Chat is GET /v1/chats/{chat}. A group the account is in but has kept nothing from is answered
// from WhatsApp, like a kept one: membership is not content.
func (a *Account) Chat(ctx context.Context, ref string) (*ChatDetail, error) {
	id, err := a.ResolveChat(ctx, ref)
	var c ChatSummary
	switch {
	case err == nil:
		if c, err = a.summary(ctx, a.db, id); err != nil {
			return nil, err
		}
	case identity.IsGroup(ref) && isNotFound(err):
		id = ref
		c = ChatSummary{ID: id, Type: "group"}
		if err := a.db.QueryRowContext(ctx, `SELECT coalesce((SELECT n FROM discard_counters WHERE chat_key=?),0)`, id).Scan(&c.Discarded); err != nil {
			return nil, err
		}
		s := a.Settings()
		c.Override = s.Chats[id]
		c.Scope = scope.EffectiveScope(s.Scope, c.Override)
	default:
		return nil, err
	}
	d := &ChatDetail{ChatSummary: c, Participants: []User{}}
	rows, err := a.db.QueryContext(ctx, `SELECT alias FROM chat_aliases WHERE chat_id=? ORDER BY alias`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var al string
		if err := rows.Scan(&al); err == nil {
			d.Aliases = append(d.Aliases, al)
		}
	}
	rows.Close()

	own := a.own()
	ops := a.Settings().Operators
	add := func(u User) {
		contact := !u.Me && a.isContact(ctx, u)
		u.Contact = &contact
		d.Participants = append(d.Participants, u)
	}
	if c.Type == "group" {
		g, err := a.client.GroupInfo(ctx, id)
		if err != nil {
			st, _, _ := a.State()
			switch {
			case errors.Is(err, client.ErrNotConnected):
				return nil, &APIError{Status: http.StatusConflict, Code: "not_connected", Message: "The participant list of a group needs a live connection to WhatsApp.", State: st}
			case errors.Is(err, client.ErrNoGroup):
				return nil, notFound("The account is not a member of %s, and nothing from it is kept.", id)
			}
			return nil, a.clientErr(err, "Reading the group")
		}
		if g.Name != "" {
			d.Name = g.Name
		}
		for _, p := range g.Participants {
			alt := p.PN
			raw := p.JID
			if p.LID != "" {
				raw, alt = p.LID, firstNonEmpty(p.PN, p.JID)
			}
			add(a.user(ctx, raw, alt, "", own, ops, false))
		}
		return d, nil
	}
	if own.UserID() != "" {
		add(User{ID: own.UserID(), LID: own.LID, PN: identity.PhoneOf(own.PN), Me: true, Operator: identity.IsOperator(own.LID, own.PN, ops)})
	}
	alt := ""
	for _, al := range d.Aliases {
		if identity.IsPN(al) {
			alt = al
		}
	}
	add(a.user(ctx, id, alt, c.Name, own, ops, false))
	return d, nil
}

func isNotFound(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Code == "not_found"
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

// EventQuery selects events.
type EventQuery struct {
	After *int64
	Limit int
	Chat  string // resolved chat id, "" for all
	Kind  string
}

// Events returns events matching q, oldest first. Without After it returns the most recent Limit
// events.
func (a *Account) Events(ctx context.Context, q EventQuery) ([]Event, error) {
	where := []string{"1=1"}
	var args []any
	if q.Chat != "" {
		where = append(where, "e.chat_id=?")
		args = append(args, q.Chat)
	}
	if q.Kind != "" {
		where = append(where, "e.kind=?")
		args = append(args, q.Kind)
	}
	order := "DESC"
	if q.After != nil {
		where = append(where, "e.seq>?")
		args = append(args, *q.After)
		order = "ASC"
	}
	args = append(args, q.Limit)
	rows, err := a.db.QueryContext(ctx, `SELECT e.seq, e.t, e.kind, e.payload, coalesce(c.id,''), coalesce(c.type,''), coalesce(c.name,'')
FROM events e LEFT JOIN chats c ON c.id=e.chat_id
WHERE `+strings.Join(where, " AND ")+` ORDER BY e.seq `+order+` LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var seq, t int64
		var kind, payload, cid, ctype, cname string
		if err := rows.Scan(&seq, &t, &kind, &payload, &cid, &ctype, &cname); err != nil {
			return nil, err
		}
		var e Event
		if err := json.Unmarshal([]byte(payload), &e); err != nil {
			return nil, err
		}
		e.Seq, e.T, e.Kind, e.Account = seq, rfc3339(fromMS(t)), kind, a.layout.Account
		if cid != "" {
			e.Chat = &ChatRef{ID: cid, Type: ctype, Name: cname}
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if order == "DESC" {
		sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	}
	return out, nil
}

// LastSeq is the highest seq in the store.
func (a *Account) LastSeq(ctx context.Context) (int64, error) {
	var n int64
	err := a.db.QueryRowContext(ctx, `SELECT coalesce(max(seq),0) FROM events`).Scan(&n)
	return n, err
}

const messageColumns = `id, sender_id, sender_lid, sender_pn, sender_name, from_me, operator, ts, text, kept_by,
  partial, mentions_me, mentions, reply_id, reply_from, reply_text, media, ephemeral, edited, deleted, chat_id, status`

func scanMessage(sc interface{ Scan(...any) error }) (*MessageView, string, error) {
	var v MessageView
	var ts, eph int64
	var fromMe, op, partial, mme, edited, deleted bool
	var mentions, replyID, replyFrom, replyText, media, chat, status string
	if err := sc.Scan(&v.ID, &v.From.ID, &v.From.LID, &v.From.PN, &v.From.Name, &fromMe, &op, &ts, &v.Text, &v.KeptBy,
		&partial, &mme, &mentions, &replyID, &replyFrom, &replyText, &media, &eph, &edited, &deleted, &chat, &status); err != nil {
		return nil, "", err
	}
	if status == StatusPending || status == StatusFailed {
		v.Status = status
	}
	v.From.Me, v.From.Operator = fromMe, op
	v.T = rfc3339(fromMS(ts))
	v.Partial, v.MentionsMe, v.Edited, v.Deleted = partial, mme, edited, deleted
	v.Ephemeral = uint32(eph)
	if mentions != "" && mentions != "[]" {
		_ = json.Unmarshal([]byte(mentions), &v.Mentions)
	}
	if replyID != "" {
		v.ReplyTo = &ReplyView{ID: replyID, Text: replyText}
		if replyFrom != "" {
			var u User
			if json.Unmarshal([]byte(replyFrom), &u) == nil {
				v.ReplyTo.From = &u
			}
		}
	}
	if media != "" {
		var mv MediaView
		if json.Unmarshal([]byte(media), &mv) == nil {
			v.Media = &mv
		}
	}
	return &v, chat, nil
}

func (a *Account) decorate(ctx context.Context, q querier, chat string, v *MessageView, ops []string) error {
	if v.ReplyTo != nil {
		var n int
		if err := q.QueryRowContext(ctx, `SELECT count(*) FROM messages WHERE chat_id=? AND id=?`, chat, v.ReplyTo.ID).Scan(&n); err != nil {
			return err
		}
		v.ReplyTo.Kept = n > 0
	}
	rows, err := q.QueryContext(ctx, `SELECT r.sender_id, r.emoji FROM reactions r WHERE r.chat_id=? AND r.message_id=? ORDER BY r.ts`, chat, v.ID)
	if err != nil {
		return err
	}
	type pair struct{ id, emoji string }
	var ps []pair
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.id, &p.emoji); err != nil {
			rows.Close()
			return err
		}
		ps = append(ps, p)
	}
	rows.Close()
	own := a.own()
	for _, p := range ps {
		v.Reactions = append(v.Reactions, Reaction{From: a.user(ctx, p.id, "", "", own, ops, false), Emoji: p.emoji})
	}
	return nil
}

func (a *Account) loadMessageTx(ctx context.Context, q querier, chat, id string, ops []string) (*MessageView, error) {
	v, _, err := scanMessage(q.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages WHERE chat_id=? AND id=?`, chat, id))
	if err != nil {
		return nil, err
	}
	if err := a.decorate(ctx, q, chat, v, ops); err != nil {
		return nil, err
	}
	return v, nil
}

// MessagesPage is GET /v1/messages.
type MessagesPage struct {
	Chat     ChatRef       `json:"chat"`
	Messages []MessageView `json:"messages"`
	More     bool          `json:"more"`
	// MarkedRead is how many returned messages a mark_read request marked now.
	MarkedRead *int `json:"marked_read,omitempty"`
}

// Messages returns kept messages of a chat, newest last, before an optional message id.
func (a *Account) Messages(ctx context.Context, chatRef, before string, limit int) (*MessagesPage, error) {
	chat, err := a.ResolveChat(ctx, chatRef)
	if err != nil {
		return nil, err
	}
	sum, err := a.summary(ctx, a.db, chat)
	if err != nil {
		return nil, err
	}
	cond := ""
	args := []any{chat}
	if before != "" {
		var ts, rowid int64
		err := a.db.QueryRowContext(ctx, `SELECT ts, rowid FROM messages WHERE chat_id=? AND id=?`, chat, before).Scan(&ts, &rowid)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, notFound("No kept message %s in %s.", before, chat)
		} else if err != nil {
			return nil, err
		}
		cond = ` AND (ts < ? OR (ts = ? AND rowid < ?))`
		args = append(args, ts, ts, rowid)
	}
	args = append(args, limit+1)
	rows, err := a.db.QueryContext(ctx, `SELECT `+messageColumns+` FROM messages WHERE chat_id=?`+cond+` ORDER BY ts DESC, rowid DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	var list []MessageView
	for rows.Next() {
		v, _, err := scanMessage(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, *v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	page := &MessagesPage{Chat: ChatRef{ID: sum.ID, Type: sum.Type, Name: sum.Name}, Messages: []MessageView{}}
	if len(list) > limit {
		page.More = true
		list = list[:limit]
	}
	for i := len(list) - 1; i >= 0; i-- {
		v := list[i]
		if err := a.decorate(ctx, a.db, chat, &v, a.Settings().Operators); err != nil {
			return nil, err
		}
		page.Messages = append(page.Messages, v)
	}
	return page, nil
}

// MessageResult is GET /v1/messages/{chat}/{id}.
type MessageResult struct {
	Chat    ChatRef     `json:"chat"`
	Message MessageView `json:"message"`
}

// resolveMessage finds a kept message by chat (any form, or "" for a bare id) and id.
func (a *Account) resolveMessage(ctx context.Context, chatRef, id string) (string, error) {
	if id == "" {
		return "", badRequest("a message id is required")
	}
	if chatRef != "" {
		chat, err := a.ResolveChat(ctx, chatRef)
		if err != nil {
			return "", err
		}
		var n int
		if err := a.db.QueryRowContext(ctx, `SELECT count(*) FROM messages WHERE chat_id=? AND id=?`, chat, id).Scan(&n); err != nil {
			return "", err
		}
		if n == 0 {
			return "", notFound("No kept message %s in %s.", id, chat)
		}
		return chat, nil
	}
	rows, err := a.db.QueryContext(ctx, `SELECT chat_id FROM messages WHERE id=? ORDER BY chat_id`, id)
	if err != nil {
		return "", err
	}
	var chats []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			rows.Close()
			return "", err
		}
		chats = append(chats, c)
	}
	rows.Close()
	switch len(chats) {
	case 0:
		return "", notFound("No kept message %s.", id)
	case 1:
		return chats[0], nil
	}
	cands := make([]string, len(chats))
	for i, c := range chats {
		cands[i] = c + "/" + id
	}
	return "", &APIError{Status: http.StatusConflict, Code: "ambiguous", Message: fmt.Sprintf("Message id %s is kept in %d chats; use <chat>/<id>.", id, len(chats)), Candidates: cands}
}

// Message returns one kept message.
func (a *Account) Message(ctx context.Context, chatRef, id string) (*MessageResult, error) {
	chat, err := a.resolveMessage(ctx, chatRef, id)
	if err != nil {
		return nil, err
	}
	v, err := a.loadMessageTx(ctx, a.db, chat, id, a.Settings().Operators)
	if err != nil {
		return nil, err
	}
	sum, err := a.summary(ctx, a.db, chat)
	if err != nil {
		return nil, err
	}
	return &MessageResult{Chat: ChatRef{ID: sum.ID, Type: sum.Type, Name: sum.Name}, Message: *v}, nil
}

// ForgetResult is POST /v1/forget.
type ForgetResult struct {
	Chat     string `json:"chat"`
	Message  string `json:"message,omitempty"`
	Messages int64  `json:"messages"`
	Events   int64  `json:"events"`
}

// Forget deletes kept content for a chat, or for one message when id is set. chatRef may be ""
// with a bare id.
func (a *Account) Forget(ctx context.Context, chatRef, id string) (*ForgetResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var chat string
	var err error
	if id != "" {
		chat, err = a.resolveMessage(ctx, chatRef, id)
	} else {
		chat, err = a.ResolveChat(ctx, chatRef)
	}
	if err != nil {
		return nil, err
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	res := &ForgetResult{Chat: chat, Message: id}
	var media []string
	mq := `SELECT media_path FROM messages WHERE chat_id=? AND media_path<>''`
	margs := []any{chat}
	if id != "" {
		mq += ` AND id=?`
		margs = append(margs, id)
	}
	rows, err := tx.QueryContext(ctx, mq, margs...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			media = append(media, p)
		}
	}
	rows.Close()
	if id != "" {
		r, err := tx.ExecContext(ctx, `DELETE FROM events WHERE chat_id=? AND message_id=?`, chat, id)
		if err != nil {
			return nil, err
		}
		res.Events, _ = r.RowsAffected()
		r, err = tx.ExecContext(ctx, `DELETE FROM messages WHERE chat_id=? AND id=?`, chat, id)
		if err != nil {
			return nil, err
		}
		res.Messages, _ = r.RowsAffected()
	} else {
		if err := tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM messages WHERE chat_id=?1), (SELECT count(*) FROM events WHERE chat_id=?1)`, chat).Scan(&res.Messages, &res.Events); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM chats WHERE id=?`, chat); err != nil {
			return nil, err
		}
	}
	if err := pruneEmptyChats(ctx, tx); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	for _, p := range media {
		a.removeMedia(p)
	}
	a.checkpoint(ctx)
	return res, nil
}

func pruneEmptyChats(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM chats WHERE NOT EXISTS (SELECT 1 FROM messages WHERE chat_id=chats.id)`)
	return err
}

// RetentionResult reports a retention run.
type RetentionResult struct {
	Messages int64
	Events   int64
}

// RunRetention removes kept messages older than retain_days, with their events, reactions and
// media files (events.md "Retention").
func (a *Account) RunRetention(ctx context.Context) (RetentionResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var res RetentionResult
	days := a.settings.EffectiveRetainDays()
	if days == 0 {
		return res, nil
	}
	cutoff := ms(a.now().Add(-time.Duration(days) * 24 * time.Hour))
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return res, err
	}
	defer tx.Rollback()
	var media []string
	rows, err := tx.QueryContext(ctx, `SELECT media_path FROM messages WHERE ts < ? AND media_path<>''`, cutoff)
	if err != nil {
		return res, err
	}
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			media = append(media, p)
		}
	}
	rows.Close()
	r, err := tx.ExecContext(ctx, `DELETE FROM events WHERE message_id<>'' AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=events.chat_id AND m.id=events.message_id AND m.ts < ?)`, cutoff)
	if err != nil {
		return res, err
	}
	res.Events, _ = r.RowsAffected()
	r, err = tx.ExecContext(ctx, `DELETE FROM messages WHERE ts < ?`, cutoff)
	if err != nil {
		return res, err
	}
	res.Messages, _ = r.RowsAffected()
	if err := pruneEmptyChats(ctx, tx); err != nil {
		return res, err
	}
	if err := tx.Commit(); err != nil {
		return res, err
	}
	for _, p := range media {
		a.removeMedia(p)
	}
	if res.Messages > 0 {
		a.checkpoint(ctx)
		a.log.Info("retention removed kept messages", "messages", res.Messages, "events", res.Events)
	}
	return res, nil
}

// RetentionLoop runs retention now and then once a day until ctx ends.
func (a *Account) RetentionLoop(ctx context.Context) {
	tick := time.NewTicker(24 * time.Hour)
	defer tick.Stop()
	for {
		if _, err := a.RunRetention(ctx); err != nil && ctx.Err() == nil {
			a.log.Error("retention failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// SettingsResult is the response of GET and PATCH /v1/settings.
type SettingsResult struct {
	Settings            json.RawMessage `json:"settings"`
	EffectiveRetainDays int             `json:"effective_retain_days"`
	Changed             *bool           `json:"changed,omitempty"`
}

// SettingsView renders settings with every key present (null for unset).
func SettingsView(s settings.Settings, changed *bool) *SettingsResult {
	b, _ := json.Marshal(s)
	return &SettingsResult{Settings: b, EffectiveRetainDays: s.EffectiveRetainDays(), Changed: changed}
}

// PatchSettings applies a partial settings object, validated as a whole before anything is
// written. Chat keys in "chats" may be given in any chat form; they are stored canonically.
func (a *Account) PatchSettings(ctx context.Context, body []byte) (*SettingsResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, badRequest("the body must be a JSON object: %v", err)
	}
	if chats, ok := raw["chats"]; ok && string(chats) != "null" {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(chats, &m); err != nil {
			return nil, badRequest("settings: chats: must be an object of chat id to scope")
		}
		norm := map[string]json.RawMessage{}
		for k, v := range m {
			key, err := a.canonicalChatKey(ctx, k)
			if err != nil {
				var ae *APIError
				if errors.As(err, &ae) {
					return nil, badRequest("settings: chats.%s: %s", k, ae.Message)
				}
				return nil, err
			}
			norm[key] = v
		}
		raw["chats"], _ = json.Marshal(norm)
		body, _ = json.Marshal(raw)
	}
	next, err := settings.Patch(a.settings, body)
	if err != nil {
		return nil, badRequest("%s", err.Error())
	}
	changed := !settings.Equal(next, a.settings)
	if changed {
		if err := a.writeSettings(next); err != nil {
			return nil, err
		}
	}
	return SettingsView(next, &changed), nil
}

// writeSettings writes and applies settings. The caller holds a.mu.
func (a *Account) writeSettings(next settings.Settings) error {
	if err := settings.Write(a.layout.SettingsFile(), next); err != nil {
		return err
	}
	prev := a.settings
	a.settings = next
	if !next.ParentBuffer || prev.Scope != next.Scope || !mapsEqual(prev.Chats, next.Chats) {
		a.buffer.clear()
	}
	return nil
}

func mapsEqual(x, y map[string]string) bool {
	if len(x) != len(y) {
		return false
	}
	for k, v := range x {
		if y[k] != v {
			return false
		}
	}
	return true
}

// BufferLen reports how many messages the recent-message buffer holds for a chat. Tests use it;
// no request exposes it.
func (a *Account) BufferLen(chat string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.buffer.len(chat)
}
