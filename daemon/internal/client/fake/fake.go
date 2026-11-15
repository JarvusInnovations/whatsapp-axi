// Package fake is a client.Client for tests: it emits events on demand and records calls. It
// never touches the network.
package fake

import (
	"context"
	"sync"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
)

// MarkReadCall records one MarkRead.
type MarkReadCall struct {
	Chat, Sender string
	IDs          []string
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
	Requested []string // ids passed to RequestMapping
	Closed    bool
	Presences int // SendPresence calls
	LoggedOut bool

	// Linking is what the next Link call does.
	Linking LinkPlan
	// LinkRequests records every Link request.
	LinkRequests []client.LinkRequest
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
	c.MarkReads = append(c.MarkReads, MarkReadCall{Chat: chat, Sender: sender, IDs: append([]string(nil), ids...)})
	return nil
}

func (c *Client) SendPresence(context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != "connected" {
		return client.ErrNotConnected
	}
	c.Presences++
	return nil
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

// MarkReadCount returns how many MarkRead calls were made.
func (c *Client) MarkReadCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.MarkReads)
}
