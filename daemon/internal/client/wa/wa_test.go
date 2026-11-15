package wa

import (
	"bytes"
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/session"
)

// Invented ids, as in the specs.
var (
	group   = types.NewJID("120363000000000001", types.GroupServer)
	ownPN   = types.NewJID("15550100000", types.DefaultUserServer)
	ownLID  = types.NewJID("100000000000000", types.HiddenUserServer)
	samLID  = types.NewJID("100000000000001", types.HiddenUserServer)
	samPN   = types.NewJID("15550100001", types.DefaultUserServer)
	alexLID = types.NewJID("100000000000002", types.HiddenUserServer)
	own     = client.Own{PN: ownPN.String(), LID: ownLID.String()}
)

func groupMsg(m *waE2E.Message, mod ...func(*events.Message)) *events.Message {
	e := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: group, Sender: samLID, SenderAlt: samPN, IsGroup: true, AddressingMode: types.AddressingModeLID},
			ID:            "3EB0AAAA0000000001",
			PushName:      "Sam",
			Timestamp:     time.Date(2030, 1, 5, 14, 0, 0, 0, time.UTC),
		},
		Message: m,
	}
	for _, f := range mod {
		f(e)
	}
	return e
}

func one(t *testing.T, raw any) *client.Message {
	t.Helper()
	evs := Translate(raw, own)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1: %+v", len(evs), evs)
	}
	m, ok := evs[0].(*client.Message)
	if !ok {
		t.Fatalf("got %T", evs[0])
	}
	return m
}

func none(t *testing.T, raw any) {
	t.Helper()
	if evs := Translate(raw, own); len(evs) != 0 {
		t.Fatalf("want nothing, got %+v", evs)
	}
}

func TestPlainTextAndEnvelope(t *testing.T) {
	m := one(t, groupMsg(&waE2E.Message{Conversation: proto.String("hello")}))
	if m.Kind != client.KindMessage || m.Text != "hello" || m.Chat != group.String() || m.ChatType != client.ChatGroup ||
		m.Sender != samLID.String() || m.SenderAlt != samPN.String() || m.PushName != "Sam" || m.ID != "3EB0AAAA0000000001" || m.FromMe {
		t.Fatalf("%+v", m)
	}
}

func TestCaptionsOnEachMediaType(t *testing.T) {
	ci := &waE2E.ContextInfo{MentionedJID: []string{ownLID.String()}}
	cases := map[string]*waE2E.Message{
		"image":    {ImageMessage: &waE2E.ImageMessage{Caption: proto.String("cap image"), Mimetype: proto.String("image/jpeg"), FileLength: proto.Uint64(10), DirectPath: proto.String("/v/t62/x?ccb=1&oh=tok"), MediaKey: []byte("k"), ContextInfo: ci}},
		"video":    {VideoMessage: &waE2E.VideoMessage{Caption: proto.String("cap video"), Mimetype: proto.String("video/mp4"), ContextInfo: ci}},
		"document": {DocumentMessage: &waE2E.DocumentMessage{Caption: proto.String("cap document"), Mimetype: proto.String("application/pdf"), FileName: proto.String("report.pdf"), ContextInfo: ci}},
	}
	for typ, msg := range cases {
		m := one(t, groupMsg(msg))
		if m.Media == nil || m.Media.Type != typ || m.Media.Caption != "cap "+typ || m.Text != "" {
			t.Fatalf("%s: %+v %+v", typ, m, m.Media)
		}
		if len(m.Mentions) != 1 || m.Mentions[0] != ownLID.String() {
			t.Fatalf("%s: mention on the caption lost: %v", typ, m.Mentions)
		}
	}
	// The download path is kept exactly as it arrived, query string included.
	m := one(t, groupMsg(cases["image"]))
	k, err := DecodeKeys(m.Media.Keys)
	if err != nil || k.DirectPath != "/v/t62/x?ccb=1&oh=tok" || string(k.MediaKey) != "k" || k.Type != "image" {
		t.Fatalf("keys: %+v %v", k, err)
	}
	// A document's name, and audio and stickers without captions.
	if m := one(t, groupMsg(cases["document"])); m.Media.Name != "report.pdf" || m.Media.MIME != "application/pdf" {
		t.Fatalf("%+v", m.Media)
	}
	if m := one(t, groupMsg(&waE2E.Message{AudioMessage: &waE2E.AudioMessage{Mimetype: proto.String("audio/ogg")}})); m.Media.Type != "audio" {
		t.Fatalf("%+v", m.Media)
	}
	if m := one(t, groupMsg(&waE2E.Message{StickerMessage: &waE2E.StickerMessage{}})); m.Media.Type != "sticker" {
		t.Fatalf("%+v", m.Media)
	}
	// View-once.
	vo := one(t, groupMsg(&waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}, func(e *events.Message) { e.IsViewOnce = true }))
	if !vo.Media.ViewOnce {
		t.Fatal("view-once lost")
	}
}

