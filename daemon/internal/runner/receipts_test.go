package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client/fake"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/core"
)

// follow reads a stream's lines into ch until stop is called.
func (d *daemon) follow(path string, ch chan<- map[string]json.RawMessage) (stop func()) {
	d.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://x"+path, nil)
	resp, err := d.http.Do(req)
	if err != nil {
		cancel()
		d.t.Fatal(err)
	}
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			var l map[string]json.RawMessage
			if json.Unmarshal(sc.Bytes(), &l) == nil {
				select {
				case ch <- l:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return cancel
}

func (d *daemon) markRead(body any) core.MarkReadResult {
	d.t.Helper()
	code, out := d.do("POST", "/v1/mark-read", body)
	if code != 200 {
		d.t.Fatalf("mark-read %v: %d %s", body, code, out)
	}
	var r core.MarkReadResult
	if err := json.Unmarshal(out, &r); err != nil {
		d.t.Fatal(err)
	}
	return r
}

func TestReadReceiptsOnRead(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	m1 := d.emit(msg("@Example one", mention))
	if d.fake.MarkReadCount() != 0 {
		t.Fatal("under on-read, keeping a message sends no read receipt")
	}
	// Reading without mark_read marks nothing.
	d.events("?after=0")
	d.messages(group)
	if d.fake.MarkReadCount() != 0 {
		t.Fatal("a read without mark_read sent a receipt")
	}

	// A read with mark_read sends exactly one, and a second read sends none.
	var res struct {
		MarkRead core.MarkOutcome `json:"mark_read"`
	}
	d.get("/v1/events?after=0&mark_read=1", &res)
	calls := d.fake.MarkReadCalls()
	if res.MarkRead != (core.MarkOutcome{Marked: 1}) || len(calls) != 1 || calls[0].Chat != group || calls[0].Sender != samLID || len(calls[0].IDs) != 1 || calls[0].IDs[0] != m1.ID {
		t.Fatalf("marked %+v, calls %+v", res.MarkRead, calls)
	}
	d.get("/v1/events?after=0&mark_read=1", &res)
	if res.MarkRead != (core.MarkOutcome{AlreadyMarked: 1}) || d.fake.MarkReadCount() != 1 {
		t.Fatalf("a second mark sent another receipt: %+v", res.MarkRead)
	}
	if r := d.markRead(map[string]any{"chat": group, "id": m1.ID}); r.Marked != 0 || r.AlreadyMarked != 1 || r.ReadReceipts != "on-read" {
		t.Fatalf("explicit mark of a marked message: %+v", r)
	}

	// An explicit mark of one message sends one receipt; the account's own messages are never marked.
	m2 := d.emit(msg("@Example two", mention))
	d.emit(msg("mine", fromMe))
	if r := d.markRead(map[string]any{"id": m2.ID}); r.Marked != 1 || r.Chat != group {
		t.Fatalf("%+v", r)
	}
	if d.fake.MarkReadCount() != 2 {
		t.Fatal("explicit mark")
	}

	// messages with mark_read marks what it returned, in one receipt per sender.
	m3 := d.emit(msg("@Example three", mention))
	m4 := d.emit(msg("@Example four", mention))
	var page core.MessagesPage
	d.get("/v1/messages?chat="+group+"&mark_read=1", &page)
	calls = d.fake.MarkReadCalls()
	if page.MarkRead == nil || page.MarkRead.Marked != 2 || page.MarkRead.Failed != 0 || len(calls) != 3 || fmt.Sprint(calls[2].IDs) != fmt.Sprint([]string{m3.ID, m4.ID}) {
		t.Fatalf("marked %+v, calls %+v", page.MarkRead, calls)
	}

	// through marks every kept incoming message up to and including the one named.
	m5 := d.emit(msg("@Example five", mention))
	m6 := d.emit(msg("@Example six", mention))
	if r := d.markRead(map[string]any{"chat": group, "through": m5.ID}); r.Marked != 1 || r.AlreadyMarked != 4 {
		t.Fatalf("through: %+v", r)
	}
	if r := d.markRead(map[string]any{"chat": group, "through": m6.ID}); r.Marked != 1 || r.AlreadyMarked != 5 {
		t.Fatalf("through the latest: %+v", r)
	}
	if n := d.fake.MarkReadCount(); n != 5 {
		t.Fatalf("receipts: %d", n)
	}

	// Request errors.
	d.wantError("POST", "/v1/mark-read", map[string]any{"chat": group, "id": m1.ID, "through": m1.ID}, 400, "bad_request")
	d.wantError("POST", "/v1/mark-read", map[string]any{"chat": group}, 400, "bad_request")
	d.wantError("POST", "/v1/mark-read", map[string]any{"through": m1.ID}, 400, "bad_request")
	d.wantError("POST", "/v1/mark-read", map[string]any{"chat": group, "id": m1.ID, "extra": 1}, 400, "bad_request")
	d.wantError("POST", "/v1/mark-read", map[string]any{"chat": group, "id": "3EB0FFFFFFFFFFFFFF"}, 404, "not_found")
	d.wantError("GET", "/v1/events?mark_read=yes", nil, 400, "bad_request")
}

func TestReadReceiptsOnKeepAndOff(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.patch(`{"read_receipts":"on-keep"}`)
	m := d.emit(msg("@Example", mention))
	if d.fake.MarkReadCount() != 1 {
		t.Fatal("on-keep marks on keep")
	}
	d.get("/v1/events?after=0&mark_read=1", nil)
	if r := d.markRead(map[string]any{"chat": group, "id": m.ID}); r.Marked != 0 || r.AlreadyMarked != 1 || d.fake.MarkReadCount() != 1 {
		t.Fatalf("a message marked on keep is not marked again: %+v", r)
	}

	d.patch(`{"read_receipts":"off"}`)
	m2 := d.emit(msg("@Example again", mention))
	// Off sends nothing, and says so: the unmarked message is failed with reason off.
	var res struct {
		Events   []core.Event     `json:"events"`
		MarkRead core.MarkOutcome `json:"mark_read"`
	}
	d.get("/v1/events?after=0&mark_read=1", &res)
	if len(res.Events) == 0 || res.MarkRead != (core.MarkOutcome{AlreadyMarked: 1, Failed: 1, Reason: "off"}) {
		t.Fatalf("events under off: %+v", res.MarkRead)
	}
	var page core.MessagesPage
	d.get("/v1/messages?chat="+group+"&mark_read=1", &page)
	if len(page.Messages) != 2 || page.MarkRead == nil || page.MarkRead.Failed != 1 || page.MarkRead.Reason != "off" {
		t.Fatalf("messages under off: %+v", page.MarkRead)
	}
	if r := d.markRead(map[string]any{"chat": group, "id": m2.ID}); r.Marked != 0 || r.Failed != 1 || r.Reason != "off" || r.ReadReceipts != "off" {
		t.Fatalf("off is not reported as done: %+v", r)
	}
	// A message already marked is not a failure under off.
	if r := d.markRead(map[string]any{"chat": group, "id": m.ID}); r.Failed != 0 || r.Reason != "" || r.AlreadyMarked != 1 {
		t.Fatalf("already marked under off: %+v", r)
	}
	if d.fake.MarkReadCount() != 1 {
		t.Fatal("off never sends a read receipt")
	}
}

func TestMarkReadOffline(t *testing.T) {
	e := newEnv(t)
	e.init()
	fc := fake.New("connected", client.Own{PN: ownPN, LID: ownLID})
	d := e.start(startOpts{fake: fc})
	m := d.emit(msg("@Example", mention))
	fc.Emit(client.StateChange{State: "connecting", Reason: "connection lost"})
	// Reading still works offline and leaves the message unmarked for later.
	var res struct {
		Events   []core.Event     `json:"events"`
		MarkRead core.MarkOutcome `json:"mark_read"`
	}
	d.get("/v1/events?after=0&mark_read=1", &res)
	if len(res.Events) == 0 || res.MarkRead != (core.MarkOutcome{Failed: 1, Reason: "not_connected"}) {
		t.Fatalf("%+v", res)
	}
	if r := d.markRead(map[string]any{"chat": group, "id": m.ID}); r.Marked != 0 || r.Failed != 1 || r.Reason != "not_connected" {
		t.Fatalf("an offline mark is not reported as done: %+v", r)
	}
	fc.Emit(client.StateChange{State: "connected"})
	if r := d.markRead(map[string]any{"chat": group, "id": m.ID}); r.Marked != 1 {
		t.Fatalf("marked once connected: %+v", r)
	}
}

func TestMarkReadPartialAndFollow(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.emit(msg("@Example from sam", mention))
	m2 := d.emit(msg("@Example from alex", mention, func(m *client.Message) { m.Sender, m.SenderAlt, m.PushName = alexLID, alexPN, "Alex" }))
	// WhatsApp refuses the receipt for one sender: the other is still sent, and the answer says
	// how many were sent and how many were not.
	d.fake.SetMarkReadErr(func(_, sender string) error {
		if sender == alexLID {
			return fmt.Errorf("refused")
		}
		return nil
	})
	r := d.markRead(map[string]any{"chat": group, "through": m2.ID})
	if r.Marked != 1 || r.Failed != 1 || r.Reason != "whatsapp_error" {
		t.Fatalf("partial mark: %+v", r)
	}

	// A follow stream with mark_read says a failed mark on an error line and keeps streaming.
	d.fake.SetMarkReadErr(func(string, string) error { return fmt.Errorf("refused") })
	lines := make(chan map[string]json.RawMessage, 16)
	stop := d.follow("/v1/events?after=0&follow=1&mark_read=1&chat="+group, lines)
	defer stop()
	sawErr := false
	deadline := time.After(5 * time.Second)
	for !sawErr {
		select {
		case l := <-lines:
			if raw, ok := l["error"]; ok {
				var mf core.MarkFailed
				if err := json.Unmarshal(raw, &mf); err != nil || mf.Code != "mark_failed" || mf.Failed != 1 || mf.Reason != "whatsapp_error" {
					t.Fatalf("error line %s", raw)
				}
				sawErr = true
			}
		case <-deadline:
			t.Fatal("no error line")
		}
	}
	d.fake.SetMarkReadErr(nil)
	m3 := d.emit(msg("@Example later", mention))
	deadline = time.After(5 * time.Second)
	for {
		select {
		case l := <-lines:
			if raw, ok := l["message"]; ok && strings.Contains(string(raw), m3.ID) {
				return
			}
		case <-deadline:
			t.Fatal("the stream stopped after a failed mark")
		}
	}
}

func TestTyping(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.emit(msg("@Example", mention))
	typing := func(on bool) core.TypingResult {
		t.Helper()
		code, out := d.do("POST", "/v1/typing", map[string]any{"chat": group, "on": on})
		if code != 200 {
			t.Fatalf("typing %v: %d %s", on, code, out)
		}
		var r core.TypingResult
		_ = json.Unmarshal(out, &r)
		return r
	}
	want := func(n int, last bool) {
		t.Helper()
		calls := d.fake.Typing()
		if len(calls) != n || calls[n-1].Chat != group || calls[n-1].On != last {
			t.Fatalf("typing calls %+v", calls)
		}
	}

	// A send to the chat clears it.
	if r := typing(true); !r.Typing || !r.Changed {
		t.Fatalf("%+v", r)
	}
	want(1, true)
	if code, out := d.do("POST", "/v1/send", map[string]any{"chat": group, "text": "on it"}); code != 200 {
		t.Fatalf("send: %d %s", code, out)
	}
	want(2, false)

	// A stop request clears it; a second stop is a no-op.
	typing(true)
	if r := typing(false); r.Typing || !r.Changed {
		t.Fatalf("%+v", r)
	}
	want(4, false)
	if r := typing(false); r.Changed {
		t.Fatal("stopping when not typing is a no-op")
	}
	want(4, false)

	// The limit clears it by itself.
	old := core.TypingLimit
	core.TypingLimit = 50 * time.Millisecond
	defer func() { core.TypingLimit = old }()
	typing(true)
	waitFor(t, func() bool { return len(d.fake.Typing()) == 6 })
	want(6, false)
	// A send after the limit has nothing to clear.
	d.do("POST", "/v1/send", map[string]any{"chat": group, "text": "done"})
	time.Sleep(20 * time.Millisecond)
	want(6, false)

	// A stop that fails leaves the indicator on, so it can be retried.
	core.TypingLimit = old
	typing(true)
	n := len(d.fake.Typing())
	d.fake.SetTypingErr(fmt.Errorf("refused"))
	d.wantError("POST", "/v1/typing", map[string]any{"chat": group, "on": false}, 502, "whatsapp_error")
	d.fake.SetTypingErr(nil)
	if r := typing(false); !r.Changed {
		t.Fatal("the retried stop was a no-op")
	}
	want(n+1, false)

	d.wantError("POST", "/v1/typing", map[string]any{"chat": group}, 400, "bad_request")
	d.fake.Emit(client.StateChange{State: "connecting"})
	d.wantError("POST", "/v1/typing", map[string]any{"chat": group, "on": true}, 409, "not_connected")
}
