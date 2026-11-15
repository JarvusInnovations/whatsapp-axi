// Package client defines what the daemon needs from a WhatsApp client. The real adapter on
// whatsmeow is a later plan (plans/whatsapp-client.md); in this plan the daemon runs on the
// offline client, and tests drive it with the fake in client/fake.
//
// Every JID crossing this interface is a full "user@server" string; a sender may carry a device
// suffix, which the daemon strips.
package client

import (
	"context"
	"errors"
	"time"
)

// ChatType classifies the chat a message arrived in.
type ChatType string

const (
	ChatDirect            ChatType = "direct"
	ChatGroup             ChatType = "group"
	ChatCommunityAnnounce ChatType = "community_announcement"
	ChatStatus            ChatType = "status"
	ChatBroadcast         ChatType = "broadcast"
	ChatNewsletter        ChatType = "newsletter"
	ChatUnknown           ChatType = "unknown"
)

// Kind is what an incoming message does. The adapter filters protocol traffic and history
// before anything reaches the daemon.
type Kind string

const (
	KindMessage  Kind = "message"
	KindEdit     Kind = "edit"
	KindRevoke   Kind = "revoke"
	KindReaction Kind = "reaction"
	// KindEncrypted is an encrypted reaction or comment in a community announcement group. The
	// daemon always discards it.
	KindEncrypted Kind = "encrypted"
)

// Quoted is the parent of a reply as carried inside the reply.
type Quoted struct {
	ID     string
	Sender string // the parent's sender, exactly as it arrived
	Chat   string // the parent's chat when the reply names one, else ""
	Text   string // the parent's text or caption as carried
	Media  *Media // the parent's media descriptor when the copy includes one
}

// Media is a media descriptor. Keys is opaque key material the adapter needs to fetch the file
// later; the daemon stores it and never returns it.
type Media struct {
	Type     string // image, video, audio, document, sticker
	MIME     string
	Name     string
	Size     int64
	Caption  string
	ViewOnce bool
	Keys     []byte
}

// Message is one incoming message, edit, revoke or reaction.
type Message struct {
	Kind      Kind
	Chat      string // the chat as WhatsApp addressed it, device-free
	ChatAlt   string // the other form of a direct chat's id, when the stanza carried it
	ChatType  ChatType
	ID        string
	Sender    string
	SenderAlt string
	FromMe    bool
	Time      time.Time
	PushName  string

	// Content, for KindMessage and for the new content of KindEdit.
	Text      string // body text; a media caption is in Media.Caption
	Mentions  []string
	ReplyTo   *Quoted
	Media     *Media
	Ephemeral uint32

	// TargetID is the message an edit, revoke or reaction acts on.
	TargetID string
	// Emoji is a reaction's emoji; empty removes the reaction.
	Emoji string
}

// StateChange reports a change of connection state (specs/daemon.md "States").
type StateChange struct {
	State  string
	Reason string
}

// PhoneActivity reports traffic from the account's own phone.
type PhoneActivity struct {
	Time time.Time
}

// Event is one of *Message, StateChange or PhoneActivity.
type Event any

// Handler receives events. The client calls it from one goroutine at a time.
type Handler func(Event)

// Participant is one member of a group.
type Participant struct {
	JID string // the member's primary id for the group
	PN  string // phone-number id, when known
	LID string // hidden id, when known
}

// GroupInfo is what the daemon needs about a group.
type GroupInfo struct {
	Name         string
	Participants []Participant
}

// Own is the account's own pair of ids, device-free. Either may be empty.
type Own struct {
	PN  string
	LID string
}

// ErrNotConnected is returned by calls that need a live connection.
var ErrNotConnected = errors.New("not connected")

// Client is the WhatsApp client the daemon drives.
type Client interface {
	// Start begins delivering events to h. It returns once delivery is set up.
	Start(ctx context.Context, h Handler) error
	// Close disconnects and releases the client.
	Close() error
	// State is the current state and reason.
	State() (state, reason string)
	// OwnIDs is the account's own ids, empty when unlinked.
	OwnIDs() Own
	// LIDForPN and PNForLID read the library's id map. They return "" when the pair is unknown
	// and never go to the network.
	LIDForPN(ctx context.Context, pn string) string
	PNForLID(ctx context.Context, lid string) string
	// RequestMapping asks the library to learn the other form of id, in the background, so
	// later messages can match. It never blocks.
	RequestMapping(ctx context.Context, id string)
	// Contact returns the address-book name of a user and whether the user is a contact.
	Contact(ctx context.Context, id string) (name string, isContact bool)
	// GroupInfo returns a group's name and participants. ErrNotConnected when offline.
	GroupInfo(ctx context.Context, chat string) (GroupInfo, error)
	// MarkRead sends a read receipt for messages of one sender in one chat.
	MarkRead(ctx context.Context, chat, sender string, ids []string, t time.Time) error
}