func TestReplyAndQuotedCopy(t *testing.T) {
	m := one(t, groupMsg(&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text: proto.String("@100000000000000 look"),
		ContextInfo: &waE2E.ContextInfo{
			StanzaID:      proto.String("3EB0AAAA0000000000"),
			Participant:   proto.String(alexLID.String()),
			QuotedMessage: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("the photo"), Mimetype: proto.String("image/png")}},
			MentionedJID:  []string{ownLID.String()},
			Expiration:    proto.Uint32(86400),
		},
	}}))
	q := m.ReplyTo
	if q == nil || q.ID != "3EB0AAAA0000000000" || q.Sender != alexLID.String() || q.Media == nil || q.Media.Caption != "the photo" {
		t.Fatalf("reply: %+v", q)
	}
	if m.Ephemeral != 86400 {
		t.Fatalf("ephemeral %d", m.Ephemeral)
	}
	// A quote with nothing but an id and sender is tolerated.
	m = one(t, groupMsg(&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("x"), ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String("3EB0AAAA0000000009")}}}))
	if m.ReplyTo == nil || m.ReplyTo.Text != "" || m.ReplyTo.Sender != "" {
		t.Fatalf("%+v", m.ReplyTo)
	}
}

func TestMentionsByEitherIDForm(t *testing.T) {
	for _, id := range []string{ownLID.String(), ownPN.String()} {
		m := one(t, groupMsg(&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("hi"), ContextInfo: &waE2E.ContextInfo{MentionedJID: []string{id}}}}))
		if len(m.Mentions) != 1 || m.Mentions[0] != id {
			t.Fatalf("%v", m.Mentions)
		}
	}
	// A message wrapped as a group mention is unwrapped.
	m := one(t, groupMsg(&waE2E.Message{GroupMentionedMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("all"), ContextInfo: &waE2E.ContextInfo{MentionedJID: []string{ownPN.String()}}}}}}))
	if m.Text != "all" || len(m.Mentions) != 1 {
		t.Fatalf("%+v", m)
	}
}

func TestEditRevokeReaction(t *testing.T) {
	key := &waCommon.MessageKey{ID: proto.String("3EB0AAAA0000000000")}
	edit := one(t, groupMsg(&waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(), Key: key,
		EditedMessage: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("new"), ContextInfo: &waE2E.ContextInfo{MentionedJID: []string{ownLID.String()}}}},
	}}, func(e *events.Message) { e.IsEdit = true }))
	if edit.Kind != client.KindEdit || edit.TargetID != "3EB0AAAA0000000000" || edit.Text != "new" || len(edit.Mentions) != 1 {
		t.Fatalf("edit %+v", edit)
	}
	rev := one(t, groupMsg(&waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: key}}))
	if rev.Kind != client.KindRevoke || rev.TargetID != "3EB0AAAA0000000000" {
		t.Fatalf("revoke %+v", rev)
	}
	r := one(t, groupMsg(&waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Key: key, Text: proto.String("👍")}}))
	if r.Kind != client.KindReaction || r.TargetID != "3EB0AAAA0000000000" || r.Emoji != "👍" {
		t.Fatalf("reaction %+v", r)
	}
	r = one(t, groupMsg(&waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Key: key, Text: proto.String("")}}))
	if r.Emoji != "" {
		t.Fatal("removal must have an empty emoji")
	}
	enc := one(t, groupMsg(&waE2E.Message{EncReactionMessage: &waE2E.EncReactionMessage{}}))
	if enc.Kind != client.KindEncrypted {
		t.Fatalf("%+v", enc)
	}
}

