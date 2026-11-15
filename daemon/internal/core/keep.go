package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/identity"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/scope"
)

// Counter keys for discards that have no per-chat counter.
const (
	// CounterUnsupported is shared by every message of an always-discarded chat type.
	CounterUnsupported = "*unsupported"
	// CounterDirect is shared by discarded direct messages from chats with nothing kept. A direct
	// chat's id is the other person's id, so a per-chat counter for a chat with nothing kept
	// would record who sent the discarded message; scopes.md says a counter has no sender.
	CounterDirect = "*direct"
)

// pending is an event committed in the current write, for after-commit work.
type pending struct {
	seq    int64
	kind   string
	fromMe bool
}

func (a *Account) handleMessage(ctx context.Context, m *client.Message) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	if m.FromMe {
		a.setMeta(ctx, "last_phone_activity", rfc3339(now))
	}

	own := a.own()
	s := a.settings
	var chatID string
	var forms []string
	isGroup := m.ChatType == client.ChatGroup || m.ChatType == client.ChatCommunityAnnounce
	switch {
	case isGroup:
		chatID = identity.NonAD(m.Chat)
		forms = []string{chatID}
	case m.ChatType == client.ChatDirect:
		var err error
		chatID, forms, err = a.directKey(ctx, m)
		if err != nil {
			return err
		}
	}
	if chatID == "" && (isGroup || m.ChatType == client.ChatDirect) {
		// Not an id the daemon understands: treat like an unsupported chat.
		m = &client.Message{Kind: m.Kind, ChatType: client.ChatUnknown}
	}

	sender := a.user(ctx, m.Sender, m.SenderAlt, m.PushName, own, s.Operators, true)
	if m.FromMe {
		sender.Me = true
	}
	r := scope.Decide(scope.Input{
		Msg:              m,
		ChatID:           chatID,
		ChatForms:        forms,
		Own:              own,
		SenderIsOperator: sender.Operator,
		AccountScope:     s.Scope,
		DMFrom:           s.DMFrom,
		Override:         s.Chats[chatID],
		Kept:             a.keptLookup(ctx),
	})

	switch r.Action {
	case scope.Discard:
		return a.discard(ctx, m, chatID, r, now)
	case scope.Keep:
		return a.keep(ctx, m, chatID, sender, own, r, now)
	case scope.Edit:
		return a.edit(ctx, m, chatID, own, r)
	case scope.Revoke:
		return a.revoke(ctx, m, chatID)
	case scope.React:
		return a.react(ctx, m, chatID, sender, now)
	}
	return nil
}

func (a *Account) keptLookup(ctx context.Context) scope.Lookup {
	return func(chat, id string) (string, bool) {
		var by string
		err := a.db.QueryRowContext(ctx, `SELECT kept_by FROM messages WHERE chat_id=? AND id=?`, chat, id).Scan(&by)
		if err != nil {
			return "", false
		}
		return by, true
	}
}

// directKey returns a direct chat's canonical id (the hidden id when known) and every form it is
// known by. When a chat is stored under the phone-number id and the hidden id is now known, the
// chat is rekeyed first.
func (a *Account) directKey(ctx context.Context, m *client.Message) (string, []string, error) {
	lid, pn := a.pair(ctx, m.Chat, m.ChatAlt, false)
	var id string
	var forms []string
	if lid != "" {
		id = lid
		forms = append(forms, lid)
	}
	if pn != "" {
		if id == "" {
			id = pn
		}
		forms = append(forms, pn)
	}
	if lid != "" && pn != "" {
		var exists int
		if err := a.db.QueryRowContext(ctx, `SELECT count(*) FROM chats WHERE id=?`, pn).Scan(&exists); err != nil {
			return "", nil, err
		}
		if exists > 0 {
			if err := a.rekey(ctx, pn, lid); err != nil {
				return "", nil, err
			}
		}
	}
	return id, forms, nil
}

