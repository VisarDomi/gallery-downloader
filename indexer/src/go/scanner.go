package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// -- STRUCTS --

type ImageDimension struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Gallery represents the truthful content of info.json + file system context.
type Gallery struct {
	// Raw metadata from info.json
	GalleryID   int      `json:"gallery_id"`
	Title       string   `json:"title"`
	TitleJPN    string   `json:"title_jpn"`
	Type        string   `json:"type"`
	Language    string   `json:"language"`
	Lang        string   `json:"lang"`
	Date        string   `json:"date"`
	Tags        []string `json:"tags"`
	Artist      []string `json:"artist"`
	Group       []string `json:"group"`
	Parody      []string `json:"parody"`
	Characters  []string `json:"characters"`
	Count       int      `json:"count"`
	Category    string   `json:"category"`
	Subcategory string   `json:"subcategory"`

	// Filesystem Context
	Files          []string         `json:"files"`
	FullFiles      []string         `json:"fullFiles"`
	ThumbnailFiles []string         `json:"thumbnailFiles"`
	Dimensions     []ImageDimension `json:"dimensions"`
	Path           string           `json:"path"`
}

// -- MAIN --

func main() {
	if len(os.Args) < 2 {
		os.Exit(1)
	}
	root := os.Args[1]

	results := make(chan Gallery, 512)

	var wg sync.WaitGroup
	sem := make(chan struct{}, 64)

	wg.Add(1)
	go walk(root, root, &wg, results, sem)

	go func() {
		wg.Wait()
		close(results)
	}()

	galleries := make([]Gallery, 0, 2000)
	for g := range results {
		galleries = append(galleries, g)
	}

	// Sort by Date Descending (Newest First)
	sort.Slice(galleries, func(i, j int) bool {
		return galleries[i].Date > galleries[j].Date
	})

	encoder := json.NewEncoder(os.Stdout)
	encoder.Encode(galleries)
}

// -- LOGIC --

func walk(root, currentDir string, wg *sync.WaitGroup, out chan<- Gallery, sem chan struct{}) {
	defer wg.Done()

	sem <- struct{}{}
	entries, err := os.ReadDir(currentDir)
	<-sem

	if err != nil {
		return
	}

	var infoEntry os.DirEntry
	var subDirs []string

	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() {
			if name == "info.json" {
				infoEntry = e
			}
		} else {
			if name[0] != '.' && name != "node_modules" {
				subDirs = append(subDirs, name)
			}
		}
	}

	if infoEntry != nil {
		if isDownloading(currentDir) {
			return
		}
		processGallery(root, currentDir, entries, out)
	} else {
		for _, dirName := range subDirs {
			wg.Add(1)
			go walk(root, filepath.Join(currentDir, dirName), wg, out, sem)
		}
	}
}

func processGallery(root, dirPath string, entries []os.DirEntry, out chan<- Gallery) {
	infoPath := filepath.Join(dirPath, "info.json")

	f, err := os.Open(infoPath)
	if err != nil {
		return
	}
	defer f.Close()

	// OPTIMIZATION: Get file size first to allocate exactly once.
	stat, err := f.Stat()
	if err != nil {
		return
	}

	data := make([]byte, stat.Size())
	_, err = io.ReadFull(f, data)
	if err != nil {
		return
	}

	var g Gallery
	if err := json.Unmarshal(data, &g); err != nil {
		return
	}

	// Ensure arrays are initialized if empty in JSON (Go does this partially, but good to be safe if strictly required)
	if g.Tags == nil { g.Tags = []string{} }
	if g.Artist == nil { g.Artist = []string{} }
	if g.Group == nil { g.Group = []string{} }
	if g.Parody == nil { g.Parody = []string{} }
	if g.Characters == nil { g.Characters = []string{} }

	images := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && isImage(e.Name()) {
			images = append(images, e.Name())
		}
	}

	if len(images) == 0 {
		return
	}
	sort.Strings(images)

	// Split images into full files and thumbnail files
	fullFiles := make([]string, 0, len(images)/2)
	thumbnailFiles := make([]string, 0, len(images)/2)
	for _, name := range images {
		if strings.Contains(name, "_thumb_") {
			thumbnailFiles = append(thumbnailFiles, name)
		} else {
			fullFiles = append(fullFiles, name)
		}
	}

	// Read dimensions for full files (webp header parsing)
	dimensions := make([]ImageDimension, len(fullFiles))
	for i, name := range fullFiles {
		w, h := readImageDimensions(filepath.Join(dirPath, name))
		dimensions[i] = ImageDimension{Width: w, Height: h}
	}

	relDir, _ := filepath.Rel(root, dirPath)

	g.Files = images
	g.FullFiles = fullFiles
	g.ThumbnailFiles = thumbnailFiles
	g.Dimensions = dimensions
	g.Count = len(fullFiles)
	g.Path = relDir

	out <- g
}

func isDownloading(dirPath string) bool {
	dirName := filepath.Base(dirPath)
	spaceIdx := strings.IndexByte(dirName, ' ')
	if spaceIdx <= 0 {
		return false
	}
	galleryID := dirName[:spaceIdx]
	markerPath := filepath.Join(filepath.Dir(dirPath), ".downloading-"+galleryID)
	_, err := os.Stat(markerPath)
	return err == nil
}

// -- HELPERS --

