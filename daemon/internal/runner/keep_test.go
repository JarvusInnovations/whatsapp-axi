package runner

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/core"
)

func kinds(evs []core.Event) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.Kind)
	}
	return out
}

func TestParentKeptWholeFromBuffer(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.patch(`{"read_receipts":"on-keep"}`)
	parent := d.emit(msg("the report is attached", func(m *client.Message) {
		m.Sender, m.SenderAlt, m.PushName = alexLID, alexPN, "Alex"
		m.Text = ""
		m.Media = &client.Media{Type: "document", MIME: "application/pdf", Name: "report.pdf", Size: 48213, Caption: "the report is attached", Keys: []byte("KEYMATERIAL-PARENT")}
	}))
	if d.kept(group, parent.ID) {
		t.Fatal("a plain group message must be discarded")
	}
	if d.acct.BufferLen(group) != 1 {
		t.Fatal("the discarded message is in the buffer")
	}
	early := d.emit(msg("first!", replyTo(parent.ID, alexLID, "the report is attached")))
	before := d.events("?after=0")
	reply := d.emit(msg("@Example can you check this?", mention, replyTo(parent.ID, alexLID, "the report is attached")))

	evs := d.events(fmt.Sprintf("?after=%d", before[len(before)-1].Seq))
	if len(evs) != 2 || evs[0].Message.ID != parent.ID || evs[1].Message.ID != reply.ID || evs[1].Seq != evs[0].Seq+1 {
		t.Fatalf("the parent's event immediately precedes the reply's: %+v", evs)
	}
	p := evs[0].Message
	if p.KeptBy != "parent" || p.Partial || p.Media == nil || p.Media.Name != "report.pdf" || p.Media.Size != 48213 || p.From.ID != alexLID || p.From.Name != "Alex" || p.Text != "the report is attached" {
		t.Fatalf("kept whole: %+v", p)
	}
	if !evs[1].Message.ReplyTo.Kept || evs[1].Message.KeptBy != "mention" {
		t.Fatalf("reply_to.kept is true for a mentioning reply: %+v", evs[1].Message)
	}
	if d.acct.BufferLen(group) != 1 { // only the early sibling remains
		t.Fatal("the pulled-in parent leaves the buffer")
	}
	// The parent is read once the reply brings it in.
	if n := d.fake.MarkReadCount(); n != 2 {
		t.Fatalf("mark-read calls: %d", n)
	}

	// It does not start a thread: a sibling reply from before the mention is not recovered...
	if d.kept(group, early.ID) {
		t.Fatal("a sibling reply from before the mention is not recovered")
	}
	// ...a sibling reply after it stays discarded...
	sib := d.emit(msg("me too", replyTo(parent.ID, alexLID, "the report is attached")))
	if d.kept(group, sib.ID) {
		t.Fatal("a sibling reply to a rule-2 parent is discarded")
	}
	// ...a reply down the mentioning reply's thread is kept...
	down := d.emit(msg("done", replyTo(reply.ID, samLID, "")))
	if !d.kept(group, down.ID) {
		t.Fatal("a reply to the mentioning reply is kept")
	}
	// ...and once the parent is edited to mention the account, replies to it are kept.
	d.emit(msg("", func(m *client.Message) {
		m.Kind, m.TargetID, m.Sender, m.SenderAlt = client.KindEdit, parent.ID, alexLID, alexPN
		m.Text = "the report is attached @Example"
		m.Mentions = []string{ownLID}
	}))
	var one core.MessageResult
	d.get("/v1/messages/"+url.PathEscape(group)+"/"+parent.ID, &one)
	if one.Message.KeptBy != "mention" || !one.Message.Edited {
		t.Fatalf("edited parent: %+v", one.Message)
	}
	sib2 := d.emit(msg("now?", replyTo(parent.ID, alexLID, "")))
	if !d.kept(group, sib2.ID) {
		t.Fatal("after the edit adds a mention, replies to the parent are kept")
	}
}

