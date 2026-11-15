package runner

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client/fake"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/core"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/sqlite"
)

func (d *daemon) post(path string, body any) (int, map[string]any) {
	d.t.Helper()
	code, out := d.do("POST", path, body)
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	return code, m
}

func (d *daemon) send(body any) core.SentMessage {
	d.t.Helper()
	code, out := d.do("POST", "/v1/send", body)
	if code != 200 {
		d.t.Fatalf("send: %d %s", code, out)
	}
	var s core.SentMessage
	json.Unmarshal(out, &s)
	return s
}

func (d *daemon) message(chat, id string) core.MessageView {
	d.t.Helper()
	var r core.MessageResult
	d.get("/v1/messages/"+url.PathEscape(chat)+"/"+id, &r)
	return r.Message
}

// keptGroup starts a daemon with a group that has kept activity and known members.
func keptGroup(t *testing.T) (*daemon, *client.Message) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.fake.SetGroup(group, client.GroupInfo{Name: "Example group", Participants: []client.Participant{
		{JID: ownLID, LID: ownLID, PN: ownPN}, {JID: samLID, LID: samLID, PN: samPN}, {JID: alexLID, LID: alexLID, PN: alexPN},
	}})
	m := d.emit(msg("@Example the report is attached", mention))
	return d, m
}

func TestSendRecordsBeforeTheClientReturns(t *testing.T) {
	d, _ := keptGroup(t)
	var during core.MessageView
	var replyID string
	d.fake.BeforeSend = func(m client.OutMessage) {
		// Mid-send, the message is already in store.db by its id...
		during = d.message(group, m.ID)
		// ...so a reply to it that arrives now is kept by the reply rule.
		replyID = d.emit(msg("thanks", replyTo(m.ID, ownLID, "on it"))).ID
	}
	s := d.send(map[string]any{"chat": group, "text": "on it"})
	if during.ID != s.ID || during.Status != "pending" || !during.From.Me || during.KeptBy != "own" {
		t.Fatalf("mid-send: %+v", during)
	}
	after := d.message(group, s.ID)
	if after.Status != "" || after.Text != "on it" {
		t.Fatalf("after: %+v", after)
	}
	if r := d.message(group, replyID); r.KeptBy != "reply" {
		t.Fatalf("reply kept_by %q", r.KeptBy)
	}
	if s.Chat != group || s.T != "2030-01-05T15:00:00Z" {
		t.Fatalf("%+v", s)
	}
	// The own message has its event, and writes no wake line (not tested here: keep_test covers it).
	evs := d.events("?kind=message&limit=10")
	found := false
	for _, ev := range evs {
		if ev.Message != nil && ev.Message.ID == s.ID && ev.Message.KeptBy == "own" {
			found = true
		}
	}
	if !found {
		t.Fatal("no message event for the sent message")
	}
	if sent := d.fake.Sent(); len(sent) != 1 || sent[0].Text != "on it" || sent[0].Chat != group {
		t.Fatalf("%+v", sent)
	}
}

func TestFailedSendIsMarkedAndNotRetried(t *testing.T) {
	d, _ := keptGroup(t)
	d.fake.SendErr = errors.New("server said no")
	code, body := d.post("/v1/send", map[string]any{"chat": group, "text": "hello"})
	e := body["error"].(map[string]any)
	if code != 502 || e["code"] != "whatsapp_error" || strings.Contains(fmt.Sprint(e["message"]), "server said no") {
		t.Fatalf("%d %+v", code, body)
	}
	time.Sleep(100 * time.Millisecond)
	if n := d.fake.AttemptCount(); n != 1 {
		t.Fatalf("attempts %d", n)
	}
	msgs := d.messages(group)
	last := msgs[len(msgs)-1]
	if last.Status != "failed" || last.Text != "hello" {
		t.Fatalf("%+v", last)
	}
	for _, ev := range d.events("?kind=message&limit=10") {
		if ev.Message != nil && ev.Message.ID == last.ID {
			t.Fatal("a failed send has no message event")
		}
	}
}

