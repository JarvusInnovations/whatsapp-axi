package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/core"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/paths"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/settings"
)

func runOnce(e *env) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return Run(ctx, Options{Account: account, Getenv: e.getenv, Log: e.log, Ready: func(*core.Account) { cancel() }})
}

func TestStartRefusesLooseModes(t *testing.T) {
	cases := []struct {
		name string
		path func(l pathsLayout) string
		mode os.FileMode
	}{
		{"settings file", func(l pathsLayout) string { return l.SettingsFile() }, 0o644},
		{"config dir", func(l pathsLayout) string { return l.ConfigDir() }, 0o750},
		{"state dir", func(l pathsLayout) string { return l.StateDir() }, 0o755},
		{"media dir", func(l pathsLayout) string { return l.MediaDir() }, 0o770},
		{"config root", func(l pathsLayout) string { return l.ConfigRoot }, 0o755},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			l := e.init()
			p := c.path(l)
			if err := os.Chmod(p, c.mode); err != nil {
				t.Fatal(err)
			}
			err := runOnce(e)
			if err == nil || !strings.Contains(err.Error(), p) || !strings.Contains(err.Error(), "fix: chmod") {
				t.Fatalf("got %v, want a refusal naming %s and the fix", err, p)
			}
		})
	}
	t.Run("database file", func(t *testing.T) {
		e := newEnv(t)
		l := e.init()
		if err := runOnce(e); err != nil {
			t.Fatal(err)
		}
		os.Chmod(l.StoreDB(), 0o640)
		if err := runOnce(e); err == nil || !strings.Contains(err.Error(), "store.db") {
			t.Fatalf("got %v", err)
		}
	})
}

type pathsLayout = paths.Layout

func TestStartRefusesHeldLockAndBadSettings(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	err := runOnce(e)
	if !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second daemon: got %v, want already running", err)
	}
	// remove refuses while the daemon runs.
	if _, err := Remove(account, e.getenv); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("remove while running: %v", err)
	}
	d.stop()

	l := e.layout()
	os.WriteFile(l.SettingsFile(), []byte(`{"scope":"tagged","colour":"blue"}`), 0o600)
	if err := runOnce(e); err == nil || !strings.Contains(err.Error(), "colour") {
		t.Fatalf("unknown settings key: got %v", err)
	}
	os.WriteFile(l.SettingsFile(), []byte(`{"scope":"some"}`), 0o600)
	if err := runOnce(e); err == nil || !strings.Contains(err.Error(), "scope") {
		t.Fatalf("bad settings value: got %v", err)
	}
}

