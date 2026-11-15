package core

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/identity"
)

// Read receipts and typing (specs/daemon.md "Receipts and typing").
//
// A kept incoming message is marked read on WhatsApp when a consumer marks it (on-read), or when
// it is kept (on-keep). The store records each mark in messages.read_marked, so marking is
// idempotent and a message produces at most one read receipt.

// MsgRef names one kept message.
type MsgRef struct {
	Chat string
	ID   string
}

// markLocked sends read receipts for the incoming messages among refs that have not been marked,
// and records them as marked. It returns how many it marked now and how many were marked before.
// Messages from the account itself, and refs that are not kept, are skipped. The caller holds
// a.mu and has checked read_receipts.
func (a *Account) markLocked(ctx context.Context, refs []MsgRef) (marked, already int, err error) {
	type group struct {
		chat, receiptChat, sender string
		ids                       []string
	}
	var order []string
	groups := map[string]*group{}
	seen := map[MsgRef]bool{}
	for _, r := range refs {
		if seen[r] {
			continue
		}
		seen[r] = true
		var fromMe, done bool
		var senderRaw string
		err := a.db.QueryRowContext(ctx, `SELECT from_me, read_marked, sender_raw FROM messages WHERE chat_id=? AND id=?`, r.Chat, r.ID).Scan(&fromMe, &done, &senderRaw)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		} else if err != nil {
			return marked, already, err
		}
		if fromMe {
			continue
		}
		if done {
			already++
			continue
		}
		// A receipt goes to the chat as WhatsApp addresses it: the group, or for a direct chat the
		// sender exactly as the message arrived.
		receiptChat := r.Chat
		if !identity.IsGroup(r.Chat) && senderRaw != "" {
			receiptChat = identity.NonAD(senderRaw)
		}
		key := r.Chat + "\x00" + receiptChat + "\x00" + senderRaw
		g, ok := groups[key]
		if !ok {
			g = &group{chat: r.Chat, receiptChat: receiptChat, sender: senderRaw}
			groups[key] = g
			order = append(order, key)
		}
		g.ids = append(g.ids, r.ID)
	}
	now := a.now()
	for _, key := range order {
		g := groups[key]
		if err := a.client.MarkRead(ctx, g.receiptChat, g.sender, g.ids, now); err != nil {
			return marked, already, err
		}
		for _, id := range g.ids {
			if _, err := a.db.ExecContext(ctx, `UPDATE messages SET read_marked=1 WHERE chat_id=? AND id=?`, g.chat, id); err != nil {
				return marked, already, err
			}
		}
		marked += len(g.ids)
	}
	return marked, already, nil
}

// markOnKeep marks newly kept messages read when read_receipts is on-keep. The caller holds a.mu.
func (a *Account) markOnKeep(ctx context.Context, rows []row) {
	if a.settings.ReadReceipts != "on-keep" {
		return
	}
	var refs []MsgRef
	for _, r := range rows {
		if !r.fromMe {
			refs = append(refs, MsgRef{Chat: r.chat, ID: r.id})
		}
	}
	if _, _, err := a.markLocked(ctx, refs); err != nil && !errors.Is(err, client.ErrNotConnected) {
		a.log.Warn("marking a kept message read failed", "err", err)
	}
}

// MarkReturned marks read the incoming messages a read request returned, for a request with
// mark_read. The read itself never fails because of it: offline, the messages stay unmarked for a
// later mark. It returns how many were marked now.
func (a *Account) MarkReturned(ctx context.Context, refs []MsgRef) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.settings.ReadReceipts == "off" || len(refs) == 0 {
		return 0
	}
	n, _, err := a.markLocked(ctx, refs)
	if err != nil && !errors.Is(err, client.ErrNotConnected) {
		a.log.Warn("marking returned messages read failed", "err", err)
	}
	return n
}

// EventRefs are the incoming messages among events.
func EventRefs(evs []Event) []MsgRef {
	var out []MsgRef
	for _, e := range evs {
		if e.Kind == KindMessage && e.Message != nil && !e.Message.From.Me && e.Chat != nil {
			out = append(out, MsgRef{Chat: e.Chat.ID, ID: e.Message.ID})
		}
	}
	return out
}

// PageRefs are the incoming messages of a messages page.
func PageRefs(p *MessagesPage) []MsgRef {
	var out []MsgRef
	for _, m := range p.Messages {
		if !m.From.Me {
			out = append(out, MsgRef{Chat: p.Chat.ID, ID: m.ID})
		}
	}
	return out
}

// MarkReadBody is the body of POST /v1/mark-read.
type MarkReadBody struct {
	Chat    *string `json:"chat"`
	ID      *string `json:"id"`
	Through *string `json:"through"`
}