func TestConcurrentSendsReachTheClientOneAtATime(t *testing.T) {
	d, _ := keptGroup(t)
	d.fake.BeforeSend = func(client.OutMessage) { time.Sleep(150 * time.Millisecond) }
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			d.send(map[string]any{"chat": group, "text": fmt.Sprintf("parallel %d", i)})
		}(i)
	}
	wg.Wait()
	if d.fake.MaxInFlight != 1 || len(d.fake.Sent()) != 3 {
		t.Fatalf("max in flight %d, sent %d", d.fake.MaxInFlight, len(d.fake.Sent()))
	}
}

func TestReplyIsBuiltFromTheKeptCopy(t *testing.T) {
	d, parent := keptGroup(t)
	keys := []byte("PARENTKEYS-0001")
	withMedia := d.emit(msg("@Example see file", mention, func(m *client.Message) {
		m.Text = ""
		m.Media = &client.Media{Type: "document", MIME: "application/pdf", Name: "a.pdf", Caption: "see file", Keys: keys}
	}))
	s := d.send(map[string]any{"chat": group, "text": "done", "reply_to": parent.ID})
	q := d.fake.Sent()[0].Reply
	if q == nil || q.ID != parent.ID || q.Sender != samLID || q.Text != "@Example the report is attached" || q.Media != nil {
		t.Fatalf("quote %+v", q)
	}
	if v := d.message(group, s.ID); v.ReplyTo == nil || v.ReplyTo.ID != parent.ID || !v.ReplyTo.Kept {
		t.Fatalf("%+v", v.ReplyTo)
	}
	d.send(map[string]any{"chat": group, "text": "got it", "reply_to": withMedia.ID})
	q = d.fake.Sent()[1].Reply
	if q.Text != "see file" || q.Media != nil {
		t.Fatalf("caption quote %+v", q)
	}
	b, _ := json.Marshal(d.fake.Sent())
	if bytes.Contains(b, keys) || bytes.Contains(b, []byte(base64.StdEncoding.EncodeToString(keys))) {
		t.Fatal("the quote carries key material")
	}
	d.wantError("POST", "/v1/send", map[string]any{"chat": group, "text": "x", "reply_to": "3EB0NOPE"}, 404, "not_found")
	if len(d.fake.Sent()) != 2 {
		t.Fatal("a refused reply was sent")
	}
}

func TestMentions(t *testing.T) {
	d, _ := keptGroup(t)
	d.send(map[string]any{"chat": group, "text": "please look", "mentions": []string{"+15550100001", alexPN}})
	m := d.fake.Sent()[0]
	if strings.Join(m.Mentions, ",") != samLID+","+alexLID || m.Text != "please look @100000000000001 @100000000000002" {
		t.Fatalf("%+v", m)
	}
	d.send(map[string]any{"chat": group, "text": "hi @100000000000001", "mentions": []string{samLID}})
	if m := d.fake.Sent()[1]; m.Text != "hi @100000000000001" {
		t.Fatalf("text changed: %q", m.Text)
	}
	d.wantError("POST", "/v1/send", map[string]any{"chat": group, "text": "x", "mentions": []string{caseyPN}}, 400, "bad_request")
	d.wantError("POST", "/v1/send", map[string]any{"chat": group, "text": "x", "mentions": []string{"nobody"}}, 400, "bad_request")
}

func TestSendRequestsValidated(t *testing.T) {
	d, _ := keptGroup(t)
	for _, body := range []any{`{}`, `{"chat":"` + group + `"}`, `{"chat":"` + group + `","text":"  "}`, `{"chat":"` + group + `","text":"x","y":1}`, `{"chat":"bogus","text":"x"}`} {
		d.wantError("POST", "/v1/send", body, 400, "bad_request")
	}
	for _, body := range []any{`{"chat":"` + group + `","path":"relative.pdf"}`, `{"chat":"` + group + `","path":"/nonexistent/x.pdf"}`, `{"chat":"` + group + `","path":"/tmp","as":"pdf"}`} {
		d.wantError("POST", "/v1/send-file", body, 400, "bad_request")
	}
	if len(d.fake.Sent()) != 0 {
		t.Fatal("something was sent")
	}
}

func writeFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func pngBytes(t *testing.T, w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 128, 255})
		}
	}
	var b bytes.Buffer
	png.Encode(&b, img)
	return b.Bytes()
}

