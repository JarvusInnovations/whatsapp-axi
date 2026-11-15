package runner

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/core"
)

// TestLeavesNoTrace is the test of scopes.md "Leaves no trace" and security.md rule 4. A
// discarded message carries a unique marker in its text, caption, quoted copy and file name (and
// in its media keys and its sender's push name). The test then reads every byte of every file
// under the account's config and state directories, the socket directory and the wake file, every
// response the socket gives, and the daemon's log at debug level, and fails if a marker appears
// anywhere. It runs with the recent-message buffer holding the message, and again after the
// buffer's limits (age, then count) have pushed it out.
func TestLeavesNoTrace(t *testing.T) {
	for _, phase := range []string{"buffer holds it", "evicted by age", "evicted by count"} {
		t.Run(phase, func(t *testing.T) { leavesNoTrace(t, phase) })
	}
}

func leavesNoTrace(t *testing.T, phase string) {
	e := newEnv(t)
	l := e.init()
	wake := filepath.Join(e.vars["HOME"], "wake.jsonl")
	d := e.start(startOpts{})
	d.fake.SetGroup(group, client.GroupInfo{Name: "Example group", Participants: []client.Participant{
		{JID: ownLID, LID: ownLID, PN: ownPN}, {JID: samLID, LID: samLID, PN: samPN},
	}})
	d.patch(`{"wake_file":"` + wake + `","operators":["+15550100001"]}`)

	// Kept content, so that every request has something to return.
	kept := d.emit(msg("@Example kept text", mention))
	d.emit(msg("own words", fromMe))
	d.emit(msg("", func(m *client.Message) { m.Kind, m.TargetID, m.Emoji = client.KindReaction, kept.ID, "👍" }))

	nonce := fmt.Sprintf("%x", time.Now().UnixNano())
	markers := map[string]string{
		"text":             "MKTEXT" + nonce,
		"caption":          "MKCAPTION" + nonce,
		"quote":            "MKQUOTE" + nonce,
		"file name":        "MKFILE" + nonce + ".pdf",
		"quoted file name": "MKQFILE" + nonce + ".jpg",
		"media key":        "MKKEY" + nonce,
		"push name":        "MKPUSH" + nonce,
	}
	before := d.counter(group)
	discarded := d.emit(msg(markers["text"], func(m *client.Message) {
		m.Sender, m.SenderAlt, m.PushName = alexLID, alexPN, markers["push name"]
		m.Media = &client.Media{Type: "document", MIME: "application/pdf", Name: markers["file name"], Size: 1234, Caption: markers["caption"], Keys: []byte(markers["media key"])}
		m.ReplyTo = &client.Quoted{ID: nextID(), Sender: samLID, Text: markers["quote"], Media: &client.Media{Type: "image", Name: markers["quoted file name"], Keys: []byte(markers["media key"])}}
	}))
	if got := d.counter(group); got != before+1 {
		t.Fatalf("the chat's counter went from %d to %d, want +1", before, got)
	}
	if d.kept(group, discarded.ID) {
		t.Fatal("the message was kept")
	}

	// The same markers through the other discard paths.
	d.emit(msg(markers["text"], func(m *client.Message) { // a DM from a non-operator
		m.Chat, m.ChatType, m.Sender, m.SenderAlt, m.PushName = caseyLID, client.ChatDirect, caseyLID, "", markers["push name"]
		m.Media = &client.Media{Type: "document", Name: markers["file name"], Caption: markers["caption"], Keys: []byte(markers["media key"])}
		m.ReplyTo = &client.Quoted{ID: nextID(), Text: markers["quote"]}
	}))
	d.emit(msg(markers["text"], func(m *client.Message) { // an edit of an unkept message
		m.Kind, m.TargetID = client.KindEdit, discarded.ID
		m.Media = &client.Media{Type: "document", Name: markers["file name"], Caption: markers["caption"]}
	}))
	d.emit(msg("", func(m *client.Message) { // a reaction to an unkept message
		m.Kind, m.TargetID, m.Emoji, m.PushName = client.KindReaction, discarded.ID, "👍", markers["push name"]
	}))
	d.emit(msg(markers["text"], func(m *client.Message) { // an unsupported chat type
		m.Chat, m.ChatType = "status@broadcast", client.ChatStatus
		m.Media = &client.Media{Type: "image", Name: markers["file name"], Caption: markers["caption"]}
	}))

	switch phase {
	case "buffer holds it":
		if d.acct.BufferLen(group) == 0 {
			t.Fatal("the buffer should hold the discarded message")
		}
	case "evicted by age":
		d.clock.Add(core.BufferMaxAge + time.Minute)
	case "evicted by count":
		for i := 0; i < core.BufferMaxMessages; i++ {
			d.emit(msg("filler"))
		}
	}
	if phase != "buffer holds it" {
		// Pushed out: a mentioning reply to it can only keep what the reply itself carries.
		reply := d.emit(msg("@Example about that", mention, replyTo(discarded.ID, alexLID, "neutral copy")))
		var one core.MessageResult
		d.get("/v1/messages/"+url.PathEscape(group)+"/"+discarded.ID, &one)
		if !one.Message.Partial || one.Message.Text != "neutral copy" || one.Message.Media != nil {
			t.Fatalf("after eviction the parent comes only from the quoted copy: %+v", one.Message)
		}
		if !d.kept(group, reply.ID) {
			t.Fatal("reply kept")
		}
	}

	// Every response the socket can produce.
	esc := url.PathEscape(group)
	d.get("/v1/status", nil)
	d.get("/v1/settings", nil)
	d.patch(`{"presence":true}`)
	d.get("/v1/chats", nil)
	d.get("/v1/chats/"+esc, nil)
	d.get("/v1/groups", nil)
	d.do("GET", "/v1/chats/"+url.PathEscape(caseyLID), nil)
	d.get("/v1/events", nil)
	d.get("/v1/events?after=0&limit=1000", nil)
	for _, k := range core.Kinds {
		d.get("/v1/events?after=0&kind="+k, nil)
	}
	d.get("/v1/events?after=0&chat="+url.QueryEscape(group), nil)
	d.get("/v1/messages?chat="+url.QueryEscape(group)+"&limit=500", nil)
	d.get("/v1/messages/"+esc+"/"+kept.ID, nil)
	d.get("/v1/messages/"+kept.ID, nil)
	d.do("GET", "/v1/messages/"+esc+"/"+discarded.ID, nil)
	d.do("GET", "/v1/messages/"+discarded.ID, nil)
	d.do("GET", "/v1/messages?chat="+url.QueryEscape(caseyLID), nil)
	d.do("GET", "/v1/events?chat="+url.QueryEscape(caseyLID), nil)
	d.do("POST", "/v1/forget", map[string]string{"chat": caseyLID})
	d.do("GET", "/v1/messages?chat="+url.QueryEscape(group)+"&before="+discarded.ID, nil)
	d.do("GET", "/v1/bogus", nil)
	d.do("PATCH", "/v1/settings", `{"scope":"`+markers["text"]+`x"}`)
	d.followBacklog()

	// Every byte of every file.
	var files []string
	for _, root := range []string{l.ConfigRoot, l.StateRoot, l.RuntimeRoot} {
		filepath.WalkDir(root, func(p string, de fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if de.Type().IsRegular() {
				files = append(files, p)
			}
			return nil
		})
	}
	files = append(files, wake)
	check := func(where string, data []byte) {
		t.Helper()
		for name, mk := range markers {
			for _, form := range [][]byte{[]byte(mk), []byte(base64.StdEncoding.EncodeToString([]byte(mk))), []byte(hex.EncodeToString([]byte(mk)))} {
				if bytes.Contains(data, form) {
					t.Errorf("the %s marker appears in %s", name, where)
				}
			}
		}
	}
	scan := func() {
		for _, f := range files {
			data, err := os.ReadFile(f)
			if err != nil && !os.IsNotExist(err) {
				t.Fatalf("read %s: %v", f, err)
			}
			check(f, data)
		}
	}
	if len(files) < 5 {
		t.Fatalf("expected the databases, WAL files and settings among the files, got %v", files)
	}
	scan()
	for i, body := range d.transcript {
		check(fmt.Sprintf("socket response %d", i), body)
	}
	if !bytes.Contains(e.log.Bytes(), []byte("level=DEBUG")) {
		t.Fatal("the log was not at debug level")
	}
	// Stop, so everything is flushed, and look again (the log included).
	d.stop()
	scan()
	check("the daemon's log at debug level", e.log.Bytes())
}

// followBacklog reads a follow stream's backlog into the transcript.
func (d *daemon) followBacklog() {
	d.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://x/v1/events?follow=1&after=0", nil)
	resp, err := d.http.Do(req)
	if err != nil {
		d.t.Fatal(err)
	}
	defer resp.Body.Close()
	last, _ := d.acct.LastSeq(context.Background())
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := append([]byte(nil), sc.Bytes()...)
		d.transcript = append(d.transcript, line)
		if strings.Contains(string(line), fmt.Sprintf(`"seq":%d,`, last)) {
			return
		}
	}
	d.t.Fatal("follow backlog incomplete")
}
