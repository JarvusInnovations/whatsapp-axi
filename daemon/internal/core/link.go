package core

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/identity"
)

// LinkWindow bounds a whole link attempt: WhatsApp's login window is a little under three
// minutes (specs/daemon.md "By pairing code").
var LinkWindow = 3*time.Minute + 10*time.Second

// LinkLine is one line of the POST /v1/link stream: a pairing code, a QR payload, or the final
// result.
type LinkLine struct {
	Code   string      `json:"code,omitempty"`
	QR     string      `json:"qr,omitempty"`
	Result *LinkResult `json:"result,omitempty"`
}

// LinkResult is the final line of a link stream.
type LinkResult struct {
	Linked bool      `json:"linked"`
	State  string    `json:"state"`
	Me     *User     `json:"me,omitempty"`
	Error  *APIError `json:"error,omitempty"`
}

// LinkBody is the body of POST /v1/link.
type LinkBody struct {
	Phone *string `json:"phone"`
	QR    *bool   `json:"qr"`
}

func conflict(code, state, format string, a ...any) *APIError {
	e := badRequest(format, a...)
	e.Status, e.Code, e.State = http.StatusConflict, code, state
	return e
}

// WhatsAppError is a failure WhatsApp reported, with a cleaned-up reason.
func WhatsAppError(msg string) *APIError {
	return &APIError{Status: http.StatusBadGateway, Code: "whatsapp_error", Message: msg}
}

// OutcomeUnknown is a send whose result the daemon could not determine: it may have gone out.
func OutcomeUnknown(what string) *APIError {
	return &APIError{Status: http.StatusGatewayTimeout, Code: "outcome_unknown", Message: fmt.Sprintf("%s: the daemon could not tell whether WhatsApp accepted it; it may have gone out.", what)}
}

// notConnected is the error of a request that needs a live connection.
func (a *Account) notConnected(what string) *APIError {
	st, _, _ := a.State()
	if st == "unlinked" || st == "logged_out" {
		return conflict("not_linked", st, "%s needs a linked account; this one has no session (state %s).", what, st)
	}
	return conflict("not_connected", st, "%s needs a live connection to WhatsApp; the account is %s.", what, st)
}

// BeginLink validates a link request and claims the single link slot. The caller must call
// RunLink next, which releases it.
func (a *Account) BeginLink(b LinkBody) (client.LinkRequest, error) {
	var req client.LinkRequest
	qr := b.QR != nil && *b.QR
	switch {
	case b.Phone != nil && qr:
		return req, badRequest("Give phone or qr, not both.")
	case b.Phone != nil:
		if !identity.IsPhone(*b.Phone) {
			return req, badRequest("phone must be a phone number in E.164 form, like +15550100001.")
		}
		req.Phone = strings.TrimPrefix(*b.Phone, "+")
	case qr:
		req.QR = true
	default:
		return req, badRequest("Give phone (a phone number in E.164 form) or qr: true.")
	}
	a.linkMu.Lock()
	defer a.linkMu.Unlock()
	if a.linking {
		return req, conflict("link_in_progress", "linking", "A link attempt is already running for this account.")
	}
	st, _, _ := a.State()
	if st != "unlinked" && st != "logged_out" {
		e := badRequest("The account is already linked (state %s). Run auth logout first to link it again.", st)
		e.State = st
		return req, e
	}
	a.linking = true
	return req, nil
}

