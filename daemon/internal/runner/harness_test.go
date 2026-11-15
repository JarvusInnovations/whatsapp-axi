package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client/fake"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/core"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/paths"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/server"
)

// Invented ids, as in the specs.
const (
	account  = "example"
	group    = "120363000000000001@g.us"
	group2   = "120363000000000002@g.us"
	ownPN    = "15550100000@s.whatsapp.net"
	ownLID   = "100000000000000@lid"
	samLID   = "100000000000001@lid"
	samPN    = "15550100001@s.whatsapp.net"
	alexLID  = "100000000000002@lid"
	alexPN   = "15550100002@s.whatsapp.net"
	caseyPN  = "15550100003@s.whatsapp.net"
	caseyLID = "100000000000003@lid"
)

// clock is a settable time source.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) Bytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.b.Bytes()...)
}

// env is one test's private set of XDG directories.
type env struct {
	t    *testing.T
	vars map[string]string
	log  *syncBuffer
}

func newEnv(t *testing.T) *env {
	t.Helper()
	home := t.TempDir()
	// The runtime directory is kept short so the socket path fits sun_path.
	run, err := os.MkdirTemp("/tmp", "wa")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(run) })
	if err := os.Chmod(run, 0o700); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, log: &syncBuffer{}, vars: map[string]string{
		"HOME":            home,
		"XDG_CONFIG_HOME": filepath.Join(home, "config"),
		"XDG_STATE_HOME":  filepath.Join(home, "state"),
		"XDG_DATA_HOME":   filepath.Join(home, "data"),
		"XDG_RUNTIME_DIR": run,
	}}
	return e
}

func (e *env) getenv(k string) string { return e.vars[k] }

func (e *env) layout() paths.Layout {
	l, err := paths.Resolve(account, e.getenv)
	if err != nil {
		e.t.Fatal(err)
	}
	return l
}

func (e *env) init() paths.Layout {
	e.t.Helper()
	l, err := Init(account, e.getenv)
	if err != nil {
		e.t.Fatal(err)
	}
	return l
}

// daemon is a running daemon under test.
type daemon struct {
	t      *testing.T
	env    *env
	fake   *fake.Client
	acct   *core.Account
	clock  *clock
	cancel context.CancelFunc
	errc   chan error
	http   *http.Client
	mu     sync.Mutex
	// transcript holds every response body the test received.
	transcript [][]byte
}

type startOpts struct {
	state string
	own   client.Own
	peer  server.PeerUID
	clock *clock
	fake  *fake.Client
}

func (e *env) start(o startOpts) *daemon {
	e.t.Helper()
	if o.state == "" {
		o.state = "connected"
	}
	if o.own == (client.Own{}) {
		o.own = client.Own{PN: ownPN, LID: ownLID}
	}
	if o.clock == nil {
		o.clock = &clock{t: time.Date(2030, 1, 5, 14, 0, 0, 0, time.UTC)}
	}
	fc := o.fake
	if fc == nil {
		fc = fake.New(o.state, o.own)
	}
	d := &daemon{t: e.t, env: e, fake: fc, clock: o.clock, errc: make(chan error, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	d.cancel = cancel
	ready := make(chan *core.Account, 1)
	go func() {
		d.errc <- Run(ctx, Options{
			Account:   account,
			Getenv:    e.getenv,
			Version:   "0.0.0-test",
			Log:       e.log,
			Level:     slog.LevelDebug,
			NewClient: func(bool) client.Client { return fc },
			PeerUID:   o.peer,
			Now:       o.clock.Now,
			Ready:     func(a *core.Account) { ready <- a },
		})
	}()
	select {
	case d.acct = <-ready:
	case err := <-d.errc:
		e.t.Fatalf("daemon did not start: %v", err)
	case <-time.After(30 * time.Second):
		e.t.Fatal("daemon did not start in time")
	}
	sock := e.layout().Socket()
	d.http = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var dl net.Dialer
		return dl.DialContext(ctx, "unix", sock)
	}}}
	e.t.Cleanup(d.stop)
	return d
}

