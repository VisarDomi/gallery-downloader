# OCR TODO

Goal: make `paddle-vl` the high-quality daily-driver OCR path and build the harness around this model's behavior. Do not spend product work on non-VL OCR paths.

## Current State

- `Plan 0` is effectively done:
  - debug artifacts
  - fixture corpus
  - benchmark harness
- `Plan 1` is done enough for current use:
  - source-native render policy
  - legacy Paddle geometry/order fixes
  - generated perturbation suite
- `Plan 2` (`manga-ocr`) is not a winner:
  - too hallucination-prone for unattended pipeline use
  - do not pursue further
- `Plan 3` (`paddle-vl`) is the current production path:
  - default backend
  - better Japanese character fidelity than the non-VL path
  - less hallucination-prone than prior general VL experiments
  - current crop-based harness is no longer the right fit
  - measured parallel limit of `2`

## Decision: Build A VL-Native Harness

Observation from the `2026-04-25` frontend debug capture:

- The crop-based harness produced fragmented output:
  - `でもキャ`
  - `フを満喫`
  - `間`
  - `で`
  - `はない`
- Sending the same rendered viewport image directly to PaddleOCR-VL produced the near-correct text:
  - `でもキャンパスライフを満喫`
  - `しているような人間ではない。`
- Therefore the main failure is not PaddleOCR-VL recognition. The current harness is damaging the input before recognition by using classic PaddleOCR block detection, crop OCR, and block ordering rules that were built for the non-VL path.

Decision:

- The harness may be tightly coupled to PaddleOCR-VL.
- The app no longer needs a model-neutral OCR architecture.
- Classic OCR and OCR-VL are different enough that the old detector-box recognizer harness is the wrong abstraction for the production path.
- Build around PaddleOCR-VL's strengths:
  - full rendered viewport OCR for dense narration/dialogue views
  - page/column-level crops instead of small detector boxes when cropping is needed
  - explicit right-to-left vertical reading order after recognition
  - fewer perturbations until the base VL harness is trustworthy
- Keep old non-VL code only as fallback/reference while replacing the product path.

## Current Baseline

- Default backend: `paddle-vl`
- Default harness behavior:
  - legacy crop-based segmentation plus staged rotation
  - this is now considered a transitional implementation, not the target architecture
- Current safe parallel width:
  - full OCR pipeline: `2`
  - direct `llama-server` use: `2` is the conservative target

## Fixture Policy

- Keep human-verified fixtures under `tests/ocr-ground-truth/`
- Current important cases:
  - `case-2026-04-22-right-dialogue`
  - `case-2026-04-22-tight-crop`
  - `case-2026-04-22-bikini-dialogue`
- Keep adding cases that stress:
  - slanted text
  - mixed SFX + dialogue
  - very small crops
  - multi-page viewport seams
  - stylized fonts
  - dense vertical dialogue

## Near-Term Harness Work

Purpose: replace the legacy crop-based harness with a PaddleOCR-VL-native harness.

1. Add the `2026-04-25` frontend debug capture as a single manual fixture before generating perturbations.
2. Implement a VL-native baseline path:
   - send the full rendered viewport image to PaddleOCR-VL
   - compare against the current block-crop output in the same summary format
3. If full viewport OCR is reliable, make it the primary `paddle-vl` path for narration-heavy vertical text.
4. If full viewport OCR needs structure, group detected text into large columns or bubble regions before calling VL.
5. Reintroduce perturbation suites after the base harness preserves the visible text on manual fixtures.
6. Keep using the benchmark harness before widening internal fan-out.

## Architecture Rules

- Optimize the production OCR harness for PaddleOCR-VL, not for backend interchangeability.
- Keep rendering, VL prompting, result parsing, and reading-order cleanup inspectable as separate steps.
- Use fixture runner and summary formats to measure PaddleOCR-VL harness changes.
- Do not suppress warnings from the build or OCR stack; fix the owner.
- Prefer adapter-level changes over app-wide hacks.
- Do not force PaddleOCR-VL through classic detector-box segmentation.

## Suggested Next Experiment Order

1. Add the `2026-04-25` debug capture as a manual fixture.
2. Implement full-viewport PaddleOCR-VL as the primary baseline.
3. Run existing fixtures and compare against the crop harness.
4. Add column/page-region grouping only where full-viewport output needs ordering cleanup.
5. Add perturbations only after manual fixtures are stable.
