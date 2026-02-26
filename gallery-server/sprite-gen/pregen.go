package main

import (
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	mediaRoot   = "/home/visar/Pictures"
	galleryRoot = mediaRoot + "/gallery-dl/hitomi"
)

func runPregen() {
	entries, err := os.ReadDir(galleryRoot)
	if err != nil {
		log.Fatalf("read gallery root: %v", err)
	}

	var dirs []os.DirEntry
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			dirs = append(dirs, e)
		}
	}

	fmt.Printf("Scanning %d galleries for missing sprites...\n", len(dirs))

	totalGenerated := 0
	galleriesProcessed := 0
	skipped := 0
	startTime := time.Now()

	for _, e := range dirs {
		name := e.Name()
		galleryDir := filepath.Join(galleryRoot, name)

		// Skip galleries still downloading
		galleryID := strings.SplitN(name, " ", 2)[0]
		marker := filepath.Join(galleryRoot, fmt.Sprintf(".downloading-%s", galleryID))
		if _, err := os.Stat(marker); err == nil {
			continue
		}

		generated, err := processGallery(galleryDir, name)
		if err != nil {
			log.Printf("  Error processing %s: %v", name, err)
			continue
		}

		if generated > 0 {
			galleriesProcessed++
			totalGenerated += generated
			truncName := name
			if len(truncName) > 60 {
				truncName = truncName[:60]
			}
			fmt.Printf("  [%d] %s — %d strip(s)\n", galleriesProcessed, truncName, generated)
		} else {
			skipped++
			if skipped%500 == 0 {
				fmt.Printf("  ...skipped %d (already have sprites)\n", skipped)
			}
		}
	}

	elapsed := time.Since(startTime).Seconds()
	fmt.Printf("\nDone. Generated %d strips across %d galleries in %.1fs\n", totalGenerated, galleriesProcessed, elapsed)
}

func processGallery(galleryDir, galleryName string) (int, error) {
	spritesDir := filepath.Join(galleryDir, ".sprites")

	thumbs, err := getThumbFiles(galleryDir)
	if err != nil {
		return 0, err
	}
	if len(thumbs) == 0 {
		return 0, nil
	}

	stripCount := int(math.Ceil(float64(len(thumbs)) / float64(maxPerStrip)))

	// Check existing sprites — if count matches, skip; if mismatched, delete stale dir
	existing, err := os.ReadDir(spritesDir)
	if err == nil && len(existing) > 0 {
		existingStrips := 0
		for _, e := range existing {
			if strings.HasPrefix(e.Name(), "strip_") && strings.HasSuffix(e.Name(), ".webp") {
				existingStrips++
			}
		}
		if existingStrips == stripCount {
			return 0, nil
		}
		// Stale sprites (thumb count changed since last generation)
		log.Printf("  Stale sprites for %s: have %d strips, need %d — regenerating", galleryName, existingStrips, stripCount)
		os.RemoveAll(spritesDir)
	}

	generated := 0
	for i := 0; i < stripCount; i++ {
		cachePath := filepath.Join(spritesDir, fmt.Sprintf("strip_%d.webp", i))

		data, err := generateStrip(galleryDir, i, thumbs)
		if err != nil {
			log.Printf("  Error generating strip %d for %s: %v", i, galleryName, err)
			continue
		}

		if err := os.MkdirAll(spritesDir, 0o755); err != nil {
			return generated, fmt.Errorf("mkdir: %w", err)
		}
		if err := os.WriteFile(cachePath, data, 0o644); err != nil {
			return generated, fmt.Errorf("write: %w", err)
		}
		generated++
	}

	return generated, nil
}
