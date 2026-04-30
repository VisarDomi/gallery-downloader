#!/usr/bin/env python3
"""
Sync diagnostic tool (READ-ONLY). Shows raw hitomi counts per entry.

IMPORTANT: This script does NOT apply the filter policy from filters.txt.
The canonical sync lives in the downloader service (manifest-resolver.ts).
Use the TS sync for actual downloads:
    curl -k -X POST https://localhost:11558/sync

This script is for dry-run diagnostics only.

Usage:
    python3 sync.py                  # dry-run: show what's new
    python3 sync.py --verify         # dry-run verify (show existing gallery count)
    python3 sync.py --extra-query female:mesugaki
"""

import struct
import sqlite3
import sys
import os
import urllib.parse
import urllib.error
import urllib.request
import ssl
import re

DOMAIN = "gold-usergeneratedcontent.net"
ROOT = "https://hitomi.la"
ARCHIVE_DB = os.path.expanduser("~/Pictures/gallery-dl/hitomi.sqlite3")
HITOMI_DIR = os.path.expanduser("~/Pictures/gallery-dl/hitomi")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ARTISTS_FILE = os.path.join(SCRIPT_DIR, "artists.txt")
QUERIES_FILE = os.path.join(SCRIPT_DIR, "queries.txt")
FILTERS_FILE = os.path.join(SCRIPT_DIR, "filters.txt")
DEFAULT_LANGUAGE = "japanese"
NOZOMI_CACHE: dict[tuple[str, str, str], list[int]] = {}
NOZOMI_CACHE_HITS = 0
NOZOMI_FETCHES = 0


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
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return b""
        raise


def fetch_nozomi(entry_type: str, name: str, language: str) -> list[int]:
    """Fetch gallery IDs from a single language-specific nozomi index. 1 HTTP request."""
    global NOZOMI_CACHE_HITS, NOZOMI_FETCHES
    name = normalize_search_value(name)
    language = normalize_search_value(language)
    cache_key = (entry_type, name, language)
    cached = NOZOMI_CACHE.get(cache_key)
    if cached is not None:
        NOZOMI_CACHE_HITS += 1
        return cached

    if entry_type == "language":
        url = f"https://ltn.{DOMAIN}/n/index-{urllib.parse.quote(name)}.nozomi"
        ids = decode_nozomi(http_get(url))
        NOZOMI_FETCHES += 1
        NOZOMI_CACHE[cache_key] = ids
        return ids

    name_encoded = urllib.parse.quote(name)
    if entry_type in ("female", "male"):
        full_tag = urllib.parse.quote(f"{entry_type}:{name}")
        url = f"https://ltn.{DOMAIN}/n/tag/{full_tag}-{urllib.parse.quote(language)}.nozomi"
    elif entry_type == "tag":
        url = f"https://ltn.{DOMAIN}/n/tag/{name_encoded}-{urllib.parse.quote(language)}.nozomi"
    else:
        url = f"https://ltn.{DOMAIN}/n/{entry_type}/{name_encoded}-{urllib.parse.quote(language)}.nozomi"

    ids = decode_nozomi(http_get(url))
    NOZOMI_FETCHES += 1
    NOZOMI_CACHE[cache_key] = ids
    return ids


def hitomi_url(entry_type: str, name: str, language: str) -> str:
    """Construct the hitomi.la browsable URL for this entry."""
    return f"{ROOT}/{entry_type}/{urllib.parse.quote(name)}-{language}.html"


def gallery_url(gallery_id: int) -> str:
    return f"{ROOT}/galleries/{gallery_id}.html"


# -- Filters parsing --

def load_filters(filepath: str) -> tuple[str, list[tuple[str, str]]]:
    """Load filters.txt. Returns (language, [(namespace, value), ...])."""
    language = DEFAULT_LANGUAGE
    negatives: list[tuple[str, str]] = []

    if not os.path.exists(filepath):
        return language, negatives

    with open(filepath) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            try:
                tokens = parse_tagged_query(line)
            except ValueError:
                continue

            if len(tokens) != 1:
                continue

            token = tokens[0]
            if token.namespace == "language" and not token.negated:
                language = token.value
                continue
            if token.negated:
                negatives.append((token.namespace, token.value))

    return language, negatives


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
MARKER_PATTERN = re.compile(r"(^|\s)(-?)(" + "|".join(KNOWN_NAMESPACES) + r"):", re.IGNORECASE)


def normalize_search_value(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip()).lower()


def parse_tagged_query(raw_query: str) -> list[QueryToken]:
    raw = raw_query.strip()
    if not raw:
        return []

    markers = list(MARKER_PATTERN.finditer(raw))
    if not markers:
        raise ValueError("Search must use namespace:value tokens")

    prefix = raw[:markers[0].start()].strip()
    if prefix:
        raise ValueError(f"Invalid text before first token: {prefix}")

    tokens: list[QueryToken] = []
    for i, marker in enumerate(markers):
        leading = marker.group(1) or ""
        token_start = marker.start() + len(leading)
        value_start = token_start + len(marker.group(0)) - len(leading)
        value_end = markers[i + 1].start() if i + 1 < len(markers) else len(raw)

        namespace = marker.group(3).lower()
        value = normalize_search_value(raw[value_start:value_end])
        if not value:
            raise ValueError(f"Missing value for {namespace}:")

        unknown_marker = re.search(r"(^|\s)-?([a-z][a-z0-9_-]*):", value, re.IGNORECASE)
        if unknown_marker and unknown_marker.group(2).lower() not in KNOWN_NAMESPACES:
            raise ValueError(f"Unknown namespace: {unknown_marker.group(2).lower()}")

        tokens.append(QueryToken(marker.group(2) == "-", namespace, value))

    return tokens