// rekey moves a direct chat from its phone-number id to its hidden id in one transaction and
// emits chat_rekeyed (identity.md "Rekey if needed"). The caller holds a.mu.
func (a *Account) rekey(ctx context.Context, old, newID string) error {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var both int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM chats WHERE id=?`, newID).Scan(&both); err != nil {
		return err
	}
	if both > 0 {
		stmts := []string{
			`UPDATE OR IGNORE messages SET chat_id=?2 WHERE chat_id=?1`,
			`DELETE FROM messages WHERE chat_id=?1`,
			`UPDATE events SET chat_id=?2 WHERE chat_id=?1`,
			`UPDATE chat_aliases SET chat_id=?2 WHERE chat_id=?1`,
			`UPDATE chats SET last_kept_at=max(coalesce(last_kept_at,0),(SELECT coalesce(last_kept_at,0) FROM chats WHERE id=?1)) WHERE id=?2`,
			`DELETE FROM chats WHERE id=?1`,
		}
		for _, q := range stmts {
			if _, err := tx.ExecContext(ctx, q, old, newID); err != nil {
				return err
			}
		}
	} else if _, err := tx.ExecContext(ctx, `UPDATE chats SET id=? WHERE id=?`, newID, old); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO chat_aliases(alias, chat_id) VALUES(?, ?) ON CONFLICT(alias) DO UPDATE SET chat_id=excluded.chat_id`, old, newID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE messages SET sender_id=?2, sender_lid=?2 WHERE chat_id=?2 AND sender_id=?1`, old, newID); err != nil {
		return err
	}
	if err := moveCounter(ctx, tx, old, newID); err != nil {
		return err
	}
	if _, err := a.insertEvent(ctx, tx, KindChatRekeyed, newID, "", false, Event{Old: old, New: newID}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	a.notify.Notify()
	if v, ok := a.settings.Chats[old]; ok {
		next := a.settings
		next.Chats = map[string]string{}
		for k, val := range a.settings.Chats {
			next.Chats[k] = val
		}
		delete(next.Chats, old)
		if _, set := next.Chats[newID]; !set {
			next.Chats[newID] = v
		}
		if err := a.writeSettings(next); err != nil {
			return err
		}
	}
	a.log.Info("rekeyed a direct chat")
	return nil
}

func moveCounter(ctx context.Context, tx *sql.Tx, old, newID string) error {
	var n int64
	err := tx.QueryRowContext(ctx, `SELECT n FROM discard_counters WHERE chat_key=?`, old).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM discard_counters WHERE chat_key=?`, old); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO discard_counters(chat_key, n) VALUES(?, ?) ON CONFLICT(chat_key) DO UPDATE SET n=n+excluded.n`, newID, n)
	return err
}

// discard counts a discarded message and, in a tagged group, holds it in the memory-only buffer.
// Nothing about the message itself is written.
func (a *Account) discard(ctx context.Context, m *client.Message, chatID string, r scope.Result, now time.Time) error {
	key := chatID
	switch {
	case r.Unsupported:
		key = CounterUnsupported
	case m.ChatType == client.ChatDirect:
		var exists int
		if err := a.db.QueryRowContext(ctx, `SELECT count(*) FROM chats WHERE id=?`, chatID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			key = CounterDirect
		}
	}
	if _, err := a.db.ExecContext(ctx, `INSERT INTO discard_counters(chat_key, n) VALUES(?, 1) ON CONFLICT(chat_key) DO UPDATE SET n=n+1`, key); err != nil {
		return err
	}
	if r.Tagged && a.settings.ParentBuffer {
		switch m.Kind {
		case client.KindMessage:
			a.buffer.add(chatID, m, now)
		case client.KindEdit:
			a.buffer.edit(chatID, m, now)
		case client.KindRevoke:
			a.buffer.remove(chatID, m.TargetID, now)
		}
	}
	// Ids of discarded messages are logged only at debug level; content never.
	a.log.Debug("discarded", "chat", chatID, "id", m.ID)
	return nil
}

// row is one message to write.
type row struct {
	chat       string
	id         string
	from       User
	senderRaw  string
	fromMe     bool
	t          time.Time
	text       string
	keptBy     string
	partial    bool
	mentionsMe bool
	mentions   []User
	replyID    string
	replyRaw   string
	replyFrom  *User
	replyText  string
	media      *MediaView
	keys       []byte
	ephemeral  uint32
}

func textOf(text string, media *client.Media) string {
	if text != "" || media == nil {
		return text
	}
	return media.Caption
}

func mediaView(m *client.Media) *MediaView {
	if m == nil {
		return nil
	}
	return &MediaView{Type: m.Type, MIME: m.MIME, Name: m.Name, Size: m.Size, ViewOnce: m.ViewOnce}
}

func (a *Account) mentionUsers(ctx context.Context, jids []string, own identity.Own) []User {
	var out []User
	seen := map[string]bool{}
	for _, j := range jids {
		if own.IsMe(j) {
			continue
		}
		u := a.user(ctx, j, "", "", own, a.settings.Operators, false)
		if u.ID == "" || seen[u.ID] {
			continue
		}
		seen[u.ID] = true
		out = append(out, u)
	}
	return out
}

// rowFrom builds the row of a message the scope keeps.
func (a *Account) rowFrom(ctx context.Context, m *client.Message, chatID string, from User, own identity.Own, keptBy string, mentionsMe bool, id string) row {
	r := row{
		chat:       chatID,
		id:         id,
		from:       from,
		senderRaw:  m.Sender,
		fromMe:     m.FromMe || from.Me,
		t:          m.Time,
		text:       textOf(m.Text, m.Media),
		keptBy:     keptBy,
		mentionsMe: mentionsMe,
		mentions:   a.mentionUsers(ctx, m.Mentions, own),
		media:      mediaView(m.Media),
		ephemeral:  m.Ephemeral,
	}
	if r.t.IsZero() {
		r.t = a.now()
	}
	if m.Media != nil {
		r.keys = m.Media.Keys
	}
	if q := m.ReplyTo; q != nil && q.ID != "" {
		r.replyID = q.ID
		r.replyRaw = q.Sender
		r.replyText = textOf(q.Text, q.Media)
		if q.Sender != "" {
			u := a.user(ctx, q.Sender, "", "", own, a.settings.Operators, false)
			r.replyFrom = &u
		}
	}
	return r
}

func (r row) view(replyKept bool) *MessageView {
	v := &MessageView{
		ID:         r.id,
		From:       r.from,
		T:          rfc3339(r.t),
		Text:       r.text,
		KeptBy:     r.keptBy,
		Partial:    r.partial,
		MentionsMe: r.mentionsMe,
		Mentions:   r.mentions,
		Media:      r.media,
		Ephemeral:  r.ephemeral,
	}
	if r.replyID != "" {
		v.ReplyTo = &ReplyView{ID: r.replyID, From: r.replyFrom, Text: r.replyText, Kept: replyKept}
	}
	return v
}

func (a *Account) ensureChat(ctx context.Context, tx *sql.Tx, chatID string, t client.ChatType, keptAt time.Time) error {
	typ := "direct"
	if t != client.ChatDirect {
		typ = "group"
	}
	name := ""
	if typ == "group" {
		if g, err := a.client.GroupInfo(ctx, chatID); err == nil {
			name = g.Name
		}
	} else {
		lid, pn := a.pair(ctx, chatID, "", false)
		u := a.user(ctx, chatID, pn, "", a.own(), nil, false)
		name = u.Name
		if lid != "" && pn != "" && lid == chatID {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO chats(id, type, created_at) VALUES(?, ?, ?)`, chatID, typ, ms(a.now())); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO chat_aliases(alias, chat_id) VALUES(?, ?)`, pn, chatID); err != nil {
				return err
			}
		}
	}
	_, err := tx.ExecContext(ctx, `
