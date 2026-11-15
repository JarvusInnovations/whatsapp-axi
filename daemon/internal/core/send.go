package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/identity"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/scope"
)

// Status of a message row.
const (
	StatusReceived = "received"
	StatusPending  = "pending"
	StatusSent     = "sent"
	StatusFailed   = "failed"
)

// MaxTextBytes bounds a text or caption.
const MaxTextBytes = 64 * 1024

// SendBody is POST /v1/send.
type SendBody struct {
	Chat         string   `json:"chat"`
	Text         string   `json:"text"`
	ReplyTo      string   `json:"reply_to"`
	Mentions     []string `json:"mentions"`
	FirstContact bool     `json:"first_contact"`
}

// SendFileBody is POST /v1/send-file.
type SendFileBody struct {
	Chat         string `json:"chat"`
	Path         string `json:"path"`
	Caption      string `json:"caption"`
	As           string `json:"as"`
	ReplyTo      string `json:"reply_to"`
	FirstContact bool   `json:"first_contact"`
}

// ReactBody is POST /v1/react. Chat may be omitted with an unambiguous id.
type ReactBody struct {
	Chat  string  `json:"chat"`
	ID    string  `json:"id"`
	Emoji *string `json:"emoji"`
}

// DownloadBody is POST /v1/download. Chat may be omitted with an unambiguous id.
type DownloadBody struct {
	Chat string `json:"chat"`
	ID   string `json:"id"`
}

// SendTimeout bounds one send, reaction or file upload, counted from when it is recorded as
// pending. The daemon carries a send through to this limit whatever happens to the request; the
// CLI waits at least this long (GET /v1/status reports it as send_timeout_seconds).
var SendTimeout = 10 * time.Minute

// SentMessage is the answer to a send. Warning is set when WhatsApp accepted the message and only
// the daemon's own bookkeeping failed afterwards: the message was sent.
type SentMessage struct {
	ID      string     `json:"id"`
	Chat    string     `json:"chat"`
	T       string     `json:"t"`
	Media   *MediaView `json:"media,omitempty"`
	Warning string     `json:"warning,omitempty"`
}

// ReactResult is the answer to a reaction. Warning as for SentMessage.
type ReactResult struct {
	Chat    string `json:"chat"`
	ID      string `json:"id"`
	Emoji   string `json:"emoji"`
	Changed bool   `json:"changed"`
	Warning string `json:"warning,omitempty"`
}

// bookkeepingWarning is the warning of a send WhatsApp accepted whose recording failed.
const bookkeepingWarning = "WhatsApp accepted it, but the daemon could not record it in full; see the daemon's log. It may be missing from read and events."

// DownloadResult is the answer to a download.
type DownloadResult struct {
	Chat     string `json:"chat"`
	ID       string `json:"id"`
	Path     string `json:"path"`
	Name     string `json:"name"`
	MIME     string `json:"mime"`
	Size     int64  `json:"size"`
	Existing bool   `json:"existing"`
}

func notDownloadable(format string, a ...any) *APIError {
	e := badRequest(format, a...)
	e.Status, e.Code = 422, "not_downloadable"
	return e
}

func (a *Account) requireConnected(what string) error {
	if st, _, _ := a.State(); st != "connected" {
		return a.notConnected(what)
	}
	return nil
}

func (a *Account) clientErr(err error, what string) error {
	if errors.Is(err, client.ErrNotConnected) {
		return a.notConnected(what)
	}
	// The library's error text can carry ids and paths; the log gets it, the caller a clean reason.
	a.log.Warn("WhatsApp refused or failed an operation", "op", what, "err", err)
	return WhatsAppError(fmt.Sprintf("WhatsApp refused or failed this: %s.", strings.ToLower(what)))
}

// target is where a send goes.
type target struct {
	chat    string // the store's chat id
	isGroup bool
	known   bool // the chat has kept activity
}

