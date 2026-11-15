package core

import (
	"fmt"
	"net/http"
	"time"
)

// User is a user object (identity.md "User ids").
type User struct {
	ID       string `json:"id"`
	LID      string `json:"lid,omitempty"`
	PN       string `json:"pn,omitempty"`
	Name     string `json:"name"`
	Me       bool   `json:"me"`
	Operator bool   `json:"operator"`
	Contact  *bool  `json:"contact,omitempty"`
}

// MediaView is a media descriptor as returned. It never carries key material.
type MediaView struct {
	Type     string `json:"type"`
	MIME     string `json:"mime"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	ViewOnce bool   `json:"view_once,omitempty"`
}

// ReplyView is the parent of a reply as carried in it.
type ReplyView struct {
	ID   string `json:"id"`
	From *User  `json:"from,omitempty"`
	Text string `json:"text"`
	Kept bool   `json:"kept"`
}

// Reaction is one reaction on a kept message.
type Reaction struct {
	From  User   `json:"from"`
	Emoji string `json:"emoji"`
}

// MessageView is a message as returned in events and responses (events.md "Message fields").
type MessageView struct {
	ID         string     `json:"id"`
	From       User       `json:"from"`
	T          string     `json:"t,omitempty"`
	Text       string     `json:"text"`
	KeptBy     string     `json:"kept_by,omitempty"`
	Partial    bool       `json:"partial,omitempty"`
	MentionsMe bool       `json:"mentions_me"`
	Mentions   []User     `json:"mentions,omitempty"`
	ReplyTo    *ReplyView `json:"reply_to,omitempty"`
	Media      *MediaView `json:"media,omitempty"`
	Ephemeral  uint32     `json:"ephemeral,omitempty"`
	Edited     bool       `json:"edited,omitempty"`
	Deleted    bool       `json:"deleted,omitempty"`
	Reactions  []Reaction `json:"reactions,omitempty"`
	// Status is set only for the account's own message that is not (yet) sent: pending or failed.
	Status string `json:"status,omitempty"`
}

// ChatRef is the chat object carried on events.
type ChatRef struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Name string `json:"name"`
}

// Event is one event record (events.md "The record").
type Event struct {
	Seq     int64        `json:"seq"`
	T       string       `json:"t"`
	Kind    string       `json:"kind"`
	Account string       `json:"account"`
	Chat    *ChatRef     `json:"chat,omitempty"`
	Message *MessageView `json:"message,omitempty"`
	Edited  bool         `json:"edited,omitempty"`
	Target  string       `json:"target,omitempty"`
	From    *User        `json:"from,omitempty"`
	Emoji   *string      `json:"emoji,omitempty"`
	State   string       `json:"state,omitempty"`
	Reason  string       `json:"reason,omitempty"`
	Old     string       `json:"old,omitempty"`
	New     string       `json:"new,omitempty"`
}

// ChatSummary is one row of GET /v1/chats.
type ChatSummary struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	Scope     string  `json:"scope"`
	Override  string  `json:"override,omitempty"`
	LastKept  *string `json:"last_kept"`
	Discarded int64   `json:"discarded"`
	Messages  int64   `json:"messages"`
}

// ChatDetail is GET /v1/chats/{chat}.
type ChatDetail struct {
	ChatSummary
	Aliases      []string `json:"aliases,omitempty"`
	Participants []User   `json:"participants"`
}

// Event kinds.
const (
	KindMessage     = "message"
	KindEdit        = "edit"
	KindRevoke      = "revoke"
	KindReaction    = "reaction"
	KindState       = "state"
	KindChatRekeyed = "chat_rekeyed"
)

// Kinds lists every event kind.
var Kinds = []string{KindMessage, KindEdit, KindRevoke, KindReaction, KindState, KindChatRekeyed}

// wakeKinds are the kinds that append a wake line.
var wakeKinds = map[string]bool{KindMessage: true, KindEdit: true, KindRevoke: true, KindReaction: true}

// APIError is a failed request (socket-protocol.md "Errors").
type APIError struct {
	Status     int      `json:"-"`
	Code       string   `json:"code"`
	Message    string   `json:"message"`
	State      string   `json:"state,omitempty"`
	Candidates []string `json:"candidates,omitempty"`
	RetryAfter int      `json:"retry_after_seconds,omitempty"`
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

func badRequest(format string, a ...any) *APIError {
	return &APIError{Status: http.StatusBadRequest, Code: "bad_request", Message: fmt.Sprintf(format, a...)}
}

func notFound(format string, a ...any) *APIError {
	return &APIError{Status: http.StatusNotFound, Code: "not_found", Message: fmt.Sprintf(format, a...)}
}

// BadRequest builds a bad_request error.
func BadRequest(format string, a ...any) *APIError { return badRequest(format, a...) }

// Internal is the body of every unexpected failure: no paths, no content.
var Internal = &APIError{Status: http.StatusInternalServerError, Code: "internal", Message: "Internal error in the daemon; see its log."}

func rfc3339(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func ms(t time.Time) int64 { return t.UnixMilli() }

func fromMS(v int64) time.Time { return time.UnixMilli(v).UTC() }