INSERT INTO chats(id, type, name, created_at, last_kept_at) VALUES(?1, ?2, ?3, ?4, ?5)
ON CONFLICT(id) DO UPDATE SET
  name = CASE WHEN ?3 <> '' THEN ?3 ELSE chats.name END,
  last_kept_at = max(coalesce(chats.last_kept_at, 0), ?5)`,
		chatID, typ, name, ms(a.now()), ms(keptAt))
	return err
}

// insertRow writes a message; false when it was already kept (a redelivery).
func insertRow(ctx context.Context, tx *sql.Tx, r row, status string) (bool, error) {
	var replyFrom string
	if r.replyFrom != nil {
		replyFrom = mustJSON(r.replyFrom)
	}
	media := ""
	if r.media != nil {
		media = mustJSON(r.media)
	}
	mentions := "[]"
	if len(r.mentions) > 0 {
		mentions = mustJSON(r.mentions)
	}
	res, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO messages(chat_id, id, sender_id, sender_raw, sender_lid, sender_pn, sender_name,
  from_me, operator, ts, text, kept_by, partial, mentions_me, mentions, reply_id, reply_raw, reply_from,
  reply_text, media, media_keys, ephemeral, status)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		r.chat, r.id, r.from.ID, r.senderRaw, r.from.LID, r.from.PN, r.from.Name,
		r.fromMe, r.from.Operator, ms(r.t), r.text, r.keptBy, r.partial, r.mentionsMe, mentions,
		r.replyID, r.replyRaw, replyFrom, r.replyText, media, r.keys, int64(r.ephemeral), status)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// insertEvent appends an event. body carries the kind-specific fields.
func (a *Account) insertEvent(ctx context.Context, tx *sql.Tx, kind, chatID, messageID string, fromMe bool, body Event) (pending, error) {
	body.Seq, body.T, body.Kind, body.Account, body.Chat = 0, "", "", "", nil
	var chat any
	if chatID != "" {
		chat = chatID
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO events(t, kind, chat_id, message_id, from_me, payload) VALUES(?, ?, ?, ?, ?, ?)`,
		ms(a.now()), kind, chat, messageID, fromMe, mustJSON(body))
	if err != nil {
		return pending{}, err
	}
	seq, err := res.LastInsertId()
	return pending{seq: seq, kind: kind, fromMe: fromMe}, err
}