func TestSendFiles(t *testing.T) {
	d, parent := keptGroup(t)
	d.fake.UploadKeys = []byte("UPLOADKEYS-0001")
	pdf := writeFile(t, "report.pdf", []byte("%PDF-1.4 test document"))
	code, out := d.do("POST", "/v1/send-file", map[string]any{"chat": group, "path": pdf, "caption": "the report", "reply_to": parent.ID})
	if code != 200 {
		t.Fatalf("%d %s", code, out)
	}
	f := d.fake.Sent()[0]
	if f.File == nil || f.File.Type != "document" || f.File.MIME != "application/pdf" || f.File.Name != "report.pdf" || f.Text != "the report" || f.File.Thumbnail != nil || f.Reply == nil {
		t.Fatalf("%+v %+v", f, f.File)
	}
	var s core.SentMessage
	json.Unmarshal(out, &s)
	v := d.message(group, s.ID)
	if v.Media == nil || v.Media.Name != "report.pdf" || v.Media.MIME != "application/pdf" || v.Text != "the report" {
		t.Fatalf("%+v", v)
	}

	img := writeFile(t, "photo.png", pngBytes(t, 300, 200))
	d.send2File(map[string]any{"chat": group, "path": img})
	f = d.fake.Sent()[1]
	if f.File.Type != "image" || f.File.MIME != "image/png" || len(f.File.Thumbnail) == 0 || f.File.Width != 300 || f.File.Height != 200 {
		t.Fatalf("%+v", f.File.Type)
	}
	if _, _, err := image.Decode(bytes.NewReader(f.File.Thumbnail)); err != nil {
		t.Fatalf("preview is not an image: %v", err)
	}
	// A file without an extension whose content is a PDF, forced to a document; unknown bytes are
	// the generic type.
	noext := writeFile(t, "blob", []byte("%PDF-1.4 x"))
	d.send2File(map[string]any{"chat": group, "path": noext})
	if f := d.fake.Sent()[2]; f.File.MIME != "application/pdf" || f.File.Type != "document" {
		t.Fatalf("%+v", f.File.MIME)
	}
	bin := writeFile(t, "data", []byte{0, 1, 2, 3, 0xff, 0xfe})
	d.send2File(map[string]any{"chat": group, "path": bin})
	if f := d.fake.Sent()[3]; f.File.MIME != "application/octet-stream" {
		t.Fatalf("%+v", f.File.MIME)
	}
	d.send2File(map[string]any{"chat": group, "path": img, "as": "document"})
	if f := d.fake.Sent()[4]; f.File.Type != "document" || f.File.Name != "photo.png" {
		t.Fatalf("%+v", f.File)
	}
	// Audio cannot carry a caption; the size limit holds.
	ogg := writeFile(t, "note.ogg", []byte("OggS fake"))
	d.wantError("POST", "/v1/send-file", map[string]any{"chat": group, "path": ogg, "caption": "x"}, 400, "bad_request")
	d.patch(`{"send":{"max_file_mb":1}}`)
	big := writeFile(t, "big.pdf", make([]byte, 1<<20+1))
	d.wantError("POST", "/v1/send-file", map[string]any{"chat": group, "path": big}, 400, "bad_request")
	if len(d.fake.Sent()) != 5 {
		t.Fatal("a refused file was sent")
	}
	// The upload's key material is stored for downloads, and never returned.
	for _, b := range d.transcript {
		if bytes.Contains(b, d.fake.UploadKeys) || bytes.Contains(b, []byte(base64.StdEncoding.EncodeToString(d.fake.UploadKeys))) {
			t.Fatalf("key material in a response: %s", b)
		}
	}
}

func (d *daemon) send2File(body any) {
	d.t.Helper()
	code, out := d.do("POST", "/v1/send-file", body)
	if code != 200 {
		d.t.Fatalf("send-file: %d %s", code, out)
	}
}

