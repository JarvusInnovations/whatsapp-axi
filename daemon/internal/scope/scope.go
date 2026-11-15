// Package scope is the scope filter of specs/scopes.md: a pure function over an incoming message,
// the account's ids, the settings that apply to the chat and a lookup of kept messages. It
// decides; it writes nothing.
package scope

import (
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/identity"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/settings"
)

// Why a message was kept (events.md "kept_by").
const (
	ByMention = "mention"
	ByParent  = "parent"
	ByReply   = "reply"
	ByOwn     = "own"
	ByDM      = "dm"
	ByFull    = "full"
)

// Action is what the daemon does with an incoming message.
type Action int

const (
	Discard Action = iota
	Keep           // keep as a new message
	Edit           // update a kept message
	Revoke         // erase a kept message
	React          // record a reaction on a kept message
)

func (a Action) String() string {
	return [...]string{"discard", "keep", "edit", "revoke", "react"}[a]
}

// Lookup reports whether a message is kept in a chat, and why.
type Lookup func(chat, id string) (keptBy string, kept bool)

// Input is everything the decision depends on.
type Input struct {
	Msg *client.Message
	// ChatID is the canonical chat id; ChatForms are every id the chat is known by (including
	// ChatID), used to tell whether a quoted parent is in the same chat.
	ChatID    string
	ChatForms []string
	Own       identity.Own
	// SenderIsOperator is the operator mark of the sender (identity.md "Operators").
	SenderIsOperator bool
	// AccountScope, DMFrom and Override come from the settings; Override is "" when the chat has
	// none.
	AccountScope string
	DMFrom       string
	Override     string
	Kept         Lookup
}

// Result is the decision.
type Result struct {
	Action     Action
	KeptBy     string // for Keep
	MentionsMe bool
	// PullParent is set when a kept message is a reply that mentions the account and its parent
	// is not kept: the parent is to be kept by rule 2 (scopes.md "The parent of a mention").
	PullParent bool
	// Unsupported is set for chat types that are always discarded; they share one counter.
	Unsupported bool
	// Tagged is set when the chat is a group under tagged scope (the recent-message buffer
	// applies to its discards).
	Tagged bool
}

// MentionsMe reports whether a mention list contains either of the account's ids.
func MentionsMe(own identity.Own, mentions []string) bool {
	for _, m := range mentions {
		if own.IsMe(m) {
			return true
		}
	}
	return false
}

// EffectiveScope is the scope that applies to a chat: the override, else the account scope.
func EffectiveScope(accountScope, override string) string {
	if override != "" {
		return override
	}
	return accountScope
}

func isGroupType(t client.ChatType) bool {
	return t == client.ChatGroup || t == client.ChatCommunityAnnounce
}

// Decide applies the scope rules.
func Decide(in Input) Result {
	m := in.Msg
	switch m.ChatType {
	case client.ChatDirect, client.ChatGroup, client.ChatCommunityAnnounce:
	default:
		return Result{Action: Discard, Unsupported: true}
	}
	eff := EffectiveScope(in.AccountScope, in.Override)
	tagged := isGroupType(m.ChatType) && eff == settings.ScopeTagged

	switch m.Kind {
	case client.KindEncrypted:
		return Result{Action: Discard, Tagged: tagged}
	case client.KindRevoke:
		if _, ok := in.Kept(in.ChatID, m.TargetID); ok {
			return Result{Action: Revoke}
		}
		return Result{Action: Discard, Tagged: tagged}
	case client.KindReaction:
		if _, ok := in.Kept(in.ChatID, m.TargetID); ok {
			return Result{Action: React}
		}
		return Result{Action: Discard, Tagged: tagged}
	case client.KindEdit:
		if _, ok := in.Kept(in.ChatID, m.TargetID); ok {
			return Result{Action: Edit, MentionsMe: MentionsMe(in.Own, m.Mentions)}
		}
		// Not kept: the edited content is judged as a message with the original id.
		r := decideContent(in, eff, tagged)
		return r
	case client.KindMessage:
		return decideContent(in, eff, tagged)
	}
	return Result{Action: Discard, Tagged: tagged}
}

func decideContent(in Input, eff string, tagged bool) Result {
	m := in.Msg
	mentionsMe := MentionsMe(in.Own, m.Mentions)
	keep := func(by string) Result {
		return Result{Action: Keep, KeptBy: by, MentionsMe: mentionsMe, Tagged: tagged}
	}
	discard := Result{Action: Discard, MentionsMe: mentionsMe, Tagged: tagged}

	if m.ChatType == client.ChatDirect {
		if m.FromMe {
			return keep(ByOwn)
		}
		switch eff {
		case settings.ScopeFull:
			return keep(ByFull)
		case settings.OverrideNone:
			return discard
		}
		if in.DMFrom == "anyone" || in.SenderIsOperator {
			return keep(ByDM)
		}
		return discard
	}

	// Groups.
	switch eff {
	case settings.ScopeFull:
		if m.FromMe {
			return keep(ByOwn)
		}
		return keep(ByFull)
	case settings.OverrideNone, settings.ScopeDMOnly:
		if m.FromMe {
			return keep(ByOwn)
		}
		return discard
	}

	// Tagged: mention, (parent is decided on the mentioning reply), reply, own.
	parentKept, parentKeptBy := false, ""
	sameChat := m.ReplyTo != nil && m.ReplyTo.ID != "" && in.sameChat(m.ReplyTo.Chat)
	if sameChat {
		parentKeptBy, parentKept = in.Kept(in.ChatID, m.ReplyTo.ID)
	}
	if mentionsMe {
		r := keep(ByMention)
		r.PullParent = sameChat && !parentKept
		return r
	}
	if parentKept && (parentKeptBy == ByMention || parentKeptBy == ByReply || parentKeptBy == ByOwn) {
		return keep(ByReply)
	}
	if m.FromMe {
		return keep(ByOwn)
	}
	return discard
}

func (in Input) sameChat(quotedChat string) bool {
	if quotedChat == "" {
		return true
	}
	q := identity.NonAD(quotedChat)
	for _, f := range in.ChatForms {
		if q == f {
			return true
		}
	}
	return false
}