func TestStaleSocketReplacedAndModes(t *testing.T) {
	e := newEnv(t)
	l := e.init()
	// A socket left behind by a crashed daemon.
	os.MkdirAll(l.RuntimeRoot, 0o700)
	ln, err := net.Listen("unix", l.Socket())
	if err != nil {
		t.Fatal(err)
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	ln.Close()
	if _, err := os.Stat(l.Socket()); err != nil {
		t.Fatal("stale socket not left behind")
	}
	d := e.start(startOpts{})
	var st core.Status
	d.get("/v1/status", &st)

	fi, _ := os.Stat(l.RuntimeRoot)
	if fi.Mode().Perm() != 0o700 {
		t.Errorf("socket directory mode %o", fi.Mode().Perm())
	}
	fi, _ = os.Stat(l.Socket())
	if fi.Mode().Perm() != 0o600 || fi.Mode()&os.ModeSocket == 0 {
		t.Errorf("socket mode %v", fi.Mode())
	}
	d.stop()
	if _, err := os.Stat(l.Socket()); !os.IsNotExist(err) {
		t.Error("a clean stop removes the socket")
	}

	// A socket directory with looser modes is refused.
	os.Chmod(l.RuntimeRoot, 0o755)
	if err := runOnce(e); err == nil || !strings.Contains(err.Error(), l.RuntimeRoot) {
		t.Fatalf("loose socket directory: %v", err)
	}
}

func TestPeerUIDChecked(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{peer: func(net.Conn) (int, error) { return os.Getuid() + 1, nil }})
	req, _ := http.NewRequest("GET", "http://whatsapp-axi/v1/status", nil)
	resp, err := d.http.Do(req)
	if err == nil {
		resp.Body.Close()
		t.Fatalf("a connection from another user got a response: %d", resp.StatusCode)
	}
	// The connection is closed before any request is read: nothing reaches the handlers.
	if strings.Contains(string(e.log.Bytes()), "path=/v1/status") {
		t.Fatal("the request was read")
	}
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(string(e.log.Bytes()), "closed a connection from another user") {
		if time.Now().After(deadline) {
			t.Fatal("rejection not logged")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestKernelPeerUIDIsOwn(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{}) // uses the real SO_PEERCRED lookup
	var st core.Status
	d.get("/v1/status", &st)
	if st.State != "connected" {
		t.Fatal(st.State)
	}
}

// TestNoTCPListener lists the process's listening sockets and finds only the Unix one
// (security.md rule 1).
func TestNoTCPListener(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	var st core.Status
	d.get("/v1/status", &st)

	inodes := map[string]bool{}
	fds, _ := os.ReadDir("/proc/self/fd")
	for _, fd := range fds {
		target, err := os.Readlink(filepath.Join("/proc/self/fd", fd.Name()))
		if err == nil && strings.HasPrefix(target, "socket:[") {
			inodes[strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")] = true
		}
	}
	if len(inodes) == 0 {
		t.Fatal("found no sockets at all")
	}
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp", "/proc/net/udp6"} {
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n")[1:] {
			fields := strings.Fields(line)
			if len(fields) > 9 && inodes[fields[9]] {
				t.Errorf("the process has an inet socket: %s", line)
			}
		}
	}
	data, _ := os.ReadFile("/proc/net/unix")
	foundListen := false
	for _, line := range strings.Split(string(data), "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) >= 8 && inodes[fields[6]] && strings.HasSuffix(line, e.layout().Socket()) {
			foundListen = true
		}
	}
	if !foundListen {
		t.Error("the Unix socket is not among the process's sockets")
	}
}

func TestCoreDumpsDisabled(t *testing.T) {
	e := newEnv(t)
	e.init()
	e.start(startOpts{})
	var rl unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_CORE, &rl); err != nil {
		t.Fatal(err)
	}
	if rl.Cur != 0 || rl.Max != 0 {
		t.Fatalf("RLIMIT_CORE = %+v", rl)
	}
}

func TestUnlinkedOnTheOfflineClient(t *testing.T) {
	e := newEnv(t)
	e.init()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	errc := make(chan error, 1)
	go func() {
		errc <- Run(ctx, Options{Account: account, Getenv: e.getenv, Log: e.log, Version: "0.0.0-test", Ready: func(*core.Account) { close(ready) }})
	}()
	select {
	case <-ready:
	case err := <-errc:
		t.Fatal(err)
	}
	sock := e.layout().Socket()
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
	resp, err := hc.Get("http://x/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	var st core.Status
	json.NewDecoder(resp.Body).Decode(&st)
	resp.Body.Close()
	if st.State != "unlinked" || st.Protocol != 1 || st.DaemonVersion != "0.0.0-test" || st.LibraryVersion == "" || st.Me != nil {
		t.Fatalf("status: %+v", st)
	}
	cancel()
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
	// Both databases were created, migrated and are owner-only.
	l := e.layout()
	for _, p := range []string{l.StoreDB(), l.SessionDB()} {
		fi, err := os.Stat(p)
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("%s: %v %v", p, fi, err)
		}
	}
}

