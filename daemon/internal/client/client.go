// Package client defines what the daemon needs from a WhatsApp client. The real adapter on
// whatsmeow is client/wa; tests drive the daemon with the fake in client/fake, and client/offline
// is what a daemon built without a session store runs on.
//
// Every JID crossing this interface is a full "user@server" string; a sender may carry a device
// suffix, which the daemon strips.
package client

import (
	"context"
	"errors"
	"strings"
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

// PushNameReady reports that the account's own display name is known to the library, after
// app-state sync. Presence cannot be announced before it.
type PushNameReady struct{}

// Event is one of *Message, StateChange, PhoneActivity or PushNameReady.
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

// JoinedGroup is one group the account is a member of, as WhatsApp reports it at request time.
type JoinedGroup struct {
	ID      string
	Name    string
	Members int
}

// Own is the account's own pair of ids, device-free. Either may be empty.
type Own struct {
	PN  string
	LID string
}

// ErrNotConnected is returned by calls that need a live connection.
var ErrNotConnected = errors.New("not connected")

// ErrNoPushName: presence cannot be announced until the account's own name has synced from the
// phone. The client emits PushNameReady when it has.
var ErrNoPushName = errors.New("the account's name has not synced yet")

// Link errors (specs/daemon.md "Linking").
var (
	// ErrLinkTimeout: WhatsApp's login window closed before the phone completed the link.
	ErrLinkTimeout = errors.New("the link window closed before the phone completed the link")
	// ErrWrongNumber: the phone that tried to complete the link is not the number the operator
	// named. The pairing was refused.
	ErrWrongNumber = errors.New("the phone that completed the link is not the number given to auth link; the pairing was refused")
	// ErrOutdated: WhatsApp rejected the client as too old while linking.
	ErrOutdated = errors.New("WhatsApp rejected the client as too old")
)

// ErrNoGroup: no such group, or the account is not a member of it.
var ErrNoGroup = errors.New("no such group, or the account is not a member")

// ErrNotDownloadable: the media's server copy has expired or the descriptor cannot be fetched.
var ErrNotDownloadable = errors.New("the media cannot be downloaded")

// OutFile is a file to send.
type OutFile struct {
	Type      string // image, video, audio or document
	MIME      string
	Name      string // base name; recipients see it for a document
	Data      []byte
	Thumbnail []byte // a small JPEG preview, images only
	Width     int
	Height    int
}

// OutMessage is a message to send. ID is chosen by the daemon before sending. Text is the body,
// or the caption when File is set.
type OutMessage struct {
	ID       string
	Chat     string
	Text     string
	Mentions []string // ids in the form WhatsApp expects for the chat
	// Reply quotes a kept message: its id, its sender exactly as stored, and its text. Never
	// any media keys.
	Reply *Quoted
	File  *OutFile
}

// SendResult is what WhatsApp answered to a send.
type SendResult struct {
	Chat   string // the chat as WhatsApp addressed it, device-free
	Sender string // the account's id the message went out as, device-free; may be empty
	Time   time.Time
	Media  *Media // for a file: the descriptor of the upload, with its key material
}

// LinkRequest starts a link: by pairing code for Phone (digits only, international form, no
// leading "+"), or by QR code when QR is set.
type LinkRequest struct {
	Phone string
	QR    bool
}

// LinkProgress is one step of a link attempt: a pairing code, or a QR payload.
type LinkProgress struct {
	Code string
	QR   string
}

// PhoneMatches reports whether a pairing id (a phone-number id, possibly with a device suffix)
// belongs to the phone number digits the operator named. It is the check behind security.md
// rule 8, shared by the adapter and the fake.
func PhoneMatches(digits, jid string) bool {
	if digits == "" {
		return true // QR linking names no number
	}
	user := jid
	if i := strings.IndexByte(user, '@'); i >= 0 {
		if user[i+1:] != "s.whatsapp.net" {
			return false
		}
		user = user[:i]
	}
	if i := strings.IndexAny(user, ".:"); i >= 0 {
		user = user[:i]
	}
	return user != "" && user == digits
}

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
	// GroupInfo returns a group's name and participants. ErrNotConnected when offline, ErrNoGroup
	// for a group the account is not in.
	GroupInfo(ctx context.Context, chat string) (GroupInfo, error)
	// JoinedGroups asks WhatsApp for every group the account is a member of. ErrNotConnected
	// when offline. Nothing is stored.
	JoinedGroups(ctx context.Context) ([]JoinedGroup, error)
	// MarkRead sends a read receipt for messages of one sender in one chat.
	MarkRead(ctx context.Context, chat, sender string, ids []string, t time.Time) error
	// SendTyping turns the typing indicator on or off in a chat.
	SendTyping(ctx context.Context, chat string, on bool) error
	// SendPresence announces the account as available (specs/daemon.md "Presence").
	SendPresence(ctx context.Context) error

	// Link makes the client a linked device. It reports each pairing code or QR payload to
	// progress as it happens and returns nil once the device is linked and connected, or one of
	// ErrLinkTimeout, ErrWrongNumber, ErrOutdated or another error. Only valid without a
	// session. While it runs the client emits no state changes; the daemon owns "linking".
	Link(ctx context.Context, req LinkRequest, progress func(LinkProgress)) error
	// Logout tells WhatsApp to remove this linked device, then deletes the session.
	// ErrNotConnected when offline.
	Logout(ctx context.Context) error

	// NewMessageID returns a fresh message id for a message the account is about to send.
	NewMessageID() string
	// Send sends a message and returns once WhatsApp has accepted it. ErrNotConnected when offline.
	Send(ctx context.Context, m OutMessage) (SendResult, error)
	// React puts emoji on a message (empty removes the account's reaction). sender is the
	// original sender exactly as stored, or "" for the account's own message.
	React(ctx context.Context, chat, sender, id, emoji string) (SendResult, error)
	// Download fetches and decrypts the file of a media descriptor. ErrNotDownloadable when its
	// server copy has expired; ErrNotConnected when offline.
	Download(ctx context.Context, m *Media) ([]byte, error)
}
