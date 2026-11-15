package core

import (
	"crypto/sha256"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/settings"
)

// limiter holds the send limits' memory (specs/sending.md "Send limits"): the times of recent
// sends and reactions, and a hash of each recent text with the chats it went to. It lives in
// memory only.
type limiter struct {
	mu    sync.Mutex
	sends []time.Time
	texts map[[32]byte][]textUse
}

type textUse struct {
	chat string
	t    time.Time
}

const sameTextWindow = 10 * time.Minute

func newLimiter() *limiter { return &limiter{texts: map[[32]byte][]textUse{}} }

func textHash(text string) [32]byte { return sha256.Sum256([]byte(strings.TrimSpace(text))) }

func (l *limiter) prune(now time.Time) {
	i := 0
	for i < len(l.sends) && now.Sub(l.sends[i]) >= time.Hour {
		i++
	}
	l.sends = l.sends[i:]
	for h, uses := range l.texts {
		keep := uses[:0]
		for _, u := range uses {
			if now.Sub(u.t) < sameTextWindow {
				keep = append(keep, u)
			}
		}
		if len(keep) == 0 {
			delete(l.texts, h)
		} else {
			l.texts[h] = keep
		}
	}
}

// check refuses a send that would break a rate or same-text limit. text is "" for a send that
// carries no text (a reaction, a file without caption).
func (l *limiter) check(now time.Time, lim settings.Send, chat, text string) *APIError {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(now)
	retry := func(oldest time.Time, window time.Duration) int {
		s := int(oldest.Add(window).Sub(now).Seconds() + 0.999)
		if s < 1 {
			s = 1
		}
		return s
	}
	var lastMinute []time.Time
	for _, t := range l.sends {
		if now.Sub(t) < time.Minute {
			lastMinute = append(lastMinute, t)
		}
	}
	if len(lastMinute) >= lim.PerMinute {
		return &APIError{Status: http.StatusTooManyRequests, Code: "rate_limited", RetryAfter: retry(lastMinute[len(lastMinute)-lim.PerMinute], time.Minute),
			Message: "The account has reached its limit of sends per minute (send.per_minute)."}
	}
	if len(l.sends) >= lim.PerHour {
		return &APIError{Status: http.StatusTooManyRequests, Code: "rate_limited", RetryAfter: retry(l.sends[len(l.sends)-lim.PerHour], time.Hour),
			Message: "The account has reached its limit of sends per hour (send.per_hour)."}
	}
	if strings.TrimSpace(text) != "" {
		chats := map[string]bool{}
		for _, u := range l.texts[textHash(text)] {
			chats[u.chat] = true
		}
		if !chats[chat] && len(chats) >= lim.SameTextChats {
			return &APIError{Status: http.StatusTooManyRequests, Code: "duplicate_text",
				Message: "The same text already went to the most chats allowed in ten minutes (send.same_text_chats)."}
		}
	}
	return nil
}

// record counts a send that went to the client.
func (l *limiter) record(now time.Time, chat, text string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sends = append(l.sends, now)
	if strings.TrimSpace(text) != "" {
		h := textHash(text)
		l.texts[h] = append(l.texts[h], textUse{chat: chat, t: now})
	}
}
