package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// handleExecNew: WS /sprites/:name/exec?cmd=...&cols=&rows= — start a PTY session.
func handleExecNew(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &wsClient{conn: ws}
	q := r.URL.Query()

	// The app sends one `cmd` per argv element (api.ts) or a single `cmd=bash`
	// token (exec-poc, which types the real command as TTY input afterwards).
	cmds := q["cmd"]
	var argv []string
	switch {
	case len(cmds) > 1:
		argv = cmds
	case len(cmds) == 1:
		argv = strings.Fields(cmds[0])
	}
	if len(argv) == 0 {
		argv = []string{"bash"}
	}
	cols := atoiDefault(q.Get("cols"), 120)
	rows := atoiDefault(q.Get("rows"), 40)

	c := exec.Command(argv[0], argv[1:]...)
	c.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(c, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		_ = client.writeJSON(logEvent{Type: "error", Data: "spawn failed: " + err.Error()})
		_ = ws.Close()
		return
	}

	id := newID()
	sess := &execSession{
		id:           id,
		ptmx:         ptmx,
		cmd:          c,
		cmdline:      strings.Join(argv, " "),
		subs:         map[*wsClient]bool{client: true},
		alive:        true,
		lastActivity: time.Now(),
	}
	execMu.Lock()
	execSessions[id] = sess
	execMu.Unlock()

	// session_info first so the app captures the session id + geometry.
	_ = client.writeJSON(sessionInfo{Type: "session_info", SessionID: id, Cols: cols, Rows: rows})

	go readPtyLoop(sess)
	execInputLoop(sess, client)
}

// handleExecAttach: WS /sprites/:name/exec/:sessionId — replay scrollback, then
// behave like a live subscriber.
func handleExecAttach(w http.ResponseWriter, r *http.Request, sessionID string) {
	execMu.Lock()
	sess := execSessions[sessionID]
	execMu.Unlock()

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &wsClient{conn: ws}

	if sess == nil {
		_ = client.writeJSON(logEvent{Type: "error", Data: "Session " + sessionID + " not found"})
		_ = ws.Close()
		return
	}

	_ = client.writeJSON(sessionInfo{Type: "session_info", SessionID: sessionID})

	sess.mu.Lock()
	snapshot := make([][]byte, len(sess.scrollback))
	copy(snapshot, sess.scrollback)
	alive := sess.alive
	if alive {
		sess.subs[client] = true
	}
	sess.mu.Unlock()

	for _, chunk := range snapshot {
		_ = client.writeBinary(frameOut(streamStdout, chunk))
	}

	if !alive {
		_ = client.writeJSON(execExit{Type: "exit", ExitCode: 0})
		_ = ws.Close()
		return
	}

	execInputLoop(sess, client)
}

// readPtyLoop pumps PTY output to all subscribers (stream-id 1 framed), keeps a
// bounded scrollback, and on process exit emits the exit event + schedules the
// session for cleanup.
func readPtyLoop(sess *execSession) {
	buf := make([]byte, 4096)
	for {
		n, err := sess.ptmx.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			sess.mu.Lock()
			sess.lastActivity = time.Now()
			sess.scrollback = append(sess.scrollback, chunk)
			sess.scrollbackSz += n
			for sess.scrollbackSz > scrollbackMaxBytes && len(sess.scrollback) > 1 {
				sess.scrollbackSz -= len(sess.scrollback[0])
				sess.scrollback = sess.scrollback[1:]
			}
			subs := snapshotSubs(sess)
			sess.mu.Unlock()

			framed := frameOut(streamStdout, chunk)
			for _, c := range subs {
				_ = c.writeBinary(framed)
			}
		}
		if err != nil {
			break // EOF or EIO once the child closes the PTY slave
		}
	}

	_ = sess.cmd.Wait()
	exitCode := 0
	if sess.cmd.ProcessState != nil {
		if ec := sess.cmd.ProcessState.ExitCode(); ec > 0 {
			exitCode = ec
		}
	}

	sess.mu.Lock()
	sess.alive = false
	subs := snapshotSubs(sess)
	sess.mu.Unlock()

	msg := execExit{Type: "exit", ExitCode: exitCode}
	for _, c := range subs {
		_ = c.writeJSON(msg)
	}

	time.AfterFunc(deadSessionTTL, func() {
		execMu.Lock()
		delete(execSessions, sess.id)
		execMu.Unlock()
	})
}

func snapshotSubs(sess *execSession) []*wsClient {
	subs := make([]*wsClient, 0, len(sess.subs))
	for c := range sess.subs {
		subs = append(subs, c)
	}
	return subs
}

// execInputLoop forwards this client's incoming frames to the PTY until the WS
// closes.
func execInputLoop(sess *execSession, client *wsClient) {
	for {
		mt, data, err := client.conn.ReadMessage()
		if err != nil {
			break
		}
		sess.mu.Lock()
		alive := sess.alive
		sess.mu.Unlock()
		if !alive {
			continue
		}
		handleExecInput(sess, mt, data)
	}
	sess.mu.Lock()
	delete(sess.subs, client)
	sess.mu.Unlock()
	_ = client.conn.Close()
}

// handleExecInput: text frames are resize control (JSON) or plain stdin; binary
// frames are stdin, with an optional leading 0x00 (api.ts makeExecStdinFrame).
func handleExecInput(sess *execSession, mt int, data []byte) {
	if mt == websocket.TextMessage {
		var m map[string]any
		if json.Unmarshal(data, &m) == nil {
			if t, _ := m["type"].(string); t == "resize" {
				cols := toInt(m["cols"])
				rows := toInt(m["rows"])
				if cols > 0 && rows > 0 {
					_ = pty.Setsize(sess.ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
				}
				return
			}
		}
		_, _ = sess.ptmx.Write(data)
		return
	}
	if len(data) > 0 && data[0] == 0x00 {
		_, _ = sess.ptmx.Write(data[1:])
		return
	}
	_, _ = sess.ptmx.Write(data)
}

// handleExecKill: POST /sprites/:name/exec/:sessionId/kill
func handleExecKill(w http.ResponseWriter, sessionID string) {
	execMu.Lock()
	sess := execSessions[sessionID]
	execMu.Unlock()
	if sess != nil {
		sess.mu.Lock()
		alive := sess.alive
		sess.mu.Unlock()
		if alive && sess.cmd.Process != nil {
			_ = sess.cmd.Process.Kill()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleExecListSessions: GET /sprites/:name/exec
func handleExecListSessions(w http.ResponseWriter) {
	type row struct {
		ID           string `json:"id"`
		Cmd          string `json:"cmd"`
		TTY          bool   `json:"tty"`
		LastActivity string `json:"last_activity"`
	}
	list := []row{}
	execMu.Lock()
	for id, s := range execSessions {
		s.mu.Lock()
		alive := s.alive
		cmdline := s.cmdline
		la := s.lastActivity
		s.mu.Unlock()
		if alive {
			list = append(list, row{ID: id, Cmd: cmdline, TTY: true, LastActivity: la.Format(time.RFC3339)})
		}
	}
	execMu.Unlock()
	writeJSON(w, http.StatusOK, list)
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	if v, err := strconv.Atoi(s); err == nil {
		return v
	}
	return def
}

func toInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case string:
		i, _ := strconv.Atoi(n)
		return i
	}
	return 0
}
