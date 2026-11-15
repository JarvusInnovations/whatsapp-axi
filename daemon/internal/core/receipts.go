package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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

// Why a mark was not sent (specs/daemon.md "Receipts and typing").
const (
	MarkReasonOff          = "off"           // read_receipts is off
	MarkReasonNotConnected = "not_connected" // no live connection to WhatsApp
	MarkReasonWhatsApp     = "whatsapp_error"
	MarkReasonInternal     = "internal" // the store could not be read; see the daemon's log
)

// MarkOutcome is what a mark did: how many incoming messages were marked now, how many had been
// marked before, and how many were asked for and not marked, with the reason. A mark that was
// asked for and not sent is never reported as done.
type MarkOutcome struct {
	Marked        int    `json:"marked"`
	AlreadyMarked int    `json:"already_marked"`
	Failed        int    `json:"failed"`
	Reason        string `json:"reason,omitempty"`
}

// markGroup is the messages of one sender in one chat: one read receipt.
type markGroup struct {
	chat, receiptChat, sender string
	ids                       []string
}

// markTargets finds, among refs, the incoming kept messages not yet marked, grouped per receipt,
// and counts those marked before. Messages from the account itself, and refs that are not kept,
// are skipped. The caller holds a.mu.
func (a *Account) markTargets(ctx context.Context, refs []MsgRef) (groups []*markGroup, already int, err error) {
	byKey := map[string]*markGroup{}
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
			return nil, already, err
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
		g, ok := byKey[key]
		if !ok {
			g = &markGroup{chat: r.Chat, receiptChat: receiptChat, sender: senderRaw}
			byKey[key] = g
			groups = append(groups, g)
		}
		g.ids = append(g.ids, r.ID)
	}
	return groups, already, nil
}

// markLocked sends read receipts for the incoming messages among refs that have not been marked,
// and records them as marked. Under read_receipts off it sends nothing and counts every unmarked
// message as failed with reason off. A receipt that fails does not stop the others, unless the
// connection is gone. The error is a store failure only; WhatsApp's own refusals are in the
// outcome. The caller holds a.mu.
func (a *Account) markLocked(ctx context.Context, refs []MsgRef) (MarkOutcome, error) {
	var out MarkOutcome
	groups, already, err := a.markTargets(ctx, refs)
	out.AlreadyMarked = already
	if err != nil {
		return out, err
	}
	if a.settings.ReadReceipts == "off" {
		for _, g := range groups {
			out.Failed += len(g.ids)
		}
		if out.Failed > 0 {
			out.Reason = MarkReasonOff
		}
		return out, nil
	}
	now := a.now()
	for i, g := range groups {
		if err := a.client.MarkRead(ctx, g.receiptChat, g.sender, g.ids, now); err != nil {
			if errors.Is(err, client.ErrNotConnected) {
				for _, rest := range groups[i:] {
					out.Failed += len(rest.ids)
				}
				out.Reason = MarkReasonNotConnected
				return out, nil
			}
			a.log.Warn("WhatsApp refused or failed a read receipt", "err", err)
			out.Failed += len(g.ids)
			out.Reason = MarkReasonWhatsApp
			continue
		}
		for _, id := range g.ids {
			if _, err := a.db.ExecContext(ctx, `UPDATE messages SET read_marked=1 WHERE chat_id=? AND id=?`, g.chat, id); err != nil {
				// The receipt went out; only recording it failed, so it counts as marked.
				a.log.Error("recording a read receipt failed", "err", err)
			}
		}
		out.Marked += len(g.ids)
	}
	return out, nil
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
	out, err := a.markLocked(ctx, refs)
	if err != nil {
		a.log.Warn("marking a kept message read failed", "err", err)
	} else if out.Failed > 0 && out.Reason != MarkReasonNotConnected {
		a.log.Warn("marking a kept message read failed", "failed", out.Failed, "reason", out.Reason)
	}
}

// MarkReturned marks read the incoming messages a read request returned, for a request with
// mark_read. The read itself never fails because of it: the outcome says what was marked and
// what was not, and why; unmarked messages stay unmarked for a later mark.
func (a *Account) MarkReturned(ctx context.Context, refs []MsgRef) MarkOutcome {
	a.mu.Lock()
	defer a.mu.Unlock()
	out, err := a.markLocked(ctx, refs)
	if err != nil {
		a.log.Error("marking returned messages read failed", "err", err)
		out.Reason = MarkReasonInternal
		// Whatever was not counted could not be looked at: report it as failed.
		if rest := len(refs) - out.Marked - out.AlreadyMarked; rest > out.Failed {
			out.Failed = rest
		}
	}
	return out
}

// MarkFailed is the error line a follow stream sends when a mark fails; the stream goes on.
type MarkFailed struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	MarkOutcome
}

// MarkFailedLine describes a mark that sent fewer receipts than asked.
func MarkFailedLine(m MarkOutcome) MarkFailed {
	return MarkFailed{Code: "mark_failed", Message: fmt.Sprintf("%d of the returned messages were not marked read (%s).", m.Failed, m.Reason), MarkOutcome: m}
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
	Chat string `json:"chat"`
	MarkOutcome
	ReadReceipts string `json:"read_receipts"`
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// MarkRead marks one kept message read ({chat, id}; chat may be omitted when the id is kept in one
// chat only) or every kept incoming message of a chat up to and including one ({chat, through}).
// Under read_receipts off it sends nothing and says so (failed, reason off). A partial mark says
// how many were sent and how many were not.
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
	if res.MarkOutcome, err = a.markLocked(ctx, refs); err != nil {
		return nil, err
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
		// The local timer goes only once the stop was sent, so a failed stop can be retried.
		if err := a.client.SendTyping(ctx, chat, false); err != nil {
			return nil, a.clientErr(err, "Clearing the typing indicator")
		}
		cur.timer.Stop()
		delete(a.typing.timers, chat)
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