func TestParentPartialFromQuotedCopy(t *testing.T) {
	for _, mode := range []string{"buffer off", "evicted by age", "evicted by count", "never seen"} {
		t.Run(mode, func(t *testing.T) {
			e := newEnv(t)
			e.init()
			d := e.start(startOpts{})
			parent := msg("original text", func(m *client.Message) {
				m.Sender, m.SenderAlt = alexLID, alexPN
				m.Media = &client.Media{Type: "image", MIME: "image/jpeg", Name: "original.jpg"}
			})
			switch mode {
			case "buffer off":
				d.patch(`{"parent_buffer":false}`)
				d.emit(parent)
			case "evicted by age":
				d.emit(parent)
				d.clock.Add(49 * time.Hour)
			case "evicted by count":
				d.emit(parent)
				for i := 0; i < core.BufferMaxMessages; i++ {
					d.emit(msg("filler"))
				}
				if d.acct.BufferLen(group) != core.BufferMaxMessages {
					t.Fatalf("buffer holds %d", d.acct.BufferLen(group))
				}
			}
			if mode != "never seen" && d.kept(group, parent.ID) {
				t.Fatal("parent discarded")
			}
			reply := d.emit(msg("@Example this", mention, func(m *client.Message) {
				m.ReplyTo = &client.Quoted{ID: parent.ID, Sender: alexLID, Text: "copy text", Media: &client.Media{Type: "image", MIME: "image/jpeg", Keys: []byte("COPYKEYS")}}
			}))
			var one core.MessageResult
			d.get("/v1/messages/"+url.PathEscape(group)+"/"+parent.ID, &one)
			p := one.Message
			if p.KeptBy != "parent" || !p.Partial || p.Text != "copy text" || p.Media == nil || p.Media.Name != "" || p.From.ID != alexLID {
				t.Fatalf("partial parent: %+v", p)
			}
			if !d.kept(group, reply.ID) {
				t.Fatal("reply kept")
			}
		})
	}
}

func TestNonMentioningReplyDoesNotPull(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	parent := d.emit(msg("parent"))
	r := d.emit(msg("reply", replyTo(parent.ID, samLID, "parent")))
	if d.kept(group, r.ID) || d.kept(group, parent.ID) {
		t.Fatal("a non-mentioning reply to a discarded parent is discarded and does not pull it in")
	}
	// A reply kept by rule 3 does not pull its parent in either: its parent is kept already.
	m := d.emit(msg("@Example", mention))
	r3 := d.emit(msg("more", replyTo(m.ID, samLID, "")))
	if !d.kept(group, r3.ID) {
		t.Fatal("rule 3")
	}
}

