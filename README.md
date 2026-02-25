# gallery-reader

Monorepo for a self-hosted gallery viewer PWA with search, sprite thumbnails, and a download queue.

## Structure

- **gallery-sources** — Provider-specific logic (currently: Hitomi)
- **gallery-reader** — SvelteKit frontend PWA
- **gallery-server** — Backend services (indexer, streamer, downloader)
- **gallery-index** — JSON registry of available sources

## Setup

```bash
git clone --recurse-submodules git@github.com:VisarDomi/gallery-reader.git
cd gallery-reader

# Install dependencies
npm install

# Set up gallery-dl Python venv
cd gallery-server/gallery-dl
python3 -m venv .venv
.venv/bin/pip install -e .
cd ../..

# Build everything
npm run build
```
