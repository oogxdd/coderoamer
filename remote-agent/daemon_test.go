package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const testToken = "test-token-123"

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	token = testToken // package-level auth token
	srv := httptest.NewServer(newMux())
	t.Cleanup(srv.Close)
	return srv
}

func authedReq(t *testing.T, method, url string, body io.Reader) *http.Request {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	return req
}

func dialWS(t *testing.T, srv *httptest.Server, path string) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + path
	h := http.Header{}
	h.Set("Authorization", "Bearer "+testToken)
	c, _, err := websocket.DefaultDialer.Dial(wsURL, h)
	if err != nil {
		t.Fatalf("ws dial %s: %v", path, err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// ---------------------------------------------------------------------------

func TestAuthRejected(t *testing.T) {
	srv := testServer(t)
	resp, err := http.Get(srv.URL + "/sprites/x/exec")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401 without token, got %d", resp.StatusCode)
	}
}

func TestFsWrite(t *testing.T) {
	srv := testServer(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "nested", "hello.txt")
	content := []byte("remote-agent fs write ok")

	url := srv.URL + "/sprites/anything/fs/write?path=" + target + "&mode=0600&mkdir=true"
	req := authedReq(t, http.MethodPut, url, bytes.NewReader(content))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("fs/write status %d: %s", resp.StatusCode, b)
	}
	var out struct {
		Path string `json:"path"`
		Size int    `json:"size"`
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Size != len(content) {
		t.Fatalf("size: want %d got %d", len(content), out.Size)
	}
	if out.Mode != "0600" {
		t.Fatalf("mode: want 0600 got %s", out.Mode)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("content mismatch: %q", got)
	}
}

func TestServicesStream(t *testing.T) {
	srv := testServer(t)
	// /v1 prefix must be accepted (the app posts to baseUrl + "/v1").
	url := srv.URL + "/v1/sprites/anything/services/echo-svc?duration=10s"
	body := strings.NewReader(`{"cmd":"sh","args":["-c","printf hi-service"]}`)
	req := authedReq(t, http.MethodPut, url, body)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var types []string
	var stdout strings.Builder
	var exitCode = -999
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var ev struct {
			Type     string `json:"type"`
			Data     string `json:"data"`
			ExitCode *int   `json:"exit_code"`
		}
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("bad ndjson line %q: %v", line, err)
		}
		types = append(types, ev.Type)
		if ev.Type == "stdout" {
			stdout.WriteString(ev.Data)
		}
		if ev.Type == "exit" && ev.ExitCode != nil {
			exitCode = *ev.ExitCode
		}
	}
	joined := strings.Join(types, ",")
	if !strings.Contains(joined, "started") || !strings.Contains(joined, "exit") || !strings.Contains(joined, "complete") {
		t.Fatalf("missing lifecycle events, got: %s", joined)
	}
	if !strings.Contains(stdout.String(), "hi-service") {
		t.Fatalf("stdout missing payload, got %q", stdout.String())
	}
	if exitCode != 0 {
		t.Fatalf("exit code: want 0 got %d", exitCode)
	}
}

// readExecUntil accumulates stdout (stream-id 1) from binary frames and records
// whether a JSON exit event arrived, until `contains` is seen or `deadline`.
func readExecStdout(t *testing.T, c *websocket.Conn, contains string, deadline time.Duration) (string, bool) {
	t.Helper()
	var out strings.Builder
	sawExit := false
	_ = c.SetReadDeadline(time.Now().Add(deadline))
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			break
		}
		switch mt {
		case websocket.BinaryMessage:
			if len(data) > 0 && data[0] == streamStdout {
				out.Write(data[1:])
			}
		case websocket.TextMessage:
			var m map[string]any
			if json.Unmarshal(data, &m) == nil {
				if m["type"] == "exit" {
					sawExit = true
				}
			}
		}
		if contains != "" && strings.Contains(out.String(), contains) {
			break
		}
		if contains == "" && sawExit {
			break
		}
	}
	return out.String(), sawExit
}

