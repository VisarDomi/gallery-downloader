#!/usr/bin/env python3
"""
Sync script: reads artists.txt and queries.txt, checks hitomi nozomi indexes
against the local gallery-dl archive, and queues only NEW galleries for download.

artists.txt: one entry per line (artist:name, group:name, etc.) — 1 HTTP request each.
queries.txt: one compound query per line — parsed like the search bar, multiple fetches
             with set intersection (positives) and subtraction (negatives).

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
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ARTISTS_FILE = os.path.join(SCRIPT_DIR, "artists.txt")
QUERIES_FILE = os.path.join(SCRIPT_DIR, "queries.txt")
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


# -- Query parsing (for queries.txt) --

class QueryToken:
    __slots__ = ("negated", "namespace", "value")

    def __init__(self, negated: bool, namespace: str, value: str):
        self.negated = negated
        self.namespace = namespace
        self.value = value

    def __eq__(self, other):
        return (self.negated, self.namespace, self.value) == (other.negated, other.namespace, other.value)

    def __hash__(self):
        return hash((self.negated, self.namespace, self.value))


KNOWN_NAMESPACES = {"type", "language", "tag", "female", "male", "artist", "group", "series", "character"}


def parse_query(raw: str) -> tuple[list[QueryToken], str]:
    """Parse a query string into deduplicated tokens and language.
    Returns (tokens, language). Language defaults to DEFAULT_LANGUAGE."""
    parts = raw.strip().split()
    language = DEFAULT_LANGUAGE
    seen: set[QueryToken] = set()
    tokens: list[QueryToken] = []

    for part in parts:
        negated = part.startswith("-")
        clean = part[1:] if negated else part

        if ":" not in clean:
            continue

        ns, _, val = clean.partition(":")
        if ns not in KNOWN_NAMESPACES:
            continue

        if ns == "language":
            language = val.replace("_", " ")
            continue

        token = QueryToken(negated, ns, val.replace("_", " "))
        if token not in seen:
            seen.add(token)
            tokens.append(token)

    return tokens, language


def sync_query(raw: str, archived: set[int]) -> tuple[int, int, list[str]]:
    """Sync a compound query. Returns (remote_count, new_count, new_urls)."""
    tokens, language = parse_query(raw)

    positives = [t for t in tokens if not t.negated]
    negatives = [t for t in tokens if t.negated]

    if not positives:
        print(f"  SKIP (no positive tokens): {raw}")
        return 0, 0, []

    # Intersect all positive token sets
    result_ids: set[int] | None = None
    for token in positives:
        label = f"{token.namespace}:{token.value}"
        try:
            ids = set(fetch_nozomi(token.namespace, token.value, language))
        except Exception as e:
            print(f"  ERROR fetching {label}: {e}")
            return 0, 0, []
        print(f"  +{label} ({len(ids)})", end="", flush=True)
        result_ids = ids if result_ids is None else result_ids & ids

    # Subtract all negative token sets
    for token in negatives:
        label = f"{token.namespace}:{token.value}"
        try:
            ids = set(fetch_nozomi(token.namespace, token.value, language))
        except Exception as e:
            print(f"  ERROR fetching -{label}: {e}")
            continue
        before = len(result_ids)
        result_ids -= ids
        print(f"  -{label} (-{before - len(result_ids)})", end="", flush=True)

    print()

    remote_count = len(result_ids)
    new_ids = result_ids - archived
    new_urls = [gallery_url(gid) for gid in sorted(new_ids, reverse=True)]
    return remote_count, len(new_ids), new_urls


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


def load_lines(filepath: str) -> list[str]:
    """Load non-empty, non-comment lines from a file. Returns [] if file missing."""
    if not os.path.exists(filepath):
        return []
    with open(filepath) as f:
        return [line.strip() for line in f if line.strip() and not line.startswith("#")]


def main():
    do_queue = "--queue" in sys.argv
    do_verify = "--verify" in sys.argv

    artist_lines = load_lines(ARTISTS_FILE)
    query_lines = load_lines(QUERIES_FILE)

    if not artist_lines and not query_lines:
        print("Both artists.txt and queries.txt are empty or missing.")
        return

    mode_parts = []
    if do_queue:
        mode_parts.append("QUEUE")
    if do_verify:
        mode_parts.append("VERIFY")
    if not mode_parts:
        mode_parts.append("DRY-RUN")

    print(f"Loaded {len(artist_lines)} artists + {len(query_lines)} queries")
    print(f"Mode: {' + '.join(mode_parts)}")
    print("=" * 60)

    print("Loading archive...", end=" ", flush=True)
    archived = load_archived_gallery_ids()
    print(f"{len(archived)} galleries downloaded\n")

    # --- Phase 1a: artists.txt (single-index entries) ---
    all_new_urls = []
    total_remote = 0
    total_new = 0

    if artist_lines:
        print(f"--- artists.txt ({len(artist_lines)} entries) ---")

    for line in artist_lines:
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

    # --- Phase 1b: queries.txt (compound queries) ---
    if query_lines:
        print(f"\n--- queries.txt ({len(query_lines)} queries) ---")

    for raw in query_lines:
        print(f"[{raw}]")

        remote_count, new_count, new_urls = sync_query(raw, archived)
        total_remote += remote_count
        total_new += new_count

        print(f"  remote={remote_count} new={new_count}")

        if new_urls:
            all_new_urls.extend(new_urls)
            for url in new_urls[:3]:
                print(f"  + {url}")
            if len(new_urls) > 3:
                print(f"  ... +{len(new_urls) - 3} more")

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
