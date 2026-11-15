package runner

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client/fake"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/core"
)

// linkReader opens a link stream and returns its lines as they arrive.
func (d *daemon) linkStream(ctx context.Context, body string) (int, <-chan core.LinkLine, []byte) {
	d.t.Helper()
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://x/v1/link", strings.NewReader(body))
	resp, err := d.http.Do(req)
	if err != nil {
		d.t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		defer resp.Body.Close()
		var b [4096]byte
		n, _ := resp.Body.Read(b[:])
		return resp.StatusCode, nil, b[:n]
	}
	if resp.Header.Get("Content-Type") != "application/x-ndjson" {
		d.t.Fatal(resp.Header)
	}
	lines := make(chan core.LinkLine, 16)
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			d.mu.Lock()
			d.transcript = append(d.transcript, append([]byte(nil), sc.Bytes()...))
			d.mu.Unlock()
			var l core.LinkLine
			json.Unmarshal(sc.Bytes(), &l)
			lines <- l
		}
		close(lines)
	}()
	return 200, lines, nil
}

func recvLine(t *testing.T, lines <-chan core.LinkLine) core.LinkLine {
	t.Helper()
	select {
	case l, ok := <-lines:
		if !ok {
			t.Fatal("the stream ended")
		}
		return l
	case <-time.After(10 * time.Second):
		t.Fatal("no line")
	}
	return core.LinkLine{}
}

func (d *daemon) state() core.Status {
	d.t.Helper()
	var st core.Status
	d.get("/v1/status", &st)
	return st
}

func unlinkedFake() *fake.Client { return fake.New("unlinked", client.Own{}) }

func TestLinkByPairingCode(t *testing.T) {
	e := newEnv(t)
	e.init()
	fc := unlinkedFake()
	release := make(chan struct{})
	fc.Linking = fake.LinkPlan{Codes: []string{"ABCD-EFGH"}, PairAs: ownPN, PairLID: ownLID, Wait: release}
	d := e.start(startOpts{fake: fc})
	if st := d.state(); st.State != "unlinked" {
		t.Fatal(st.State)
	}
	code, lines, _ := d.linkStream(context.Background(), `{"phone":"+15550100000"}`)
	if code != 200 {
		t.Fatal(code)
	}
	// The code is streamed before the link completes.
	if l := recvLine(t, lines); l.Code != "ABCD-EFGH" || l.Result != nil {
		t.Fatalf("%+v", l)
	}
	if st := d.state(); st.State != "linking" {
		t.Fatalf("state while linking: %s", st.State)
	}
	// A second attempt while one runs.
	d.wantError("POST", "/v1/link", `{"qr":true}`, 409, "link_in_progress")
	close(release)
	l := recvLine(t, lines)
	if l.Result == nil || !l.Result.Linked || l.Result.State != "connected" || l.Result.Me == nil || l.Result.Me.ID != ownLID {
		t.Fatalf("result: %+v", l.Result)
	}
	if _, ok := <-lines; ok {
		t.Fatal("the stream continues after the result")
	}
	if st := d.state(); st.State != "connected" || st.Me == nil {
		t.Fatalf("after linking: %+v", st)
	}
	if fc.LinkRequests[0].Phone != "15550100000" {
		t.Fatalf("%+v", fc.LinkRequests)
	}
	// Presence is announced once after the connect (presence defaults to true).
	waitFor(t, func() bool { return fc.PresenceCount() == 1 })
	// state events: linking, then connected.
	var kinds []string
	for _, ev := range d.events("?kind=state&limit=10") {
		kinds = append(kinds, ev.State)
	}
	if strings.Join(kinds, ",") != "unlinked,linking,connected" {
		t.Fatalf("state events %v", kinds)
	}
	// Linking an account that is linked is refused.
	d.wantError("POST", "/v1/link", `{"phone":"+15550100000"}`, 400, "bad_request")
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not reached")
}

func TestLinkByQR(t *testing.T) {
	e := newEnv(t)
	e.init()
	fc := unlinkedFake()
	fc.Linking = fake.LinkPlan{QRs: []string{"2@first", "2@second"}, PairAs: ownPN}
	d := e.start(startOpts{fake: fc})
	_, lines, _ := d.linkStream(context.Background(), `{"qr":true}`)
	if l := recvLine(t, lines); l.QR != "2@first" {
		t.Fatalf("%+v", l)
	}
	if l := recvLine(t, lines); l.QR != "2@second" {
		t.Fatalf("%+v", l)
	}
	if l := recvLine(t, lines); l.Result == nil || !l.Result.Linked {
		t.Fatalf("%+v", l)
	}
}