func TestProtocolTrafficAndHistoryFiltered(t *testing.T) {
	// History sync notification: dropped, never downloaded (security.md rule 7).
	none(t, groupMsg(&waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_HISTORY_SYNC_NOTIFICATION.Enum(), HistorySyncNotification: &waE2E.HistorySyncNotification{}}}))
	none(t, &events.HistorySync{})
	// App state key share, ephemeral setting, sender key distribution only, poll vote.
	none(t, groupMsg(&waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_APP_STATE_SYNC_KEY_SHARE.Enum()}}))
	none(t, groupMsg(&waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_EPHEMERAL_SETTING.Enum()}}))
	none(t, groupMsg(&waE2E.Message{SenderKeyDistributionMessage: &waE2E.SenderKeyDistributionMessage{}}))
	none(t, groupMsg(&waE2E.Message{PollUpdateMessage: &waE2E.PollUpdateMessage{}}))
	// A message parsed from history sync, and a channel post.
	none(t, groupMsg(&waE2E.Message{Conversation: proto.String("old")}, func(e *events.Message) { e.SourceWebMsg = &waWebMsg }))
	none(t, groupMsg(&waE2E.Message{Conversation: proto.String("post")}, func(e *events.Message) {
		e.Info.Chat = types.NewJID("120363000000000009", types.NewsletterServer)
	}))
	none(t, &events.UndecryptableMessage{})
}

func TestChatTypesAndDirectAlt(t *testing.T) {
	status := one(t, groupMsg(&waE2E.Message{Conversation: proto.String("s")}, func(e *events.Message) { e.Info.Chat = types.StatusBroadcastJID }))
	if status.ChatType != client.ChatStatus {
		t.Fatal(status.ChatType)
	}
	bl := one(t, groupMsg(&waE2E.Message{Conversation: proto.String("b")}, func(e *events.Message) { e.Info.Chat = types.NewJID("1700000000", types.BroadcastServer) }))
	if bl.ChatType != client.ChatBroadcast {
		t.Fatal(bl.ChatType)
	}
	dm := one(t, groupMsg(&waE2E.Message{Conversation: proto.String("d")}, func(e *events.Message) {
		e.Info.IsGroup = false
		e.Info.Chat = samPN
		e.Info.Sender = types.NewADJID(samPN.User, 0, 3)
		e.Info.SenderAlt = samLID
	}))
	if dm.ChatType != client.ChatDirect || dm.Chat != samPN.String() || dm.ChatAlt != samLID.String() || !strings.Contains(dm.Sender, ":3@") {
		t.Fatalf("%+v", dm)
	}
	// The account's own message from its phone: the chat's other form is the recipient's.
	mine := Translate(groupMsg(&waE2E.Message{Conversation: proto.String("m")}, func(e *events.Message) {
		e.Info.IsGroup, e.Info.IsFromMe = false, true
		e.Info.Chat, e.Info.Sender, e.Info.RecipientAlt = samLID, ownPN, samPN
	}), own)
	if len(mine) != 2 {
		t.Fatalf("%+v", mine)
	}
	if m := mine[0].(*client.Message); !m.FromMe || m.ChatAlt != samPN.String() {
		t.Fatalf("%+v", m)
	}
	if _, ok := mine[1].(client.PhoneActivity); !ok {
		t.Fatalf("no phone activity: %+v", mine[1])
	}
}

func TestConnectionEventsToStates(t *testing.T) {
	cases := []struct {
		ev    any
		state string
	}{
		{&events.Connected{}, "connected"},
		{&events.Disconnected{}, "connecting"},
		{&events.LoggedOut{OnConnect: true, Reason: events.ConnectFailureLoggedOut}, "logged_out"},
		{&events.LoggedOut{}, "logged_out"},
		{&events.TemporaryBan{Code: events.TempBanSentToTooManyPeople, Expire: time.Hour}, "suspended"},
		{&events.ClientOutdated{}, "outdated"},
	}
	for _, c := range cases {
		evs := Translate(c.ev, own)
		if len(evs) != 1 {
			t.Fatalf("%T: %+v", c.ev, evs)
		}
		sc, ok := evs[0].(client.StateChange)
		if !ok || sc.State != c.state {
			t.Fatalf("%T: %+v", c.ev, evs[0])
		}
	}
	if evs := Translate(&events.Receipt{MessageSource: types.MessageSource{IsFromMe: true, Sender: ownPN}}, own); len(evs) != 1 {
		t.Fatalf("own phone receipt: %+v", evs)
	}
}

