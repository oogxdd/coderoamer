package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
)

// handleService dispatches GET (status) / PUT (start) / DELETE (kill) for
// /sprites/:name/services/:svc.
func handleService(w http.ResponseWriter, r *http.Request, svcName string) {
	switch r.Method {
	case http.MethodGet:
		servicesMu.Lock()
		svc := services[svcName]
		servicesMu.Unlock()
		status := "not_found"
		if svc != nil {
			svc.mu.Lock()
			if svc.alive {
				status = "running"
			} else {
				status = "stopped"
			}
			svc.mu.Unlock()
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"name":  svcName,
			"state": map[string]string{"status": status},
		})
	case http.MethodPut:
		startService(w, r, svcName)
	case http.MethodDelete:
		deleteService(w, svcName)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// emit records an event for replay and fans it out to subscribers (non-blocking
// so one slow client can't stall the process).
func (svc *service) emit(ev logEvent) {
	svc.mu.Lock()
	svc.events = append(svc.events, ev)
	for sub := range svc.subs {
		select {
		case sub.ch <- ev:
		default:
		}
	}
	svc.mu.Unlock()
}

// finish marks the service dead and closes subscriber channels exactly once
// (clearing svc.subs under the lock makes a concurrent DELETE a no-op).
func (svc *service) finish(code int) {
	svc.mu.Lock()
	svc.alive = false
	svc.exitCode = code
	subs := svc.subs
	svc.subs = map[*serviceSub]bool{}
	svc.mu.Unlock()
	for sub := range subs {
		close(sub.ch)
	}
}

func startService(w http.ResponseWriter, r *http.Request, svcName string) {
	var cfg struct {
		Cmd  string   `json:"cmd"`
		Args []string `json:"args"`
	}
	body, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(body, &cfg)
	if cfg.Cmd == "" {
		cfg.Cmd = "bash"
	}

	// Replace any existing service with this name (re-PUT overwrites, matching
	// the Sprites semantics).
	servicesMu.Lock()
	if old := services[svcName]; old != nil {
		old.mu.Lock()
		if old.alive && old.cmd != nil && old.cmd.Process != nil {
			_ = old.cmd.Process.Signal(syscall.SIGTERM)
		}
		old.mu.Unlock()
	}
	svc := &service{name: svcName, subs: map[*serviceSub]bool{}, alive: true}
	services[svcName] = svc
	servicesMu.Unlock()

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	sub := &serviceSub{ch: make(chan logEvent, 256)}
	svc.mu.Lock()
	svc.subs[sub] = true
	svc.mu.Unlock()

	go runServiceProcess(svc, cfg.Cmd, cfg.Args)

	for ev := range sub.ch {
		b, _ := json.Marshal(ev)
		if _, err := w.Write(append(b, '\n')); err != nil {
			break
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
	svc.mu.Lock()
	delete(svc.subs, sub)
	svc.mu.Unlock()
}

func runServiceProcess(svc *service, cmd string, args []string) {
	svc.emit(logEvent{Type: "started", Data: strings.TrimSpace(cmd + " " + strings.Join(args, " "))})

	c := exec.Command(cmd, args...)
	c.Env = append(os.Environ(), "TERM=xterm-256color")
	stdout, _ := c.StdoutPipe()
	stderr, _ := c.StderrPipe()

	if err := c.Start(); err != nil {
		svc.emit(logEvent{Type: "error", Data: err.Error()})
		svc.emit(logEvent{Type: "exit", ExitCode: intp(1)})
		svc.emit(logEvent{Type: "complete"})
		svc.finish(1)
		return
	}
	svc.mu.Lock()
	svc.cmd = c
	svc.mu.Unlock()

	var wg sync.WaitGroup
	wg.Add(2)
	go pumpService(stdout, "stdout", svc, &wg)
	go pumpService(stderr, "stderr", svc, &wg)
	wg.Wait()
	_ = c.Wait()

	code := 0
	if c.ProcessState != nil {
		if ec := c.ProcessState.ExitCode(); ec > 0 {
			code = ec
		}
	}
	svc.emit(logEvent{Type: "exit", ExitCode: intp(code)})
	svc.emit(logEvent{Type: "complete"})
	svc.finish(code)
}

func pumpService(rd io.Reader, kind string, svc *service, wg *sync.WaitGroup) {
	defer wg.Done()
	buf := make([]byte, 4096)
	for {
		n, err := rd.Read(buf)
		if n > 0 {
			svc.emit(logEvent{Type: kind, Data: string(buf[:n])})
		}
		if err != nil {
			break
		}
	}
}

func deleteService(w http.ResponseWriter, svcName string) {
	servicesMu.Lock()
	svc := services[svcName]
	delete(services, svcName)
	servicesMu.Unlock()

	if svc != nil {
		svc.mu.Lock()
		alive := svc.alive
		proc := svc.cmd
		subs := svc.subs
		svc.subs = map[*serviceSub]bool{}
		svc.mu.Unlock()
		if alive && proc != nil && proc.Process != nil {
			_ = proc.Process.Signal(syscall.SIGTERM)
		}
		for sub := range subs {
			close(sub.ch)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleServiceLogs: GET /sprites/:name/services/:svc/logs — replay stored
// events, then stream live ones until the service exits or the client leaves.
func handleServiceLogs(w http.ResponseWriter, r *http.Request, svcName string) {
	servicesMu.Lock()
	svc := services[svcName]
	servicesMu.Unlock()

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	writeLine := func(ev logEvent) bool {
		b, _ := json.Marshal(ev)
		if _, err := w.Write(append(b, '\n')); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}

	if svc == nil {
		writeLine(logEvent{Type: "error", Data: "Service '" + svcName + "' not found"})
		return
	}

	svc.mu.Lock()
	replay := make([]logEvent, len(svc.events))
	copy(replay, svc.events)
	alive := svc.alive
	var sub *serviceSub
	if alive {
		sub = &serviceSub{ch: make(chan logEvent, 256)}
		svc.subs[sub] = true
	}
	svc.mu.Unlock()

	for _, ev := range replay {
		if !writeLine(ev) {
			if sub != nil {
				svc.mu.Lock()
				delete(svc.subs, sub)
				svc.mu.Unlock()
			}
			return
		}
	}
	if !alive {
		return
	}

	ctx := r.Context()
	for {
		select {
		case ev, ok := <-sub.ch:
			if !ok {
				return
			}
			if !writeLine(ev) {
				svc.mu.Lock()
				delete(svc.subs, sub)
				svc.mu.Unlock()
				return
			}
		case <-ctx.Done():
			svc.mu.Lock()
			delete(svc.subs, sub)
			svc.mu.Unlock()
			return
		}
	}
}

// handleServiceList: GET /sprites/:name/services
func handleServiceList(w http.ResponseWriter) {
	list := []map[string]any{}
	servicesMu.Lock()
	for name, s := range services {
		s.mu.Lock()
		status := "stopped"
		if s.alive {
			status = "running"
		}
		s.mu.Unlock()
		list = append(list, map[string]any{
			"name":  name,
			"state": map[string]string{"status": status},
		})
	}
	servicesMu.Unlock()
	writeJSON(w, http.StatusOK, list)
}