func TestDownload(t *testing.T) {
	d, _ := keptGroup(t)
	keys := []byte(`{"direct_path":"/v/t62.7119-24/x?ccb=11-4&oh=TOKEN&oe=1"}`)
	m := d.emit(msg("@Example doc", mention, func(mm *client.Message) {
		mm.Media = &client.Media{Type: "document", MIME: "application/pdf", Name: "../../evil name.pdf", Size: 9, Keys: keys}
	}))
	d.fake.Files = map[string][]byte{string(keys): []byte("%PDF file")}
	var r core.DownloadResult
	code, out := d.do("POST", "/v1/download", map[string]any{"chat": group, "id": m.ID})
	if code != 200 {
		t.Fatalf("%d %s", code, out)
	}
	json.Unmarshal(out, &r)
	media := d.env.layout().MediaDir()
	if filepath.Dir(r.Path) != media || strings.Contains(r.Path, "evil") || !strings.HasSuffix(r.Path, ".pdf") || r.Name != "../../evil name.pdf" || r.Existing {
		t.Fatalf("%+v", r)
	}
	data, err := os.ReadFile(r.Path)
	fi, _ := os.Stat(r.Path)
	if err != nil || string(data) != "%PDF file" || fi.Mode().Perm() != 0o600 {
		t.Fatalf("%v %q %v", err, data, fi.Mode())
	}
	// The stored keys, and so the stored path, reached the client unchanged; a second download
	// returns the same file without fetching again.
	code, out = d.do("POST", "/v1/download", map[string]any{"id": m.ID})
	var r2 core.DownloadResult
	json.Unmarshal(out, &r2)
	if code != 200 || r2.Path != r.Path || !r2.Existing || d.fake.Downloads != 1 {
		t.Fatalf("%d %+v downloads=%d", code, r2, d.fake.Downloads)
	}
	// Refusals.
	vo := d.emit(msg("@Example once", mention, func(mm *client.Message) {
		mm.Media = &client.Media{Type: "image", MIME: "image/jpeg", ViewOnce: true, Keys: []byte("vo")}
	}))
	d.wantError("POST", "/v1/download", map[string]any{"chat": group, "id": vo.ID}, 422, "not_downloadable")
	plain := d.emit(msg("@Example no media", mention))
	d.wantError("POST", "/v1/download", map[string]any{"chat": group, "id": plain.ID}, 422, "not_downloadable")
	gone := d.emit(msg("@Example old", mention, func(mm *client.Message) {
		mm.Media = &client.Media{Type: "image", MIME: "image/jpeg", Keys: []byte("expired")}
	}))
	d.wantError("POST", "/v1/download", map[string]any{"chat": group, "id": gone.ID}, 422, "not_downloadable")
	d.wantError("POST", "/v1/download", map[string]any{"chat": group, "id": "3EB0NOPE"}, 404, "not_found")
	// Downloads do not count toward the send limits.
	d.patch(`{"send":{"per_minute":1}}`)
	d.do("POST", "/v1/download", map[string]any{"id": m.ID})
	d.send(map[string]any{"chat": group, "text": "still allowed"})
	// No key material in any response.
	for _, b := range d.transcript {
		if bytes.Contains(b, []byte("TOKEN")) || bytes.Contains(b, []byte("media_keys")) {
			t.Fatalf("key material in a response: %s", b)
		}
	}
}

func TestReact(t *testing.T) {
	d, parent := keptGroup(t)
	code, body := d.post("/v1/react", map[string]any{"chat": group, "id": parent.ID, "emoji": "👍"})
	if code != 200 || body["changed"] != true {
		t.Fatalf("%d %+v", code, body)
	}
	r := d.fake.Reactions()
	if len(r) != 1 || r[0].Sender != samLID || r[0].ID != parent.ID || r[0].Chat != group || r[0].Emoji != "👍" {
		t.Fatalf("%+v", r)
	}
	v := d.message(group, parent.ID)
	if len(v.Reactions) != 1 || !v.Reactions[0].From.Me || v.Reactions[0].Emoji != "👍" {
		t.Fatalf("%+v", v.Reactions)
	}
	// The same emoji again: a no-op, nothing sent.
	code, body = d.post("/v1/react", map[string]any{"id": parent.ID, "emoji": "👍"})
	if code != 200 || body["changed"] != false || len(d.fake.Reactions()) != 1 {
		t.Fatalf("%d %+v", code, body)
	}
	// Removing, on the account's own message (sender empty).
	own := d.send(map[string]any{"chat": group, "text": "mine"})
	d.post("/v1/react", map[string]any{"chat": group, "id": own.ID, "emoji": "✅"})
	if r := d.fake.Reactions(); r[1].Sender != "" {
		t.Fatalf("own message reacted with sender %q", r[1].Sender)
	}
	code, body = d.post("/v1/react", map[string]any{"chat": group, "id": parent.ID, "emoji": ""})
	if code != 200 || body["changed"] != true || d.fake.Reactions()[2].Emoji != "" {
		t.Fatalf("%d %+v", code, body)
	}
	if v := d.message(group, parent.ID); len(v.Reactions) != 0 {
		t.Fatalf("%+v", v.Reactions)
	}
	d.wantError("POST", "/v1/react", map[string]any{"chat": group, "id": parent.ID}, 400, "bad_request")
	d.wantError("POST", "/v1/react", map[string]any{"chat": group, "id": "3EB0NOPE", "emoji": "x"}, 404, "not_found")
}