func TestPrePairRefusesADifferentNumber(t *testing.T) {
	refused := make(chan struct{}, 1)
	cb := PrePair("15550100000", refused)
	if !cb(types.NewADJID("15550100000", 0, 12), "android", "") {
		t.Fatal("the named number must pair")
	}
	if cb(types.NewADJID("15550100099", 0, 12), "android", "") {
		t.Fatal("a different number must be refused")
	}
	select {
	case <-refused:
	default:
		t.Fatal("refusal not signalled")
	}
	if cb(types.NewADJID("100000000000000", 0, 12).ToNonAD(), "", "") {
		t.Fatal("a non-phone id must be refused")
	}
	// A QR link names no number.
	if !PrePair("", refused)(types.NewADJID("15550100099", 0, 12), "", "") {
		t.Fatal("QR linking accepts any number")
	}
}

func newAdapter(t *testing.T, logw *bytes.Buffer) *Client {
	t.Helper()
	log := slog.New(slog.NewTextHandler(logw, &slog.HandlerOptions{Level: slog.LevelDebug}))
	c, has, err := session.Open(context.Background(), filepath.Join(t.TempDir(), "session.db"), log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	if has {
		t.Fatal("new session.db has a device")
	}
	return New(c, false, log)
}

// TestRequiredLibrarySettings asserts every setting scopes.md requires, on the client the adapter
// builds, and that without a session nothing connects.
func TestRequiredLibrarySettings(t *testing.T) {
	var logw bytes.Buffer
	a := newAdapter(t, &logw)
	var got []client.Event
	if err := a.Start(context.Background(), func(e client.Event) { got = append(got, e) }); err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	cli := a.lib()
	if cli.EnableDecryptedEventBuffer {
		t.Error("the decrypted-message buffer must stay off")
	}
	if !cli.ManualHistorySyncDownload {
		t.Error("history download must be manual")
	}
	if cli.UseRetryMessageStore {
		t.Error("the retry message store must stay off")
	}
	if !cli.AutoTrustIdentity || !cli.EnableAutoReconnect {
		t.Error("identity changes are accepted and reconnects are on")
	}
	if cli.AutomaticMessageRerequestFromPhone {
		t.Error("no re-requests from the phone")
	}
	if cli.IsConnected() {
		t.Fatal("connected without a session")
	}
	if st, _ := a.State(); st != "unlinked" || len(got) != 0 {
		t.Fatalf("state %s, events %+v", st, got)
	}
	if store.DeviceProps.GetOs() != "Linux" || store.DeviceProps.GetPlatformType() != waCompanionReg.DeviceProps_CHROME {
		t.Fatalf("device props %v %v", store.DeviceProps.GetOs(), store.DeviceProps.GetPlatformType())
	}
	if PairDisplayName != "Chrome (Linux)" {
		t.Fatal(PairDisplayName)
	}
	// The library's logger runs at warning level or quieter: debug and info lines never appear.
	cli.Log.Debugf("MARKERDEBUG %s", "x")
	cli.Log.Infof("MARKERINFO %s", "x")
	cli.Log.Sub("Recv").Debugf("MARKERSUB")
	cli.Log.Warnf("visible warning")
	out := logw.String()
	if strings.Contains(out, "MARKER") || !strings.Contains(out, "visible warning") {
		t.Fatalf("log: %s", out)
	}
	// Calls that need a connection say so; reads of the store work offline.
	if err := a.SendPresence(context.Background()); err != client.ErrNotConnected {
		t.Fatal(err)
	}
	if err := a.Logout(context.Background()); err != client.ErrNotConnected {
		t.Fatal(err)
	}
	if _, err := a.GroupInfo(context.Background(), group.String()); err != client.ErrNotConnected {
		t.Fatal(err)
	}
	if _, err := a.JoinedGroups(context.Background()); err != client.ErrNotConnected {
		t.Fatal(err)
	}
	if err := a.MarkRead(context.Background(), group.String(), samLID.String(), []string{"x"}, time.Now()); err != client.ErrNotConnected {
		t.Fatal(err)
	}
	if a.LIDForPN(context.Background(), samPN.String()) != "" || a.OwnIDs() != (client.Own{}) {
		t.Fatal("no session, no ids")
	}
	if _, ok := a.Contact(context.Background(), samPN.String()); ok {
		t.Fatal("no contacts without a session")
	}
}

func TestGroupInfoAndContactNames(t *testing.T) {
	g := groupInfo(&types.GroupInfo{GroupName: types.GroupName{Name: "Example group"}, Participants: []types.GroupParticipant{
		{JID: samLID, LID: samLID, PhoneNumber: samPN},
		{JID: types.NewJID("15550100003", types.DefaultUserServer)},
	}})
	if g.Name != "Example group" || g.Participants[0].LID != samLID.String() || g.Participants[0].PN != samPN.String() || g.Participants[1].PN != "15550100003@s.whatsapp.net" {
		t.Fatalf("%+v", g)
	}
	j := joinedGroups([]*types.GroupInfo{nil, {JID: group, GroupName: types.GroupName{Name: "Example group"}, Participants: []types.GroupParticipant{{JID: samLID}, {JID: alexLID}}}})
	if len(j) != 1 || j[0] != (client.JoinedGroup{ID: group.String(), Name: "Example group", Members: 2}) {
		t.Fatalf("%+v", j)
	}
	if n, ok := addressBookName(types.ContactInfo{Found: true, PushName: "Self"}); ok || n != "" {
		t.Fatal("a push name alone is not a contact")
	}
	if n, ok := addressBookName(types.ContactInfo{Found: true, FullName: "Sam Example"}); !ok || n != "Sam Example" {
		t.Fatal(n)
	}
}

var waWebMsg = waWeb.WebMessageInfo{}

// The live run after a link by pairing code: the library reconnects as the new device and its
// Connected arrives while the link is still finishing; the link ends connected; then the pairing
// socket's Disconnected arrives, last. The state must stay connected, because the connection is
// up. A Disconnected while the connection is really down still reports connecting, and every
// later Connected is reported.
func TestPairingDisconnectAfterConnected(t *testing.T) {
	var logw bytes.Buffer
	a := newAdapter(t, &logw)
	var got []client.StateChange
	if err := a.Start(context.Background(), func(e client.Event) {
		if sc, ok := e.(client.StateChange); ok {
			got = append(got, sc)
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	live := true
	a.mu.Lock()
	a.live = func() bool { return live }
	a.linking = true
	a.mu.Unlock()

	a.onEvent(&events.Connected{}) // the new device's socket, during the link
	a.endLink(nil, true)           // the link reports success
	a.onEvent(&events.Disconnected{})
	if st, _ := a.State(); st != "connected" || len(got) != 1 || got[0].State != "connected" {
		t.Fatalf("state %s, events %+v", st, got)
	}

	live = false
	a.onEvent(&events.Disconnected{})
	if st, why := a.State(); st != "connecting" || why != reasonConnectionLost {
		t.Fatalf("a real disconnect: %s %s", st, why)
	}
	a.onEvent(&events.Connected{}) // stale: the socket is already gone
	if st, _ := a.State(); st != "connecting" {
		t.Fatal("a stale Connected must not report connected")
	}
	live = true
	a.onEvent(&events.Connected{})
	if st, _ := a.State(); st != "connected" || got[len(got)-1].State != "connected" {
		t.Fatalf("a later Connected is reported: %+v", got)
	}
	if len(got) != 3 {
		t.Fatalf("events %+v", got)
	}
}

// With a session, the first state is the one the session implies, never "unlinked".
func TestInitialStateFollowsTheSession(t *testing.T) {
	log := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	c, _, err := session.Open(context.Background(), filepath.Join(t.TempDir(), "session.db"), log)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if st, why := New(c, true, log).State(); st != "connecting" || why != "starting" {
		t.Fatalf("with a session: %s (%s)", st, why)
	}
	if st, _ := New(c, false, log).State(); st != "unlinked" {
		t.Fatalf("without a session: %s", st)
	}
}

// The account's own name arriving through app-state sync is reported only once the library has
// it.
func TestPushNameReady(t *testing.T) {
	for _, ev := range []any{&events.PushNameSetting{}, &events.AppStateSyncComplete{}} {
		if evs := Translate(ev, own); len(evs) != 1 || evs[0] != (client.PushNameReady{}) {
			t.Fatalf("%T: %+v", ev, evs)
		}
	}
	var logw bytes.Buffer
	a := newAdapter(t, &logw)
	var got []client.Event
	if err := a.Start(context.Background(), func(e client.Event) { got = append(got, e) }); err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	a.onEvent(&events.AppStateSyncComplete{})
	if len(got) != 0 {
		t.Fatalf("no name yet: %+v", got)
	}
	a.mu.Lock()
	a.device.PushName = "Example"
	a.mu.Unlock()
	a.onEvent(&events.AppStateSyncComplete{})
	if len(got) != 1 {
		t.Fatalf("name known: %+v", got)
	}
}