func (a *Account) keep(ctx context.Context, m *client.Message, chatID string, sender User, own identity.Own, r scope.Result, now time.Time) error {
	id := m.ID
	if m.Kind == client.KindEdit {
		id = m.TargetID
	}
	msgRow := a.rowFrom(ctx, m, chatID, sender, own, r.KeptBy, r.MentionsMe, id)

	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := a.ensureChat(ctx, tx, chatID, m.ChatType, msgRow.t); err != nil {
		return err
	}
	var events []pending
	var reads []row
	replyKept := false
	if msgRow.replyID != "" {
		_, replyKept = a.keptLookupTx(ctx, tx, chatID, msgRow.replyID)
	}

	var parentFromBuffer *client.Message
	if r.PullParent {
		parent, err := a.parentRow(ctx, m, chatID, own, now, &parentFromBuffer)
		if err != nil {
			return err
		}
		ok, err := insertRow(ctx, tx, parent, "received")
		if err != nil {
			return err
		}
		if ok {
			ev, err := a.insertEvent(ctx, tx, KindMessage, chatID, parent.id, parent.fromMe, Event{Message: parent.view(a.isKeptTx(ctx, tx, chatID, parent.replyID))})
			if err != nil {
				return err
			}
			events = append(events, ev)
			if parentFromBuffer != nil {
				reads = append(reads, parent)
			}
		}
		replyKept = true
	}

	ok, err := insertRow(ctx, tx, msgRow, "received")
	if err != nil {
		return err
	}
	if !ok {
		// Already kept: a redelivery changes nothing.
		return nil
	}
	ev, err := a.insertEvent(ctx, tx, KindMessage, chatID, msgRow.id, msgRow.fromMe, Event{Message: msgRow.view(replyKept)})
	if err != nil {
		return err
	}
	events = append(events, ev)
	reads = append(reads, msgRow)
	if err := tx.Commit(); err != nil {
		if parentFromBuffer != nil {
			a.buffer.add(chatID, parentFromBuffer, now)
		}
		return err
	}
	a.afterCommit(ctx, events)
	a.markRead(ctx, m, reads)
	return nil
}