func isImage(name string) bool {
	if len(name) < 4 {
		return false
	}

	s := name[len(name)-4:]
	if len(name) >= 5 && name[len(name)-5] == '.' {
		s = name[len(name)-5:]
	}
	s = strings.ToLower(s)

	switch s {
	case ".jpg", ".png", ".gif":
		return true
	}
	if len(s) == 5 {
		switch s {
		case ".jpeg", ".webp", ".avif":
			return true
		}
	}
	return false
}

// readImageDimensions reads width/height from image file headers without full decode.
// Supports WebP (RIFF/VP8/VP8L/VP8X), PNG, JPEG, GIF.
func readImageDimensions(filePath string) (int, int) {
	f, err := os.Open(filePath)
	if err != nil {
		return 0, 0
	}
	defer f.Close()

	// Read enough bytes for any header format
	header := make([]byte, 30)
	n, err := f.Read(header)
	if err != nil || n < 12 {
		return 0, 0
	}

	ext := strings.ToLower(filepath.Ext(filePath))

	switch ext {
	case ".webp":
		return readWebpDimensions(header, n)
	case ".png":
		return readPngDimensions(header, n)
	case ".jpg", ".jpeg":
		return readJpegDimensions(f, header, n)
	case ".gif":
		return readGifDimensions(header, n)
	}

	return 0, 0
}

func readWebpDimensions(header []byte, n int) (int, int) {
	// WebP: RIFF....WEBP
	if n < 20 || string(header[0:4]) != "RIFF" || string(header[8:12]) != "WEBP" {
		return 0, 0
	}

	chunk := string(header[12:16])

	switch chunk {
	case "VP8 ":
		// Lossy VP8: dimensions at bytes 26-29 (little-endian)
		if n < 30 {
			return 0, 0
		}
		// VP8 bitstream starts at offset 20 (after chunk header)
		// Frame tag at bytes 20-22, then keyframe header
		// Width at 26-27 (14 bits), Height at 28-29 (14 bits)
		w := int(binary.LittleEndian.Uint16(header[26:28])) & 0x3FFF
		h := int(binary.LittleEndian.Uint16(header[28:30])) & 0x3FFF
		return w, h

	case "VP8L":
		// Lossless VP8L: dimensions encoded in first 4 bytes of bitstream at offset 21
		if n < 25 {
			return 0, 0
		}
		bits := binary.LittleEndian.Uint32(header[21:25])
		w := int(bits&0x3FFF) + 1
		h := int((bits>>14)&0x3FFF) + 1
		return w, h

	case "VP8X":
		// Extended VP8X: canvas size at bytes 24-29
		if n < 30 {
			return 0, 0
		}
		w := int(header[24]) | int(header[25])<<8 | int(header[26])<<16 + 1
		h := int(header[27]) | int(header[28])<<8 | int(header[29])<<16 + 1
		return w, h
	}

	return 0, 0
}

func readPngDimensions(header []byte, n int) (int, int) {
	// PNG: 8-byte signature, then IHDR chunk with width at 16-19, height at 20-23
	if n < 24 {
		return 0, 0
	}
	w := int(binary.BigEndian.Uint32(header[16:20]))
	h := int(binary.BigEndian.Uint32(header[20:24]))
	return w, h
}

func readGifDimensions(header []byte, n int) (int, int) {
	// GIF: signature (6 bytes) + width (2 LE) + height (2 LE)
	if n < 10 {
		return 0, 0
	}
	w := int(binary.LittleEndian.Uint16(header[6:8]))
	h := int(binary.LittleEndian.Uint16(header[8:10]))
	return w, h
}

func readJpegDimensions(f *os.File, header []byte, n int) (int, int) {
	// JPEG: Need to find SOF0/SOF2 marker
	if n < 2 || header[0] != 0xFF || header[1] != 0xD8 {
		return 0, 0
	}

	// Re-seek to start and scan for SOF marker
	f.Seek(2, 0)

	buf := make([]byte, 2)
	for {
		// Read marker
		if _, err := io.ReadFull(f, buf); err != nil {
			return 0, 0
		}

		if buf[0] != 0xFF {
			return 0, 0
		}

		marker := buf[1]

		// Skip filler bytes
		for marker == 0xFF {
			if _, err := io.ReadFull(f, buf[:1]); err != nil {
				return 0, 0
			}
			marker = buf[0]
		}

		// SOF markers: C0 (baseline), C1 (extended), C2 (progressive)
		if marker >= 0xC0 && marker <= 0xC2 {
			// Read length (2) + precision (1) + height (2) + width (2)
			sof := make([]byte, 7)
			if _, err := io.ReadFull(f, sof); err != nil {
				return 0, 0
			}
			h := int(binary.BigEndian.Uint16(sof[3:5]))
			w := int(binary.BigEndian.Uint16(sof[5:7]))
			return w, h
		}

		// Read segment length and skip
		if _, err := io.ReadFull(f, buf); err != nil {
			return 0, 0
		}
		segLen := int(binary.BigEndian.Uint16(buf)) - 2
		if segLen < 0 {
			return 0, 0
		}
		if _, err := f.Seek(int64(segLen), 1); err != nil {
			return 0, 0
		}
	}

	return 0, 0 // unreachable but makes compiler happy
}

// Compile check
var _ = fmt.Sprintf
