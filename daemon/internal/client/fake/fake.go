// Package fake is a client.Client for tests: it emits events on demand and records calls. It
// never touches the network.
package fake

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
)

// MarkReadCall records one MarkRead.
type MarkReadCall struct {
	Chat, Sender string
	IDs          []string
}

// TypingCall records one SendTyping.
type TypingCall struct {
	Chat string
	On   bool
}

// Client is the fake.
type Client struct {
	mu       sync.Mutex
	handler  client.Handler
	state    string
	reason   string
	own      client.Own
	lidOfPN  map[string]string
	contacts map[string]string // id -> address-book name
	groups   map[string]client.GroupInfo

	MarkReads []MarkReadCall
	typing    []TypingCall
	Requested []string // ids passed to RequestMapping
	Closed    bool
	Presences int // SendPresence calls
	// NoPushName makes SendPresence fail with ErrNoPushName, as before app-state sync.
	NoPushName bool
	LoggedOut  bool

	// Linking is what the next Link call does.
	Linking LinkPlan
	// LinkRequests records every Link request.
	LinkRequests []client.LinkRequest

	// Sending.
	sent      []client.OutMessage
	reactions []ReactCall
	idSeq     int
	inFlight  int
	// Attempts counts Send and React calls that reached the fake while connected.
	Attempts int
	// MaxInFlight is the most sends or reactions that were ever in the client at once.
	MaxInFlight int
	// BeforeSend, when set, runs inside Send before it returns (to look at the store mid-send).
	BeforeSend func(client.OutMessage)
	// SendErr, when set, fails every Send and React.
	SendErr error
	// AddressAs, when set, is the chat id WhatsApp answers with (a phone-number send answered
	// by hidden id, for example).
	AddressAs map[string]string
	// UploadKeys is the key material a file send returns.
	UploadKeys []byte
	// Files maps a media descriptor's keys to the file Download returns; DownloadErr fails it.
	Files       map[string][]byte
	DownloadErr error
	Downloads   int
}

// ReactCall records one React.
type ReactCall struct {
	Chat, Sender, ID, Emoji string
}

// LinkPlan scripts a Link call of the fake.
type LinkPlan struct {
	Codes []string // pairing codes reported, in order (pairing-code links)
	QRs   []string // QR payloads reported, in order (QR links)
	// PairAs is the phone-number id of the phone that completes the link. Empty means the
	// window closes first (ErrLinkTimeout).
	PairAs  string
	PairLID string
	// Wait, when set, is waited on (or the context) before the link completes.
	Wait <-chan struct{}
	// Err, when set, is returned instead.
	Err error
}

// New returns a fake in the given state with the given own ids.
func New(state string, own client.Own) *Client {
	return &Client{
		state:    state,
		own:      own,
		lidOfPN:  map[string]string{},
		contacts: map[string]string{},
		groups:   map[string]client.GroupInfo{},
	}
}

// Map records a LID/PN pair in the fake's id map.
func (c *Client) Map(lid, pn string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lidOfPN[pn] = lid
}

// AddContact marks id as a contact with an address-book name.
func (c *Client) AddContact(id, name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.contacts[id] = name
}

// SetGroup sets a group's info.
func (c *Client) SetGroup(chat string, g client.GroupInfo) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.groups[chat] = g
}

// SetOwn changes the account's own ids.
func (c *Client) SetOwn(own client.Own) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.own = own
}

// Emit delivers an event synchronously, as the real client does.
func (c *Client) Emit(ev client.Event) {
	c.mu.Lock()
	h := c.handler
	if sc, ok := ev.(client.StateChange); ok {
		c.state, c.reason = sc.State, sc.Reason
	}
	c.mu.Unlock()
	if h != nil {
		h(ev)
	}
}

func (c *Client) Start(_ context.Context, h client.Handler) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.handler = h
	return nil
}

func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Closed = true
	c.handler = nil
	return nil
}

func (c *Client) State() (string, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state, c.reason
}

func (c *Client) OwnIDs() client.Own {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.own
}

func (c *Client) LIDForPN(_ context.Context, pn string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lidOfPN[pn]
}

func (c *Client) PNForLID(_ context.Context, lid string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	for pn, l := range c.lidOfPN {
		if l == lid {
			return pn
		}
	}
	return ""
}

func (c *Client) RequestMapping(_ context.Context, id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Requested = append(c.Requested, id)
}

func (c *Client) Contact(_ context.Context, id string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	name, ok := c.contacts[id]
	return name, ok
}

func (c *Client) GroupInfo(_ context.Context, chat string) (client.GroupInfo, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != "connected" {
		return client.GroupInfo{}, client.ErrNotConnected
	}
	g, ok := c.groups[chat]
	if !ok {
		return client.GroupInfo{}, client.ErrNotConnected
	}
	return g, nil
}

func (c *Client) MarkRead(_ context.Context, chat, sender string, ids []string, _ time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != "connected" {
		return client.ErrNotConnected
	}
	c.MarkReads = append(c.MarkReads, MarkReadCall{Chat: chat, Sender: sender, IDs: append([]string(nil), ids...)})
	return nil
}

func (c *Client) SendTyping(_ context.Context, chat string, on bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != "connected" {
		return client.ErrNotConnected
	}
	c.typing = append(c.typing, TypingCall{Chat: chat, On: on})
	return nil
}