// parentRow builds the parent of a mentioning reply from the buffer, else from the quoted copy.
func (a *Account) parentRow(ctx context.Context, reply *client.Message, chatID string, own identity.Own, now time.Time, fromBuffer **client.Message) (row, error) {
	q := reply.ReplyTo
	if a.settings.ParentBuffer {
		if pm, ok := a.buffer.take(chatID, q.ID, now); ok {
			*fromBuffer = pm
			from := a.user(ctx, pm.Sender, pm.SenderAlt, pm.PushName, own, a.settings.Operators, false)
			r := a.rowFrom(ctx, pm, chatID, from, own, scope.ByParent, false, pm.ID)
			r.mentionsMe = false
			return r, nil
		}
	}
	from := User{}
	if q.Sender != "" {
		from = a.user(ctx, q.Sender, "", "", own, a.settings.Operators, false)
	}
	r := row{
		chat:      chatID,
		id:        q.ID,
		from:      from,
		senderRaw: q.Sender,
		fromMe:    from.Me,
		t:         reply.Time,
		text:      textOf(q.Text, q.Media),
		keptBy:    scope.ByParent,
		partial:   true,
		media:     mediaView(q.Media),
	}
	if q.Media != nil {
		r.keys = q.Media.Keys
	}
	if r.t.IsZero() {
		r.t = now
	}
	return r, nil
}

func (a *Account) keptLookupTx(ctx context.Context, tx *sql.Tx, chat, id string) (string, bool) {
	var by string
	if err := tx.QueryRowContext(ctx, `SELECT kept_by FROM messages WHERE chat_id=? AND id=?`, chat, id).Scan(&by); err != nil {
		return "", false
	}
	return by, true
}

func (a *Account) isKeptTx(ctx context.Context, tx *sql.Tx, chat, id string) bool {
	if id == "" {
		return false
	}
	_, ok := a.keptLookupTx(ctx, tx, chat, id)
	return ok
}

