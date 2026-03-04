package main

import (
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

// -- STRUCTS --

type ImageDimension struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// InfoJSON represents the raw info.json metadata.
type InfoJSON struct {
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
}

// GalleryDir holds a discovered gallery's path and mtime.
type GalleryDir struct {
	DirPath string
	Mtime   int64 // Unix timestamp of info.json mtime
}

// ProcessedGallery holds all data ready for DB insertion.
type ProcessedGallery struct {
	Info       InfoJSON
	Path       string // relative to media root
	ThumbCount int
	Files      []FileEntry
	Tags       []TagEntry
}

type FileEntry struct {
	SortOrder int
	Filename  string
	Width     int
	Height    int
}

type TagEntry struct {
	Namespace string
	Value     string
}

// -- MAIN --

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: scanner <media_root> <db_path>\n")
		os.Exit(1)
	}
	root := os.Args[1]
	dbPath := os.Args[2]

	// Step 1: Walk and collect all gallery dirs
	galleryDirs := walkAndCollect(root)

	// Step 2: Open/create DB and ensure schema
	db, err := openDB(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to open database: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := createSchema(db); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create schema: %v\n", err)
		os.Exit(1)
	}

	// Step 3: Load existing timestamps
	existing := loadExistingTimestamps(db)

	// Step 4: Determine new, updated, deleted
	onDisk := make(map[int]struct{}, len(galleryDirs))
	var toProcess []GalleryDir
	unchanged := 0

	for id, gd := range galleryDirs {
		onDisk[id] = struct{}{}
		if lastScanned, ok := existing[id]; ok {
			if gd.Mtime > lastScanned {
				toProcess = append(toProcess, gd)
			} else {
				unchanged++
			}
		} else {
			toProcess = append(toProcess, gd)
		}
	}

	var deletedIDs []int
	for id := range existing {
		if _, ok := onDisk[id]; !ok {
			deletedIDs = append(deletedIDs, id)
		}
	}

	// Step 5: Process new+updated galleries concurrently
	results := make(chan ProcessedGallery, len(toProcess))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 64)

	for _, gd := range toProcess {
		wg.Add(1)
		go func(gd GalleryDir) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			pg := processGallery(root, gd.DirPath)
			if pg != nil {
				results <- *pg
			}
		}(gd)
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	var processed []ProcessedGallery
	for pg := range results {
		processed = append(processed, pg)
	}

	// Step 6: Single transaction for all DB writes
	newCount := 0
	updatedCount := 0

	tx, err := db.Begin()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to begin transaction: %v\n", err)
		os.Exit(1)
	}

	stmtGallery, _ := tx.Prepare(`INSERT OR REPLACE INTO galleries
		(gallery_id, title, title_jpn, type, language, lang, date, count, category, subcategory, path, thumb_count, last_scanned)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	defer stmtGallery.Close()

	stmtDeleteTags, _ := tx.Prepare(`DELETE FROM tags WHERE gallery_id = ?`)
	defer stmtDeleteTags.Close()

	stmtTag, _ := tx.Prepare(`INSERT INTO tags (gallery_id, namespace, value) VALUES (?, ?, ?)`)
	defer stmtTag.Close()

	stmtDeleteFiles, _ := tx.Prepare(`DELETE FROM files WHERE gallery_id = ?`)
	defer stmtDeleteFiles.Close()

	stmtFile, _ := tx.Prepare(`INSERT INTO files (gallery_id, sort_order, filename, width, height) VALUES (?, ?, ?, ?, ?)`)
	defer stmtFile.Close()

	stmtDeleteGallery, _ := tx.Prepare(`DELETE FROM galleries WHERE gallery_id = ?`)
	defer stmtDeleteGallery.Close()

	for _, pg := range processed {
		id := pg.Info.GalleryID
		mtime := galleryDirs[id].Mtime

		if _, wasExisting := existing[id]; wasExisting {
			updatedCount++
		} else {
			newCount++
		}

		stmtGallery.Exec(id, pg.Info.Title, pg.Info.TitleJPN, pg.Info.Type,
			pg.Info.Language, pg.Info.Lang, pg.Info.Date, pg.Info.Count,
			pg.Info.Category, pg.Info.Subcategory, pg.Path, pg.ThumbCount, mtime)

		stmtDeleteTags.Exec(id)
		for _, t := range pg.Tags {
			stmtTag.Exec(id, t.Namespace, t.Value)
		}

		stmtDeleteFiles.Exec(id)
		for _, f := range pg.Files {
			stmtFile.Exec(id, f.SortOrder, f.Filename, f.Width, f.Height)
		}
	}

	for _, id := range deletedIDs {
		stmtDeleteGallery.Exec(id)
	}

	if err := tx.Commit(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to commit transaction: %v\n", err)
		os.Exit(1)
	}

	total := unchanged + newCount + updatedCount
	fmt.Printf("Scan complete: %d new, %d updated, %d deleted, %d unchanged, %d total\n",
		newCount, updatedCount, len(deletedIDs), unchanged, total)
}

// -- DB SETUP --

func openDB(dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	db.Exec("PRAGMA journal_mode = WAL")
	db.Exec("PRAGMA foreign_keys = ON")
	db.Exec("PRAGMA synchronous = NORMAL")
	return db, nil
}

func createSchema(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS galleries (
			gallery_id   INTEGER PRIMARY KEY,
			title        TEXT NOT NULL DEFAULT '',
			title_jpn    TEXT NOT NULL DEFAULT '',
			type         TEXT NOT NULL DEFAULT '',
			language     TEXT NOT NULL DEFAULT '',
			lang         TEXT NOT NULL DEFAULT '',
			date         TEXT NOT NULL DEFAULT '',
			count        INTEGER NOT NULL DEFAULT 0,
			category     TEXT NOT NULL DEFAULT '',
			subcategory  TEXT NOT NULL DEFAULT '',
			path         TEXT NOT NULL DEFAULT '',
			thumb_count  INTEGER NOT NULL DEFAULT 0,
			last_scanned INTEGER NOT NULL DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS tags (
			gallery_id INTEGER NOT NULL REFERENCES galleries(gallery_id) ON DELETE CASCADE,
			namespace  TEXT NOT NULL,
			value      TEXT NOT NULL,
			PRIMARY KEY (gallery_id, namespace, value)
		);
		CREATE INDEX IF NOT EXISTS idx_tags_ns_val ON tags(namespace, value);

		CREATE TABLE IF NOT EXISTS files (
			gallery_id INTEGER NOT NULL REFERENCES galleries(gallery_id) ON DELETE CASCADE,
			sort_order INTEGER NOT NULL,
			filename   TEXT NOT NULL,
			width      INTEGER NOT NULL DEFAULT 0,
			height     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (gallery_id, sort_order)
		);
	`)
	return err
}

