# what

A gallery management repo, to download and view galleries.

# why

I usually had to use multiple tools to download and view galleries, making the experience feel clunky. This monorepo makes it so you use the pc+phone combo to make gallery management usable only from the phone.

# how

This monorepo uses gallery-dl as the base to manage downloads and builds on top of that. I forked that repo to make it download thumbnails as well. And have a indexing system to keep lookup times from the frontend feel near instant. And a sync system which keeps tracked queries uptodate with the target website which has the galleries you download from. The .txt files that track the queries are managed by the frontend as well, so that you can use this app purely from the frontend after setup.

# manifest setup

The live manifest files are private and should stay local:

- `gallery-server/artists.txt`
- `gallery-server/filters.txt`
- `gallery-server/queries.txt`

To set them up:

1. Copy each example file and remove the `.example` suffix.
2. Put whatever private content you want in the live files.

Example:

- `gallery-server/artists.txt.example` -> `gallery-server/artists.txt`
- `gallery-server/filters.txt.example` -> `gallery-server/filters.txt`
- `gallery-server/queries.txt.example` -> `gallery-server/queries.txt`

# ocr runtimes

The reader OCR flow now uses repo-owned runtimes and model files.

- `gallery-server/.venvs/paddleocr-venv`
- `gallery-server/.venvs/mangaocr-venv`
- `gallery-server/.models/paddleocr-vl-1.5`

The streamer OCR route references those paths in `gallery-server/streamer/src/config.ts`.

If another repo needs one of these runtimes, it should reference that interpreter explicitly rather than owning the environment itself.

Current default backend:

- `paddle-vl`

Current available backends:

- `paddle-current`
- `manga-ocr`
- `paddle-vl`

Setup expectations:

1. Create the repo-owned Python envs under `gallery-server/.venvs/`.
2. Install the backend-specific dependencies into those envs.
3. Put the PaddleOCR-VL GGUF + mmproj files under `gallery-server/.models/paddleocr-vl-1.5/`.
4. Make sure `llama-server` from your local `llama.cpp` build exists at:
   - `~/Documents/work/ai/local-llm/engine/stable/llama.cpp/build/bin/llama-server`
5. Restart the streamer through systemd:
   - `npm run restart:streamer`

Operational notes:

- OCR debug artifacts are written to `/tmp/gallery-ocr-debug/` when `GALLERY_OCR_DEBUG_ARTIFACTS=1` is set for the streamer service.
- The default `paddle-vl` OCR worker preloads after streamer startup and stays loaded until `gallery-streamer.service` stops. Set `GALLERY_OCR_PRELOAD_DELAY_MS` on the streamer service to change the default 5 minute startup delay.
- Restarting `gallery-streamer.service` clears warm OCR workers and frees OCR-related VRAM.
- `manga-ocr` is currently kept only as an experimental backend. The production path is `paddle-vl`.