def parse_query(raw: str, language: str, negatives: list[tuple[str, str]]) -> tuple[list[QueryToken], str]:
    """Parse a query string + merge filters. Returns (tokens, language)."""
    seen: set[QueryToken] = set()
    tokens: list[QueryToken] = []

    for token in parse_tagged_query(raw):
        if token not in seen:
            seen.add(token)
            tokens.append(token)

    # Merge filter negatives
    for ns, val in negatives:
        token = QueryToken(True, ns, normalize_search_value(val))
        if token not in seen:
            seen.add(token)
            tokens.append(token)

    return tokens, language


def sync_query(raw: str, language: str, negatives: list[tuple[str, str]], archived: set[int]) -> tuple[int, int, list[str]]:
    """Sync a compound query with filters merged. Returns (remote_count, new_count, new_urls)."""
    tokens, lang = parse_query(raw, language, negatives)

    positives = [t for t in tokens if not t.negated]
    neg_tokens = [t for t in tokens if t.negated]

    if not positives:
        print(f"  SKIP (no positive tokens): {raw}")
        return 0, 0, []

    # Intersect all positive token sets
    result_ids: set[int] | None = None
    for token in positives:
        label = f"{token.namespace}:{token.value}"
        try:
            ids = set(fetch_nozomi(token.namespace, token.value, lang))
        except Exception as e:
            print(f"  ERROR fetching {label}: {e}")
            return 0, 0, []
        print(f"  +{label} ({len(ids)})", end="", flush=True)
        result_ids = ids if result_ids is None else result_ids & ids

    # Subtract all negative token sets
    for token in neg_tokens:
        label = f"{token.namespace}:{token.value}"
        try:
            ids = set(fetch_nozomi(token.namespace, token.value, lang))
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


def load_lines(filepath: str) -> list[str]:
    """Load non-empty, non-comment lines from a file. Returns [] if file missing."""
    if not os.path.exists(filepath):
        return []
    with open(filepath) as f:
        return [line.strip() for line in f if line.strip() and not line.startswith("#")]


def read_option_values(flag: str) -> list[str]:
    values: list[str] = []
    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == flag:
            if i + 1 >= len(sys.argv):
                print(f"ERROR: {flag} needs a value")
                sys.exit(1)
            values.append(sys.argv[i + 1])
            i += 2
            continue
        if arg.startswith(flag + "="):
            values.append(arg[len(flag) + 1:])
        i += 1
    return values


def main():
    if "--queue" in sys.argv:
        print("ERROR: --queue is removed. Use the TS sync instead:")
        print("  curl -k -X POST https://localhost:11558/sync")
        sys.exit(1)

    do_verify = "--verify" in sys.argv
    extra_queries = read_option_values("--extra-query")

    language, negatives = load_filters(FILTERS_FILE)
    artist_lines = load_lines(ARTISTS_FILE)
    query_lines = load_lines(QUERIES_FILE)
    for raw in extra_queries:
        try:
            tokens = parse_tagged_query(raw)
        except ValueError as e:
            print(f"ERROR: bad --extra-query {raw!r}: {e}")
            sys.exit(1)
        if not tokens or any(token.negated for token in tokens):
            print(f"ERROR: --extra-query must contain positive namespace:value tokens only: {raw}")
            sys.exit(1)
        query_lines.append(raw)

    if not artist_lines and not query_lines:
        print("Both artists.txt and queries.txt are empty or missing.")
        return

    mode_parts = ["DRY-RUN"]
    if do_verify:
        mode_parts.append("VERIFY")

    print(f"Loaded {len(artist_lines)} artists + {len(query_lines)} queries + {len(negatives)} filters")
    if extra_queries:
        print(f"Extra dry-run queries: {len(extra_queries)} (not written to queries.txt)")
    print(f"Language: {language}")
    print(f"Mode: {' + '.join(mode_parts)}")
    print("NOTE: Artist counts are UNFILTERED (no exclusions applied).")
    print("      The TS sync applies all filter negatives to artist IDs.")
    print("=" * 60)

    print("Loading archive...", end=" ", flush=True)
    archived = load_archived_gallery_ids()
    print(f"{len(archived)} galleries downloaded\n")

    # --- Phase 1: artists.txt (single-index entries, NO filter application) ---
    all_new_urls = []
    total_remote = 0
    total_new = 0

    if artist_lines:
        print(f"--- artists.txt ({len(artist_lines)} entries) ---")

    for line in artist_lines:
        try:
            tokens = parse_tagged_query(line)
        except ValueError as e:
            print(f"  SKIP (bad format): {line} ({e})")
            continue

        if len(tokens) != 1 or tokens[0].negated or tokens[0].namespace not in ("artist", "group"):
            print(f"  SKIP (bad format): {line}")
            continue

        entry_type = tokens[0].namespace
        name = tokens[0].value

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

    # --- Phase 2: queries.txt (with filters merged) ---
    if query_lines:
        print(f"\n--- queries.txt ({len(query_lines)} queries, filters merged) ---")

    for raw in query_lines:
        print(f"[{raw}]")

        remote_count, new_count, new_urls = sync_query(raw, language, negatives, archived)
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

    # --- Verify existing galleries ---
    if do_verify:
        disk_ids = load_disk_gallery_ids()
        print(f"Verify: {len(disk_ids)} existing galleries on disk")

    # --- Summary ---
    if all_new_urls:
        print(f"\n{len(all_new_urls)} new.")
    else:
        print("\nNothing new.")
    print(f"Nozomi cache: {NOZOMI_CACHE_HITS} hits, {NOZOMI_FETCHES} network fetches")
    print("To queue downloads, use: curl -k -X POST https://localhost:11558/sync")


if __name__ == "__main__":
    main()