func TestEditRevokeReaction(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	// An edit that adds a mention to a discarded message keeps it under the original id.
	orig := d.emit(msg("plain"))
	d.emit(msg("", func(m *client.Message) {
		m.Kind, m.TargetID = client.KindEdit, orig.ID
		m.Text, m.Mentions = "plain @Example", []string{ownPN}
	}))
	var one core.MessageResult
	d.get("/v1/messages/"+url.PathEscape(group)+"/"+orig.ID, &one)
	if one.Message.KeptBy != "mention" || one.Message.Text != "plain @Example" {
		t.Fatalf("edit adds a mention: %+v", one.Message)
	}
	// An edit that removes the mention does not un-keep it.
	d.emit(msg("", func(m *client.Message) { m.Kind, m.TargetID, m.Text = client.KindEdit, orig.ID, "plain" }))
	if !d.kept(group, orig.ID) {
		t.Fatal("un-kept by an edit")
	}
	evs := d.events("?after=0&kind=edit")
	if len(evs) != 1 || !evs[0].Edited || evs[0].Message.Text != "plain" {
		t.Fatalf("edit event: %+v", evs)
	}
	// Reaction on a kept message, then its removal.
	d.emit(msg("", func(m *client.Message) { m.Kind, m.TargetID, m.Emoji = client.KindReaction, orig.ID, "👍" }))
	d.get("/v1/messages/"+url.PathEscape(group)+"/"+orig.ID, &one)
	if len(one.Message.Reactions) != 1 || one.Message.Reactions[0].Emoji != "👍" {
		t.Fatalf("reaction: %+v", one.Message.Reactions)
	}
	d.emit(msg("", func(m *client.Message) { m.Kind, m.TargetID, m.Emoji = client.KindReaction, orig.ID, "" }))
	one = core.MessageResult{}
	d.get("/v1/messages/"+url.PathEscape(group)+"/"+orig.ID, &one)
	if len(one.Message.Reactions) != 0 {
		t.Fatal("reaction removal")
	}
	re := d.events("?after=0&kind=reaction")
	if len(re) != 2 || re[0].Target != orig.ID || *re[0].Emoji != "👍" || *re[1].Emoji != "" || re[0].From.ID != samLID {
		t.Fatalf("reaction events: %+v", re)
	}
	// A reaction to an unkept message is discarded.
	stray := d.emit(msg("stray"))
	d.emit(msg("", func(m *client.Message) { m.Kind, m.TargetID, m.Emoji = client.KindReaction, stray.ID, "👍" }))
	if len(d.events("?after=0&kind=reaction")) != 2 {
		t.Fatal("a reaction to an unkept message must be discarded")
	}
	// Revoke of a kept message erases its content everywhere.
	secret := d.emit(msg("@Example REVOKEDTEXT", mention))
	d.emit(msg("", func(m *client.Message) { m.Kind, m.TargetID = client.KindRevoke, secret.ID }))
	d.get("/v1/messages/"+url.PathEscape(group)+"/"+secret.ID, &one)
	if !one.Message.Deleted || one.Message.Text != "" {
		t.Fatalf("revoked: %+v", one.Message)
	}
	all, _ := json.Marshal(d.events("?after=0"))
	if bytes.Contains(all, []byte("REVOKEDTEXT")) {
		t.Fatal("revoked content still in events")
	}
	rv := d.events("?after=0&kind=revoke")
	if len(rv) != 1 || rv[0].Message.ID != secret.ID || rv[0].Message.From.ID != samLID || rv[0].Message.Text != "" {
		t.Fatalf("revoke event: %+v", rv)
	}
}

func TestDMFromAndOperators(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.fake.Map(samLID, samPN)
	d.patch(`{"operators":["+15550100001","100000000000002@lid"]}`)
	dm := func(sender, alt string) *client.Message {
		return msg("hi", func(m *client.Message) {
			m.Chat, m.ChatType, m.Sender, m.SenderAlt = sender, client.ChatDirect, sender, alt
		})
	}
	// Operator by phone number through the map.
	a := d.emit(dm(samLID, ""))
	if !d.kept(samLID, a.ID) {
		t.Fatal("operator DM by mapped phone number")
	}
	// Operator by hidden id directly.
	b := d.emit(dm(alexLID, ""))
	if !d.kept(alexLID, b.ID) {
		t.Fatal("operator DM by hidden id")
	}
	// Unknown mapping fails closed, and the daemon asks the library to resolve it.
	c := d.emit(dm(caseyLID, ""))
	if d.kept(caseyLID, c.ID) {
		t.Fatal("unmapped hidden id must not count as an operator")
	}
	found := false
	for _, id := range d.fake.Requested {
		found = found || id == caseyLID
	}
	if !found {
		t.Fatal("the mapping was not requested")
	}
	var st core.Status
	d.get("/v1/status", &st)
	if st.Counts.Discarded != 1 {
		t.Fatalf("discard counted: %+v", st.Counts)
	}
	// dm_from anyone.
	d.patch(`{"dm_from":"anyone","confirm":true}`)
	c2 := d.emit(dm(caseyLID, ""))
	if !d.kept(caseyLID, c2.ID) {
		t.Fatal("dm_from anyone")
	}
	// Operator mark on the kept message.
	var one core.MessageResult
	d.get("/v1/messages/"+url.PathEscape(samLID)+"/"+a.ID, &one)
	if !one.Message.From.Operator || one.Message.From.PN != "+15550100001" || one.Message.KeptBy != "dm" {
		t.Fatalf("operator mark: %+v", one.Message.From)
	}
	d.get("/v1/messages/"+url.PathEscape(caseyLID)+"/"+c2.ID, &one)
	if one.Message.From.Operator {
		t.Fatal("non-operator marked as operator")
	}
}