func TestNotConnectedRefusesEverySend(t *testing.T) {
	for _, st := range []string{"suspended", "logged_out", "outdated", "connecting"} {
		t.Run(st, func(t *testing.T) {
			d, parent := keptGroup(t)
			d.fake.Emit(client.StateChange{State: st})
			want := "not_connected"
			if st == "logged_out" {
				want = "not_linked"
			}
			e := d.wantError("POST", "/v1/send", map[string]any{"chat": group, "text": "x"}, 409, want)
			if e["state"] != st {
				t.Fatalf("%+v", e)
			}
			d.wantError("POST", "/v1/react", map[string]any{"chat": group, "id": parent.ID, "emoji": "x"}, 409, want)
			if d.fake.AttemptCount() != 0 {
				t.Fatal("sent while not connected")
			}
		})
	}
}

// countRows returns the messages of a chat in store.db, failed ones included.
func (d *daemon) countMessages(chat string) int {
	return len(d.messages(chat))
}

// TestSendLimitsAtTheSocket: for each limit, the request at the limit succeeds, the next fails
// with its code, and nothing is sent or recorded for the failure (security.md rule 9).
func TestSendLimitsAtTheSocket(t *testing.T) {
	t.Run("first contact", func(t *testing.T) {
		d, _ := keptGroup(t)
		before := d.fake.AttemptCount()
		d.wantError("POST", "/v1/send", map[string]any{"chat": "+15550100003", "text": "hello"}, 409, "first_contact")
		d.wantError("POST", "/v1/send", map[string]any{"chat": group2, "text": "hello"}, 409, "first_contact")
		d.wantError("POST", "/v1/send-file", map[string]any{"chat": group2, "path": writeFile(t, "a.pdf", []byte("%PDF"))}, 409, "first_contact")
		if d.fake.AttemptCount() != before {
			t.Fatal("sent")
		}
		var chats struct{ Chats []core.ChatSummary }
		d.get("/v1/chats", &chats)
		if len(chats.Chats) != 1 {
			t.Fatalf("a refused first contact recorded a chat: %+v", chats.Chats)
		}
		// With the flag it goes; a phone-number chat answered by hidden id is rekeyed.
		d.fake.Map(caseyLID, caseyPN)
		d.fake.AddressAs = map[string]string{}
		s := d.send(map[string]any{"chat": "+15550100003", "text": "hello", "first_contact": true})
		if s.Chat != caseyLID || d.fake.Sent()[0].Chat != caseyLID {
			t.Fatalf("%+v %+v", s, d.fake.Sent()[0])
		}
		// Now the chat has activity: no flag needed.
		d.send(map[string]any{"chat": caseyPN, "text": "again"})
		// A phone number the library cannot map yet is sent by phone-number id and rekeyed when
		// WhatsApp answers with the hidden id.
		d.fake.AddressAs = map[string]string{"15550100009@s.whatsapp.net": "100000000000009@lid"}
		s = d.send(map[string]any{"chat": "+15550100009", "text": "hi", "first_contact": true})
		if s.Chat != "100000000000009@lid" {
			t.Fatalf("%+v", s)
		}
		if d.countMessages("100000000000009@lid") != 1 || d.countMessages("15550100009@s.whatsapp.net") != 1 {
			t.Fatal("the old id must still resolve to the rekeyed chat")
		}
		// send.first_contact allow.
		d.patch(`{"send":{"first_contact":"allow"},"confirm":true}`)
		d.send(map[string]any{"chat": "+15550100008", "text": "hi"})
	})

	t.Run("per minute and per hour", func(t *testing.T) {
		d, parent := keptGroup(t)
		d.patch(`{"send":{"per_minute":3,"per_hour":5}}`)
		d.send(map[string]any{"chat": group, "text": "1"})
		d.send(map[string]any{"chat": group, "text": "2"})
		d.post("/v1/react", map[string]any{"chat": group, "id": parent.ID, "emoji": "👍"}) // reactions count
		n := d.countMessages(group)
		e := d.wantError("POST", "/v1/send", map[string]any{"chat": group, "text": "4"}, 429, "rate_limited")
		if e["retry_after_seconds"] == nil || e["retry_after_seconds"].(float64) < 1 {
			t.Fatalf("%+v", e)
		}
		d.wantError("POST", "/v1/react", map[string]any{"chat": group, "id": parent.ID, "emoji": "❤"}, 429, "rate_limited")
		if d.countMessages(group) != n || d.fake.AttemptCount() != 3 {
			t.Fatal("a refused send was sent or recorded")
		}
		d.clock.Add(61 * time.Second)
		d.send(map[string]any{"chat": group, "text": "5"})
		d.send(map[string]any{"chat": group, "text": "6"}) // the fifth this hour
		d.clock.Add(61 * time.Second)
		e = d.wantError("POST", "/v1/send", map[string]any{"chat": group, "text": "7"}, 429, "rate_limited")
		if !strings.Contains(fmt.Sprint(e["message"]), "per hour") {
			t.Fatalf("%+v", e)
		}
		d.clock.Add(time.Hour)
		d.send(map[string]any{"chat": group, "text": "8"})
	})

	t.Run("same text", func(t *testing.T) {
		e := newEnv(t)
		e.init()
		d := e.start(startOpts{})
		d.patch(`{"send":{"same_text_chats":2,"first_contact":"allow"},"confirm":true}`)
		d.send(map[string]any{"chat": "+15550100001", "text": "Buy now"})
		d.send(map[string]any{"chat": "+15550100002", "text": "  Buy now\n"}) // compared after trimming
		d.send(map[string]any{"chat": "+15550100001", "text": "Buy now"})     // the same chat again is fine
		before := d.fake.AttemptCount()
		d.wantError("POST", "/v1/send", map[string]any{"chat": "+15550100003", "text": "Buy now"}, 429, "duplicate_text")
		if d.fake.AttemptCount() != before || d.countChats() != 2 {
			t.Fatal("a refused send was sent or recorded")
		}
		d.send(map[string]any{"chat": "+15550100003", "text": "Something else"})
		d.clock.Add(10*time.Minute + time.Second)
		d.send(map[string]any{"chat": "+15550100004", "text": "Buy now"})
	})
}