// sendTarget resolves a chat in any accepted form to its store id. A chat with nothing kept is
// keyed by the hidden id when known, else the phone-number id.
func (a *Account) sendTarget(ctx context.Context, ref string) (target, error) {
	if ref == "" {
		return target{}, badRequest("chat is required.")
	}
	id, err := a.ResolveChat(ctx, ref)
	if err == nil {
		var n int
		if err := a.db.QueryRowContext(ctx, `SELECT count(*) FROM messages WHERE chat_id=? AND status<>?`, id, StatusFailed).Scan(&n); err != nil {
			return target{}, err
		}
		return target{chat: id, isGroup: identity.IsGroup(id), known: n > 0}, nil
	}
	var ae *APIError
	if !errors.As(err, &ae) || ae.Code != "not_found" {
		return target{}, err
	}
	key, err := a.canonicalChatKey(ctx, ref)
	if err != nil {
		return target{}, err
	}
	return target{chat: key, isGroup: identity.IsGroup(key)}, nil
}

// parentQuote builds the quote of a kept parent in the same chat from its kept copy.
func (a *Account) parentQuote(ctx context.Context, chat, id string) (*client.Quoted, row, error) {
	var q client.Quoted
	var r row
	var fromMe bool
	var fromJSON string
	err := a.db.QueryRowContext(ctx, `SELECT sender_raw, text, from_me, json_object('id', sender_id, 'lid', sender_lid, 'pn', sender_pn, 'name', sender_name, 'me', json(CASE from_me WHEN 1 THEN 'true' ELSE 'false' END), 'operator', json(CASE operator WHEN 1 THEN 'true' ELSE 'false' END)) FROM messages WHERE chat_id=? AND id=? AND status<>?`,
		chat, id, StatusFailed).Scan(&q.Sender, &q.Text, &fromMe, &fromJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, r, notFound("No kept message %s in %s to reply to.", id, chat)
	} else if err != nil {
		return nil, r, err
	}
	q.ID = id
	r.replyID, r.replyRaw, r.replyText = id, q.Sender, q.Text
	var u User
	if err := jsonUnmarshal(fromJSON, &u); err == nil {
		r.replyFrom = &u
	}
	return &q, r, nil
}

// resolveMentions turns user ids into the ids WhatsApp expects for the chat, and makes sure each
// appears in the text as "@<user>".
func (a *Account) resolveMentions(ctx context.Context, t target, ids []string, text string) ([]string, string, error) {
	if len(ids) == 0 {
		return nil, text, nil
	}
	var members []client.Participant
	if t.isGroup {
		g, err := a.client.GroupInfo(ctx, t.chat)
		if err != nil {
			return nil, "", a.clientErr(err, "Reading the group's members")
		}
		members = g.Participants
	} else {
		lid, pn := a.pair(ctx, t.chat, "", false)
		members = []client.Participant{{JID: t.chat, LID: lid, PN: pn}}
		own := a.own()
		if own.UserID() != "" {
			members = append(members, client.Participant{JID: own.UserID(), LID: own.LID, PN: own.PN})
		}
	}
	var out []string
	seen := map[string]bool{}
	for _, raw := range ids {
		id := raw
		if identity.IsPhone(id) {
			id = identity.PNOfPhone(id)
		}
		if !identity.IsUser(id) {
			return nil, "", badRequest("Mention %q is not a user: use a hidden id, a phone-number id or a phone number.", raw)
		}
		lid, pn := a.pair(ctx, id, "", false)
		found := ""
		for _, m := range members {
			for _, f := range []string{id, lid, pn} {
				if f != "" && (f == m.JID || f == m.LID || f == m.PN) {
					found = m.JID
				}
			}
		}
		if found == "" {
			return nil, "", badRequest("Mention %s is not in the chat %s.", raw, t.chat)
		}
		if seen[found] {
			continue
		}
		seen[found] = true
		out = append(out, found)
		tag := "@" + strings.SplitN(found, "@", 2)[0]
		if !strings.Contains(text, tag) {
			if text != "" && !strings.HasSuffix(text, " ") {
				text += " "
			}
			text += tag
		}
	}
	return out, text, nil
}

// outgoing is one send in preparation.
type outgoing struct {
	t        target
	msg      client.OutMessage
	row      row
	limitTxt string
}