// RunLink runs a link attempt claimed by BeginLink, reporting each code or QR payload to emit,
// and returns the result. A cancelled ctx (the client went away) abandons the attempt.
func (a *Account) RunLink(ctx context.Context, req client.LinkRequest, emit func(LinkLine)) LinkResult {
	done := false
	// finish records the final state and frees the link slot together, so a new attempt never
	// sees the slot free while the old attempt's state is still being written.
	finish := func(st, why string) {
		a.linkMu.Lock()
		defer a.linkMu.Unlock()
		if err := a.enterState(context.Background(), st, why, false); err != nil {
			a.log.Error("recording a state change failed", "err", err)
		}
		a.linking = false
		done = true
	}
	defer func() {
		if !done {
			a.linkMu.Lock()
			a.linking = false
			a.linkMu.Unlock()
		}
	}()
	reason := "linking by pairing code"
	if req.QR {
		reason = "linking by QR code"
	}
	if err := a.enterState(context.Background(), "linking", reason, false); err != nil {
		a.log.Error("recording a state change failed", "err", err)
	}
	lctx, cancel := context.WithTimeout(ctx, LinkWindow)
	defer cancel()
	err := a.client.Link(lctx, req, func(p client.LinkProgress) {
		emit(LinkLine{Code: p.Code, QR: p.QR})
	})
	if err == nil {
		st, why := a.client.State()
		if st == "linking" || st == "unlinked" || st == "" {
			st, why = "connecting", "linked"
		}
		finish(st, why)
		a.log.Info("linked")
		res := LinkResult{Linked: true, State: st}
		if own := a.own(); own.UserID() != "" {
			res.Me = &User{ID: own.UserID(), LID: own.LID, PN: identity.PhoneOf(own.PN), Me: true}
		}
		return res
	}
	var fail *APIError
	next, why := "unlinked", ""
	switch {
	case errors.Is(err, client.ErrWrongNumber):
		fail = &APIError{Code: "wrong_number", Message: "The phone that completed the link is not the number given to auth link, so the pairing was refused."}
		why = "pairing refused: a different phone number"
	case errors.Is(err, client.ErrOutdated):
		fail = &APIError{Code: "outdated", Message: "WhatsApp rejected this client as too old. Upgrade to a release built on a newer library."}
		next, why = "outdated", "WhatsApp rejected the client as too old"
	case errors.Is(err, client.ErrLinkTimeout), errors.Is(lctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil:
		fail = &APIError{Code: "link_timeout", Message: "The link window closed before the phone completed the link."}
		why = "the link window closed"
	case ctx.Err() != nil:
		fail = &APIError{Code: "link_cancelled", Message: "The link attempt was abandoned because the client went away."}
		why = "the link attempt was abandoned"
	default:
		a.log.Warn("link failed", "err", err)
		fail = &APIError{Code: "whatsapp_error", Message: "WhatsApp failed the link attempt; see the daemon's log."}
		why = "the link attempt failed"
	}
	finish(next, why)
	return LinkResult{Linked: false, State: next, Error: fail}
}

// LogoutResult is the body of a successful POST /v1/logout.
type LogoutResult struct {
	LoggedOut bool   `json:"logged_out"`
	State     string `json:"state"`
}

// Logout unlinks the device and deletes the session. store.db is left as it is.
func (a *Account) Logout(ctx context.Context) (*LogoutResult, error) {
	a.linkMu.Lock()
	linking := a.linking
	a.linkMu.Unlock()
	if linking {
		return nil, conflict("link_in_progress", "linking", "A link attempt is running; wait for it to end.")
	}
	st, _, _ := a.State()
	if st != "connected" {
		return nil, a.notConnected("Logging out")
	}
	if err := a.client.Logout(ctx); err != nil {
		if errors.Is(err, client.ErrNotConnected) {
			return nil, a.notConnected("Logging out")
		}
		a.log.Warn("logout failed", "err", err)
		return nil, WhatsAppError("WhatsApp did not accept the logout; the device is still linked.")
	}
	if err := a.enterState(ctx, "unlinked", "logged out by the operator", false); err != nil {
		return nil, err
	}
	return &LogoutResult{LoggedOut: true, State: "unlinked"}, nil
}

// onConnected announces presence after each connect when the settings ask for it.
func (a *Account) onConnected() {
	if !a.Settings().Presence {
		return
	}
	a.presMu.Lock()
	a.presPending, a.presNoted = true, false
	a.presMu.Unlock()
	go a.announce()
}

// onPushNameReady retries an announcement that waited for the account's own name, which
// WhatsApp delivers through app-state sync some time after connecting.
func (a *Account) onPushNameReady() {
	if !a.Settings().Presence {
		return
	}
	go a.announce()
}

// announce sends presence once per connect. A failure for want of the account's name is
// expected right after linking or starting; it is noted once per connect and retried when the
// name arrives.
func (a *Account) announce() {
	a.presMu.Lock()
	defer a.presMu.Unlock()
	if !a.presPending {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := a.client.SendPresence(ctx)
	switch {
	case err == nil:
		a.presPending = false
		a.log.Info("announced presence")
	case errors.Is(err, client.ErrNoPushName):
		if !a.presNoted {
			a.presNoted = true
			a.log.Info("presence waits for the account's name to sync from the phone")
		}
	case errors.Is(err, client.ErrNotConnected):
		// The next connect tries again.
	default:
		a.presPending = false
		a.log.Warn("announcing presence failed", "err", err)
	}
}
