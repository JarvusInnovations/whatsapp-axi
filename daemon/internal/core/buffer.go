package core

import (
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
)

// Limits of the recent-message buffer (scopes.md "The parent of a mention").
const (
	BufferMaxMessages = 500
	BufferMaxAge      = 48 * time.Hour
)

type buffered struct {
	at  time.Time
	msg client.Message
}

// recentBuffer holds recently discarded messages of tagged groups, in memory only. It is never
// written, logged or returned.
type recentBuffer struct {
	chats map[string][]buffered
}

func newRecentBuffer() *recentBuffer { return &recentBuffer{chats: map[string][]buffered{}} }

func (b *recentBuffer) prune(chat string, now time.Time) {
	list := b.chats[chat]
	i := 0
	for i < len(list) && now.Sub(list[i].at) > BufferMaxAge {
		list[i] = buffered{}
		i++
	}
	if over := len(list) - i - BufferMaxMessages; over > 0 {
		for j := i; j < i+over; j++ {
			list[j] = buffered{}
		}
		i += over
	}
	if i == len(list) {
		delete(b.chats, chat)
		return
	}
	b.chats[chat] = append([]buffered(nil), list[i:]...)
}

func (b *recentBuffer) add(chat string, m *client.Message, now time.Time) {
	b.chats[chat] = append(b.chats[chat], buffered{at: now, msg: *m})
	b.prune(chat, now)
}

func (b *recentBuffer) find(chat, id string, now time.Time) int {
	b.prune(chat, now)
	list := b.chats[chat]
	for i := len(list) - 1; i >= 0; i-- {
		if list[i].msg.ID == id {
			return i
		}
	}
	return -1
}

// take removes and returns a buffered message.
func (b *recentBuffer) take(chat, id string, now time.Time) (*client.Message, bool) {
	i := b.find(chat, id, now)
	if i < 0 {
		return nil, false
	}
	list := b.chats[chat]
	m := list[i].msg
	b.chats[chat] = append(list[:i:i], list[i+1:]...)
	if len(b.chats[chat]) == 0 {
		delete(b.chats, chat)
	}
	return &m, true
}

// edit replaces a buffered message's content with an edit's new content.
func (b *recentBuffer) edit(chat string, e *client.Message, now time.Time) {
	i := b.find(chat, e.TargetID, now)
	if i < 0 {
		return
	}
	m := &b.chats[chat][i].msg
	m.Text, m.Mentions, m.ReplyTo, m.Media = e.Text, e.Mentions, e.ReplyTo, e.Media
}

// remove drops a buffered message (it was deleted for everyone).
func (b *recentBuffer) remove(chat, id string, now time.Time) {
	_, _ = b.take(chat, id, now)
}

func (b *recentBuffer) clear() { b.chats = map[string][]buffered{} }

func (b *recentBuffer) len(chat string) int { return len(b.chats[chat]) }
