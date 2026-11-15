// Package server is the daemon's socket: HTTP/1.1 with JSON bodies over a Unix socket, with the
// peer's user id checked on every connection (specs/socket-protocol.md).
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/core"
)

// PeerUID returns the user id of the process at the other end of a Unix connection.
type PeerUID func(net.Conn) (int, error)

// Server serves one account.
type Server struct {
	acct *core.Account
	log  *slog.Logger
	mux  *http.ServeMux
}

// New builds the handler set.
func New(acct *core.Account, log *slog.Logger) *Server {
	s := &Server{acct: acct, log: log, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /v1/status", s.status)
	s.mux.HandleFunc("GET /v1/settings", s.getSettings)
	s.mux.HandleFunc("PATCH /v1/settings", s.patchSettings)
	s.mux.HandleFunc("GET /v1/chats", s.chats)
	s.mux.HandleFunc("GET /v1/chats/{chat}", s.chat)
	s.mux.HandleFunc("GET /v1/groups", s.groups)
	s.mux.HandleFunc("GET /v1/events", s.events)
	s.mux.HandleFunc("GET /v1/messages", s.messages)
	s.mux.HandleFunc("GET /v1/messages/{id}", s.message)
	s.mux.HandleFunc("GET /v1/messages/{chat}/{id}", s.message)
	s.mux.HandleFunc("POST /v1/forget", s.forget)
	s.mux.HandleFunc("POST /v1/mark-read", s.markRead)
	s.mux.HandleFunc("POST /v1/typing", s.typing)
	s.mux.HandleFunc("POST /v1/link", s.link)
	s.mux.HandleFunc("POST /v1/logout", s.logout)
	s.mux.HandleFunc("POST /v1/send", s.send)
	s.mux.HandleFunc("POST /v1/send-file", s.sendFile)
	s.mux.HandleFunc("POST /v1/react", s.react)
	s.mux.HandleFunc("POST /v1/download", s.download)
	return s
}

// ServeHTTP routes a request; anything unknown is a bad_request.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if _, pattern := s.mux.Handler(r); pattern == "" {
		writeError(w, core.BadRequest("Unknown request %s %s.", r.Method, r.URL.Path))
		return
	}
	s.mux.ServeHTTP(w, r)
}

// Serve accepts connections on l until ctx ends. Connections from any user other than uid are
// closed before a byte is read.
func (s *Server) Serve(ctx context.Context, l net.Listener, uid int, peer PeerUID) error {
	srvCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	hs := &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return srvCtx },
		ErrorLog:          slog.NewLogLogger(s.log.Handler(), slog.LevelWarn),
	}
	pl := &peerListener{Listener: l, uid: uid, peer: peer, log: s.log}
	errc := make(chan error, 1)
	go func() { errc <- hs.Serve(pl) }()
	select {
	case <-ctx.Done():
		cancel()
		sctx, c2 := context.WithTimeout(context.Background(), 5*time.Second)
		defer c2()
		_ = hs.Shutdown(sctx)
		<-errc
		return nil
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

type peerListener struct {
	net.Listener
	uid  int
	peer PeerUID
	log  *slog.Logger
}

func (l *peerListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		uid, err := l.peer(c)
		if err != nil || uid != l.uid {
			c.Close()
			l.log.Warn("closed a connection from another user", "peer_uid", uid)
			continue
		}
		return c, nil
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte(`{"error":{"code":"internal","message":"Internal error in the daemon; see its log."}}`)
	}
	w.Write(append(b, '\n'))
}

func writeError(w http.ResponseWriter, err error) {
	var ae *core.APIError
	if !errors.As(err, &ae) {
		ae = core.Internal
	}
	if ae.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(ae.RetryAfter))
	}
	writeJSON(w, ae.Status, map[string]any{"error": ae})
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	var ae *core.APIError
	if !errors.As(err, &ae) {
		// Never echo the error: it may name a path. The log gets it.
		s.log.Error("request failed", "err", err)
	}
	writeError(w, err)
}

// query checks that only allowed query parameters are present, each at most once.
func query(r *http.Request, allowed ...string) (url.Values, error) {
	q := r.URL.Query()
	ok := map[string]bool{}
	for _, a := range allowed {
		ok[a] = true
	}
	for k, v := range q {
		if !ok[k] {
			if len(allowed) == 0 {
				return nil, core.BadRequest("Unknown query parameter %q; this request takes none.", k)
			}
			return nil, core.BadRequest("Unknown query parameter %q; valid: %s.", k, strings.Join(allowed, ", "))
		}
		if len(v) > 1 {
			return nil, core.BadRequest("Query parameter %q is given more than once.", k)
		}
	}
	return q, nil
}

