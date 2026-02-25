# gallery-reader

Monorepo for a self-hosted gallery viewer PWA with search, sprite thumbnails, and a download queue.

## Structure

- **gallery-sources** — Provider-specific logic (currently: Hitomi)
- **gallery-reader** — SvelteKit frontend PWA
- **gallery-server** — Backend services (indexer, streamer, downloader)
- **gallery-index** — JSON registry of available sources

## gallery-dl fork

The downloader uses a [fork of gallery-dl](https://github.com/VisarDomi/gallery-dl) (branch: `hitomi-thumbnails`) that adds thumbnail downloading for the Hitomi provider. The fork is pinned as a git submodule at `gallery-server/gallery-dl`.

The fork's changes are small and limited to the Hitomi extractor, so rebasing onto upstream gallery-dl should be straightforward.

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
