// Package wa is the real client.Client, on whatsmeow (specs/daemon.md, plans/whatsapp-client.md).
//
// It owns the library client and its session store, sets the library settings the discard
// guarantee depends on (specs/scopes.md "Library settings the guarantee depends on"), turns
// library events into the daemon's events (translate.go), and runs linking and logout. It
// never downloads history and never logs message content: the library's logger runs at warning
// level or quieter.
package wa

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/session"
)

// The conventional browser-and-OS name the daemon presents (specs/daemon.md "Linking"):
// WhatsApp rejects a pairing-code display name of any other shape.
const (
	PairDisplayName = "Chrome (Linux)"
	osName          = "Linux"
)

func init() {
	// The device properties sent when linking: a desktop Chrome on Linux.
	name := osName
	store.DeviceProps.Os = &name
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_CHROME.Enum()
}

// Client is the whatsmeow adapter.
type Client struct {
	container *sqlstore.Container
	log       *slog.Logger

	mu      sync.Mutex
	device  *store.Device
	wa      *whatsmeow.Client
	handler client.Handler
	state   string
	reason  string
	linking bool
	ctx     context.Context
	cancel  context.CancelFunc

	// deliver serialises calls to the handler.
	deliver sync.Mutex

	mapMu     sync.Mutex
	requested map[string]time.Time

	// live reports whether the library is connected and logged in right now. Tests replace it;
	// nil asks the library.
	live func() bool
}

// New returns an adapter over an opened session store. It does not connect. hasSession says
// whether the store holds a linked device, so the first state reported is the one the session
// implies: connecting when there is one, unlinked when there is none.
func New(container *sqlstore.Container, hasSession bool, log *slog.Logger) *Client {
	c := &Client{container: container, log: log, state: "unlinked", reason: "no session", requested: map[string]time.Time{}}
	if hasSession {
		c.state, c.reason = "connecting", "starting"
	}
	return c
}

// isLive reports whether the library's connection is up and logged in.
func (c *Client) isLive() bool {
	c.mu.Lock()
	live, wa := c.live, c.wa
	c.mu.Unlock()
	if live != nil {
		return live()
	}
	return wa != nil && wa.IsConnected() && wa.IsLoggedIn()
}

// Configure applies every library setting the daemon depends on to a library client. It is
// exported so a test can assert each one.
func Configure(cli *whatsmeow.Client) {
	// The decrypted-message buffer would write plaintext of every message to session.db.
	cli.EnableDecryptedEventBuffer = false
	// History is never downloaded: the notification arrives as a protocol message, which the
	// translation drops (specs/scopes.md "History").
	cli.ManualHistorySyncDownload = true
	// Own outgoing messages are not copied into session.db for retries.
	cli.UseRetryMessageStore = false
	// Identity changes of peers are accepted, as the library does by default (daemon.md).
	cli.AutoTrustIdentity = true
	// A lost connection is retried by the library with its backoff.
	cli.EnableAutoReconnect = true
	// Messages that fail to decrypt are not re-requested from the phone.
	cli.AutomaticMessageRerequestFromPhone = false
	cli.EmitAppStateEventsOnFullSync = false
	cli.AppStateDebugLogs = false
}

func (c *Client) newLibraryClient(dev *store.Device) *whatsmeow.Client {
	cli := whatsmeow.NewClient(dev, session.Logger(c.log, "whatsapp"))
	Configure(cli)
	cli.AddEventHandler(c.onEvent)
	return cli
}

// Start loads the session and, when there is one, connects.
func (c *Client) Start(ctx context.Context, h client.Handler) error {
	dev, err := c.container.GetFirstDevice(ctx)
	if err != nil {
		return fmt.Errorf("read session.db: %w", err)
	}
	c.mu.Lock()
	c.handler = h
	c.device = dev
	c.ctx, c.cancel = context.WithCancel(context.Background())
	c.wa = c.newLibraryClient(dev)
	linked := dev.ID != nil
	changed := false
	if linked && (c.state != "connecting" || c.reason != "starting") {
		c.state, c.reason = "connecting", "starting"
		changed = true
	}
	wa := c.wa
	c.mu.Unlock()
	if changed {
		c.emit(client.StateChange{State: "connecting", Reason: "starting"})
	}
	if linked {
		go func() {
			if err := wa.ConnectContext(c.ctx); err != nil {
				c.log.Warn("connecting failed; the library retries", "err", err)
			}
		}()
	}
	return nil
}

