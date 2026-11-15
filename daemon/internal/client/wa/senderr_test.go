package wa

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"go.mau.fi/whatsmeow"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
)

// TestSendErr: errors after which a message may have gone out are ErrOutcomeUnknown; a refusal
// is not.
func TestSendErr(t *testing.T) {
	for _, err := range []error{whatsmeow.ErrMessageTimedOut, whatsmeow.ErrIQTimedOut, context.DeadlineExceeded, fmt.Errorf("wrapped: %w", context.Canceled)} {
		if !errors.Is(sendErr(err), client.ErrOutcomeUnknown) {
			t.Errorf("%v is not outcome unknown", err)
		}
	}
	for _, err := range []error{whatsmeow.ErrServerReturnedError, errors.New("upload: refused")} {
		if errors.Is(sendErr(err), client.ErrOutcomeUnknown) {
			t.Errorf("%v is outcome unknown", err)
		}
	}
}