func (d *daemon) stop() {
	if d.cancel == nil {
		return
	}
	d.cancel()
	d.cancel = nil
	select {
	case err := <-d.errc:
		if err != nil {
			d.t.Errorf("daemon exited with %v", err)
		}
	case <-time.After(15 * time.Second):
		d.t.Error("daemon did not stop")
	}
	d.http.CloseIdleConnections()
}

// do sends a request and returns the status and body, recording the body.
func (d *daemon) do(method, path string, body any) (int, []byte) {
	d.t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		r = strings.NewReader(b)
	default:
		js, _ := json.Marshal(b)
		r = bytes.NewReader(js)
	}
	req, err := http.NewRequest(method, "http://whatsapp-axi"+path, r)
	if err != nil {
		d.t.Fatal(err)
	}
	resp, err := d.http.Do(req)
	if err != nil {
		d.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	d.mu.Lock()
	d.transcript = append(d.transcript, out)
	d.mu.Unlock()
	return resp.StatusCode, out
}

// get decodes a successful JSON response.
func (d *daemon) get(path string, v any) {
	d.t.Helper()
	code, body := d.do("GET", path, nil)
	if code != 200 {
		d.t.Fatalf("GET %s: %d %s", path, code, body)
	}
	if v != nil {
		if err := json.Unmarshal(body, v); err != nil {
			d.t.Fatalf("GET %s: %v", path, err)
		}
	}
}

// wantError asserts an error response with a code.
func (d *daemon) wantError(method, path string, body any, status int, code string) map[string]any {
	d.t.Helper()
	got, out := d.do(method, path, body)
	var e struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(out, &e); err != nil || got != status || e.Error["code"] != code {
		d.t.Fatalf("%s %s: got %d %s, want %d %s", method, path, got, out, status, code)
	}
	return e.Error
}

func (d *daemon) events(query string) []core.Event {
	d.t.Helper()
	var res struct {
		Events []core.Event `json:"events"`
	}
	d.get("/v1/events"+query, &res)
	return res.Events
}

func (d *daemon) patch(body string) {
	d.t.Helper()
	code, out := d.do("PATCH", "/v1/settings", body)
	if code != 200 {
		d.t.Fatalf("PATCH %s: %d %s", body, code, out)
	}
}

var seq int

func nextID() string {
	seq++
	return "3EB0" + strings.Repeat("0", 10) + string(rune('A'+seq/26%26)) + string(rune('A'+seq%26))
}

// msg builds a group message from Sam.
func msg(text string, mod ...func(*client.Message)) *client.Message {
	m := &client.Message{
		Kind: client.KindMessage, Chat: group, ChatType: client.ChatGroup, ID: nextID(),
		Sender: samLID, SenderAlt: samPN, Time: time.Date(2030, 1, 5, 14, 0, 0, 0, time.UTC), PushName: "Sam", Text: text,
	}
	for _, f := range mod {
		f(m)
	}
	return m
}

func mention(m *client.Message) { m.Mentions = []string{ownLID} }

func replyTo(id, sender, text string) func(*client.Message) {
	return func(m *client.Message) { m.ReplyTo = &client.Quoted{ID: id, Sender: sender, Text: text} }
}

func fromMe(m *client.Message) { m.FromMe = true; m.Sender = ownLID; m.SenderAlt = ownPN }

func (d *daemon) emit(m *client.Message) *client.Message {
	d.fake.Emit(m)
	return m
}

func (d *daemon) messages(chat string) []core.MessageView {
	d.t.Helper()
	var page core.MessagesPage
	d.get("/v1/messages?chat="+chat+"&limit=500", &page)
	return page.Messages
}

func (d *daemon) kept(chat, id string) bool {
	d.t.Helper()
	code, _ := d.do("GET", "/v1/messages/"+chat+"/"+id, nil)
	return code == 200
}

func (d *daemon) counter(chat string) int64 {
	d.t.Helper()
	var res struct {
		Chats []core.ChatSummary `json:"chats"`
	}
	d.get("/v1/chats", &res)
	for _, c := range res.Chats {
		if c.ID == chat {
			return c.Discarded
		}
	}
	return -1
}
