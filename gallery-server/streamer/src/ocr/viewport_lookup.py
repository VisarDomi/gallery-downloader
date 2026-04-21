#!/usr/bin/env python3

import io
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from paddle_lookup import lookup_image


def clamp(value, low, high):
    return max(low, min(high, value))


def resolve_media_path(media_root: Path, media_path: str) -> Path:
    candidate = (media_root / media_path.lstrip("/")).resolve()
    if media_root not in candidate.parents and candidate != media_root:
        raise ValueError(f"media path escapes root: {media_path}")
    if not candidate.exists():
        raise FileNotFoundError(f"missing media: {candidate}")
    return candidate


def intersect(a, b):
    left = max(a["left"], b["left"])
    top = max(a["top"], b["top"])
    right = min(a["left"] + a["width"], b["left"] + b["width"])
    bottom = min(a["top"] + a["height"], b["top"] + b["height"])
    if right <= left or bottom <= top:
        return None
    return {
        "left": left,
        "top": top,
        "width": right - left,
        "height": bottom - top,
    }


def validate_payload(payload):
    viewport = payload.get("viewport")
    images = payload.get("images")
    if not isinstance(viewport, dict):
        raise ValueError("missing viewport")
    if not isinstance(images, list) or not images:
        raise ValueError("missing images")
    for field in ("width", "height", "scale", "devicePixelRatio"):
        value = viewport.get(field)
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)) or float(value) <= 0:
            raise ValueError(f"invalid viewport {field}")
    for image in images:
        if not isinstance(image, dict):
            raise ValueError("invalid image entry")
        if not isinstance(image.get("mediaPath"), str) or not image["mediaPath"]:
            raise ValueError("invalid mediaPath")
        for field in ("left", "top", "width", "height"):
            value = image.get(field)
            if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                raise ValueError(f"invalid image {field}")


def render_viewport_image(media_root: Path, payload: dict, output_path: Path | None = None):
    validate_payload(payload)
    viewport = payload["viewport"]
    images = payload["images"]

    viewport_rect = {
        "left": 0.0,
        "top": 0.0,
        "width": float(viewport["width"]),
        "height": float(viewport["height"]),
    }
    output_scale = max(1.0, float(viewport["devicePixelRatio"])) * max(1.0, float(viewport["scale"]))
    output_width = max(1, round(viewport_rect["width"] * output_scale))
    output_height = max(1, round(viewport_rect["height"] * output_scale))

    render_started = time.perf_counter()
    canvas = Image.new("RGB", (output_width, output_height), "white")
    decode_ms = 0.0
    crop_ms = 0.0
    resize_ms = 0.0
    paste_ms = 0.0
    image_total_ms = 0.0

    for image_entry in sorted(images, key=lambda item: (item.get("top", 0), item.get("pageIndex", 0))):
        image_started = time.perf_counter()
        image_rect = {
            "left": float(image_entry["left"]),
            "top": float(image_entry["top"]),
            "width": float(image_entry["width"]),
            "height": float(image_entry["height"]),
        }
        if image_rect["width"] <= 0 or image_rect["height"] <= 0:
            continue
        visible = intersect(viewport_rect, image_rect)
        if not visible:
            continue

        media_path = resolve_media_path(media_root, image_entry["mediaPath"])
        with Image.open(media_path) as opened:
            decode_started = time.perf_counter()
            source = ImageOps.exif_transpose(opened).convert("RGB")
            decode_ms += (time.perf_counter() - decode_started) * 1000
            src_width, src_height = source.size

            sx = clamp((visible["left"] - image_rect["left"]) * src_width / image_rect["width"], 0, src_width)
            sy = clamp((visible["top"] - image_rect["top"]) * src_height / image_rect["height"], 0, src_height)
            sw = clamp(visible["width"] * src_width / image_rect["width"], 0, src_width - sx)
            sh = clamp(visible["height"] * src_height / image_rect["height"], 0, src_height - sy)
            if sw <= 0 or sh <= 0:
                continue

            crop_box = (
                int(round(sx)),
                int(round(sy)),
                int(round(sx + sw)),
                int(round(sy + sh)),
            )
            crop_started = time.perf_counter()
            cropped = source.crop(crop_box)
            crop_ms += (time.perf_counter() - crop_started) * 1000

            dest_left = int(round(visible["left"] * output_scale))
            dest_top = int(round(visible["top"] * output_scale))
            dest_width = max(1, int(round(visible["width"] * output_scale)))
            dest_height = max(1, int(round(visible["height"] * output_scale)))
            if cropped.size != (dest_width, dest_height):
                resize_started = time.perf_counter()
                cropped = cropped.resize((dest_width, dest_height), Image.Resampling.LANCZOS)
                resize_ms += (time.perf_counter() - resize_started) * 1000

            paste_started = time.perf_counter()
            canvas.paste(cropped, (dest_left, dest_top))
            paste_ms += (time.perf_counter() - paste_started) * 1000
        image_total_ms += (time.perf_counter() - image_started) * 1000

    encode_ms = 0.0
    write_ms = 0.0
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        encode_started = time.perf_counter()
        encoded = io.BytesIO()
        canvas.save(encoded, format="PNG")
        encode_ms = round((time.perf_counter() - encode_started) * 1000, 2)

        write_started = time.perf_counter()
        output_path.write_bytes(encoded.getvalue())
        write_ms = round((time.perf_counter() - write_started) * 1000, 2)
    save_ms = round(encode_ms + write_ms, 2)
    render_total_ms = round((time.perf_counter() - render_started) * 1000, 2)
    image_bgr = np.array(canvas)[:, :, ::-1].copy()
    return image_bgr, {
        "render_total_ms": render_total_ms,
        "image_total_ms": round(image_total_ms, 2),
        "decode_ms": round(decode_ms, 2),
        "crop_ms": round(crop_ms, 2),
        "resize_ms": round(resize_ms, 2),
        "paste_ms": round(paste_ms, 2),
        "render_overhead_ms": round(max(0.0, image_total_ms - decode_ms - crop_ms - resize_ms - paste_ms), 2),
        "encode_ms": encode_ms,
        "write_ms": write_ms,
        "save_ms": save_ms,
        "output_width": output_width,
        "output_height": output_height,
        "image_count": len(images),
    }


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: viewport_lookup.py <media-root> <request-json> <output-image>")

    media_root = Path(sys.argv[1]).resolve()
    request_path = Path(sys.argv[2])
    output_path = Path(sys.argv[3])
    if not request_path.exists():
        raise SystemExit(f"missing request: {request_path}")

    request_read_started = time.perf_counter()
    payload = json.loads(request_path.read_text(encoding="utf-8"))
    request_read_ms = round((time.perf_counter() - request_read_started) * 1000, 2)

    image_bgr, render_profile = render_viewport_image(media_root, payload, output_path)
    result = lookup_image(image_bgr)
    result["profile"] = {
        "request_read_ms": request_read_ms,
        **render_profile,
        **(result.get("profile") or {}),
        "worker_total_ms": round(
            request_read_ms
            + render_profile["render_total_ms"]
            + float(result.get("elapsedMs", 0)),
            2,
        ),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