// MarkReadResult is the answer to POST /v1/mark-read.
type MarkReadResult struct {
	Chat          string `json:"chat"`
	Marked        int    `json:"marked"`
	AlreadyMarked int    `json:"already_marked"`
	ReadReceipts  string `json:"read_receipts"`
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// MarkRead marks one kept message read ({chat, id}; chat may be omitted when the id is kept in one
// chat only) or every kept incoming message of a chat up to and including one ({chat, through}).
// Under read_receipts off it is a no-op.
func (a *Account) MarkRead(ctx context.Context, b MarkReadBody) (*MarkReadResult, error) {
	chatRef, id, through := str(b.Chat), str(b.ID), str(b.Through)
	if (id == "") == (through == "") {
		return nil, badRequest("Give id (one message) or through (every kept incoming message up to and including it), not both.")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var chat string
	var refs []MsgRef
	var err error
	if id != "" {
		if chat, err = a.resolveMessage(ctx, chatRef, id); err != nil {
			return nil, err
		}
		refs = []MsgRef{{Chat: chat, ID: id}}
	} else {
		if chatRef == "" {
			return nil, badRequest("through needs chat.")
		}
		if chat, err = a.ResolveChat(ctx, chatRef); err != nil {
			return nil, err
		}
		var ts, rowid int64
		err := a.db.QueryRowContext(ctx, `SELECT ts, rowid FROM messages WHERE chat_id=? AND id=?`, chat, through).Scan(&ts, &rowid)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, notFound("No kept message %s in %s.", through, chat)
		} else if err != nil {
			return nil, err
		}
		rows, err := a.db.QueryContext(ctx, `SELECT id FROM messages WHERE chat_id=? AND from_me=0 AND (ts < ? OR (ts = ? AND rowid <= ?)) ORDER BY ts, rowid`, chat, ts, ts, rowid)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var mid string
			if err := rows.Scan(&mid); err != nil {
				rows.Close()
				return nil, err
			}
			refs = append(refs, MsgRef{Chat: chat, ID: mid})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	res := &MarkReadResult{Chat: chat, ReadReceipts: a.settings.ReadReceipts}
	if a.settings.ReadReceipts == "off" {
		return res, nil
	}
	res.Marked, res.AlreadyMarked, err = a.markLocked(ctx, refs)
	if err != nil {
		if res.Marked > 0 {
			a.log.Warn("marking read stopped part way", "marked", res.Marked)
		}
		return nil, a.clientErr(err, "Marking read")
	}
	return res, nil
}

// TypingLimit is how long a typing indicator stays on without a new request.
var TypingLimit = 2 * time.Minute

// typing holds the chats the account shows as typing in, each with the timer that clears it.
type typing struct {
	mu     sync.Mutex
	timers map[string]*typingEntry
}

// typingEntry is one chat's indicator. The timer's callback compares its own entry with the map's,
// so a timer replaced by a newer request does nothing.
type typingEntry struct {
	timer *time.Timer
}

// TypingBody is the body of POST /v1/typing.
type TypingBody struct {
	Chat *string `json:"chat"`
	On   *bool   `json:"on"`
}

// TypingResult is the answer to POST /v1/typing.
type TypingResult struct {
	Chat    string `json:"chat"`
	Typing  bool   `json:"typing"`
	Changed bool   `json:"changed"`
}

// Typing turns the typing indicator on or off for a chat. On lasts TypingLimit, counted from the
// latest request; turning it off when it is not on is a no-op.
func (a *Account) Typing(ctx context.Context, b TypingBody) (*TypingResult, error) {
	if b.On == nil {
		return nil, badRequest("on is required: true or false.")
	}
	t, err := a.sendTarget(ctx, str(b.Chat))
	if err != nil {
		return nil, err
	}
	chat := t.chat
	a.typing.mu.Lock()
	defer a.typing.mu.Unlock()
	cur, wasOn := a.typing.timers[chat]
	if !*b.On {
		if !wasOn {
			return &TypingResult{Chat: chat}, nil
		}
		cur.timer.Stop()
		delete(a.typing.timers, chat)
		if err := a.client.SendTyping(ctx, chat, false); err != nil {
			return nil, a.clientErr(err, "Clearing the typing indicator")
		}
		return &TypingResult{Chat: chat, Changed: true}, nil
	}
	if err := a.requireConnected("Showing typing"); err != nil {
		return nil, err
	}
	if err := a.client.SendTyping(ctx, chat, true); err != nil {
		return nil, a.clientErr(err, "Showing typing")
	}
	if wasOn {
		cur.timer.Stop()
	}
	if a.typing.timers == nil {
		a.typing.timers = map[string]*typingEntry{}
	}
	entry := &typingEntry{}
	entry.timer = time.AfterFunc(TypingLimit, func() { a.expireTyping(chat, entry) })
	a.typing.timers[chat] = entry
	return &TypingResult{Chat: chat, Typing: true, Changed: !wasOn}, nil
}

// expireTyping clears an indicator whose time is up, unless a newer request replaced its timer.
func (a *Account) expireTyping(chat string, entry *typingEntry) {
	a.typing.mu.Lock()
	defer a.typing.mu.Unlock()
	if a.typing.timers[chat] != entry {
		return
	}
	delete(a.typing.timers, chat)
	a.sendTypingOff(chat)
}

// clearTyping turns the indicator off after the account sent a message to the chat.
func (a *Account) clearTyping(chat string) {
	a.typing.mu.Lock()
	defer a.typing.mu.Unlock()
	cur, ok := a.typing.timers[chat]
	if !ok {
		return
	}
	cur.timer.Stop()
	delete(a.typing.timers, chat)
	a.sendTypingOff(chat)
}

// sendTypingOff tells WhatsApp the account stopped typing. The caller holds typing.mu.
func (a *Account) sendTypingOff(chat string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := a.client.SendTyping(ctx, chat, false); err != nil && !errors.Is(err, client.ErrNotConnected) {
		a.log.Warn("clearing the typing indicator failed", "err", err)
	}
}