func TestDirectChatRekeyed(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.patch(`{"dm_from":"anyone","chats":{"+15550100003":"full"},"confirm":true}`)
	first := d.emit(msg("by phone number", func(m *client.Message) {
		m.Chat, m.ChatType, m.Sender, m.SenderAlt = caseyPN, client.ChatDirect, caseyPN, ""
	}))
	if !d.kept(caseyPN, first.ID) {
		t.Fatal("first message keyed by phone-number id")
	}
	// The hidden id becomes known.
	d.fake.Map(caseyLID, caseyPN)
	second := d.emit(msg("by hidden id", func(m *client.Message) {
		m.Chat, m.ChatType, m.Sender, m.SenderAlt = caseyLID, client.ChatDirect, caseyLID, ""
	}))
	var list struct {
		Chats []core.ChatSummary `json:"chats"`
	}
	d.get("/v1/chats", &list)
	if len(list.Chats) != 1 || list.Chats[0].ID != caseyLID || list.Chats[0].Messages != 2 {
		t.Fatalf("one chat, one history: %+v", list.Chats)
	}
	rk := d.events("?after=0&kind=chat_rekeyed")
	if len(rk) != 1 || rk[0].Old != caseyPN || rk[0].New != caseyLID {
		t.Fatalf("one chat_rekeyed event: %+v", rk)
	}
	// Old ids keep resolving, in every accepted form.
	for _, ref := range []string{caseyPN, "+15550100003", caseyLID} {
		var page core.MessagesPage
		d.get("/v1/messages?chat="+url.QueryEscape(ref), &page)
		if page.Chat.ID != caseyLID || len(page.Messages) != 2 || page.Messages[0].ID != first.ID || page.Messages[1].ID != second.ID {
			t.Fatalf("%s: %+v", ref, page)
		}
	}
	// The per-chat override was rewritten to the new id.
	s := d.acct.Settings()
	if s.Chats[caseyLID] != "full" || s.Chats[caseyPN] != "" {
		t.Fatalf("override rewritten: %+v", s.Chats)
	}
	// Resolve first: a new chat whose hidden id is known is keyed by it from the start.
	d.fake.Map(samLID, samPN)
	d.emit(msg("x", func(m *client.Message) {
		m.Chat, m.ChatType, m.Sender, m.SenderAlt = samPN, client.ChatDirect, samPN, ""
	}))
	d.get("/v1/chats", &list)
	for _, c := range list.Chats {
		if c.ID == samPN {
			t.Fatal("chat keyed by phone-number id although the hidden id was known")
		}
	}
	if len(d.events("?after=0&kind=chat_rekeyed")) != 1 {
		t.Fatal("no second rekey")
	}
}

func TestAmbiguousRefChangesNothing(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	id := nextID()
	d.emit(msg("in one", mention, func(m *client.Message) { m.ID = id }))
	d.emit(msg("in two", mention, func(m *client.Message) { m.ID = id; m.Chat = group2 }))
	er := d.wantError("GET", "/v1/messages/"+id, nil, 409, "ambiguous")
	cands, _ := er["candidates"].([]any)
	if len(cands) != 2 || cands[0] != group+"/"+id || cands[1] != group2+"/"+id {
		t.Fatalf("candidates: %v", er)
	}
	var st1, st2 core.Status
	d.get("/v1/status", &st1)
	d.wantError("POST", "/v1/forget", map[string]string{"id": id}, 409, "ambiguous")
	d.get("/v1/status", &st2)
	if st1.Counts != st2.Counts {
		t.Fatalf("an ambiguous forget changed something: %+v %+v", st1.Counts, st2.Counts)
	}
	// With the chat it is unambiguous.
	var one core.MessageResult
	d.get("/v1/messages/"+url.PathEscape(group2)+"/"+id, &one)
	if one.Message.Text != "in two" {
		t.Fatal(one)
	}
}