func TestExecPtyStdinAndExit(t *testing.T) {
	srv := testServer(t)
	c := dialWS(t, srv, "/sprites/anything/exec?cmd=sh&cols=100&rows=30")

	// First frame: session_info (text JSON) with a session id.
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, data, err := c.ReadMessage()
	if err != nil || mt != websocket.TextMessage {
		t.Fatalf("expected session_info text frame, got mt=%d err=%v", mt, err)
	}
	var si struct {
		Type      string `json:"type"`
		SessionID string `json:"session_id"`
	}
	if json.Unmarshal(data, &si); si.Type != "session_info" || si.SessionID == "" {
		t.Fatalf("bad session_info: %s", data)
	}

	// Resize control frame (text) — must not disrupt the session.
	_ = c.WriteMessage(websocket.TextMessage, []byte(`{"type":"resize","cols":120,"rows":40}`))

	// Stdin as a 0x00-prefixed binary frame (api.ts makeExecStdinFrame convention).
	stdin := append([]byte{0x00}, []byte("echo remote-agent-OK\n")...)
	if err := c.WriteMessage(websocket.BinaryMessage, stdin); err != nil {
		t.Fatal(err)
	}
	out, _ := readExecStdout(t, c, "remote-agent-OK", 3*time.Second)
	if !strings.Contains(out, "remote-agent-OK") {
		t.Fatalf("did not see command output; got %q", out)
	}

	// Exit the shell and confirm we get an exit event.
	_ = c.WriteMessage(websocket.BinaryMessage, append([]byte{0x00}, []byte("exit\n")...))
	_, sawExit := readExecStdout(t, c, "", 3*time.Second)
	if !sawExit {
		t.Fatalf("expected exit event after shell exit")
	}
}

func TestExecAttachReplayAndKill(t *testing.T) {
	srv := testServer(t)
	c := dialWS(t, srv, "/sprites/anything/exec?cmd=sh")

	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var si struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(data, &si)
	if si.SessionID == "" {
		t.Fatal("no session id")
	}

	// Produce some output, then let it settle into scrollback.
	_ = c.WriteMessage(websocket.BinaryMessage, append([]byte{0x00}, []byte("echo REPLAY-MARKER\n")...))
	if out, _ := readExecStdout(t, c, "REPLAY-MARKER", 3*time.Second); !strings.Contains(out, "REPLAY-MARKER") {
		t.Fatalf("origin never saw output: %q", out)
	}

	// Attach a second client — it should replay the scrollback.
	att := dialWS(t, srv, "/sprites/anything/exec/"+si.SessionID)
	replay, _ := readExecStdout(t, att, "REPLAY-MARKER", 3*time.Second)
	if !strings.Contains(replay, "REPLAY-MARKER") {
		t.Fatalf("attach did not replay scrollback; got %q", replay)
	}

	// Kill via REST; the session should end.
	req := authedReq(t, http.MethodPost, srv.URL+"/sprites/anything/exec/"+si.SessionID+"/kill", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("kill status %d", resp.StatusCode)
	}
	if _, sawExit := readExecStdout(t, c, "", 3*time.Second); !sawExit {
		t.Fatalf("expected exit after kill")
	}
}

func TestExecListSessions(t *testing.T) {
	srv := testServer(t)
	c := dialWS(t, srv, "/sprites/anything/exec?cmd=sh")
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := c.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	// Keep the shell busy so it stays alive for the list call.
	_ = c.WriteMessage(websocket.BinaryMessage, append([]byte{0x00}, []byte("sleep 2\n")...))
	time.Sleep(200 * time.Millisecond)

	req := authedReq(t, http.MethodGet, srv.URL+"/sprites/anything/exec", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var list []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list) == 0 {
		t.Fatalf("expected at least one live session")
	}
}