func TestStatusAndSettingsRequests(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	var st core.Status
	d.get("/v1/status", &st)
	if st.State != "connected" || st.Me == nil || st.Me.ID != ownLID || st.Me.PN != "+15550100000" || !st.LastPhoneActivityApprox {
		t.Fatalf("status: %+v", st)
	}
	d.wantError("GET", "/v1/status?x=1", nil, 400, "bad_request")
	d.wantError("GET", "/v1/nothing", nil, 400, "bad_request")
	d.wantError("DELETE", "/v1/status", nil, 400, "bad_request")
	d.wantError("POST", "/v1/send", `{}`, 400, "bad_request")

	var sv struct {
		Settings settings.Settings `json:"settings"`
		Eff      int               `json:"effective_retain_days"`
		Changed  *bool             `json:"changed"`
	}
	d.get("/v1/settings", &sv)
	if sv.Settings.Scope != "tagged" || sv.Eff != 90 {
		t.Fatalf("settings: %+v", sv)
	}
	code, body := d.do("PATCH", "/v1/settings", `{"operators":["+15550100001"],"chats":{"+15550100003":"full"}}`)
	json.Unmarshal(body, &sv)
	if code != 200 || sv.Changed == nil || !*sv.Changed || len(sv.Settings.Operators) != 1 || sv.Settings.Chats[caseyPN] != "full" {
		t.Fatalf("patch: %d %s", code, body)
	}
	// Idempotent: the same patch again changes nothing.
	_, body = d.do("PATCH", "/v1/settings", `{"operators":["+15550100001"]}`)
	json.Unmarshal(body, &sv)
	if *sv.Changed {
		t.Fatal("a repeated patch reports a change")
	}
	before, _ := os.ReadFile(e.layout().SettingsFile())
	d.wantError("PATCH", "/v1/settings", `{"operators":["+15550100002"],"bogus":1}`, 400, "bad_request")
	d.wantError("PATCH", "/v1/settings", `{"scope":"full","presence":"maybe"}`, 400, "bad_request")
	d.wantError("PATCH", "/v1/settings", `{"chats":{"not-a-chat":"full"}}`, 400, "bad_request")
	d.wantError("PATCH", "/v1/settings", `{"chats":{"+15550100003":"tagged"}}`, 400, "bad_request")
	d.wantError("PATCH", "/v1/settings", `not json`, 400, "bad_request")
	after, _ := os.ReadFile(e.layout().SettingsFile())
	if string(before) != string(after) {
		t.Fatal("a rejected patch changed the file")
	}

	// Durable across a restart.
	d.stop()
	d = e.start(startOpts{})
	d.get("/v1/settings", &sv)
	if len(sv.Settings.Operators) != 1 || sv.Settings.Operators[0] != "+15550100001" {
		t.Fatalf("after restart: %+v", sv.Settings)
	}
	// Atomic: no temporary files left next to settings.json.
	entries, _ := os.ReadDir(e.layout().ConfigDir())
	if len(entries) != 1 {
		t.Fatalf("config dir: %v", entries)
	}
}

func TestChatRequests(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.fake.SetGroup(group, client.GroupInfo{Name: "Example group", Participants: []client.Participant{
		{JID: ownLID, LID: ownLID, PN: ownPN}, {JID: samLID, LID: samLID, PN: samPN}, {JID: alexLID, LID: alexLID},
	}})
	d.fake.AddContact(samLID, "Sam Example")
	d.patch(`{"operators":["+15550100001"]}`)
	d.emit(msg("@Example hi", mention))

	var list struct {
		Chats []core.ChatSummary `json:"chats"`
	}
	d.get("/v1/chats", &list)
	if len(list.Chats) != 1 || list.Chats[0].ID != group || list.Chats[0].Name != "Example group" || list.Chats[0].Scope != "tagged" || list.Chats[0].LastKept == nil {
		t.Fatalf("chats: %+v", list)
	}
	var cv struct {
		Chat core.ChatDetail `json:"chat"`
	}
	d.get("/v1/chats/"+url.PathEscape(group), &cv)
	marks := map[string][3]bool{}
	for _, p := range cv.Chat.Participants {
		marks[p.ID] = [3]bool{p.Me, p.Operator, p.Contact != nil && *p.Contact}
	}
	if marks[ownLID] != [3]bool{true, false, false} || marks[samLID] != [3]bool{false, true, true} || marks[alexLID] != [3]bool{false, false, false} {
		t.Fatalf("participants: %+v", cv.Chat.Participants)
	}
	d.wantError("GET", "/v1/chats/"+url.PathEscape(group2), nil, 404, "not_found")
	d.wantError("GET", "/v1/chats/bogus", nil, 400, "bad_request")
	d.wantError("GET", "/v1/chats?x=1", nil, 400, "bad_request")
	d.fake.Emit(client.StateChange{State: "connecting", Reason: "connection lost"})
	e2 := d.wantError("GET", "/v1/chats/"+url.PathEscape(group), nil, 409, "not_connected")
	if e2["state"] != "connecting" {
		t.Fatalf("not_connected carries the state: %v", e2)
	}
}

