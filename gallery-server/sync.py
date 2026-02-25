#!/usr/bin/env python3
"""
Sync script: reads artists.txt, checks hitomi nozomi indexes against
the local gallery-dl archive, and queues only NEW galleries for download.

Each entry = 1 HTTP request (language-specific nozomi index).

Usage:
    python3 sync.py                  # dry-run: show what's new
    python3 sync.py --queue          # send new galleries to downloader
    python3 sync.py --verify         # dry-run verify (show existing gallery count)
    python3 sync.py --queue --verify # queue new, then append all existing for gap-filling
"""

import struct
import sqlite3
import sys
import os
import urllib.parse
import urllib.request
import ssl
import json
from pathlib import Path

DOMAIN = "gold-usergeneratedcontent.net"
ROOT = "https://hitomi.la"
ARCHIVE_DB = os.path.expanduser("~/Pictures/gallery-dl/hitomi.sqlite3")
HITOMI_DIR = os.path.expanduser("~/Pictures/gallery-dl/hitomi")
ARTISTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artists.txt")
DOWNLOADER_URL = "https://localhost:11558/queue"
DEFAULT_LANGUAGE = "japanese"


def decode_nozomi(data: bytes) -> list[int]:
    count = len(data) // 4
    if count == 0:
        return []
    return list(struct.unpack(f'>{count}I', data[:count * 4]))


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={
        "Origin": ROOT,
        "Referer": ROOT + "/",
        "User-Agent": "Mozilla/5.0",
    })
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        return resp.read()


def fetch_nozomi(entry_type: str, name: str, language: str) -> list[int]:
    """Fetch gallery IDs from a single language-specific nozomi index. 1 HTTP request."""
    name_encoded = urllib.parse.quote(name.replace('_', ' '))

    if entry_type in ("female", "male"):
        url = f"https://ltn.{DOMAIN}/tag/{entry_type}%3A{name_encoded}-{language}.nozomi"
    else:
        url = f"https://ltn.{DOMAIN}/{entry_type}/{name_encoded}-{language}.nozomi"

    return decode_nozomi(http_get(url))


def parse_entry(line: str) -> tuple[str, str, str]:
    """Parse a line like 'artist:name' or 'language:korean artist:name'.
    Returns (entry_type, name, language)."""
    parts = line.split()
    language = DEFAULT_LANGUAGE
    entry_type = None
    name = None

    for part in parts:
        key, _, val = part.partition(":")
        if key == "language":
            language = val
        else:
            entry_type = key
            name = val

    return entry_type, name, language


def hitomi_url(entry_type: str, name: str, language: str) -> str:
    """Construct the hitomi.la browsable URL for this entry."""
    return f"{ROOT}/{entry_type}/{name}-{language}.html"


def gallery_url(gallery_id: int) -> str:
    return f"{ROOT}/galleries/{gallery_id}.html"


def load_archived_gallery_ids() -> set[int]:
    if not os.path.exists(ARCHIVE_DB):
        return set()
    conn = sqlite3.connect(ARCHIVE_DB)
    cursor = conn.execute(
        "SELECT DISTINCT substr(entry, 1, instr(entry, '_') - 1) FROM archive"
    )
    ids = set()
    for (prefix,) in cursor:
        try:
            ids.add(int(prefix[6:]))  # strip "hitomi"
        except (ValueError, IndexError):
            pass
    conn.close()
    return ids


def load_disk_gallery_ids() -> list[int]:
    """Get all gallery IDs from on-disk directories, sorted oldest first."""
    ids = []
    if not os.path.isdir(HITOMI_DIR):
        return ids
    for name in os.listdir(HITOMI_DIR):
        if name.startswith('.'):
            continue
        full = os.path.join(HITOMI_DIR, name)
        if not os.path.isdir(full):
            continue
        try:
            ids.append(int(name.split(' ')[0]))
        except ValueError:
            pass
    ids.sort()
    return ids


def post_to_downloader(urls: list[str]) -> bool:
    payload = json.dumps({"urls": "\n".join(urls)}).encode()
    req = urllib.request.Request(
        DOWNLOADER_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, context=ctx) as resp:
            result = json.loads(resp.read())
            return result.get("status") == "ok"
    except Exception as e:
        print(f"  ERROR posting to downloader: {e}")
        return False


def main():
    do_queue = "--queue" in sys.argv
    do_verify = "--verify" in sys.argv

    if not os.path.exists(ARTISTS_FILE):
        print(f"No artists.txt found at {ARTISTS_FILE}")
        sys.exit(1)

    with open(ARTISTS_FILE) as f:
        lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]

    if not lines:
        print("artists.txt is empty.")
        return

    mode_parts = []
    if do_queue:
        mode_parts.append("QUEUE")
    if do_verify:
        mode_parts.append("VERIFY")
    if not mode_parts:
        mode_parts.append("DRY-RUN")

    print(f"Loaded {len(lines)} entries from artists.txt")
    print(f"Mode: {' + '.join(mode_parts)}")
    print("=" * 60)

    print("Loading archive...", end=" ", flush=True)
    archived = load_archived_gallery_ids()
    print(f"{len(archived)} galleries downloaded\n")

    # --- Phase 1: find new galleries ---
    all_new_urls = []
    total_remote = 0
    total_new = 0

    for line in lines:
        entry_type, name, language = parse_entry(line)
        if not entry_type or not name:
            print(f"  SKIP (bad format): {line}")
            continue

        label = f"{entry_type}:{name}"
        print(f"[{label}]", end=" ", flush=True)

        try:
            remote_ids = set(fetch_nozomi(entry_type, name, language))
        except Exception as e:
            print(f"ERROR: {e}")
            continue

        new_ids = remote_ids - archived
        total_remote += len(remote_ids)
        total_new += len(new_ids)

        print(f"remote={len(remote_ids)} new={len(new_ids)}", end="")
        print(f"  {hitomi_url(entry_type, name, language)}")

        if new_ids:
            urls = [gallery_url(gid) for gid in sorted(new_ids, reverse=True)]
            all_new_urls.extend(urls)
            for url in urls[:3]:
                print(f"  + {url}")
            if len(urls) > 3:
                print(f"  ... +{len(urls) - 3} more")

    print("\n" + "=" * 60)
    print(f"Total: {total_remote} remote, {len(archived)} archived, {total_new} new")

    # --- Phase 2: verify existing galleries ---
    verify_urls = []
    if do_verify:
        disk_ids = load_disk_gallery_ids()
        verify_urls = [gallery_url(gid) for gid in disk_ids]
        print(f"Verify: {len(verify_urls)} existing galleries will be re-checked for gaps")

    # --- Queue ---
    combined = all_new_urls + verify_urls

    if not combined:
        print("Nothing to do.")
        return

    if do_queue:
        print(f"\nQueueing {len(combined)} galleries ({len(all_new_urls)} new + {len(verify_urls)} verify)...")
        if post_to_downloader(combined):
            print("Queued successfully!")
        else:
            print("Failed. Is the downloader running?")
    else:
        parts = []
        if all_new_urls:
            parts.append(f"{len(all_new_urls)} new")
        if verify_urls:
            parts.append(f"{len(verify_urls)} verify")
        print(f"\n{' + '.join(parts)}. Run with --queue to download.")


if __name__ == "__main__":
    main()
