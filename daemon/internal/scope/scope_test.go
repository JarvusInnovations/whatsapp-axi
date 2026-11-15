package scope

import (
	"testing"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/identity"
)

// Invented ids only.
const (
	group    = "120363000000000001@g.us"
	ownPN    = "15550100000@s.whatsapp.net"
	ownLID   = "100000000000000@lid"
	otherLID = "100000000000001@lid"
	otherPN  = "15550100001@s.whatsapp.net"
)

var own = identity.Own{PN: ownPN, LID: ownLID}

type kept map[string]string // id -> kept_by

func (k kept) lookup(chat, id string) (string, bool) {
	if chat != group && chat != otherLID {
		return "", false
	}
	by, ok := k[id]
	return by, ok
}

func groupMsg(mod func(*client.Message)) *client.Message {
	m := &client.Message{Kind: client.KindMessage, Chat: group, ChatType: client.ChatGroup, ID: "3EB0AAAA0000000100", Sender: otherLID, Text: "hello"}
	if mod != nil {
		mod(m)
	}
	return m
}

func dmMsg(mod func(*client.Message)) *client.Message {
	m := &client.Message{Kind: client.KindMessage, Chat: otherLID, ChatType: client.ChatDirect, ID: "3EB0AAAA0000000200", Sender: otherLID, Text: "hi"}
	if mod != nil {
		mod(m)
	}
	return m
}

func decide(m *client.Message, k kept, mod func(*Input)) Result {
	in := Input{Msg: m, ChatID: identity.NonAD(m.Chat), ChatForms: []string{identity.NonAD(m.Chat)}, Own: own, AccountScope: "tagged", DMFrom: "operators", Kept: k.lookup}
	if mod != nil {
		mod(&in)
	}
	return Decide(in)
}

func expect(t *testing.T, name string, r Result, action Action, by string) {
	t.Helper()
	if r.Action != action || r.KeptBy != by {
		t.Errorf("%s: got %s/%q, want %s/%q", name, r.Action, r.KeptBy, action, by)
	}
}

func TestTaggedMention(t *testing.T) {
	expect(t, "no mention", decide(groupMsg(nil), nil, nil), Discard, "")
	expect(t, "mention by phone-number id", decide(groupMsg(func(m *client.Message) { m.Mentions = []string{ownPN} }), nil, nil), Keep, ByMention)
	expect(t, "mention by hidden id", decide(groupMsg(func(m *client.Message) { m.Mentions = []string{ownLID} }), nil, nil), Keep, ByMention)
	expect(t, "mention with device suffix", decide(groupMsg(func(m *client.Message) { m.Mentions = []string{"100000000000000:3@lid"} }), nil, nil), Keep, ByMention)
	expect(t, "mention of someone else", decide(groupMsg(func(m *client.Message) { m.Mentions = []string{otherLID} }), nil, nil), Discard, "")
	expect(t, "mention on a caption", decide(groupMsg(func(m *client.Message) {
		m.Text = ""
		m.Media = &client.Media{Type: "image", Caption: "look"}
		m.Mentions = []string{ownLID}
	}), nil, nil), Keep, ByMention)
	expect(t, "name in text is not a mention", decide(groupMsg(func(m *client.Message) { m.Text = "@15550100000 @Example" }), nil, nil), Discard, "")
	// The hidden id unknown: a mention by phone-number id still works.
	r := decide(groupMsg(func(m *client.Message) { m.Mentions = []string{ownPN} }), nil, func(in *Input) { in.Own = identity.Own{PN: ownPN} })
	expect(t, "hidden id unknown", r, Keep, ByMention)
}

func TestTaggedParentPull(t *testing.T) {
	reply := func(parent string, mention bool) *client.Message {
		return groupMsg(func(m *client.Message) {
			m.ReplyTo = &client.Quoted{ID: parent, Sender: otherPN, Text: "parent"}
			if mention {
				m.Mentions = []string{ownLID}
			}
		})
	}
	r := decide(reply("P1", true), nil, nil)
	expect(t, "mentioning reply to a discarded parent", r, Keep, ByMention)
	if !r.PullParent {
		t.Error("mentioning reply to a discarded parent must pull the parent in")
	}
	r = decide(reply("P1", true), kept{"P1": ByOwn}, nil)
	if r.PullParent {
		t.Error("an already-kept parent is left as it is")
	}
	r = decide(reply("P1", false), nil, nil)
	expect(t, "non-mentioning reply to a discarded parent", r, Discard, "")
	if r.PullParent {
		t.Error("a non-mentioning reply does not pull its parent in")
	}
	// A reply quoting a parent in another chat is not a reply in this chat.
	r = decide(groupMsg(func(m *client.Message) {
		m.ReplyTo = &client.Quoted{ID: "P1", Chat: "120363000000000009@g.us"}
		m.Mentions = []string{ownLID}
	}), nil, nil)
	if r.PullParent {
		t.Error("a parent in another chat is not pulled in")
	}
}

