package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

const socketPath = "/run/user/1000/gallery-sprite-gen.sock"

type generateRequest struct {
	GalleryDir string `json:"galleryDir"`
	StripIndex int    `json:"stripIndex"`
	CachePath  string `json:"cachePath"`
}

type generateResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Size  int    `json:"size,omitempty"`
}

func handleGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req generateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, generateResponse{Error: "bad request: " + err.Error()})
		return
	}

	if req.GalleryDir == "" || req.CachePath == "" {
		writeJSON(w, http.StatusBadRequest, generateResponse{Error: "galleryDir and cachePath required"})
		return
	}

	data, err := generateAndCache(req.GalleryDir, req.StripIndex, req.CachePath)
	if err != nil {
		log.Printf("generate error: gallery=%s strip=%d: %v", filepath.Base(req.GalleryDir), req.StripIndex, err)
		writeJSON(w, http.StatusInternalServerError, generateResponse{Error: err.Error()})
		return
	}

	log.Printf("generated: %s strip_%d (%d bytes)", filepath.Base(req.GalleryDir), req.StripIndex, len(data))
	writeJSON(w, http.StatusOK, generateResponse{OK: true, Size: len(data)})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func runServe() {
	// Clean up stale socket
	os.Remove(socketPath)

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatalf("listen %s: %v", socketPath, err)
	}
	defer listener.Close()

	// Allow the streamer (same user) to connect
	os.Chmod(socketPath, 0o660)

	mux := http.NewServeMux()
	mux.HandleFunc("/generate", handleGenerate)

	server := &http.Server{Handler: mux}

	// Graceful shutdown on SIGTERM/SIGINT
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sig
		log.Println("shutting down...")
		server.Close()
	}()

	log.Printf("sprite-gen daemon listening on %s", socketPath)
	if err := server.Serve(listener); err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}
