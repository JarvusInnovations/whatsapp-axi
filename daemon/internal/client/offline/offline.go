// Package offline is the client the daemon runs on when no WhatsApp client is configured (tests
// of the runner). It never connects: with no session the daemon is unlinked, and
// every call that would need WhatsApp reports that it is not connected.
package offline

import (
	"context"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
)

// Client is the offline client.
type Client struct {
	hasSession bool
}

// New returns an offline client. hasSession says whether session.db holds a linked device.
func New(hasSession bool) *Client { return &Client{hasSession: hasSession} }

func (c *Client) Start(context.Context, client.Handler) error { return nil }
func (c *Client) Close() error                                { return nil }

func (c *Client) State() (string, string) {
	if c.hasSession {
		return "connecting", "this build has no WhatsApp client yet"
	}
	return "unlinked", "no session"
}

func (c *Client) OwnIDs() client.Own                             { return client.Own{} }
func (c *Client) LIDForPN(context.Context, string) string        { return "" }
func (c *Client) PNForLID(context.Context, string) string        { return "" }
func (c *Client) RequestMapping(context.Context, string)         {}
func (c *Client) Contact(context.Context, string) (string, bool) { return "", false }
func (c *Client) GroupInfo(context.Context, string) (client.GroupInfo, error) {
	return client.GroupInfo{}, client.ErrNotConnected
}
func (c *Client) SendPresence(context.Context) error { return client.ErrNotConnected }
func (c *Client) SendTyping(context.Context, string, bool) error {
	return client.ErrNotConnected
}
func (c *Client) Logout(context.Context) error { return client.ErrNotConnected }
func (c *Client) Link(context.Context, client.LinkRequest, func(client.LinkProgress)) error {
	return client.ErrNotConnected
}
func (c *Client) NewMessageID() string { return "" }
func (c *Client) Send(context.Context, client.OutMessage) (client.SendResult, error) {
	return client.SendResult{}, client.ErrNotConnected
}
func (c *Client) React(context.Context, string, string, string, string) (client.SendResult, error) {
	return client.SendResult{}, client.ErrNotConnected
}
func (c *Client) Download(context.Context, *client.Media) ([]byte, error) {
	return nil, client.ErrNotConnected
}
func (c *Client) MarkRead(context.Context, string, string, []string, time.Time) error {
	return client.ErrNotConnected
}