func (d *daemon) countChats() int {
	var res struct{ Chats []core.ChatSummary }
	d.get("/v1/chats", &res)
	return len(res.Chats)
}

// TestNoKeyMaterialFromSending: neither a response, an event nor a log line of the sending paths
// carries key material (security.md rule 6).
func TestNoKeyMaterialFromSending(t *testing.T) {
	d, _ := keptGroup(t)
	marker := []byte("SENDKEYMARKER-0123456789")
	d.fake.UploadKeys = marker
	pdf := writeFile(t, "r.pdf", []byte("%PDF"))
	d.send2File(map[string]any{"chat": group, "path": pdf})
	in := d.emit(msg("@Example f", mention, func(m *client.Message) {
		m.Media = &client.Media{Type: "document", MIME: "application/pdf", Name: "f.pdf", Keys: marker}
	}))
	d.fake.Files = map[string][]byte{string(marker): []byte("data")}
	d.do("POST", "/v1/download", map[string]any{"chat": group, "id": in.ID})
	d.get("/v1/events?after=0", nil)
	d.get("/v1/messages?chat="+group, nil)
	b64 := []byte(base64.StdEncoding.EncodeToString(marker))
	for _, b := range append(d.transcript, d.env.log.Bytes()) {
		if bytes.Contains(b, marker) || bytes.Contains(b, b64) {
			t.Fatalf("key material: %s", b)
		}
	}
}

