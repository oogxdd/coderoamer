package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
)

// handleFsWrite: PUT /sprites/:name/fs/write?path=&workingDir=&mode=&mkdir=
//
// The raw request body is the file's bytes. Mirrors writeSpriteFile's contract
// in src/services/api.ts (§3.4) — needed so the sprite-side Whisper
// transcription path (audio-transcription.ts) works over remote connections
// instead of silently breaking.
func handleFsWrite(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	p := q.Get("path")
	workingDir := q.Get("workingDir")
	modeStr := q.Get("mode")
	mkdir := q.Get("mkdir") == "true"

	if p == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}

	full := p
	if !filepath.IsAbs(full) {
		base := workingDir
		if base == "" {
			base = "."
		}
		full = filepath.Join(base, p)
	}

	mode := os.FileMode(0o644)
	if modeStr != "" {
		if m, err := strconv.ParseUint(modeStr, 8, 32); err == nil {
			mode = os.FileMode(m)
		}
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read body: " + err.Error()})
		return
	}

	if mkdir {
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "mkdir failed: " + err.Error()})
			return
		}
	}

	if err := os.WriteFile(full, body, mode); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "write failed: " + err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path": full,
		"size": len(body),
		"mode": fmt.Sprintf("0%o", uint32(mode.Perm())),
	})
}