const maxBody = 1 << 20

// decode reads a JSON object body strictly: unknown fields and trailing data are errors.
func decode(r *http.Request, dst any) error {
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return core.BadRequest("Cannot read the request body.")
	}
	if len(b) > maxBody {
		return core.BadRequest("The request body is too large.")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		msg := err.Error()
		if strings.HasPrefix(msg, "json: unknown field ") {
			return core.BadRequest("Unknown field %s.", strings.TrimPrefix(msg, "json: unknown field "))
		}
		return core.BadRequest("The body must be a JSON object: %s.", msg)
	}
	if dec.More() {
		return core.BadRequest("Trailing data after the JSON body.")
	}
	return nil
}

func intParam(q url.Values, name string, def, min, max int) (int, error) {
	v := q.Get(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min || n > max {
		return 0, core.BadRequest("%s must be a whole number from %d to %d.", name, min, max)
	}
	return n, nil
}

// boolParam reads a 1/0 query parameter; absent is false.
func boolParam(q url.Values, name string) (bool, error) {
	switch q.Get(name) {
	case "", "0", "false":
		return false, nil
	case "1", "true":
		return true, nil
	}
	return false, core.BadRequest("%s must be 1 or 0.", name)
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	st, err := s.acct.Status(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, core.SettingsView(s.acct.Settings(), nil))
}

func (s *Server) patchSettings(w http.ResponseWriter, r *http.Request) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(b) > maxBody {
		s.fail(w, core.BadRequest("Cannot read the request body."))
		return
	}
	res, err := s.acct.PatchSettings(r.Context(), b)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) chats(w http.ResponseWriter, r *http.Request) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	list, err := s.acct.Chats(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"chats": list})
}

func (s *Server) groups(w http.ResponseWriter, r *http.Request) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	list, err := s.acct.Groups(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": list})
}

func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	d, err := s.acct.Chat(r.Context(), r.PathValue("chat"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"chat": d})
}

