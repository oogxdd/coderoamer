// remote-agent — a single-binary daemon that speaks the Sprites exec + services
// + filesystem wire protocol, so the sprites-rn-manager app can point at any
// Linux machine instead of api.sprites.dev.
//
// This is the Go port of the original Node daemon (see git history for
// remote-agent/index.js). Go was chosen so the daemon cross-compiles to a
// single static binary with no runtime/toolchain dependency on the target — the
// Node version needed node-pty, a node-gyp native addon that can fail to build
// on an arbitrary VPS distro or an ARM home server (docs/custom-vm-providers.md
// §3.4).
//
// Endpoints (the `:name` segment is accepted but ignored — one machine per
// daemon; an optional leading `/v1` is accepted so the app's baseUrl+"/v1" works):
//
//	PUT    /sprites/:name/services/:svc         run a command, stream NDJSON
//	GET    /sprites/:name/services/:svc         service status JSON
//	GET    /sprites/:name/services/:svc/logs    replay + stream NDJSON
//	DELETE /sprites/:name/services/:svc         kill service
//	GET    /sprites/:name/services              list services
//	GET    /sprites/:name/exec                  list live TTY sessions
//	WS     /sprites/:name/exec?cmd=...          new TTY session
//	WS     /sprites/:name/exec/:sessionId       attach (replays scrollback)
//	POST   /sprites/:name/exec/:sessionId/kill  kill TTY session
//	PUT    /sprites/:name/fs/write?path=...      write a file (raw body bytes)
//
// Auth: `Authorization: Bearer <AGENT_TOKEN>` on every HTTP and WS request
// (WS also accepts ?token= as a fallback for clients that can't set headers).
//
// Usage: AGENT_TOKEN=<secret> PORT=8765 ./remote-agent
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var (
	port  = getenv("PORT", "8765")
	token = os.Getenv("AGENT_TOKEN")
)

const (
	// Per-session scrollback cap. ~256 KB is plenty for a Claude/Codex TUI and
	// bounds memory for late attaches.
	scrollbackMaxBytes = 256 * 1024
	// How long a dead exec session lingers for late attaches.
	deadSessionTTL = 5 * time.Minute
	// Exec output stream-id bytes (matches src/services/api.ts streamExec).
	streamStdout = 0x01
	streamStderr = 0x02
	streamExit   = 0x03
)

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

// logEvent is one NDJSON line of the services stream. Matches ServiceLogEvent in
// src/models/service.ts. ExitCode is a pointer so exit_code:0 is emitted (0 is a
// meaningful exit code) while non-exit events omit it.
type logEvent struct {
	Type     string `json:"type"`
	Data     string `json:"data,omitempty"`
	ExitCode *int   `json:"exit_code,omitempty"`
}

type sessionInfo struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	Cols      int    `json:"cols,omitempty"`
	Rows      int    `json:"rows,omitempty"`
}

type execExit struct {
	Type     string `json:"type"`
	ExitCode int    `json:"exit_code"`
}

// ---------------------------------------------------------------------------
// wsClient — serializes writes to a single WebSocket (gorilla allows only one
// concurrent writer).
// ---------------------------------------------------------------------------

type wsClient struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *wsClient) writeText(s string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.TextMessage, []byte(s))
}

func (c *wsClient) writeBinary(b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.BinaryMessage, b)
}

func (c *wsClient) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.writeText(string(b))
}