// Close disconnects.
func (c *Client) Close() error {
	c.mu.Lock()
	wa, cancel := c.wa, c.cancel
	c.handler = nil
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if wa != nil {
		wa.Disconnect()
	}
	return nil
}

func (c *Client) State() (string, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state, c.reason
}

// setState records and reports a state. While linking the daemon owns the state, so nothing is
// reported; an unchanged state is not reported again.
func (c *Client) setState(st, reason string) {
	c.mu.Lock()
	if c.linking || c.state == st && c.reason == reason {
		c.mu.Unlock()
		return
	}
	c.state, c.reason = st, reason
	c.mu.Unlock()
	c.emit(client.StateChange{State: st, Reason: reason})
}

func (c *Client) emit(ev client.Event) {
	c.mu.Lock()
	h := c.handler
	c.mu.Unlock()
	if h == nil {
		return
	}
	c.deliver.Lock()
	defer c.deliver.Unlock()
	h(ev)
}

func (c *Client) lib() *whatsmeow.Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.wa
}

// onEvent receives every library event.
//
// The library dispatches Disconnected from its own goroutine, so the Disconnected of an old socket
// can arrive after the Connected of its replacement: after a pairing, the library reconnects as
// the new device at once, and the pairing socket's Disconnected lands after the new Connected
// (docs/research/whatsmeow.md). For these two events the state is therefore derived from the
// library's connection as it is now, not from which event came last.
func (c *Client) onEvent(raw any) {
	c.mu.Lock()
	own := ownOf(c.device)
	pushName := c.device != nil && c.device.PushName != ""
	c.mu.Unlock()
	switch raw.(type) {
	case *events.Connected, *events.Disconnected:
		if c.isLive() {
			c.setState("connected", "")
		} else {
			c.setState("connecting", reasonConnectionLost)
		}
		return
	}
	for _, ev := range Translate(raw, own) {
		switch e := ev.(type) {
		case client.StateChange:
			c.setState(e.State, e.Reason)
		case client.PushNameReady:
			if pushName {
				c.emit(ev)
			}
		default:
			c.emit(ev)
		}
	}
}

func ownOf(dev *store.Device) client.Own {
	if dev == nil {
		return client.Own{}
	}
	var o client.Own
	if dev.ID != nil {
		o.PN = dev.ID.ToNonAD().String()
	}
	if !dev.LID.IsEmpty() {
		o.LID = dev.LID.ToNonAD().String()
	}
	return o
}

func (c *Client) OwnIDs() client.Own {
	c.mu.Lock()
	defer c.mu.Unlock()
	return ownOf(c.device)
}

func (c *Client) lids() store.LIDStore {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.device == nil || c.device.LIDs == nil {
		return nil
	}
	return c.device.LIDs
}

func (c *Client) LIDForPN(ctx context.Context, pn string) string {
	j, err := types.ParseJID(pn)
	ls := c.lids()
	if err != nil || ls == nil {
		return ""
	}
	l, err := ls.GetLIDForPN(ctx, j.ToNonAD())
	if err != nil || l.IsEmpty() {
		return ""
	}
	return l.ToNonAD().String()
}

func (c *Client) PNForLID(ctx context.Context, lid string) string {
	j, err := types.ParseJID(lid)
	ls := c.lids()
	if err != nil || ls == nil {
		return ""
	}
	p, err := ls.GetPNForLID(ctx, j.ToNonAD())
	if err != nil || p.IsEmpty() {
		return ""
	}
	return p.ToNonAD().String()
}

