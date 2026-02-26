package main

import (
	"bytes"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kolesa-team/go-webp/decoder"
	"github.com/kolesa-team/go-webp/encoder"
	"github.com/kolesa-team/go-webp/webp"
	xdraw "golang.org/x/image/draw"
)

// Matches hitomi source config
const (
	thumbWidth  = 100
	thumbHeight = 300
	maxPerStrip = 163
	thumbMarker = "_thumb_"
)

// getThumbFiles returns sorted thumbnail filenames from a gallery directory.
func getThumbFiles(galleryDir string) ([]string, error) {
	entries, err := os.ReadDir(galleryDir)
	if err != nil {
		return nil, err
	}
	var thumbs []string
	for _, e := range entries {
		if !e.IsDir() && strings.Contains(e.Name(), thumbMarker) {
			thumbs = append(thumbs, e.Name())
		}
	}
	sort.Strings(thumbs)
	return thumbs, nil
}

// decodeImage opens and decodes an image file (webp, jpeg, png).
func decodeImage(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".webp":
		return webp.Decode(f, &decoder.Options{})
	case ".jpg", ".jpeg":
		return jpeg.Decode(f)
	case ".png":
		return png.Decode(f)
	default:
		// Try generic decode
		img, _, err := image.Decode(f)
		return img, err
	}
}

// resizeCover resizes src to exactly dstW x dstH using cover+centre strategy:
// scale so the image fully covers the target, then crop from center.
func resizeCover(src image.Image, dstW, dstH int) *image.NRGBA {
	srcBounds := src.Bounds()
	srcW := srcBounds.Dx()
	srcH := srcBounds.Dy()

	// Compute scale factor: the larger scale wins (cover, not contain)
	scaleX := float64(dstW) / float64(srcW)
	scaleY := float64(dstH) / float64(srcH)
	scale := scaleX
	if scaleY > scaleX {
		scale = scaleY
	}

	// Intermediate size after scaling
	intW := int(float64(srcW)*scale + 0.5)
	intH := int(float64(srcH)*scale + 0.5)

	// Scale the image
	scaled := image.NewNRGBA(image.Rect(0, 0, intW, intH))
	xdraw.CatmullRom.Scale(scaled, scaled.Bounds(), src, srcBounds, xdraw.Over, nil)

	// Crop from center
	offX := (intW - dstW) / 2
	offY := (intH - dstH) / 2

	dst := image.NewNRGBA(image.Rect(0, 0, dstW, dstH))
	draw.Draw(dst, dst.Bounds(), scaled, image.Pt(offX, offY), draw.Src)

	return dst
}

// generateStrip generates a single sprite strip from gallery thumbnails.
// Returns the webp-encoded bytes.
func generateStrip(galleryDir string, stripIdx int, thumbs []string) ([]byte, error) {
	start := stripIdx * maxPerStrip
	if start >= len(thumbs) {
		return nil, fmt.Errorf("strip index %d out of range (have %d thumbs)", stripIdx, len(thumbs))
	}
	end := start + maxPerStrip
	if end > len(thumbs) {
		end = len(thumbs)
	}
	stripThumbs := thumbs[start:end]

	totalWidth := len(stripThumbs) * thumbWidth

	// Create the strip canvas
	strip := image.NewNRGBA(image.Rect(0, 0, totalWidth, thumbHeight))

	// Decode, resize, and composite each thumbnail
	for i, name := range stripThumbs {
		src, err := decodeImage(filepath.Join(galleryDir, name))
		if err != nil {
			return nil, fmt.Errorf("decode %s: %w", name, err)
		}

		resized := resizeCover(src, thumbWidth, thumbHeight)

		dstRect := image.Rect(i*thumbWidth, 0, (i+1)*thumbWidth, thumbHeight)
		draw.Draw(strip, dstRect, resized, image.Point{}, draw.Src)
	}

	// Encode to webp
	opts, err := encoder.NewLossyEncoderOptions(encoder.PresetDefault, 80)
	if err != nil {
		return nil, fmt.Errorf("encoder options: %w", err)
	}

	var buf bytes.Buffer
	if err := webp.Encode(&buf, strip, opts); err != nil {
		return nil, fmt.Errorf("webp encode: %w", err)
	}

	return buf.Bytes(), nil
}

// generateAndCache generates a strip and writes it to cachePath.
// Returns the encoded bytes.
func generateAndCache(galleryDir string, stripIdx int, cachePath string) ([]byte, error) {
	thumbs, err := getThumbFiles(galleryDir)
	if err != nil {
		return nil, fmt.Errorf("list thumbs: %w", err)
	}

	data, err := generateStrip(galleryDir, stripIdx, thumbs)
	if err != nil {
		return nil, err
	}

	// Write cache file
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir: %w", err)
	}
	if err := os.WriteFile(cachePath, data, 0o644); err != nil {
		return nil, fmt.Errorf("write cache: %w", err)
	}

	return data, nil
}