func (s *Server) messages(w http.ResponseWriter, r *http.Request) {
	q, err := query(r, "chat", "before", "limit", "mark_read")
	if err != nil {
		s.fail(w, err)
		return
	}
	if q.Get("chat") == "" {
		s.fail(w, core.BadRequest("chat is required."))
		return
	}
	limit, err := intParam(q, "limit", 50, 1, 500)
	if err != nil {
		s.fail(w, err)
		return
	}
	mark, err := boolParam(q, "mark_read")
	if err != nil {
		s.fail(w, err)
		return
	}
	page, err := s.acct.Messages(r.Context(), q.Get("chat"), q.Get("before"), limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	if mark {
		m := s.acct.MarkReturned(r.Context(), core.PageRefs(page))
		page.MarkRead = &m
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) message(w http.ResponseWriter, r *http.Request) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	res, err := s.acct.Message(r.Context(), r.PathValue("chat"), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

type forgetBody struct {
	Chat *string `json:"chat"`
	ID   *string `json:"id"`
}

func (s *Server) forget(w http.ResponseWriter, r *http.Request) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	var b forgetBody
	if err := decode(r, &b); err != nil {
		s.fail(w, err)
		return
	}
	chat, id := "", ""
	if b.Chat != nil {
		chat = *b.Chat
	}
	if b.ID != nil {
		id = *b.ID
	}
	if chat == "" && id == "" {
		s.fail(w, core.BadRequest("forget needs chat, or chat and id, or a bare id."))
		return
	}
	res, err := s.acct.Forget(r.Context(), chat, id)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"forgotten": res})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	q, err := query(r, "after", "limit", "chat", "kind", "follow", "mark_read")
	if err != nil {
		s.fail(w, err)
		return
	}
	ctx := r.Context()
	var eq core.EventQuery
	if v := q.Get("after"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			s.fail(w, core.BadRequest("after must be a whole number of 0 or more."))
			return
		}
		eq.After = &n
	}
	if eq.Limit, err = intParam(q, "limit", 100, 1, 1000); err != nil {
		s.fail(w, err)
		return
	}
	if k := q.Get("kind"); k != "" {
		valid := false
		for _, known := range core.Kinds {
			valid = valid || known == k
		}
		if !valid {
			s.fail(w, core.BadRequest("kind must be one of %s.", strings.Join(core.Kinds, ", ")))
			return
		}
		eq.Kind = k
	}
	if c := q.Get("chat"); c != "" {
		id, err := s.acct.ResolveChat(ctx, c)
		if err != nil {
			s.fail(w, err)
			return
		}
		eq.Chat = id
	}
	follow, err := boolParam(q, "follow")
	if err != nil {
		s.fail(w, err)
		return
	}
	mark, err := boolParam(q, "mark_read")
	if err != nil {
		s.fail(w, err)
		return
	}

	if !follow {
		list, err := s.acct.Events(ctx, eq)
		if err != nil {
			s.fail(w, err)
			return
		}
		last, err := s.acct.LastSeq(ctx)
		if err != nil {
			s.fail(w, err)
			return
		}
		res := map[string]any{"events": list, "latest_seq": last}
		if mark {
			res["mark_read"] = s.acct.MarkReturned(ctx, core.EventRefs(list))
		}
		if eq.After != nil {
			res["after"] = *eq.After
		}
		writeJSON(w, http.StatusOK, res)
		return
	}

	// Follow: subscribe first, then send the backlog, then each new event as it commits.
	sub, cancel := s.acct.Subscribe()
	defer cancel()
	var cursor int64
	if eq.After != nil {
		cursor = *eq.After
	} else {
		last, err := s.acct.LastSeq(ctx)
		if err != nil {
			s.fail(w, err)
			return
		}
		cursor = last
	}
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush()
	}
	for {
		eq.After = &cursor
		list, err := s.acct.Events(ctx, eq)
		if err != nil {
			if ctx.Err() == nil {
				s.log.Error("follow query failed", "err", err)
			}
			return
		}
		for _, e := range list {
			b, _ := json.Marshal(e)
			if _, err := w.Write(append(b, '\n')); err != nil {
				return
			}
			cursor = e.Seq
		}
		if mark {
			// A mark that fails is said on the stream, and the stream goes on.
			if m := s.acct.MarkReturned(ctx, core.EventRefs(list)); m.Failed > 0 {
				b, _ := json.Marshal(map[string]any{"error": core.MarkFailedLine(m)})
				if _, err := w.Write(append(b, '\n')); err != nil {
					return
				}
			}
		}
		if flusher != nil {
			flusher.Flush()
		}
		if len(list) == eq.Limit {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-sub:
		}
	}
}

func (s *Server) link(w http.ResponseWriter, r *http.Request) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	var b core.LinkBody
	if err := decode(r, &b); err != nil {
		s.fail(w, err)
		return
	}
	req, err := s.acct.BeginLink(b)
	if err != nil {
		s.fail(w, err)
		return
	}
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush()
	}
	write := func(l core.LinkLine) {
		b, _ := json.Marshal(l)
		if _, err := w.Write(append(b, '\n')); err == nil && flusher != nil {
			flusher.Flush()
		}
	}
	res := s.acct.RunLink(r.Context(), req, write)
	write(core.LinkLine{Result: &res})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	var b struct{}
	if r.ContentLength != 0 {
		if err := decode(r, &b); err != nil {
			s.fail(w, err)
			return
		}
	}
	res, err := s.acct.Logout(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// post runs a JSON POST request: no query parameters, a strict body, one result.
func post[B any, R any](s *Server, w http.ResponseWriter, r *http.Request, fn func(context.Context, B) (R, error)) {
	if _, err := query(r); err != nil {
		s.fail(w, err)
		return
	}
	var b B
	if err := decode(r, &b); err != nil {
		s.fail(w, err)
		return
	}
	res, err := fn(r.Context(), b)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) send(w http.ResponseWriter, r *http.Request) {
	post(s, w, r, s.acct.Send)
}

func (s *Server) sendFile(w http.ResponseWriter, r *http.Request) {
	post(s, w, r, s.acct.SendFile)
}

func (s *Server) react(w http.ResponseWriter, r *http.Request) {
	post(s, w, r, s.acct.React)
}

func (s *Server) markRead(w http.ResponseWriter, r *http.Request) {
	post(s, w, r, s.acct.MarkRead)
}

func (s *Server) typing(w http.ResponseWriter, r *http.Request) {
	post(s, w, r, s.acct.Typing)
}

func (s *Server) download(w http.ResponseWriter, r *http.Request) {
	post(s, w, r, s.acct.Download)
}
