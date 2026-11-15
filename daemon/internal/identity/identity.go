// Package identity holds the id rules of specs/identity.md: user ids, chat ids, "is this me",
// operators and message refs. Everything here is pure string handling; nothing is inferred
// from the length or shape of digits.
package identity

import (
	"regexp"
	"strings"
)

const (
	ServerPN    = "s.whatsapp.net"
	ServerLID   = "lid"
	ServerGroup = "g.us"
)

var (
	phoneRe = regexp.MustCompile(`^\+[1-9][0-9]{1,14}$`)
	lidRe   = regexp.MustCompile(`^[0-9]+@lid$`)
	pnRe    = regexp.MustCompile(`^[0-9]+@s\.whatsapp\.net$`)
	groupRe = regexp.MustCompile(`^[0-9]+(-[0-9]+)?@g\.us$`)
)

// NonAD strips a device or agent suffix from a JID ("user.agent:device@server" to "user@server").
// It returns "" for something that is not a JID.
func NonAD(jid string) string {
	at := strings.LastIndexByte(jid, '@')
	if at <= 0 || at == len(jid)-1 {
		return ""
	}
	user, server := jid[:at], jid[at+1:]
	if server != ServerGroup {
		if i := strings.IndexAny(user, ".:"); i >= 0 {
			user = user[:i]
		}
	}
	if user == "" {
		return ""
	}
	return user + "@" + server
}

// Server returns the server part of a JID.
func Server(jid string) string {
	if at := strings.LastIndexByte(jid, '@'); at >= 0 {
		return jid[at+1:]
	}
	return ""
}

func IsLID(jid string) bool   { return lidRe.MatchString(jid) }
func IsPN(jid string) bool    { return pnRe.MatchString(jid) }
func IsGroup(jid string) bool { return groupRe.MatchString(jid) }

// IsUser reports whether jid is a user id in either form.
func IsUser(jid string) bool { return IsLID(jid) || IsPN(jid) }

// IsPhone reports whether s is a phone number in E.164 form.
func IsPhone(s string) bool { return phoneRe.MatchString(s) }

// PhoneOf returns "+<digits>" for a phone-number id, or "".
func PhoneOf(pnJID string) string {
	if !IsPN(pnJID) {
		return ""
	}
	return "+" + strings.TrimSuffix(pnJID, "@"+ServerPN)
}

// PNOfPhone returns the phone-number id of an E.164 number, or "".
func PNOfPhone(phone string) string {
	if !IsPhone(phone) {
		return ""
	}
	return phone[1:] + "@" + ServerPN
}

// Own is the account's own pair of ids, both device-free; either may be empty.
type Own struct {
	PN  string
	LID string
}

// IsMe compares a JID against both of the account's ids. It works when the hidden id is unknown.
func (o Own) IsMe(jid string) bool {
	n := NonAD(jid)
	if n == "" {
		return false
	}
	return (o.PN != "" && n == o.PN) || (o.LID != "" && n == o.LID)
}

// UserID returns the hidden id when known, otherwise the phone-number id.
func (o Own) UserID() string {
	if o.LID != "" {
		return o.LID
	}
	return o.PN
}

// ValidOperator reports whether s is an operator entry: an E.164 number or a hidden id.
func ValidOperator(s string) bool { return IsPhone(s) || IsLID(s) }

// IsOperator applies the operator rule. lid and pn are the sender's two ids as known (either may
// be empty). An unknown mapping fails closed: a sender known only by hidden id matches only if
// that hidden id is listed.
func IsOperator(lid, pn string, operators []string) bool {
	phone := PhoneOf(pn)
	for _, op := range operators {
		if lid != "" && op == lid {
			return true
		}
		if phone != "" && op == phone {
			return true
		}
	}
	return false
}

// SplitRef splits a message ref into chat and id. A bare id returns chat "".
func SplitRef(ref string) (chat, id string) {
	if i := strings.LastIndexByte(ref, '/'); i >= 0 {
		return ref[:i], ref[i+1:]
	}
	return "", ref
}
