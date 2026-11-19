package wa

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/socket"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
)

// TestSendErr: once the frame is written, only the server's refusal is a definite failure;
// everything else is ErrOutcomeUnknown. An error before the write is definite
// (specs/sending.md "After the frame is written, only a refusal is a failure").
func TestSendErr(t *testing.T) {
	before := whatsmeow.MessageDebugTimings{Marshal: time.Millisecond}
	written := whatsmeow.MessageDebugTimings{Marshal: time.Millisecond, Send: time.Millisecond}
	answered := whatsmeow.MessageDebugTimings{Send: time.Millisecond, Resp: time.Millisecond}
	retried := whatsmeow.MessageDebugTimings{Send: time.Millisecond, Resp: time.Millisecond, Retry: time.Millisecond}
	disc := &whatsmeow.DisconnectedError{Action: "message send"}

	unknown := []struct {
		name string
		err  error
		t    whatsmeow.MessageDebugTimings
	}{
		{"no answer in time", whatsmeow.ErrMessageTimedOut, written},
		{"wait cut short", fmt.Errorf("wrapped: %w", context.Canceled), written},
		{"deadline", context.DeadlineExceeded, written},
		{"disconnected, no reconnect within 5s", disc, answered},
		{"disconnected on the retry", &whatsmeow.DisconnectedError{Action: "message send (retry)"}, retried},
		{"not connected when retrying", whatsmeow.ErrNotConnected, answered},
		{"retry write failed", errors.New("failed to write: broken pipe"), retried},
		{"retry timed out", whatsmeow.ErrIQTimedOut, retried},
		{"write cut short", fmt.Errorf("failed to send message node: %w", errors.New("broken pipe")), written},
		{"write cancelled", fmt.Errorf("failed to send message node: %w", context.Canceled), written},
		// Timings missing is no excuse for calling a disconnect or a timeout definite.
		{"disconnect without timings", disc, whatsmeow.MessageDebugTimings{}},
		{"timeout without timings", whatsmeow.ErrMessageTimedOut, whatsmeow.MessageDebugTimings{}},
	}
	for _, c := range unknown {
		if !errors.Is(sendErr(c.err, c.t), client.ErrOutcomeUnknown) {
			t.Errorf("%s: %v is not outcome unknown", c.name, c.err)
		}
	}

	definite := []struct {
		name string
		err  error
		t    whatsmeow.MessageDebugTimings
	}{
		{"server refused", fmt.Errorf("%w 479", whatsmeow.ErrServerReturnedError), answered},
		{"server refused after a retry", fmt.Errorf("%w 400", whatsmeow.ErrServerReturnedError), retried},
		{"not logged in", whatsmeow.ErrNotLoggedIn, whatsmeow.MessageDebugTimings{}},
		{"encryption failed", errors.New("failed to encrypt group message to send x to y: no session"), before},
		{"recipient lookup", fmt.Errorf("%w: no LID found", whatsmeow.ErrRecipientNotOnWhatsApp), whatsmeow.MessageDebugTimings{}},
		{"lookup timed out before the write", fmt.Errorf("failed to get group members: %w", whatsmeow.ErrIQTimedOut), before},
		{"cancelled before the write", context.Canceled, before},
		{"no socket at the write", fmt.Errorf("failed to send message node: %w", whatsmeow.ErrNotConnected), written},
		{"socket closed at the write", fmt.Errorf("failed to send message node: %w", socket.ErrSocketClosed), written},
		{"frame too large", fmt.Errorf("failed to send message node: %w", socket.ErrFrameTooLarge), written},
		{"upload refused", errors.New("upload: refused"), whatsmeow.MessageDebugTimings{}},
	}
	for _, c := range definite {
		if errors.Is(sendErr(c.err, c.t), client.ErrOutcomeUnknown) {
			t.Errorf("%s: %v is outcome unknown", c.name, c.err)
		}
	}
}
