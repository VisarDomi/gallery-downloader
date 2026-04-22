# OCR Fixtures

Each real frontend viewport gets its own case folder.

Canonical files live at the root of each case:

- `request.json`: the frontend viewport request
- `transcript.txt`: the human-verified source of truth
- `README.md`: short notes

Derived artifacts live under each case's `generated/` directory.

Generate deterministic perturbation suites with:

```bash
python3 tests/ocr-ground-truth/generate_cases.py
```

Render generated cases into PNGs and manifests with:

```bash
python3 tests/ocr-ground-truth/generate_cases.py --render
```

Generated output goes under each case folder and is safe to delete and rebuild.

Run OCR over every generated request and store per-variant model outputs with:

```bash
python3 tests/ocr-ground-truth/run_cases.py --backend paddle-current
```

That writes results under each case's `generated/results/<backend>/`.