// RequestMapping asks WhatsApp for the hidden id of a phone-number id, in the background, at
// most once an hour per id. The library stores the pair it learns. For a hidden id there is no
// request that returns the phone number; the library learns that pair from traffic.
func (c *Client) RequestMapping(_ context.Context, id string) {
	j, err := types.ParseJID(id)
	if err != nil || j.Server != types.DefaultUserServer {
		return
	}
	c.mapMu.Lock()
	if t, ok := c.requested[id]; ok && time.Since(t) < time.Hour {
		c.mapMu.Unlock()
		return
	}
	c.requested[id] = time.Now()
	c.mapMu.Unlock()
	wa := c.lib()
	if wa == nil || !wa.IsLoggedIn() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := wa.GetUserInfo(ctx, []types.JID{j.ToNonAD()}); err != nil {
			c.log.Debug("resolving an id failed", "err", err)
		}
	}()
}

// Contact reads the library's contact store, filled by the phone's address-book sync. A user is
// a contact when the address book has a name for them.
func (c *Client) Contact(ctx context.Context, id string) (string, bool) {
	j, err := types.ParseJID(id)
	if err != nil {
		return "", false
	}
	c.mu.Lock()
	dev := c.device
	c.mu.Unlock()
	if dev == nil || dev.Contacts == nil || dev.ID == nil {
		return "", false
	}
	info, err := dev.Contacts.GetContact(ctx, j.ToNonAD())
	if err != nil || !info.Found {
		return "", false
	}
	return addressBookName(info)
}

func addressBookName(info types.ContactInfo) (string, bool) {
	switch {
	case info.FullName != "":
		return info.FullName, true
	case info.FirstName != "":
		return info.FirstName, true
	}
	return "", false
}

func (c *Client) connected() (*whatsmeow.Client, error) {
	c.mu.Lock()
	wa, st := c.wa, c.state
	c.mu.Unlock()
	if wa == nil || st != "connected" || !wa.IsConnected() {
		return nil, client.ErrNotConnected
	}
	return wa, nil
}

func (c *Client) GroupInfo(ctx context.Context, chat string) (client.GroupInfo, error) {
	wa, err := c.connected()
	if err != nil {
		return client.GroupInfo{}, err
	}
	j, err := types.ParseJID(chat)
	if err != nil {
		return client.GroupInfo{}, err
	}
	g, err := wa.GetGroupInfo(ctx, j)
	if err != nil {
		return client.GroupInfo{}, err
	}
	return groupInfo(g), nil
}

func groupInfo(g *types.GroupInfo) client.GroupInfo {
	out := client.GroupInfo{Name: g.Name}
	for _, p := range g.Participants {
		gp := client.Participant{JID: p.JID.ToNonAD().String()}
		if !p.PhoneNumber.IsEmpty() {
			gp.PN = p.PhoneNumber.ToNonAD().String()
		} else if p.JID.Server == types.DefaultUserServer {
			gp.PN = gp.JID
		}
		if !p.LID.IsEmpty() {
			gp.LID = p.LID.ToNonAD().String()
		} else if p.JID.Server == types.HiddenUserServer {
			gp.LID = gp.JID
		}
		out.Participants = append(out.Participants, gp)
	}
	return out
}

func (c *Client) MarkRead(ctx context.Context, chat, sender string, ids []string, t time.Time) error {
	wa, err := c.connected()
	if err != nil {
		return err
	}
	cj, err := types.ParseJID(chat)
	if err != nil {
		return err
	}
	var sj types.JID
	if sender != "" {
		if sj, err = types.ParseJID(sender); err != nil {
			return err
		}
	}
	mids := make([]types.MessageID, len(ids))
	copy(mids, ids)
	return wa.MarkRead(ctx, mids, t, cj, sj)
}

func (c *Client) SendTyping(ctx context.Context, chat string, on bool) error {
	wa, err := c.connected()
	if err != nil {
		return err
	}
	j, err := types.ParseJID(chat)
	if err != nil {
		return err
	}
	state := types.ChatPresencePaused
	if on {
		state = types.ChatPresenceComposing
	}
	return wa.SendChatPresence(ctx, j.ToNonAD(), state, "")
}

func (c *Client) SendPresence(ctx context.Context) error {
	wa, err := c.connected()
	if err != nil {
		return err
	}
	if err := wa.SendPresence(ctx, types.PresenceAvailable); errors.Is(err, whatsmeow.ErrNoPushName) {
		return client.ErrNoPushName
	} else if err != nil {
		return err
	}
	return nil
}