func TestMessageRequests(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	first := d.emit(msg("one", mention))
	second := d.emit(msg("two", replyTo(first.ID, samLID, "one")))
	third := d.emit(msg("three", fromMe))

	ms := d.messages(group)
	if len(ms) != 3 || ms[0].ID != first.ID || ms[2].ID != third.ID {
		t.Fatalf("newest last: %+v", ms)
	}
	var page core.MessagesPage
	d.get("/v1/messages?chat="+group+"&limit=1&before="+third.ID, &page)
	if len(page.Messages) != 1 || page.Messages[0].ID != second.ID || !page.More {
		t.Fatalf("before/limit: %+v", page)
	}
	d.wantError("GET", "/v1/messages?chat="+group+"&before=NOPE", nil, 404, "not_found")
	d.wantError("GET", "/v1/messages?chat="+group2, nil, 404, "not_found")
	d.wantError("GET", "/v1/messages", nil, 400, "bad_request")
	d.wantError("GET", "/v1/messages?chat="+group+"&limit=0", nil, 400, "bad_request")
	d.wantError("GET", "/v1/messages?chat="+group+"&sort=asc", nil, 400, "bad_request")

	var one core.MessageResult
	d.get("/v1/messages/"+url.PathEscape(group)+"/"+second.ID, &one)
	if one.Message.ReplyTo == nil || !one.Message.ReplyTo.Kept || one.Message.KeptBy != "reply" {
		t.Fatalf("one: %+v", one)
	}
	d.get("/v1/messages/"+second.ID, &one) // a bare id
	d.wantError("GET", "/v1/messages/"+url.PathEscape(group)+"/NOPE", nil, 404, "not_found")
	d.wantError("GET", "/v1/messages/NOPE", nil, 404, "not_found")

	// forget: one message, then the chat.
	d.wantError("POST", "/v1/forget", `{"chat":"`+group+`","id":"`+second.ID+`","extra":1}`, 400, "bad_request")
	d.wantError("POST", "/v1/forget", `{}`, 400, "bad_request")
	var fr struct {
		Forgotten core.ForgetResult `json:"forgotten"`
	}
	code, body := d.do("POST", "/v1/forget", map[string]string{"chat": group, "id": second.ID})
	json.Unmarshal(body, &fr)
	if code != 200 || fr.Forgotten.Messages != 1 || fr.Forgotten.Events != 1 {
		t.Fatalf("forget message: %d %s", code, body)
	}
	if d.kept(group, second.ID) {
		t.Fatal("forgotten message still readable")
	}
	for _, ev := range d.events("?after=0") {
		if ev.Message != nil && ev.Message.ID == second.ID {
			t.Fatal("forgotten message's event still readable")
		}
	}
	d.wantError("POST", "/v1/forget", map[string]string{"chat": group, "id": second.ID}, 404, "not_found")
	code, body = d.do("POST", "/v1/forget", map[string]string{"chat": group})
	if code != 200 {
		t.Fatalf("forget chat: %d %s", code, body)
	}
	d.wantError("GET", "/v1/messages?chat="+group, nil, 404, "not_found")
	d.wantError("POST", "/v1/forget", map[string]string{"chat": group}, 404, "not_found")
}