// frameOut prefixes PTY output with a stream-id byte, as the app's exec parser
// expects (1 = stdout). A PTY merges stdout+stderr, so everything is stream 1.
func frameOut(streamID byte, b []byte) []byte {
	out := make([]byte, len(b)+1)
	out[0] = streamID
	copy(out[1:], b)
	return out
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

type execSession struct {
	id           string
	ptmx         *os.File
	cmd          *exec.Cmd
	cmdline      string
	mu           sync.Mutex
	scrollback   [][]byte
	scrollbackSz int
	subs         map[*wsClient]bool
	alive        bool
	lastActivity time.Time
}

type serviceSub struct {
	ch chan logEvent
}

type service struct {
	name     string
	cmd      *exec.Cmd
	mu       sync.Mutex
	events   []logEvent
	subs     map[*serviceSub]bool
	alive    bool
	exitCode int
}

var (
	execMu       sync.Mutex
	execSessions = map[string]*execSession{}

	servicesMu sync.Mutex
	services   = map[string]*service{}
)

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

var (
	reService     = regexp.MustCompile(`^/sprites/([^/]+)/services/([^/]+)$`)
	reServiceLogs = regexp.MustCompile(`^/sprites/([^/]+)/services/([^/]+)/logs$`)
	reServiceList = regexp.MustCompile(`^/sprites/([^/]+)/services$`)
	reExecList    = regexp.MustCompile(`^/sprites/([^/]+)/exec$`)
	reExecKill    = regexp.MustCompile(`^/sprites/([^/]+)/exec/([^/]+)/kill$`)
	reExecAttach  = regexp.MustCompile(`^/sprites/([^/]+)/exec/([^/]+)$`)
	reFsWrite     = regexp.MustCompile(`^/sprites/([^/]+)/fs/write$`)
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // native app; no browser origin
}

func authorized(r *http.Request) bool {
	if r.Header.Get("Authorization") == "Bearer "+token {
		return true
	}
	// WS fallback: some clients cannot set headers on the upgrade request.
	return r.URL.Query().Get("token") == token
}

// normalizePath strips an optional leading /v1 so the app's `${baseUrl}/v1`
// convention reaches the daemon's `/sprites/...` routes. (The original Node
// daemon routed on bare /sprites/... yet its installer advertised a /v1 base —
// this makes both work.)
func normalizePath(p string) string {
	if p == "/v1" {
		return "/"
	}
	if strings.HasPrefix(p, "/v1/") {
		return p[len("/v1"):]
	}
	return p
}

// newMux builds the HTTP handler (extracted so tests can mount it on httptest).
func newMux() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
			return
		}
		p := normalizePath(r.URL.Path)

		// WebSocket routes first (exec attach / new session).
		if websocket.IsWebSocketUpgrade(r) {
			if m := reExecAttach.FindStringSubmatch(p); m != nil {
				handleExecAttach(w, r, m[2])
				return
			}
			if reExecList.MatchString(p) {
				handleExecNew(w, r)
				return
			}
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		switch {
		case reServiceLogs.MatchString(p):
			if r.Method == http.MethodGet {
				m := reServiceLogs.FindStringSubmatch(p)
				handleServiceLogs(w, r, m[2])
				return
			}
		case reService.MatchString(p):
			m := reService.FindStringSubmatch(p)
			handleService(w, r, m[2])
			return
		case reServiceList.MatchString(p):
			if r.Method == http.MethodGet {
				handleServiceList(w)
				return
			}
		case reExecKill.MatchString(p):
			if r.Method == http.MethodPost {
				m := reExecKill.FindStringSubmatch(p)
				handleExecKill(w, m[2])
				return
			}
		case reExecList.MatchString(p):
			if r.Method == http.MethodGet {
				handleExecListSessions(w)
				return
			}
		case reFsWrite.MatchString(p):
			if r.Method == http.MethodPut {
				handleFsWrite(w, r)
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Not found", "path": p})
	})
}

func main() {
	if token == "" {
		log.Fatal("[remote-agent] AGENT_TOKEN is required. Set it in your environment.")
	}
	srv := &http.Server{Addr: ":" + port, Handler: newMux()}

	go func() {
		masked := token
		if len(masked) > 4 {
			masked = token[:4] + strings.Repeat("*", len(token)-4)
		}
		log.Printf("[remote-agent] listening on port %s", port)
		log.Printf("[remote-agent] token: %s", masked)
		log.Printf("[remote-agent] base URL for the app: http://<your-host>:%s/v1", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[remote-agent] server error: %v", err)
		}
	}()

	// Graceful shutdown: kill children so they don't outlive the daemon.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	log.Println("[remote-agent] shutting down…")
	killAll()
	_ = srv.Close()
}

func killAll() {
	execMu.Lock()
	for _, s := range execSessions {
		if s.alive && s.cmd != nil && s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
	}
	execMu.Unlock()
	servicesMu.Lock()
	for _, s := range services {
		if s.alive && s.cmd != nil && s.cmd.Process != nil {
			_ = s.cmd.Process.Signal(syscall.SIGTERM)
		}
	}
	servicesMu.Unlock()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func intp(i int) *int { return &i }