func TestTaggedReplyRule(t *testing.T) {
	r := func(parent string) *client.Message {
		return groupMsg(func(m *client.Message) { m.ReplyTo = &client.Quoted{ID: parent} })
	}
	k := kept{"M": ByMention, "R": ByReply, "O": ByOwn, "P": ByParent, "F": ByFull}
	expect(t, "reply to a mention", decide(r("M"), k, nil), Keep, ByReply)
	expect(t, "reply to a reply", decide(r("R"), k, nil), Keep, ByReply)
	expect(t, "reply to own message", decide(r("O"), k, nil), Keep, ByReply)
	expect(t, "sibling reply to a rule-2 parent", decide(r("P"), k, nil), Discard, "")
	expect(t, "reply to a message kept under full", decide(r("F"), k, nil), Discard, "")
	expect(t, "reply to an unkept message", decide(r("X"), k, nil), Discard, "")

	// Reply chains several levels deep under the mentioning reply.
	chain := kept{"M": ByMention}
	prev := "M"
	for i, id := range []string{"C1", "C2", "C3", "C4"} {
		res := decide(r(prev), chain, nil)
		expect(t, "chain level "+string(rune('1'+i)), res, Keep, ByReply)
		chain[id] = res.KeptBy
		prev = id
	}
}

func TestTaggedOwn(t *testing.T) {
	expect(t, "own message", decide(groupMsg(func(m *client.Message) { m.FromMe = true; m.Sender = ownLID }), nil, nil), Keep, ByOwn)
	// Order mention, reply, own.
	expect(t, "own reply into a thread", decide(groupMsg(func(m *client.Message) {
		m.FromMe = true
		m.ReplyTo = &client.Quoted{ID: "M"}
	}), kept{"M": ByMention}, nil), Keep, ByReply)
	// Own messages are kept under every scope and override.
	for _, sc := range []string{"full", "tagged", "dm-only"} {
		expect(t, "own in "+sc, decide(groupMsg(func(m *client.Message) { m.FromMe = true }), nil, func(in *Input) { in.AccountScope = sc }), Keep, ByOwn)
	}
	expect(t, "own under override none", decide(groupMsg(func(m *client.Message) { m.FromMe = true }), nil, func(in *Input) { in.Override = "none" }), Keep, ByOwn)
	expect(t, "own direct message", decide(dmMsg(func(m *client.Message) { m.FromMe = true }), nil, nil), Keep, ByOwn)
}

func TestEditsRevokesReactions(t *testing.T) {
	edit := func(target string, mention bool) *client.Message {
		return groupMsg(func(m *client.Message) {
			m.Kind = client.KindEdit
			m.TargetID = target
			if mention {
				m.Mentions = []string{ownLID}
			}
		})
	}
	expect(t, "edit of a kept message", decide(edit("M", false), kept{"M": ByMention}, nil), Edit, "")
	expect(t, "edit adding a mention to an unkept message", decide(edit("X", true), nil, nil), Keep, ByMention)
	expect(t, "edit of an unkept message", decide(edit("X", false), nil, nil), Discard, "")
	r := decide(edit("P", true), kept{"P": ByParent}, nil)
	if r.Action != Edit || !r.MentionsMe {
		t.Errorf("edit adding a mention to a rule-2 parent: %+v", r)
	}

	rev := func(target string) *client.Message {
		return groupMsg(func(m *client.Message) { m.Kind = client.KindRevoke; m.TargetID = target })
	}
	expect(t, "revoke of a kept message", decide(rev("M"), kept{"M": ByMention}, nil), Revoke, "")
	expect(t, "revoke of an unkept message", decide(rev("X"), nil, nil), Discard, "")

	react := func(target string) *client.Message {
		return groupMsg(func(m *client.Message) { m.Kind = client.KindReaction; m.TargetID = target; m.Emoji = "👍" })
	}
	expect(t, "reaction to a kept message", decide(react("M"), kept{"M": ByMention}, nil), React, "")
	expect(t, "reaction to an unkept message", decide(react("X"), nil, nil), Discard, "")

	enc := groupMsg(func(m *client.Message) { m.Kind = client.KindEncrypted; m.ChatType = client.ChatCommunityAnnounce })
	expect(t, "encrypted reaction in an announcement group", decide(enc, kept{"3EB0AAAA0000000100": ByMention}, nil), Discard, "")
}