// Send sends a text (POST /v1/send).
func (a *Account) Send(ctx context.Context, b SendBody) (*SentMessage, error) {
	if strings.TrimSpace(b.Text) == "" {
		return nil, badRequest("text is required and cannot be blank.")
	}
	if len(b.Text) > MaxTextBytes || !utf8.ValidString(b.Text) {
		return nil, badRequest("text must be valid UTF-8 of at most %d bytes.", MaxTextBytes)
	}
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	o, err := a.prepare(ctx, b.Chat, b.ReplyTo, b.FirstContact)
	if err != nil {
		return nil, err
	}
	mentions, text, err := a.resolveMentions(ctx, o.t, b.Mentions, b.Text)
	if err != nil {
		return nil, err
	}
	o.msg.Text, o.msg.Mentions, o.limitTxt = text, mentions, b.Text
	o.row.text = text
	o.row.mentions = a.mentionUsers(ctx, mentions, a.own())
	return a.dispatch(ctx, o)
}

// SendFile sends a file (POST /v1/send-file).
func (a *Account) SendFile(ctx context.Context, b SendFileBody) (*SentMessage, error) {
	if b.Path == "" || !filepath.IsAbs(b.Path) {
		return nil, badRequest("path must be an absolute path to a file.")
	}
	switch b.As {
	case "", "image", "video", "audio", "document":
	default:
		return nil, badRequest("as must be image, video, audio or document.")
	}
	if len(b.Caption) > MaxTextBytes || !utf8.ValidString(b.Caption) {
		return nil, badRequest("caption must be valid UTF-8 of at most %d bytes.", MaxTextBytes)
	}
	max := int64(a.Settings().Send.MaxFileMB) << 20
	fi, err := os.Stat(b.Path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, badRequest("No file at the given path.")
		}
		return nil, badRequest("The file cannot be read.")
	}
	if !fi.Mode().IsRegular() {
		return nil, badRequest("The path is not a regular file.")
	}
	if fi.Size() > max {
		return nil, badRequest("The file is %d bytes, over the limit of %d MB (send.max_file_mb).", fi.Size(), max>>20)
	}
	if fi.Size() == 0 {
		return nil, badRequest("The file is empty.")
	}
	data, err := os.ReadFile(b.Path)
	if err != nil {
		return nil, badRequest("The file cannot be read.")
	}
	name := filepath.Base(b.Path)
	mimeType := DetectMIME(name, data)
	typ := b.As
	if typ == "" {
		typ = SendType(mimeType)
	}
	if typ == "audio" && b.Caption != "" {
		return nil, badRequest("WhatsApp audio cannot carry a caption; send it as a document, or without one.")
	}
	file := &client.OutFile{Type: typ, MIME: mimeType, Name: name, Data: data}
	if typ == "image" {
		if thumb, w, h, ok := Preview(data); ok {
			file.Thumbnail, file.Width, file.Height = thumb, w, h
		}
	}

	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	o, err := a.prepare(ctx, b.Chat, b.ReplyTo, b.FirstContact)
	if err != nil {
		return nil, err
	}
	o.msg.Text, o.msg.File, o.limitTxt = b.Caption, file, b.Caption
	o.row.text = b.Caption
	mv := &MediaView{Type: typ, MIME: mimeType, Size: int64(len(data))}
	if typ == "document" {
		mv.Name = name
	}
	o.row.media = mv
	return a.dispatch(ctx, o)
}