// TestSentContentNeverLogged: the text, caption and file name of a send, and the quoted copy of
// a reply, never reach the log, even at debug level and on failure (security.md rule 5).
func TestSentContentNeverLogged(t *testing.T) {
	d, parent := keptGroup(t)
	d.send(map[string]any{"chat": group, "text": "LOGMARKTEXT one", "reply_to": parent.ID})
	d.send2File(map[string]any{"chat": group, "path": writeFile(t, "LOGMARKFILE.pdf", []byte("%PDF")), "caption": "LOGMARKCAPTION"})
	d.fake.SendErr = errors.New("failure LOGMARKERR")
	d.do("POST", "/v1/send", map[string]any{"chat": group, "text": "LOGMARKTEXT two"})
	log := d.env.log.Bytes()
	for _, m := range []string{"LOGMARKTEXT", "LOGMARKFILE", "LOGMARKCAPTION", "the report is attached"} {
		if bytes.Contains(log, []byte(m)) {
			t.Fatalf("%s in the log:\n%s", m, log)
		}
	}
}

var _ = fake.New

// storeTrigger adds a trigger to store.db through a second connection, to make the daemon's own
// bookkeeping fail at a chosen point.
func (d *daemon) storeTrigger(sql string) {
	d.t.Helper()
	db, err := sqlite.Open(context.Background(), d.env.layout().StoreDB(), false)
	if err != nil {
		d.t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(sql); err != nil {
		d.t.Fatal(err)
	}
}

// TestSendFinishesWhenTheClientDisconnects: once a send is recorded pending, the daemon carries
// it through even though the client gave up (specs/sending.md "Sending text").
func TestSendFinishesWhenTheClientDisconnects(t *testing.T) {
	d, _ := keptGroup(t)
	entered := make(chan string, 1)
	release := make(chan struct{})
	d.fake.BeforeSend = func(m client.OutMessage) {
		entered <- m.ID
		<-release
	}
	ctx, cancel := context.WithCancel(context.Background())
	js, _ := json.Marshal(map[string]any{"chat": group, "text": "carried through"})
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://x/v1/send", bytes.NewReader(js))
	errc := make(chan error, 1)
	go func() {
		resp, err := d.http.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		errc <- err
	}()
	id := <-entered
	cancel()
	if err := <-errc; err == nil {
		t.Fatal("the request was not cut off")
	}
	if m := d.message(group, id); m.Status != "pending" {
		t.Fatalf("mid-send: %+v", m)
	}
	close(release)
	waitFor(t, func() bool { return d.message(group, id).Status == "" })
	if sent := d.fake.Sent(); len(sent) != 1 || sent[0].ID != id {
		t.Fatalf("sent %+v", sent)
	}
	found := false
	for _, e := range d.events("?after=0") {
		found = found || (e.Message != nil && e.Message.ID == id)
	}
	if !found {
		t.Fatal("the sent message has no event")
	}
}

// TestSendOutcomeUnknown: a send the daemon cannot settle is outcome_unknown, never a plain
// failure, and its row stays pending.
func TestSendOutcomeUnknown(t *testing.T) {
	t.Run("the daemon's send timeout", func(t *testing.T) {
		d, parent := keptGroup(t)
		old := core.SendTimeout
		core.SendTimeout = 100 * time.Millisecond
		defer func() { core.SendTimeout = old }()
		d.fake.SetSendWait(make(chan struct{}))
		e := d.wantError("POST", "/v1/send", map[string]any{"chat": group, "text": "slow"}, 504, "outcome_unknown")
		if !strings.Contains(e["message"].(string), "may have gone out") {
			t.Fatalf("%v", e)
		}
		msgs := d.messages(group)
		if last := msgs[len(msgs)-1]; last.Text != "slow" || last.Status != "pending" {
			t.Fatalf("row %+v", last)
		}
		d.wantError("POST", "/v1/react", map[string]any{"chat": group, "id": parent.ID, "emoji": "👍"}, 504, "outcome_unknown")
	})
	t.Run("the client cannot tell", func(t *testing.T) {
		d, _ := keptGroup(t)
		d.fake.SetSendErr(fmt.Errorf("%w: timed out", client.ErrOutcomeUnknown))
		d.wantError("POST", "/v1/send", map[string]any{"chat": group, "text": "unsure"}, 504, "outcome_unknown")
		msgs := d.messages(group)
		if last := msgs[len(msgs)-1]; last.Status != "pending" {
			t.Fatalf("row %+v", last)
		}
		// A refusal is still a plain failure, and the row is failed.
		d.fake.SetSendErr(fmt.Errorf("refused"))
		d.wantError("POST", "/v1/send", map[string]any{"chat": group, "text": "refused"}, 502, "whatsapp_error")
	})
}

// TestAcceptedMeansSent: when WhatsApp accepted and only the daemon's bookkeeping failed, the
// answer is success with a warning.
func TestAcceptedMeansSent(t *testing.T) {
	t.Run("send", func(t *testing.T) {
		d, _ := keptGroup(t)
		d.storeTrigger(`CREATE TRIGGER fail_sent BEFORE UPDATE OF status ON messages WHEN NEW.status = 'sent' BEGIN SELECT RAISE(FAIL, 'test'); END`)
		code, out := d.do("POST", "/v1/send", map[string]any{"chat": group, "text": "accepted"})
		var s core.SentMessage
		_ = json.Unmarshal(out, &s)
		if code != 200 || s.ID == "" || s.Warning == "" {
			t.Fatalf("%d %s", code, out)
		}
		if len(d.fake.Sent()) != 1 {
			t.Fatal("not sent")
		}
	})
	t.Run("reaction", func(t *testing.T) {
		d, parent := keptGroup(t)
		d.storeTrigger(`CREATE TRIGGER fail_reaction BEFORE INSERT ON reactions BEGIN SELECT RAISE(FAIL, 'test'); END`)
		code, out := d.do("POST", "/v1/react", map[string]any{"chat": group, "id": parent.ID, "emoji": "👍"})
		var r core.ReactResult
		_ = json.Unmarshal(out, &r)
		if code != 200 || !r.Changed || r.Warning == "" {
			t.Fatalf("%d %s", code, out)
		}
		if len(d.fake.Reactions()) != 1 {
			t.Fatal("not sent")
		}
	})
}

func TestStatusReportsTheSendTimeout(t *testing.T) {
	d, _ := keptGroup(t)
	var st core.Status
	d.get("/v1/status", &st)
	if st.SendTimeoutSeconds != int(core.SendTimeout/time.Second) || st.SendTimeoutSeconds < 60 {
		t.Fatalf("%d", st.SendTimeoutSeconds)
	}
}

// TestForgetFailsWhenMediaStays: forget never reports forgotten while a downloaded file of it is
// still on disk; nothing is forgotten, so it can be run again.
func TestForgetFailsWhenMediaStays(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	d, _ := keptGroup(t)
	keys := []byte(`{"direct_path":"/v/x"}`)
	m := d.emit(msg("@Example doc", mention, func(mm *client.Message) {
		mm.Media = &client.Media{Type: "document", MIME: "application/pdf", Name: "a.pdf", Size: 4, Keys: keys}
	}))
	d.fake.Files = map[string][]byte{string(keys): []byte("%PDF")}
	var r core.DownloadResult
	_, out := d.do("POST", "/v1/download", map[string]any{"chat": group, "id": m.ID})
	json.Unmarshal(out, &r)
	media := d.env.layout().MediaDir()
	os.Chmod(media, 0o500)
	defer os.Chmod(media, 0o700)
	e := d.wantError("POST", "/v1/forget", map[string]string{"chat": group, "id": m.ID}, 500, "internal")
	if !strings.Contains(e["message"].(string), "Nothing was forgotten") || strings.Contains(e["message"].(string), media) {
		t.Fatalf("%v", e)
	}
	if !d.kept(group, m.ID) {
		t.Fatal("forgotten although its file stayed")
	}
	os.Chmod(media, 0o700)
	if code, out := d.do("POST", "/v1/forget", map[string]string{"chat": group, "id": m.ID}); code != 200 {
		t.Fatalf("%d %s", code, out)
	}
	if _, err := os.Stat(r.Path); !os.IsNotExist(err) || d.kept(group, m.ID) {
		t.Fatal("not forgotten on the second run")
	}
}