// Typing returns the SendTyping calls so far.
func (c *Client) Typing() []TypingCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]TypingCall(nil), c.typing...)
}

// MarkReadCalls returns the MarkRead calls so far.
func (c *Client) MarkReadCalls() []MarkReadCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]MarkReadCall(nil), c.MarkReads...)
}

func (c *Client) SendPresence(context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != "connected" {
		return client.ErrNotConnected
	}
	if c.NoPushName {
		return client.ErrNoPushName
	}
	c.Presences++
	return nil
}

// SetPushName ends (or starts) the fake's lack of a push name.
func (c *Client) SetPushName(known bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.NoPushName = !known
}

// PresenceCount returns how many SendPresence calls succeeded.
func (c *Client) PresenceCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Presences
}

// Link plays the LinkPlan. It refuses a pairing by a different number with the same check the
// adapter uses (client.PhoneMatches).
func (c *Client) Link(ctx context.Context, req client.LinkRequest, progress func(client.LinkProgress)) error {
	c.mu.Lock()
	plan := c.Linking
	c.LinkRequests = append(c.LinkRequests, req)
	c.mu.Unlock()
	if req.QR {
		for _, q := range plan.QRs {
			progress(client.LinkProgress{QR: q})
		}
	} else {
		for _, code := range plan.Codes {
			progress(client.LinkProgress{Code: code})
		}
	}
	if plan.Wait != nil {
		select {
		case <-plan.Wait:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if plan.Err != nil {
		return plan.Err
	}
	if plan.PairAs == "" {
		return client.ErrLinkTimeout
	}
	if !client.PhoneMatches(req.Phone, plan.PairAs) {
		return client.ErrWrongNumber
	}
	c.mu.Lock()
	c.own = client.Own{PN: plan.PairAs, LID: plan.PairLID}
	c.mu.Unlock()
	c.Emit(client.StateChange{State: "connected"})
	return nil
}

func (c *Client) Logout(context.Context) error {
	c.mu.Lock()
	if c.state != "connected" {
		c.mu.Unlock()
		return client.ErrNotConnected
	}
	c.own = client.Own{}
	c.LoggedOut = true
	c.state, c.reason = "unlinked", "logged out by the operator"
	c.mu.Unlock()
	return nil
}

func (c *Client) NewMessageID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.idSeq++
	return fmt.Sprintf("3EB0F0000000%06d", c.idSeq)
}

func (c *Client) enter() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != "connected" {
		return client.ErrNotConnected
	}
	c.inFlight++
	c.Attempts++
	if c.inFlight > c.MaxInFlight {
		c.MaxInFlight = c.inFlight
	}
	return nil
}

func (c *Client) leave() {
	c.mu.Lock()
	c.inFlight--
	c.mu.Unlock()
}

func (c *Client) Send(_ context.Context, m client.OutMessage) (client.SendResult, error) {
	if err := c.enter(); err != nil {
		return client.SendResult{}, err
	}
	defer c.leave()
	if c.BeforeSend != nil {
		c.BeforeSend(m)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.SendErr != nil {
		return client.SendResult{}, c.SendErr
	}
	if m.File != nil {
		m.File.Data = append([]byte(nil), m.File.Data...)
	}
	c.sent = append(c.sent, m)
	res := client.SendResult{Chat: m.Chat, Sender: c.own.LID, Time: time.Date(2030, 1, 5, 15, 0, 0, 0, time.UTC)}
	if res.Sender == "" {
		res.Sender = c.own.PN
	}
	if v, ok := c.AddressAs[m.Chat]; ok {
		res.Chat = v
	}
	if m.File != nil {
		res.Media = &client.Media{Type: m.File.Type, MIME: m.File.MIME, Name: m.File.Name, Size: int64(len(m.File.Data)), Caption: m.Text, Keys: c.UploadKeys}
	}
	return res, nil
}

// AttemptCount returns Attempts under the lock.
func (c *Client) AttemptCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Attempts
}

// Sent returns the messages sent so far.
func (c *Client) Sent() []client.OutMessage {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]client.OutMessage(nil), c.sent...)
}

func (c *Client) React(_ context.Context, chat, sender, id, emoji string) (client.SendResult, error) {
	if err := c.enter(); err != nil {
		return client.SendResult{}, err
	}
	defer c.leave()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.SendErr != nil {
		return client.SendResult{}, c.SendErr
	}
	c.reactions = append(c.reactions, ReactCall{Chat: chat, Sender: sender, ID: id, Emoji: emoji})
	return client.SendResult{Chat: chat, Time: time.Date(2030, 1, 5, 15, 0, 0, 0, time.UTC)}, nil
}

// Reactions returns the reactions sent so far.
func (c *Client) Reactions() []ReactCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ReactCall(nil), c.reactions...)
}

func (c *Client) Download(_ context.Context, m *client.Media) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != "connected" {
		return nil, client.ErrNotConnected
	}
	c.Downloads++
	if c.DownloadErr != nil {
		return nil, c.DownloadErr
	}
	data, ok := c.Files[string(m.Keys)]
	if !ok {
		return nil, client.ErrNotDownloadable
	}
	return data, nil
}

// MarkReadCount returns how many MarkRead calls were made.
func (c *Client) MarkReadCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.MarkReads)
}