// prepare resolves the chat, checks the connection, the first-contact limit and the reply
// parent. The caller holds sendMu.
func (a *Account) prepare(ctx context.Context, chatRef, replyTo string, firstContact bool) (*outgoing, error) {
	t, err := a.sendTarget(ctx, chatRef)
	if err != nil {
		return nil, err
	}
	if err := a.requireConnected("Sending"); err != nil {
		return nil, err
	}
	if !t.known && !firstContact && a.Settings().Send.FirstContact != "allow" {
		return nil, conflict("first_contact", "", "Nothing has been received from or sent to %s. Sending to a new chat needs first_contact (send.first_contact is refuse).", t.chat)
	}
	own := a.own()
	o := &outgoing{t: t, msg: client.OutMessage{Chat: t.chat}}
	o.row = row{
		chat:      t.chat,
		from:      User{ID: own.UserID(), LID: own.LID, PN: identity.PhoneOf(own.PN), Me: true, Operator: identity.IsOperator(own.LID, own.PN, a.Settings().Operators)},
		senderRaw: firstNonEmpty(own.PN, own.LID),
		fromMe:    true,
		keptBy:    scope.ByOwn,
	}
	if replyTo != "" {
		if !t.known {
			return nil, notFound("No kept message %s in %s to reply to.", replyTo, t.chat)
		}
		q, r, err := a.parentQuote(ctx, t.chat, replyTo)
		if err != nil {
			return nil, err
		}
		o.msg.Reply = q
		o.row.replyID, o.row.replyRaw, o.row.replyText, o.row.replyFrom = r.replyID, r.replyRaw, r.replyText, r.replyFrom
	}
	return o, nil
}

// dispatch checks the rate and same-text limits, records the message as pending, sends it, and
// marks it sent or failed. The caller holds sendMu, so sends reach the client one at a time.
func (a *Account) dispatch(ctx context.Context, o *outgoing) (*SentMessage, error) {
	now := a.now()
	if e := a.limits.check(now, a.Settings().Send, o.t.chat, o.limitTxt); e != nil {
		return nil, e
	}
	id := a.client.NewMessageID()
	if id == "" {
		return nil, a.notConnected("Sending")
	}
	o.msg.ID, o.row.id, o.row.t = id, id, now

	// Record first, so the message is known by id before anyone can reply to it.
	a.mu.Lock()
	err := a.recordPending(ctx, o.row)
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	a.limits.record(now, o.t.chat, o.limitTxt)

	// From here the daemon finishes the send whatever happens to the request: a client that
	// disconnects or gives up does not cancel it. Only the daemon's own send timeout bounds it.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), SendTimeout)
	defer cancel()

	res, sendErr := a.client.Send(ctx, o.msg)

	// A send to the chat ends the account's typing there; this runs after a.mu is released.
	defer func() {
		if sendErr == nil {
			a.clearTyping(o.t.chat)
		}
	}()
	a.mu.Lock()
	defer a.mu.Unlock()
	if sendErr != nil {
		if errors.Is(sendErr, client.ErrOutcomeUnknown) || ctx.Err() != nil {
			// It may have gone out: the row stays pending until the outcome is learned.
			a.log.Warn("a send's outcome is unknown", "err", sendErr)
			return nil, OutcomeUnknown("Sending")
		}
		if _, err := a.db.ExecContext(ctx, `UPDATE messages SET status=? WHERE chat_id=? AND id=?`, StatusFailed, o.t.chat, id); err != nil {
			a.log.Error("marking a send failed", "err", err)
		}
		return nil, a.clientErr(sendErr, "Sending")
	}
	sentAt := res.Time
	if sentAt.IsZero() {
		sentAt = now
	}
	o.row.t = sentAt
	if res.Sender != "" {
		o.row.senderRaw = identity.NonAD(res.Sender)
	}
	if res.Media != nil {
		o.row.keys = res.Media.Keys
	}
	chat := o.t.chat
	out := &SentMessage{ID: id, T: rfc3339(sentAt)}
	if o.row.media != nil {
		out.Media = o.row.media
	}
	// WhatsApp accepted it, so it was sent: a failure from here on is a warning, never an error.
	ev, err := a.markSent(ctx, o.row)
	if err != nil {
		a.log.Error("recording a sent message failed", "err", err)
		out.Warning = bookkeepingWarning
	} else {
		// WhatsApp answers a phone-number send with the hidden id: rekey the chat to it.
		if addressed := identity.NonAD(res.Chat); addressed != "" && addressed != chat && identity.IsPN(chat) && identity.IsLID(addressed) {
			if err := a.rekey(ctx, chat, addressed); err != nil {
				a.log.Error("rekeying after a send failed", "err", err)
			} else {
				chat = addressed
			}
		}
		a.afterCommit(ctx, []pending{ev})
	}
	out.Chat = firstNonEmpty(identity.NonAD(res.Chat), chat)
	return out, nil
}

