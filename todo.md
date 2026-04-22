# OCR TODO

Goal: keep the current `paddle-vl` path as a stable daily-driver baseline, while preserving a clean path to future recognizer experiments like DeepSeek and Qwen.

## Current State

- `Plan 0` is effectively done:
  - shared OCR harness
  - backend interface
  - debug artifacts
  - fixture corpus
  - benchmark harness
- `Plan 1` is done enough for current use:
  - source-native render policy
  - Paddle geometry/order fixes
  - generated perturbation suite
- `Plan 2` (`manga-ocr`) is not a winner:
  - too hallucination-prone for unattended pipeline use
  - kept only as an experimental backend
- `Plan 3` (`paddle-vl`) is the current production path:
  - default backend
  - staged rotation harness
  - weak-check-driven escalation
  - measured parallel limit of `2`

## Current Baseline

- Default backend: `paddle-vl`
- Default harness behavior:
  1. run `0°`
  2. evaluate baseline quality/geometry
  3. if weak, run `+20°` and `-20°` in parallel
  4. pick the strongest result
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

Purpose: improve `paddle-vl` without changing the recognizer family.

1. Validate the staged weak-check in real usage.
2. Tune the weak-check thresholds only if real phone usage shows too many unnecessary escalations.
3. If needed, add a second fallback wave after `+20/-20`:
   - only if both candidates remain weak
   - likely candidates: `+10/-10`
4. Keep using the benchmark harness before widening internal fan-out.

## Future Adapter Track

Purpose: test new recognizers against the same harness, corpus, and evaluation rules.

### DeepSeek Track

- Candidate:
  - `DeepSeek-OCR-2`
- Integration shape:
  - crop-based recognizer adapter
  - keep current render / segmentation / ordering harness
- Questions:
  - does it preserve Japanese text faithfully
  - does it beat `paddle-vl` on hard slanted dialogue
  - can it run locally with acceptable VRAM/latency

### GOT Track

- Candidate:
  - `GOT-OCR-2.0`
- Integration shape:
  - same adapter boundary as DeepSeek
- Questions:
  - is it better as a primary recognizer or repair pass
  - does it outperform `paddle-vl` on fixtures that currently need rotation escalation

### Qwen Track

- Candidate priority:
  - `Qwen2.5-VL-7B-AWQ`
- Secondary candidate:
  - `Qwen2.5-VL-3B`
- Do not target:
  - `Qwen2.5-VL-72B` on `3060 12GB`
- Integration shape:
  - same crop-based adapter boundary as DeepSeek/GOT
- Questions:
  - does Qwen work better as:
    - primary recognizer
    - repair pass
    - verifier/reranker over `paddle-vl`

## Architecture Rules

- Keep segmentation, recognition, and ordering separate.
- Do not bind the app to one recognizer implementation.
- Use the same fixture runner and summary format for every backend.
- Do not suppress warnings from the build or OCR stack; fix the owner.
- Prefer adapter-level changes over app-wide hacks.

## Suggested Next Experiment Order

1. Keep validating the current `paddle-vl` baseline in real usage.
2. If quality still needs improvement, try `DeepSeek-OCR-2`.
3. Then try `GOT-OCR-2.0`.
4. Then try `Qwen2.5-VL-7B-AWQ`.
5. Compare each against `paddle-vl` on the same fixtures and latency budget.

## Exit Criteria For Switching Away From Paddle-VL

Only switch the production default if a new backend is clearly better on:

- source fidelity
- hard slanted dialogue
- latency for daily phone usage
- operational simplicity on `3060 12GB`

If a candidate is only better on one narrow fixture but worse operationally, keep `paddle-vl` as the default and treat the candidate as an experiment.