func TestSeqSurvivesRestart(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.emit(msg("a", mention))
	d.emit(msg("b", mention))
	before := d.events("?after=0")
	d.stop()
	d = e.start(startOpts{})
	d.emit(msg("c", mention))
	after := d.events("?after=0")
	if len(after) != len(before)+1 {
		t.Fatalf("events after restart: %d vs %d", len(after), len(before))
	}
	for i := 1; i < len(after); i++ {
		if after[i].Seq <= after[i-1].Seq {
			t.Fatal("seq not strictly increasing")
		}
	}
	// Restarting in the same state emits no state event.
	if n := len(d.events("?after=0&kind=state")); n != 1 {
		t.Fatalf("state events: %d", n)
	}
}

func TestWakeFile(t *testing.T) {
	e := newEnv(t)
	e.init()
	wake := filepath.Join(e.vars["HOME"], "wake", "lines")
	os.MkdirAll(filepath.Dir(wake), 0o700)
	d := e.start(startOpts{})
	d.patch(`{"wake_file":"` + wake + `"}`)

	m := d.emit(msg("@Example WAKECONTENT", mention))
	d.emit(msg("own words", fromMe))
	d.fake.Emit(client.StateChange{State: "connecting", Reason: "lost"})
	d.emit(msg("", func(mm *client.Message) { mm.Kind, mm.TargetID, mm.Text = client.KindEdit, m.ID, "edited" }))
	d.emit(msg("", func(mm *client.Message) { mm.Kind, mm.TargetID, mm.Emoji = client.KindReaction, m.ID, "👍" }))
	d.emit(msg("", func(mm *client.Message) { mm.Kind, mm.TargetID = client.KindRevoke, m.ID }))
	d.emit(msg("discarded"))

	data, err := os.ReadFile(wake)
	if err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(wake)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("wake file mode %o", fi.Mode().Perm())
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	var got []string
	for _, l := range lines {
		var w map[string]any
		if err := json.Unmarshal([]byte(l), &w); err != nil || len(w) != 3 || w["account"] != account {
			t.Fatalf("wake line %q", l)
		}
		got = append(got, w["kind"].(string))
		// Written after commit: the event is already readable.
		seq := int64(w["seq"].(float64))
		if evs := d.events(fmt.Sprintf("?after=%d&limit=1", seq-1)); len(evs) != 1 || evs[0].Seq != seq {
			t.Fatalf("wake line for seq %d before its event", seq)
		}
	}
	if strings.Join(got, ",") != "message,edit,reaction,revoke" {
		t.Fatalf("wake kinds: %v (none for own messages or state events)", got)
	}
	if bytes.Contains(data, []byte("WAKECONTENT")) || bytes.Contains(data, []byte(group)) || bytes.Contains(data, []byte(samLID)) {
		t.Fatal("wake lines carry no content, chat or sender")
	}
}