func (a *Account) recordPending(ctx context.Context, r row) error {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	typ := client.ChatDirect
	if identity.IsGroup(r.chat) {
		typ = client.ChatGroup
	}
	if err := a.ensureChat(ctx, tx, r.chat, typ, r.t); err != nil {
		return err
	}
	ok, err := insertRow(ctx, tx, r, StatusPending)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("message id %s already recorded", r.id)
	}
	return tx.Commit()
}

func (a *Account) markSent(ctx context.Context, r row) (pending, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return pending{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE messages SET status=?, ts=?, sender_raw=?, media_keys=? WHERE chat_id=? AND id=?`,
		StatusSent, ms(r.t), r.senderRaw, r.keys, r.chat, r.id); err != nil {
		return pending{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE chats SET last_kept_at=max(coalesce(last_kept_at,0), ?) WHERE id=?`, ms(r.t), r.chat); err != nil {
		return pending{}, err
	}
	ev, err := a.insertEvent(ctx, tx, KindMessage, r.chat, r.id, true, Event{Message: r.view(r.replyID != "")})
	if err != nil {
		return pending{}, err
	}
	return ev, tx.Commit()
}

// React puts an emoji on a kept message, or removes the account's reaction (POST /v1/react).
func (a *Account) React(ctx context.Context, b ReactBody) (*ReactResult, error) {
	if b.Emoji == nil {
		return nil, badRequest("emoji is required; an empty emoji removes the account's reaction.")
	}
	emoji := *b.Emoji
	if len(emoji) > 64 || strings.ContainsAny(emoji, "\r\n") || !utf8.ValidString(emoji) {
		return nil, badRequest("emoji must be a single emoji.")
	}
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	chat, err := a.resolveMessage(ctx, b.Chat, b.ID)
	if err != nil {
		return nil, err
	}
	var senderRaw string
	var fromMe, deleted bool
	var status string
	if err := a.db.QueryRowContext(ctx, `SELECT sender_raw, from_me, deleted, status FROM messages WHERE chat_id=? AND id=?`, chat, b.ID).Scan(&senderRaw, &fromMe, &deleted, &status); err != nil {
		return nil, err
	}
	if status == StatusFailed || status == StatusPending {
		return nil, notFound("Message %s was never sent.", b.ID)
	}
	own := a.own()
	var current string
	err = a.db.QueryRowContext(ctx, `SELECT emoji FROM reactions WHERE chat_id=? AND message_id=? AND sender_id IN (?, ?, ?)`, chat, b.ID, own.UserID(), own.LID, own.PN).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	res := &ReactResult{Chat: chat, ID: b.ID, Emoji: emoji}
	if current == emoji {
		return res, nil // already so: a no-op, nothing sent
	}
	if err := a.requireConnected("Reacting"); err != nil {
		return nil, err
	}
	now := a.now()
	if e := a.limits.check(now, a.Settings().Send, chat, ""); e != nil {
		return nil, e
	}
	sender := identity.NonAD(senderRaw)
	if fromMe {
		sender = ""
	}
	a.limits.record(now, chat, "")
	// As for a send: once it is going out, the request no longer controls it.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), SendTimeout)
	defer cancel()
	if _, err := a.client.React(ctx, chat, sender, b.ID, emoji); err != nil {
		if errors.Is(err, client.ErrOutcomeUnknown) || ctx.Err() != nil {
			a.log.Warn("a reaction's outcome is unknown", "err", err)
			return nil, OutcomeUnknown("Reacting")
		}
		return nil, a.clientErr(err, "Reacting")
	}
	res.Changed = true

	a.mu.Lock()
	defer a.mu.Unlock()
	me := User{ID: own.UserID(), LID: own.LID, PN: identity.PhoneOf(own.PN), Me: true, Operator: identity.IsOperator(own.LID, own.PN, a.settings.Operators)}
	ev, err := a.recordReaction(ctx, chat, b.ID, emoji, own, me, now)
	if err != nil {
		// WhatsApp took the reaction: it was made. Only the record is missing.
		a.log.Error("recording a reaction failed", "err", err)
		res.Warning = bookkeepingWarning
		return res, nil
	}
	a.afterCommit(ctx, []pending{ev})
	return res, nil
}