func TestEventRequests(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	for i := 0; i < 5; i++ {
		d.emit(msg(fmt.Sprintf("m%d", i), mention))
	}
	d.emit(msg("elsewhere", mention, func(m *client.Message) { m.Chat = group2 }))

	all := d.events("?after=0")
	// One state event at start, then six messages.
	if len(all) != 7 || all[0].Kind != "state" {
		t.Fatalf("events: %d", len(all))
	}
	for i := 1; i < len(all); i++ {
		if all[i].Seq <= all[i-1].Seq {
			t.Fatal("seq not strictly increasing")
		}
	}
	after := d.events(fmt.Sprintf("?after=%d&limit=2", all[2].Seq))
	if len(after) != 2 || after[0].Seq != all[3].Seq || after[1].Seq != all[4].Seq {
		t.Fatalf("after/limit: %+v", after)
	}
	recent := d.events("?limit=2")
	if len(recent) != 2 || recent[1].Seq != all[6].Seq {
		t.Fatalf("without after, the most recent: %+v", recent)
	}
	if got := d.events("?after=0&chat=" + group2); len(got) != 1 || got[0].Chat.ID != group2 {
		t.Fatalf("chat filter: %+v", got)
	}
	if got := d.events("?after=0&kind=state"); len(got) != 1 {
		t.Fatalf("kind filter: %+v", got)
	}
	d.wantError("GET", "/v1/events?kind=bogus", nil, 400, "bad_request")
	d.wantError("GET", "/v1/events?after=-1", nil, 400, "bad_request")
	d.wantError("GET", "/v1/events?limit=5000", nil, 400, "bad_request")
	d.wantError("GET", "/v1/events?chat="+url.QueryEscape("120363000000000009@g.us"), nil, 404, "not_found")
	d.wantError("GET", "/v1/events?cursor=1", nil, 400, "bad_request")
	d.wantError("GET", "/v1/events?follow=yes", nil, 400, "bad_request")
}

func TestFollowStream(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.emit(msg("before", mention))
	last := d.events("?after=0")
	start := last[len(last)-1].Seq

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://x/v1/events?follow=1&after=%d", start-1), nil)
	resp, err := d.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatal(resp.Header)
	}
	lines := make(chan core.Event, 10)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			var ev core.Event
			json.Unmarshal(sc.Bytes(), &ev)
			lines <- ev
		}
		close(lines)
	}()
	recv := func() core.Event {
		select {
		case ev := <-lines:
			return ev
		case <-time.After(5 * time.Second):
			t.Fatal("no line")
		}
		return core.Event{}
	}
	if ev := recv(); ev.Seq != start {
		t.Fatalf("backlog: %+v", ev)
	}
	// Written after the request began: delivered as it happens, once.
	d.emit(msg("after", mention))
	ev := recv()
	if ev.Seq != start+1 || ev.Message == nil || ev.Message.Text != "after" {
		t.Fatalf("live: %+v", ev)
	}
	d.emit(msg("again", mention))
	if ev := recv(); ev.Seq != start+2 {
		t.Fatalf("no duplicate, in order: %+v", ev)
	}
	// The client disconnects; the stream ends cleanly and the daemon keeps serving.
	cancel()
	for range lines {
	}
	resp.Body.Close()
	var st core.Status
	d.get("/v1/status", &st)

	// Follow without after starts from now.
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	req2, _ := http.NewRequestWithContext(ctx2, "GET", "http://x/v1/events?follow=1", nil)
	resp2, err := d.http.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	go func() { time.Sleep(200 * time.Millisecond); d.emit(msg("fresh", mention)) }()
	line, err := bufio.NewReader(resp2.Body).ReadString('\n')
	if err != nil && err != io.EOF {
		t.Fatal(err)
	}
	var fresh core.Event
	json.Unmarshal([]byte(line), &fresh)
	if fresh.Message == nil || fresh.Message.Text != "fresh" {
		t.Fatalf("follow from now: %s", line)
	}
}

func TestListenRefusesLooseSocketDirectory(t *testing.T) {
	e := newEnv(t)
	l := e.init()
	if err := os.MkdirAll(l.RuntimeRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	os.Chmod(l.RuntimeRoot, 0o711)
	if _, err := Listen(l); err == nil || !strings.Contains(err.Error(), "socket directory") {
		t.Fatalf("got %v", err)
	}
	os.Chmod(l.RuntimeRoot, 0o700)
	// Something that is not a socket at the socket path is never removed.
	os.WriteFile(l.Socket(), []byte("x"), 0o600)
	if _, err := Listen(l); err == nil || !strings.Contains(err.Error(), "not a socket") {
		t.Fatalf("got %v", err)
	}
}
