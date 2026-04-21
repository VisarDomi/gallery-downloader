#!/usr/bin/env python3

import json
import math
import sys
from pathlib import Path

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


def render_viewport_image(media_root: Path, payload: dict, output_path: Path):
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

    canvas = Image.new("RGB", (output_width, output_height), "white")

    for image_entry in sorted(images, key=lambda item: (item.get("top", 0), item.get("pageIndex", 0))):
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
            source = ImageOps.exif_transpose(opened).convert("RGB")
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
            cropped = source.crop(crop_box)

            dest_left = int(round(visible["left"] * output_scale))
            dest_top = int(round(visible["top"] * output_scale))
            dest_width = max(1, int(round(visible["width"] * output_scale)))
            dest_height = max(1, int(round(visible["height"] * output_scale)))
            if cropped.size != (dest_width, dest_height):
                cropped = cropped.resize((dest_width, dest_height), Image.Resampling.LANCZOS)

            canvas.paste(cropped, (dest_left, dest_top))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, format="PNG")


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: viewport_lookup.py <media-root> <request-json> <output-image>")

    media_root = Path(sys.argv[1]).resolve()
    request_path = Path(sys.argv[2])
    output_path = Path(sys.argv[3])
    if not request_path.exists():
        raise SystemExit(f"missing request: {request_path}")

    payload = json.loads(request_path.read_text(encoding="utf-8"))
    render_viewport_image(media_root, payload, output_path)
    result = lookup_image(output_path)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