// -- WALK AND COLLECT --

func walkAndCollect(root string) map[int]GalleryDir {
	dirs := make(map[int]GalleryDir)
	var mu sync.Mutex

	filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}

		// Skip hidden dirs and node_modules
		if d.IsDir() {
			name := d.Name()
			if name != filepath.Base(root) && (name[0] == '.' || name == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}

		if d.Name() != "info.json" {
			return nil
		}

		dirPath := filepath.Dir(path)

		// Skip downloading galleries
		if isDownloading(dirPath) {
			return nil
		}

		// Parse gallery ID from info.json
		f, err := os.Open(path)
		if err != nil {
			return nil
		}

		stat, err := f.Stat()
		if err != nil {
			f.Close()
			return nil
		}

		data := make([]byte, stat.Size())
		_, err = io.ReadFull(f, data)
		f.Close()
		if err != nil {
			return nil
		}

		var partial struct {
			GalleryID int `json:"gallery_id"`
		}
		if err := json.Unmarshal(data, &partial); err != nil || partial.GalleryID == 0 {
			return nil
		}

		info, err := os.Stat(path)
		if err != nil {
			return nil
		}

		mu.Lock()
		dirs[partial.GalleryID] = GalleryDir{
			DirPath: dirPath,
			Mtime:   info.ModTime().Unix(),
		}
		mu.Unlock()

		return nil
	})

	return dirs
}

// -- EXISTING TIMESTAMPS --

func loadExistingTimestamps(db *sql.DB) map[int]int64 {
	result := make(map[int]int64)
	rows, err := db.Query("SELECT gallery_id, last_scanned FROM galleries")
	if err != nil {
		return result
	}
	defer rows.Close()

	for rows.Next() {
		var id int
		var ts int64
		rows.Scan(&id, &ts)
		result[id] = ts
	}
	return result
}

// -- PROCESS GALLERY --