// recordReaction stores the account's own reaction and its event. The caller holds a.mu.
func (a *Account) recordReaction(ctx context.Context, chat, id, emoji string, own identity.Own, me User, now time.Time) (pending, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return pending{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM reactions WHERE chat_id=? AND message_id=? AND sender_id IN (?, ?, ?)`, chat, id, own.UserID(), own.LID, own.PN); err != nil {
		return pending{}, err
	}
	if emoji != "" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO reactions(chat_id, message_id, sender_id, emoji, ts) VALUES(?, ?, ?, ?, ?)`, chat, id, own.UserID(), emoji, ms(now)); err != nil {
			return pending{}, err
		}
	}
	ev, err := a.insertEvent(ctx, tx, KindReaction, chat, id, true, Event{Target: id, From: &me, Emoji: &emoji})
	if err != nil {
		return pending{}, err
	}
	return ev, tx.Commit()
}

// Download fetches a kept message's media into media/ (POST /v1/download). Downloads do not count
// toward the send limits.
func (a *Account) Download(ctx context.Context, b DownloadBody) (*DownloadResult, error) {
	chat, err := a.resolveMessage(ctx, b.Chat, b.ID)
	if err != nil {
		return nil, err
	}
	var mediaJSON, path string
	var keys []byte
	if err := a.db.QueryRowContext(ctx, `SELECT media, media_keys, media_path FROM messages WHERE chat_id=? AND id=?`, chat, b.ID).Scan(&mediaJSON, &keys, &path); err != nil {
		return nil, err
	}
	if mediaJSON == "" {
		return nil, notDownloadable("Message %s has no media.", b.ID)
	}
	var mv MediaView
	if err := jsonUnmarshal(mediaJSON, &mv); err != nil {
		return nil, err
	}
	if mv.ViewOnce {
		return nil, notDownloadable("Message %s is view-once media, which is never downloaded.", b.ID)
	}
	res := &DownloadResult{Chat: chat, ID: b.ID, Name: mv.Name, MIME: mv.MIME, Size: mv.Size}
	if path != "" {
		full := filepath.Join(a.layout.MediaDir(), filepath.Base(path))
		if fi, err := os.Stat(full); err == nil && fi.Mode().IsRegular() {
			res.Path, res.Size, res.Existing = full, fi.Size(), true
			return res, nil
		}
	}
	if len(keys) == 0 {
		return nil, notDownloadable("Message %s was kept from a quoted copy without its media keys.", b.ID)
	}
	if err := a.requireConnected("Downloading"); err != nil {
		return nil, err
	}
	data, err := a.client.Download(ctx, &client.Media{Type: mv.Type, MIME: mv.MIME, Size: mv.Size, Keys: keys})
	if errors.Is(err, client.ErrNotDownloadable) {
		return nil, notDownloadable("The media of message %s has expired on WhatsApp's servers.", b.ID)
	} else if err != nil {
		return nil, a.clientErr(err, "Downloading")
	}
	name := mediaFileName(chat, b.ID, mv.MIME)
	dir := a.layout.MediaDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(dir, ".download-*")
	if err != nil {
		return nil, err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return nil, err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	full := filepath.Join(dir, name)
	a.mu.Lock()
	defer a.mu.Unlock()
	r, err := a.db.ExecContext(ctx, `UPDATE messages SET media_path=? WHERE chat_id=? AND id=? AND deleted=0`, name, chat, b.ID)
	if err != nil {
		return nil, err
	}
	if n, _ := r.RowsAffected(); n == 0 {
		return nil, notFound("Message %s was removed while downloading.", b.ID)
	}
	if err := os.Rename(tmp, full); err != nil {
		return nil, err
	}
	res.Path, res.Size = full, int64(len(data))
	return res, nil
}

func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }
