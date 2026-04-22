# OCR TODO

Goal: move `gallery-reader` OCR from the current Paddle-based implementation toward the best local OCR stack we can build for manga, with behavior as close as possible to strong multimodal OCR systems on Japanese vertical text.

## Current Understanding

- Strong OCR is usually not just “show the whole page to a model once.”
- The best systems are usually:
  - viewport / page render
  - layout or bubble detection
  - crop selection
  - recognition
  - reading-order reconstruction
  - post-processing
- That means our app should be built around a reusable OCR harness, not around one model.
- The harness should be mostly model-agnostic.
- The model-specific parts should live in adapters:
  - model launch/runtime
  - request format
  - prompt template if needed
  - output normalization
  - crop / token / resolution tuning

## Source Of Truth

- Keep human-verified OCR fixtures under `tests/ocr-ground-truth/`
- Current verified case:
  - `tests/ocr-ground-truth/case-2026-04-22-right-dialogue/source.png`
  - `tests/ocr-ground-truth/case-2026-04-22-right-dialogue/test.txt`
  - `tests/ocr-ground-truth/case-2026-04-22-right-dialogue/README.md`
- Add more fixtures before broad bakeoffs:
  - clean vertical dialogue
  - mixed vertical + horizontal text
  - furigana-heavy text
  - dense bubble layouts
  - captions / narration boxes
  - stylized fonts
  - low contrast

## Plan 0: Build A Plug-And-Play OCR Harness

Purpose: make every future OCR experiment swappable in the running app and directly comparable.

### Backend

- Refactor current OCR path into stages:
  - `capture`
  - `segment`
  - `recognize`
  - `order`
  - `finalize`
- Define a shared OCR result schema:
  - raw regions
  - cropped regions
  - recognized lines
  - grouped bubbles
  - final ordered text
  - timings
  - warnings
  - debug artifact paths
- Add an OCR backend interface:
  - `paddle-current`
  - `paddle-vl`
  - `paddle-vl-manga`
  - `manga-ocr`
  - `deepseek-ocr-2`
  - `got-ocr-2`
  - `qwen2.5-vl-7b`
- Keep the viewport render path reusable for all backends.
- Keep segmentation separate from recognition so we can mix:
  - Paddle detection + manga-ocr recognition
  - Paddle detection + DeepSeek/Qwen crop OCR
  - future bubble detector + same recognizers

### Frontend

- Add OCR backend selection in the UI or debug menu.
- Add “compare mode”:
  - run one selected backend
  - or run two backends on the same request
  - show final text side by side
- Add a debug inspector:
  - viewport request payload
  - rendered source image
  - detected regions / crops
  - raw recognizer output
  - ordered output
- Add a quick toggle to rerun OCR on the same captured image without recapturing.

### Evaluation

- Add a local evaluation runner over `tests/ocr-ground-truth/`
- For every backend, measure:
  - exact match
  - line-count accuracy
  - line-order accuracy
  - character accuracy
  - latency
  - VRAM usage
  - implementation complexity
- Make sure app-side compare mode and offline fixture tests use the same normalization rules.

## Plan 1: Current Paddle, But Better Ordered

Purpose: get immediate gains without replacing the current path.

- Inspect what current Paddle is already giving us:
  - raw boxes
  - confidence
  - grouping
  - whether bubble splitting is mostly from Paddle or from our render harness
- Keep current viewport render and current worker path.
- Improve ordering and grouping only:
  - vertical-first merge
  - top-to-bottom inside a column
  - columns right-to-left
  - furigana filtering
  - bubble grouping before flattening
- Try stronger layout/order components:
  - Magi
  - panel / bubble heuristics
  - explicit reading-order layer
- Baseline:
  - current Paddle output on all fixtures
- Target:
  - preserve current speed and segmentation
  - fix line count and order regressions

## Plan 2: Manga-OCR Track

Purpose: test the strongest manga-specific recognizer inside our harness.

- Use existing segmentation first:
  - start with current Paddle detections if they are already good enough
  - only add a new bubble detector if needed
- Feed cropped bubble or line regions to `manga-ocr`
- Normalize result back into the shared OCR schema
- Compare:
  - current Paddle recognizer vs manga-ocr on identical crops
- Focus questions:
  - does `manga-ocr` preserve vertical JP sentence text better
  - does it reduce missing/merged line failures
  - how much custom splitting do we need
- Treat Yomitan / Mokuro as inspiration, not as direct integration targets

## Plan 3: PaddleOCR-VL Track

Purpose: stay near the current architecture but move toward a more capable Paddle family model.

- Evaluate:
  - `PaddleOCR-VL`
  - `PaddleOCR-VL-For-Manga`
- Keep our harness:
  - same viewport render
  - same debug artifact path
  - same compare mode
- Compare against current Paddle on the same fixtures.
- Focus questions:
  - is recognition materially better on manga text
  - does it improve vertical Japanese sentence reconstruction
  - how much of the reading-order problem is still left after the model upgrade
- This is the closest path to “better OCR while keeping the app architecture stable.”

## Plan 4: OCR-Specialized / VLM Adapter Track

Purpose: test crop-based OCR backends that can plug into the same segmentation and ordering harness.

### OCR-Specialized Backends

- Try `DeepSeek-OCR-2`
- Try `GOT-OCR-2.0`
- Use them on cropped regions, not full pages first
- Normalize output into the shared OCR schema

### Qwen Track

- Do not target `Qwen2.5-VL-72B` on `RTX 3060 12GB`
- Current evidence says the practical target is:
  - `Qwen2.5-VL-7B-AWQ`
- Possibly also test:
  - `Qwen2.5-VL-3B`
- Treat Qwen as part of this same adapter track because it should plug into the same crop-based recognizer interface as DeepSeek/GOT

### Runtime Notes

- Best reported practical path for `12GB`:
  - `Qwen2.5-VL-7B-AWQ`
- Avoid assuming `72B quantized` is usable just because it can theoretically offload.
- For dense OCR, prefer crop-based prompts and controlled image token budgets.

### Focus Questions

- Are these better as:
  - direct recognizers
  - uncertainty repair passes
  - verifier / reranker after another recognizer
- Do they beat manga-ocr or Paddle on our fixtures
- Are they stable enough locally to justify integration complexity

## Architecture Rules

- Keep segmentation, recognition, and ordering separate.
- Do not bind the app to one recognizer.
- Prefer crop-level OCR over full-page VLM OCR on `3060 12GB`.
- Keep every backend behind the same interface so we can compare outputs in real time.
- Preserve existing debug artifacts and extend them rather than replacing them.

## Suggested Execution Order

1. Plan 0
   Build the plug-and-play OCR harness and compare mode first.
2. Plan 1
   Improve the existing Paddle path before changing recognizers.
3. Plan 2
   Test `manga-ocr` using current segmentation.
4. Plan 3
   Test `PaddleOCR-VL` and `PaddleOCR-VL-For-Manga`.
5. Plan 4
   Test `DeepSeek-OCR-2`, `GOT-OCR-2.0`, and `Qwen2.5-VL-7B-AWQ` as crop recognizers.
6. Compare hybrid winners:
   - Paddle segmentation + manga-ocr
   - Paddle segmentation + PaddleOCR-VL
   - Paddle segmentation + DeepSeek-OCR-2
   - Paddle segmentation + GOT-OCR-2.0
   - Paddle segmentation + Qwen2.5-VL-7B
   - best recognizer + best ordering layer + optional VLM verifier

## Expected Best End State

Most likely winning architecture:

- app capture / viewport render
- reusable segmentation layer
- explicit reading-order / grouping layer
- swappable recognizer adapters
- optional verifier / repair backend
- live compare mode in the app

This should get us closer to “OpenAI-like OCR” than chasing one giant model in isolation.

## Feedback / Planning Opinion

- Yes, Qwen should be in the plan, but not as a separate architectural universe.
- It belongs in the same adapter lane as DeepSeek and GOT because the harness should be shared.
- The real split is not “Paddle vs Qwen vs DeepSeek.”
- The real split is:
  - segmentation
  - recognizer
  - ordering
  - verifier
- If we build the harness right, the recognizer becomes the easiest part to swap.
- If we do not build Plan 0 first, every experiment will be slower, harder to compare, and harder to trust.