// Link links by pairing code or QR code (specs/daemon.md "Linking"). The pairing is refused
// in the library's pre-pair callback unless the phone is the number given (security.md rule 8).
func (c *Client) Link(ctx context.Context, req client.LinkRequest, progress func(client.LinkProgress)) error {
	c.mu.Lock()
	if c.device != nil && c.device.ID != nil && !c.device.Deleted {
		c.mu.Unlock()
		return errors.New("already linked")
	}
	if c.wa != nil {
		c.wa.Disconnect()
	}
	dev := c.container.NewDevice()
	c.device = dev
	wa := c.newLibraryClient(dev)
	c.wa = wa
	c.linking = true
	c.mu.Unlock()
	finished := false
	defer func() { c.endLink(wa, finished) }()

	refused := make(chan struct{}, 1)
	wa.PrePairCallback = PrePair(req.Phone, refused)
	connected := make(chan struct{}, 1)
	wa.AddEventHandler(func(e any) {
		if _, ok := e.(*events.Connected); ok {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
	})
	qr, err := wa.GetQRChannel(ctx)
	if err != nil {
		return err
	}
	if err := wa.ConnectContext(ctx); err != nil {
		return err
	}
	wasRefused := func() bool {
		select {
		case <-refused:
			return true
		default:
			return false
		}
	}
	codeSent := false
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case item, ok := <-qr:
			if !ok {
				return client.ErrLinkTimeout
			}
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				if req.QR {
					progress(client.LinkProgress{QR: item.Code})
				} else if !codeSent {
					code, err := wa.PairPhone(ctx, req.Phone, true, whatsmeow.PairClientChrome, PairDisplayName)
					if err != nil {
						return err
					}
					codeSent = true
					progress(client.LinkProgress{Code: code})
				}
			case whatsmeow.QRChannelSuccess.Event:
				// The server restarts the connection as the new device; wait for it.
				select {
				case <-connected:
				case <-ctx.Done():
					return ctx.Err()
				}
				finished = true
				return nil
			case whatsmeow.QRChannelClientOutdated.Event:
				return client.ErrOutdated
			case whatsmeow.QRChannelEventError:
				if wasRefused() || errors.Is(item.Error, whatsmeow.ErrPairRejectedLocally) {
					return client.ErrWrongNumber
				}
				return item.Error
			case whatsmeow.QRChannelTimeout.Event:
				if wasRefused() {
					return client.ErrWrongNumber
				}
				return client.ErrLinkTimeout
			default:
				return fmt.Errorf("link ended with %s", item.Event)
			}
		}
	}
}

// endLink ends a link attempt: on success the state is connected, and reported; otherwise the
// attempt's connection is dropped and the state is unlinked, which the daemon records itself.
func (c *Client) endLink(wa *whatsmeow.Client, finished bool) {
	c.mu.Lock()
	c.linking = false
	if finished {
		c.state, c.reason = "connected", ""
	} else {
		c.state, c.reason = "unlinked", "no session"
	}
	c.mu.Unlock()
	if finished {
		c.emit(client.StateChange{State: "connected"})
	} else if wa != nil {
		wa.Disconnect()
	}
}

// PrePair is the library's pre-pair callback: it lets a pairing complete only for the phone
// number digits given (any number for a QR link, where digits is empty), and signals refused
// otherwise.
func PrePair(digits string, refused chan<- struct{}) func(types.JID, string, string) bool {
	return func(jid types.JID, _, _ string) bool {
		if client.PhoneMatches(digits, jid.String()) {
			return true
		}
		select {
		case refused <- struct{}{}:
		default:
		}
		return false
	}
}

// Logout removes this linked device on WhatsApp and deletes the session.
func (c *Client) Logout(ctx context.Context) error {
	wa, err := c.connected()
	if err != nil {
		return err
	}
	if err := wa.Logout(ctx); err != nil {
		return err
	}
	c.mu.Lock()
	c.state, c.reason = "unlinked", "logged out by the operator"
	c.mu.Unlock()
	return nil
}