func TestLinkWithADifferentNumberIsRefused(t *testing.T) {
	e := newEnv(t)
	e.init()
	fc := unlinkedFake()
	fc.Linking = fake.LinkPlan{Codes: []string{"ABCD-EFGH"}, PairAs: "15550100099@s.whatsapp.net"}
	d := e.start(startOpts{fake: fc})
	_, lines, _ := d.linkStream(context.Background(), `{"phone":"+15550100000"}`)
	recvLine(t, lines)
	l := recvLine(t, lines)
	if l.Result == nil || l.Result.Linked || l.Result.Error == nil || l.Result.Error.Code != "wrong_number" || l.Result.State != "unlinked" {
		t.Fatalf("%+v", l.Result)
	}
	if st := d.state(); st.State != "unlinked" || st.Me != nil {
		t.Fatalf("%+v", st)
	}
}

func TestLinkWindowTimesOut(t *testing.T) {
	e := newEnv(t)
	e.init()
	fc := unlinkedFake()
	fc.Linking = fake.LinkPlan{Codes: []string{"ABCD-EFGH"}} // nobody completes it
	d := e.start(startOpts{fake: fc})
	_, lines, _ := d.linkStream(context.Background(), `{"phone":"+15550100000"}`)
	recvLine(t, lines)
	l := recvLine(t, lines)
	if l.Result == nil || l.Result.Error == nil || l.Result.Error.Code != "link_timeout" || l.Result.State != "unlinked" {
		t.Fatalf("%+v", l.Result)
	}
	// The daemon's own bound on the window, when the client never ends the attempt.
	old := core.LinkWindow
	core.LinkWindow = 200 * time.Millisecond
	defer func() { core.LinkWindow = old }()
	fc.Linking = fake.LinkPlan{Codes: []string{"ABCD-EFGH"}, Wait: make(chan struct{})}
	_, lines, _ = d.linkStream(context.Background(), `{"phone":"+15550100000"}`)
	recvLine(t, lines)
	l = recvLine(t, lines)
	if l.Result == nil || l.Result.Error == nil || l.Result.Error.Code != "link_timeout" {
		t.Fatalf("%+v", l.Result)
	}
	if st := d.state(); st.State != "unlinked" {
		t.Fatal(st.State)
	}
}

func TestLinkAbandonedWhenTheClientGoes(t *testing.T) {
	e := newEnv(t)
	e.init()
	fc := unlinkedFake()
	fc.Linking = fake.LinkPlan{Codes: []string{"ABCD-EFGH"}, Wait: make(chan struct{})}
	d := e.start(startOpts{fake: fc})
	ctx, cancel := context.WithCancel(context.Background())
	_, lines, _ := d.linkStream(ctx, `{"phone":"+15550100000"}`)
	recvLine(t, lines)
	cancel()
	waitFor(t, func() bool { return d.state().State == "unlinked" })
	// A new attempt may start.
	fc.Linking = fake.LinkPlan{QRs: []string{"2@x"}, PairAs: ownPN}
	_, lines, _ = d.linkStream(context.Background(), `{"qr":true}`)
	recvLine(t, lines)
	if l := recvLine(t, lines); l.Result == nil || !l.Result.Linked {
		t.Fatalf("%+v", l)
	}
}

func TestLinkBadRequests(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{fake: unlinkedFake()})
	for _, body := range []string{`{}`, `{"phone":"15550100000"}`, `{"phone":"+1555","qr":true}`, `{"qr":false}`, `{"phone":"+15550100000","x":1}`, `nope`} {
		d.wantError("POST", "/v1/link", body, 400, "bad_request")
	}
	d.wantError("POST", "/v1/link?x=1", `{"qr":true}`, 400, "bad_request")
}

func TestLinkAgainAfterLoggedOut(t *testing.T) {
	e := newEnv(t)
	e.init()
	fc := fake.New("connected", client.Own{PN: ownPN, LID: ownLID})
	d := e.start(startOpts{fake: fc})
	fc.Emit(client.StateChange{State: "logged_out", Reason: "logged out (401)"})
	fc.SetOwn(client.Own{})
	fc.Linking = fake.LinkPlan{Codes: []string{"ABCD-EFGH"}, PairAs: ownPN}
	_, lines, _ := d.linkStream(context.Background(), `{"phone":"+15550100000"}`)
	recvLine(t, lines)
	if l := recvLine(t, lines); l.Result == nil || !l.Result.Linked || l.Result.State != "connected" {
		t.Fatalf("%+v", l)
	}
}