func TestDMFrom(t *testing.T) {
	expect(t, "operators: from an operator", decide(dmMsg(nil), nil, func(in *Input) { in.SenderIsOperator = true }), Keep, ByDM)
	expect(t, "operators: from a non-operator", decide(dmMsg(nil), nil, nil), Discard, "")
	expect(t, "anyone: from a non-operator", decide(dmMsg(nil), nil, func(in *Input) { in.DMFrom = "anyone" }), Keep, ByDM)
	expect(t, "dm-only: operator", decide(dmMsg(nil), nil, func(in *Input) { in.AccountScope = "dm-only"; in.SenderIsOperator = true }), Keep, ByDM)
	expect(t, "dm-only: non-operator", decide(dmMsg(nil), nil, func(in *Input) { in.AccountScope = "dm-only" }), Discard, "")
	expect(t, "full ignores dm_from", decide(dmMsg(nil), nil, func(in *Input) { in.AccountScope = "full" }), Keep, ByFull)
}

func TestAccountScopes(t *testing.T) {
	expect(t, "full group", decide(groupMsg(nil), nil, func(in *Input) { in.AccountScope = "full" }), Keep, ByFull)
	expect(t, "dm-only group with a mention", decide(groupMsg(func(m *client.Message) { m.Mentions = []string{ownLID} }), nil, func(in *Input) { in.AccountScope = "dm-only" }), Discard, "")
}

func TestOverrides(t *testing.T) {
	mention := func(m *client.Message) { m.Mentions = []string{ownLID} }
	expect(t, "group override full under tagged", decide(groupMsg(nil), nil, func(in *Input) { in.Override = "full" }), Keep, ByFull)
	expect(t, "group override none under full", decide(groupMsg(mention), nil, func(in *Input) { in.AccountScope = "full"; in.Override = "none" }), Discard, "")
	expect(t, "group override tagged under full", decide(groupMsg(nil), nil, func(in *Input) { in.AccountScope = "full"; in.Override = "tagged" }), Discard, "")
	expect(t, "group override tagged under full, mention", decide(groupMsg(mention), nil, func(in *Input) { in.AccountScope = "full"; in.Override = "tagged" }), Keep, ByMention)
	expect(t, "group override tagged under dm-only", decide(groupMsg(mention), nil, func(in *Input) { in.AccountScope = "dm-only"; in.Override = "tagged" }), Keep, ByMention)
	expect(t, "direct override full", decide(dmMsg(nil), nil, func(in *Input) { in.Override = "full" }), Keep, ByFull)
	expect(t, "direct override none, operator", decide(dmMsg(nil), nil, func(in *Input) { in.Override = "none"; in.SenderIsOperator = true }), Discard, "")
	r := decide(groupMsg(nil), nil, nil)
	if !r.Tagged {
		t.Error("a tagged group discard must be marked for the buffer")
	}
	r = decide(groupMsg(nil), nil, func(in *Input) { in.AccountScope = "dm-only" })
	if r.Tagged {
		t.Error("a dm-only group discard is not buffered")
	}
}

func TestUnsupportedChatTypes(t *testing.T) {
	for _, ct := range []client.ChatType{client.ChatStatus, client.ChatBroadcast, client.ChatNewsletter, client.ChatUnknown} {
		for _, sc := range []string{"full", "tagged", "dm-only"} {
			r := decide(groupMsg(func(m *client.Message) { m.ChatType = ct; m.FromMe = true; m.Mentions = []string{ownLID} }), nil, func(in *Input) { in.AccountScope = sc })
			if r.Action != Discard || !r.Unsupported {
				t.Errorf("%s under %s: %+v", ct, sc, r)
			}
		}
	}
	// A community announcement group is a group.
	expect(t, "announcement group mention", decide(groupMsg(func(m *client.Message) {
		m.ChatType = client.ChatCommunityAnnounce
		m.Mentions = []string{ownLID}
	}), nil, nil), Keep, ByMention)
}