// afterCommit wakes followers and appends wake lines.
func (a *Account) afterCommit(_ context.Context, events []pending) {
	a.notify.Notify()
	wake := a.settings.Wake()
	if wake == "" {
		return
	}
	for _, e := range events {
		if !wakeKinds[e.kind] || e.fromMe {
			continue
		}
		line := mustJSON(struct {
			Account string `json:"account"`
			Seq     int64  `json:"seq"`
			Kind    string `json:"kind"`
		}{a.layout.Account, e.seq, e.kind}) + "\n"
		f, err := os.OpenFile(wake, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
		if err != nil {
			a.log.Warn("cannot open the wake file", "err", err)
			return
		}
		_, err = f.WriteString(line)
		f.Close()
		if err != nil {
			a.log.Warn("cannot append to the wake file", "err", err)
			return
		}
	}
}

// markRead sends read receipts for newly kept messages from others when read_receipts is on-keep.
func (a *Account) markRead(ctx context.Context, m *client.Message, rows []row) {
	if a.settings.ReadReceipts != "on-keep" {
		return
	}
	for _, r := range rows {
		if r.fromMe {
			continue
		}
		if err := a.client.MarkRead(ctx, m.Chat, r.senderRaw, []string{r.id}, r.t); err != nil && !errors.Is(err, client.ErrNotConnected) {
			a.log.Warn("marking a kept message read failed", "err", err)
		}
	}
}

func (a *Account) edit(ctx context.Context, m *client.Message, chatID string, own identity.Own, r scope.Result) error {
	text := textOf(m.Text, m.Media)
	mentions := "[]"
	if mu := a.mentionUsers(ctx, m.Mentions, own); len(mu) > 0 {
		mentions = mustJSON(mu)
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `
UPDATE messages SET text=?, mentions=?, mentions_me=?, edited=1,
  kept_by = CASE WHEN kept_by='parent' AND ? THEN 'mention' ELSE kept_by END
WHERE chat_id=? AND id=? AND deleted=0`, text, mentions, r.MentionsMe, r.MentionsMe, chatID, m.TargetID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil
	}
	v, err := a.loadMessageTx(ctx, tx, chatID, m.TargetID, a.settings.Operators)
	if err != nil {
		return err
	}
	v.Reactions = nil
	v.Edited = false
	ev, err := a.insertEvent(ctx, tx, KindEdit, chatID, m.TargetID, v.From.Me, Event{Message: v, Edited: true})
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	a.afterCommit(ctx, []pending{ev})
	return nil
}

func (a *Account) revoke(ctx context.Context, m *client.Message, chatID string) error {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var mediaPath string
	var from User
	var fromJSON string
	if err := tx.QueryRowContext(ctx, `SELECT media_path, json_object('id', sender_id, 'lid', sender_lid, 'pn', sender_pn, 'name', sender_name, 'me', json(CASE from_me WHEN 1 THEN 'true' ELSE 'false' END), 'operator', json(CASE operator WHEN 1 THEN 'true' ELSE 'false' END)) FROM messages WHERE chat_id=? AND id=?`, chatID, m.TargetID).Scan(&mediaPath, &fromJSON); err != nil {
		return err
	}
	_ = json.Unmarshal([]byte(fromJSON), &from)
	if _, err := tx.ExecContext(ctx, `
UPDATE messages SET text='', mentions='[]', mentions_me=0, reply_text='', media='', media_keys=NULL,
  media_path='', deleted=1 WHERE chat_id=? AND id=?`, chatID, m.TargetID); err != nil {
		return err
	}
	// Erase the content from earlier events of the message too.
	scrubbed := mustJSON(Event{Message: &MessageView{ID: m.TargetID, From: from, Deleted: true}})
	if _, err := tx.ExecContext(ctx, `UPDATE events SET payload=? WHERE chat_id=? AND message_id=? AND kind IN ('message','edit')`, scrubbed, chatID, m.TargetID); err != nil {
		return err
	}
	ev, err := a.insertEvent(ctx, tx, KindRevoke, chatID, m.TargetID, from.Me, Event{Message: &MessageView{ID: m.TargetID, From: from}})
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	a.removeMedia(mediaPath)
	a.checkpoint(ctx)
	a.afterCommit(ctx, []pending{ev})
	return nil
}

func (a *Account) react(ctx context.Context, m *client.Message, chatID string, from User, now time.Time) error {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t := m.Time
	if t.IsZero() {
		t = now
	}
	if m.Emoji == "" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM reactions WHERE chat_id=? AND message_id=? AND sender_id=?`, chatID, m.TargetID, from.ID); err != nil {
			return err
		}
	} else if _, err := tx.ExecContext(ctx, `INSERT INTO reactions(chat_id, message_id, sender_id, emoji, ts) VALUES(?, ?, ?, ?, ?)
ON CONFLICT(chat_id, message_id, sender_id) DO UPDATE SET emoji=excluded.emoji, ts=excluded.ts`, chatID, m.TargetID, from.ID, m.Emoji, ms(t)); err != nil {
		return err
	}
	emoji := m.Emoji
	ev, err := a.insertEvent(ctx, tx, KindReaction, chatID, m.TargetID, from.Me, Event{Target: m.TargetID, From: &from, Emoji: &emoji})
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	a.afterCommit(ctx, []pending{ev})
	return nil
}

// removeMedia deletes a fetched media file. Only file names the daemon built are stored, and only
// the base name is used, so nothing outside media/ can be touched.
func (a *Account) removeMedia(name string) {
	if name == "" {
		return
	}
	_ = os.Remove(filepath.Join(a.layout.MediaDir(), filepath.Base(name)))
}

// checkpoint folds the WAL into the database and truncates it, so content removed under secure
// deletion is not left in the WAL file.
func (a *Account) checkpoint(ctx context.Context) {
	if _, err := a.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		a.log.Warn("checkpoint failed", "err", err)
	}
}