func processGallery(root, dirPath string) *ProcessedGallery {
	infoPath := filepath.Join(dirPath, "info.json")

	f, err := os.Open(infoPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil
	}

	data := make([]byte, stat.Size())
	_, err = io.ReadFull(f, data)
	if err != nil {
		return nil
	}

	var info InfoJSON
	if err := json.Unmarshal(data, &info); err != nil {
		return nil
	}

	// Ensure arrays are initialized
	if info.Tags == nil {
		info.Tags = []string{}
	}
	if info.Artist == nil {
		info.Artist = []string{}
	}
	if info.Group == nil {
		info.Group = []string{}
	}
	if info.Parody == nil {
		info.Parody = []string{}
	}
	if info.Characters == nil {
		info.Characters = []string{}
	}

	// Collect image files
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil
	}

	images := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && isImage(e.Name()) {
			images = append(images, e.Name())
		}
	}

	if len(images) == 0 {
		return nil
	}
	sort.Strings(images)

	// Split into full and thumbnail files
	fullFiles := make([]string, 0, len(images)/2)
	thumbCount := 0
	for _, name := range images {
		if strings.Contains(name, "_thumb_") {
			thumbCount++
		} else {
			fullFiles = append(fullFiles, name)
		}
	}

	// Build file entries with dimensions
	fileEntries := make([]FileEntry, len(fullFiles))
	for i, name := range fullFiles {
		w, h := readImageDimensions(filepath.Join(dirPath, name))
		fileEntries[i] = FileEntry{
			SortOrder: i,
			Filename:  name,
			Width:     w,
			Height:    h,
		}
	}

	// Normalize tags
	tagEntries := normalizeTags(info)

	relDir, _ := filepath.Rel(root, dirPath)

	info.Count = len(fullFiles)

	return &ProcessedGallery{
		Info:       info,
		Path:       relDir,
		ThumbCount: thumbCount,
		Files:      fileEntries,
		Tags:       tagEntries,
	}
}

// -- TAG NORMALIZATION --

func normalizeTags(info InfoJSON) []TagEntry {
	var tags []TagEntry

	for _, v := range info.Artist {
		tags = append(tags, TagEntry{Namespace: "artist", Value: v})
	}
	for _, v := range info.Group {
		tags = append(tags, TagEntry{Namespace: "group", Value: v})
	}
	for _, v := range info.Parody {
		tags = append(tags, TagEntry{Namespace: "series", Value: v})
	}
	for _, v := range info.Characters {
		tags = append(tags, TagEntry{Namespace: "character", Value: v})
	}

	for _, t := range info.Tags {
		if strings.HasPrefix(t, "female:") {
			tags = append(tags, TagEntry{Namespace: "female", Value: t[7:]})
		} else if strings.HasPrefix(t, "male:") {
			tags = append(tags, TagEntry{Namespace: "male", Value: t[5:]})
		} else {
			tags = append(tags, TagEntry{Namespace: "tag", Value: t})
		}
	}

	return tags
}

// -- HELPERS --

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
	if n < 20 || string(header[0:4]) != "RIFF" || string(header[8:12]) != "WEBP" {
		return 0, 0
	}

	chunk := string(header[12:16])

	switch chunk {
	case "VP8 ":
		if n < 30 {
			return 0, 0
		}
		w := int(binary.LittleEndian.Uint16(header[26:28])) & 0x3FFF
		h := int(binary.LittleEndian.Uint16(header[28:30])) & 0x3FFF
		return w, h

	case "VP8L":
		if n < 25 {
			return 0, 0
		}
		bits := binary.LittleEndian.Uint32(header[21:25])
		w := int(bits&0x3FFF) + 1
		h := int((bits>>14)&0x3FFF) + 1
		return w, h

	case "VP8X":
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
	if n < 24 {
		return 0, 0
	}
	w := int(binary.BigEndian.Uint32(header[16:20]))
	h := int(binary.BigEndian.Uint32(header[20:24]))
	return w, h
}

func readGifDimensions(header []byte, n int) (int, int) {
	if n < 10 {
		return 0, 0
	}
	w := int(binary.LittleEndian.Uint16(header[6:8]))
	h := int(binary.LittleEndian.Uint16(header[8:10]))
	return w, h
}

func readJpegDimensions(f *os.File, header []byte, n int) (int, int) {
	if n < 2 || header[0] != 0xFF || header[1] != 0xD8 {
		return 0, 0
	}

	f.Seek(2, 0)

	buf := make([]byte, 2)
	for {
		if _, err := io.ReadFull(f, buf); err != nil {
			return 0, 0
		}

		if buf[0] != 0xFF {
			return 0, 0
		}

		marker := buf[1]

		for marker == 0xFF {
			if _, err := io.ReadFull(f, buf[:1]); err != nil {
				return 0, 0
			}
			marker = buf[0]
		}

		if marker >= 0xC0 && marker <= 0xC2 {
			sof := make([]byte, 7)
			if _, err := io.ReadFull(f, sof); err != nil {
				return 0, 0
			}
			h := int(binary.BigEndian.Uint16(sof[3:5]))
			w := int(binary.BigEndian.Uint16(sof[5:7]))
			return w, h
		}

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
}