func TestLogout(t *testing.T) {
	e := newEnv(t)
	e.init()
	fc := fake.New("connected", client.Own{PN: ownPN, LID: ownLID})
	d := e.start(startOpts{fake: fc})
	kept := d.emit(msg("@Example kept", mention))
	d.wantError("POST", "/v1/logout", `{"x":1}`, 400, "bad_request")
	code, body := d.do("POST", "/v1/logout", nil)
	if code != 200 || !strings.Contains(string(body), `"logged_out":true`) {
		t.Fatalf("%d %s", code, body)
	}
	if !fc.LoggedOut {
		t.Fatal("the client was not told to log out")
	}
	if st := d.state(); st.State != "unlinked" || st.Me != nil {
		t.Fatalf("%+v", st)
	}
	// store.db is not deleted.
	if !d.kept(group, kept.ID) {
		t.Fatal("logout deleted kept content")
	}
	// Again: there is no session.
	d.wantError("POST", "/v1/logout", `{}`, 409, "not_linked")
}

func TestLogoutNeedsAConnection(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{state: "connecting"})
	er := d.wantError("POST", "/v1/logout", nil, 409, "not_connected")
	if er["state"] != "connecting" {
		t.Fatalf("%+v", er)
	}
}

// TestStoppedStatesNeitherRetryNorExit covers daemon.md "States" and security.md rule 10.
func TestStoppedStatesNeitherRetryNorExit(t *testing.T) {
	for _, st := range []string{"logged_out", "outdated", "suspended"} {
		t.Run(st, func(t *testing.T) {
			e := newEnv(t)
			e.init()
			fc := fake.New("connected", client.Own{PN: ownPN, LID: ownLID})
			d := e.start(startOpts{fake: fc})
			fc.Emit(client.StateChange{State: st, Reason: "reason " + st})
			time.Sleep(100 * time.Millisecond)
			s := d.state()
			if s.State != st || s.Reason != "reason "+st {
				t.Fatalf("%+v", s)
			}
			// The daemon still answers, has not exited, and made no attempt to link or reconnect.
			select {
			case err := <-d.errc:
				t.Fatalf("the daemon exited: %v", err)
			default:
			}
			if len(fc.LinkRequests) != 0 {
				t.Fatal("a stopped state started a link")
			}
			evs := d.events("?kind=state")
			if last := evs[len(evs)-1]; last.State != st || last.Reason != "reason "+st {
				t.Fatalf("%+v", last)
			}
			if st != "logged_out" {
				d.wantError("POST", "/v1/link", `{"qr":true}`, 400, "bad_request")
			}
		})
	}
}

func TestPresenceSetting(t *testing.T) {
	e := newEnv(t)
	e.init()
	fc := fake.New("connecting", client.Own{PN: ownPN, LID: ownLID})
	d := e.start(startOpts{fake: fc})
	fc.Emit(client.StateChange{State: "connected"})
	waitFor(t, func() bool { return fc.PresenceCount() == 1 })
	// Every connect announces once.
	fc.Emit(client.StateChange{State: "connecting", Reason: "connection lost"})
	fc.Emit(client.StateChange{State: "connected"})
	waitFor(t, func() bool { return fc.PresenceCount() == 2 })
	d.patch(`{"presence":false}`)
	fc.Emit(client.StateChange{State: "connecting"})
	fc.Emit(client.StateChange{State: "connected"})
	time.Sleep(100 * time.Millisecond)
	if n := fc.PresenceCount(); n != 2 {
		t.Fatalf("presence off still announced: %d", n)
	}
}

// Right after linking or starting, the library cannot announce presence until the account's own
// name has synced from the phone. The daemon notes that once per connect, without a warning, and
// announces when the name arrives.
func TestPresenceWaitsForPushName(t *testing.T) {
	e := newEnv(t)
	e.init()
	fc := fake.New("connecting", client.Own{PN: ownPN, LID: ownLID})
	fc.NoPushName = true
	e.start(startOpts{fake: fc})
	fc.Emit(client.StateChange{State: "connected"})
	waitFor(t, func() bool { return bytes.Contains(e.log.Bytes(), []byte("presence waits")) })
	// A sync that brings no name yet fails again, quietly.
	fc.Emit(client.PushNameReady{})
	time.Sleep(50 * time.Millisecond)
	if fc.PresenceCount() != 0 {
		t.Fatal("announced without a name")
	}
	fc.SetPushName(true)
	fc.Emit(client.PushNameReady{})
	waitFor(t, func() bool { return fc.PresenceCount() == 1 })
	// Once announced, a later sync does not announce again.
	fc.Emit(client.PushNameReady{})
	time.Sleep(50 * time.Millisecond)
	if n := fc.PresenceCount(); n != 1 {
		t.Fatalf("announced %d times in one connect", n)
	}
	log := e.log.Bytes()
	if n := bytes.Count(log, []byte("presence waits")); n != 1 {
		t.Fatalf("the wait is noted once per connect, got %d", n)
	}
	if bytes.Contains(log, []byte("announcing presence failed")) || bytes.Contains(log, []byte("level=WARN")) {
		t.Fatalf("the expected first failure is not a warning:\n%s", log)
	}
}
