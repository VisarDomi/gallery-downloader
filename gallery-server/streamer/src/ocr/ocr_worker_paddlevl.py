#!/usr/bin/env python3

import json
import re
import sys
import time
from io import BytesIO
from pathlib import Path
from urllib.request import Request, urlopen

from PIL import Image

from paddlevl_lookup import ensure_llama_server, run_vl_ocr

DOMAIN = "gold-usergeneratedcontent.net"
GG_URL = f"https://ltn.{DOMAIN}/gg.js"
GG_CACHE = None
GG_REFRESH_INTERVAL = 1800  # refresh gg.js every 30 min
GG_LAST_FETCH = 0


def fetch(url, referer=None):
    h = {
        "Origin": "https://hitomi.la",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    }
    if referer:
        h["Referer"] = referer
    return urlopen(Request(url, headers=h), timeout=30).read()


def get_gg():
    global GG_CACHE, GG_LAST_FETCH
    now = time.monotonic()
    if GG_CACHE is not None and (now - GG_LAST_FETCH) < GG_REFRESH_INTERVAL:
        return GG_CACHE
    text = fetch(GG_URL, "https://hitomi.la/").decode()
    m, keys = {}, []
    for match in re.finditer(r'case\s+(\d+):(?:\s*o\s*=\s*(\d+))?', text):
        key, value = match.groups()
        keys.append(int(key))
        if value:
            v = int(value)
            for k in keys:
                m[k] = v
            keys.clear()
    for match in re.finditer(r'if\s+\(g\s*===?\s*(\d+)\)[\s{]*o\s*=\s*(\d+)', text):
        m[int(match.group(1))] = int(match.group(2))
    d = re.search(r'(?:var\s|default:)\s*o\s*=\s*(\d+)', text)
    b = re.search(r"b:\s*[']([^']+)[']", text)
    GG_CACHE = (m, b.group(1).strip("/") if b else "", int(d.group(1)) if d else 0)
    GG_LAST_FETCH = now
    return GG_CACHE


def download_hitomi_page(gid, page_index):
    """Download one page from a hitomi gallery. page_index is 0-based.
    Returns (PIL.Image, image_width, image_height)."""
    meta_js = fetch(
        f"https://ltn.{DOMAIN}/galleries/{gid}.js",
        f"https://hitomi.la/reader/{gid}.html",
    ).decode()
    raw = json.loads(meta_js.split("=", 1)[1].strip().rstrip(";"))
    files = raw["files"]
    if page_index < 0 or page_index >= len(files):
        raise ValueError(f"page_index {page_index} out of range (0-{len(files)-1})")

    f = files[page_index]
    ihash = f["hash"]
    # gallery-dl defaults to webp format
    ext = "webp"
    inum = int(ihash[-1] + ihash[-3:-1], 16)
    gg_m, gg_b, gg_d = get_gg()
    offset = gg_m.get(inum, gg_d) + 1
    url = f"https://{ext[0]}{offset}.{DOMAIN}/{gg_b}/{inum}/{ihash}.{ext}"

    data = fetch(url, f"https://hitomi.la/reader/{gid}.html")
    img = Image.open(BytesIO(data))
    img = img.convert("RGB")
    return img, img.size[0], img.size[1]


def write_message(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_hitomi_ocr(command):
    """Handle OCR for a hitomi gallery page crop."""
    gid = command["galleryId"]
    page_index = command["pageIndex"] - 1  # convert 1-indexed to 0-indexed
    x1 = command["x1"]
    y1 = command["y1"]
    x2 = command["x2"]
    y2 = command["y2"]

    started = time.perf_counter()

    # Download the page
    img, img_w, img_h = download_hitomi_page(gid, page_index)
    download_ms = round((time.perf_counter() - started) * 1000, 2)

    # Clamp crop coordinates to image bounds
    x1 = max(0, min(x1, img_w))
    y1 = max(0, min(y1, img_h))
    x2 = max(0, min(x2, img_w))
    y2 = max(0, min(y2, img_h))
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"invalid crop: ({x1},{y1})-({x2},{y2}) for image {img_w}x{img_h}")

    # Crop
    cropped = img.crop((x1, y1, x2, y2))
    crop_ms = round((time.perf_counter() - started) * 1000 - download_ms, 2)

    # Run OCR
    text = run_vl_ocr(cropped)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    ocr_ms = round((time.perf_counter() - started) * 1000 - download_ms - crop_ms, 2)
    total_ms = round((time.perf_counter() - started) * 1000, 2)

    result = {
        "text": "\n".join(lines),
        "lines": lines,
        "warnings": [],
        "elapsedMs": total_ms,
        "profile": {
            "mode": "hitomi-ocr",
            "galleryId": gid,
            "pageIndex": page_index + 1,
            "imageWidth": img_w,
            "imageHeight": img_h,
            "cropBox": [x1, y1, x2, y2],
            "downloadMs": download_ms,
            "cropMs": crop_ms,
            "ocrMs": ocr_ms,
            "totalMs": total_ms,
        },
    }
    return result


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
            action = command.get("action")

            if action == "warm":
                ensure_llama_server()
                write_message({
                    "ok": True,
                    "result": {
                        "text": "",
                        "lines": [],
                        "warnings": [],
                        "elapsedMs": 0,
                        "profile": {"mode": "warm"},
                    },
                })
                continue

            if action == "hitomi-ocr":
                result = handle_hitomi_ocr(command)
                write_message({"ok": True, "result": result})
                continue

            # Legacy viewport-based lookup
            media_root = Path(command["mediaRoot"]).resolve()
            request_path = Path(command["requestPath"])
            image_path_value = command.get("imagePath")
            image_path = Path(image_path_value) if image_path_value else None
            request_read_started = time.perf_counter()
            payload = json.loads(request_path.read_text(encoding="utf-8"))
            request_read_ms = round((time.perf_counter() - request_read_started) * 1000, 2)

            from paddlevl_lookup import lookup_viewport_payload

            result = lookup_viewport_payload(media_root, payload, image_path)
            profile = result.get("profile") or {}
            worker_total_ms = float(result.get("elapsedMs") or 0)
            if worker_total_ms <= 0:
                worker_total_ms = (
                    float(profile.get("render_ms", 0))
                    + float(profile.get("paddle_total_ms", 0))
                    + float(profile.get("vl_request_ms", 0))
                )
            result["profile"] = {
                "request_read_ms": request_read_ms,
                **profile,
                "worker_total_ms": round(request_read_ms + worker_total_ms, 2),
            }
            write_message({"ok": True, "result": result})

        except Exception as exc:
            write_message({"ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