func TestNoKeyMaterialAnywhere(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	keys := []byte("KEYMARKER-0123456789")
	m := d.emit(msg("@Example file", mention, func(mm *client.Message) {
		mm.Media = &client.Media{Type: "document", MIME: "application/pdf", Name: "a.pdf", Keys: keys}
	}))
	// Key material is stored for a later download...
	// ...and never returned by any request.
	d.get("/v1/status", nil)
	d.get("/v1/chats", nil)
	d.get("/v1/events?after=0", nil)
	d.get("/v1/messages?chat="+group, nil)
	d.get("/v1/messages/"+url.PathEscape(group)+"/"+m.ID, nil)
	d.get("/v1/messages/"+m.ID, nil)
	d.wantError("GET", "/v1/messages/"+url.PathEscape(group)+"/nope", nil, 404, "not_found")
	b64 := base64.StdEncoding.EncodeToString(keys)
	for _, body := range d.transcript {
		if bytes.Contains(body, keys) || bytes.Contains(body, []byte(b64)) || bytes.Contains(body, []byte("media_keys")) {
			t.Fatalf("key material in a response: %s", body)
		}
	}
	var one core.MessageResult
	d.get("/v1/messages/"+m.ID, &one)
	if one.Message.Media == nil || one.Message.Media.Name != "a.pdf" {
		t.Fatal("descriptor missing")
	}
}

func TestMarkReadOnKeep(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.patch(`{"read_receipts":"on-keep"}`)
	d.emit(msg("discarded"))
	if d.fake.MarkReadCount() != 0 {
		t.Fatal("a discarded message is never marked read")
	}
	d.emit(msg("@Example", mention))
	if d.fake.MarkReadCount() != 1 {
		t.Fatal("a kept message is marked read")
	}
	d.emit(msg("mine", fromMe))
	if d.fake.MarkReadCount() != 1 {
		t.Fatal("own messages are not marked read")
	}
	d.patch(`{"read_receipts":"off"}`)
	d.emit(msg("@Example again", mention))
	if d.fake.MarkReadCount() != 1 {
		t.Fatal("read_receipts off sends none")
	}
}

func TestRetention(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.patch(`{"retain_days":10}`)
	old := d.emit(msg("@Example old", mention))
	d.emit(msg("", func(m *client.Message) { m.Kind, m.TargetID, m.Emoji = client.KindReaction, old.ID, "👍" }))
	d.clock.Add(11 * 24 * time.Hour)
	fresh := d.emit(msg("@Example fresh", mention, func(m *client.Message) { m.Time = d.clock.Now() }))
	before := d.events("?after=0")
	res, err := d.acct.RunRetention(t.Context())
	if err != nil || res.Messages != 1 || res.Events != 2 {
		t.Fatalf("retention: %+v %v", res, err)
	}
	if d.kept(group, old.ID) || !d.kept(group, fresh.ID) {
		t.Fatal("retention removed the wrong messages")
	}
	for _, ev := range d.events("?after=0") {
		if ev.Message != nil && ev.Message.ID == old.ID || ev.Target == old.ID {
			t.Fatal("events of a removed message remain")
		}
	}
	// Its id is gone too: a late reply is no longer matched by the reply rule.
	late := d.emit(msg("late reply", replyTo(old.ID, samLID, "")))
	if d.kept(group, late.ID) {
		t.Fatal("a late reply to a removed message was kept")
	}
	// seq stays monotonic.
	d.emit(msg("@Example next", mention, func(m *client.Message) { m.Time = d.clock.Now() }))
	after := d.events("?after=0")
	if after[len(after)-1].Seq <= before[len(before)-1].Seq {
		t.Fatal("seq reused after retention")
	}
	// full accounts default to unlimited retention.
	d.patch(`{"retain_days":null,"scope":"full","confirm":true}`)
	d.clock.Add(1000 * 24 * time.Hour)
	if res, _ := d.acct.RunRetention(t.Context()); res.Messages != 0 {
		t.Fatal("full defaults to unlimited")
	}
}

func TestKeptContentNeverLogged(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.emit(msg("@Example LOGMARKER-TEXT", mention, replyTo(nextID(), alexLID, "LOGMARKER-QUOTE"), func(m *client.Message) {
		m.Media = &client.Media{Type: "document", Name: "LOGMARKER-FILE.pdf", Caption: "LOGMARKER-CAPTION"}
	}))
	d.stop()
	if bytes.Contains(e.log.Bytes(), []byte("LOGMARKER")) {
		t.Fatalf("content logged:\n%s", e.log.Bytes())
	}
}
