#!/usr/bin/env python3

import argparse
import copy
import io
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH_ROOT = ROOT / "tests" / "ocr-ground-truth"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def effective_scale(request):
    viewport = request["viewport"]
    return float(viewport["scale"]) * float(viewport["devicePixelRatio"])


def source_native_scale(request, media_root: Path):
    first_image = request["images"][0]
    image_path = (media_root / first_image["mediaPath"].lstrip("/")).resolve()
    with Image.open(image_path) as opened:
        source_width = opened.size[0]
    displayed_width = float(first_image["width"])
    return source_width / displayed_width


def clone_request(request):
    return copy.deepcopy(request)


def shift_request(request, dx=0.0, dy=0.0):
    variant = clone_request(request)
    for image in variant["images"]:
        image["left"] = round(float(image["left"]) + dx, 3)
        image["top"] = round(float(image["top"]) + dy, 3)
    return variant


def zoom_request(request, factor):
    variant = clone_request(request)
    viewport = variant["viewport"]
    cx = float(viewport["width"]) / 2.0
    cy = float(viewport["height"]) / 2.0
    for image in variant["images"]:
        left = float(image["left"])
        top = float(image["top"])
        width = float(image["width"])
        height = float(image["height"])
        image["left"] = round(cx + (left - cx) * factor, 3)
        image["top"] = round(cy + (top - cy) * factor, 3)
        image["width"] = round(width * factor, 3)
        image["height"] = round(height * factor, 3)
    return variant


def set_effective_scale(request, new_effective_scale):
    variant = clone_request(request)
    variant["viewport"]["scale"] = round(float(new_effective_scale), 6)
    variant["viewport"]["devicePixelRatio"] = 1
    return variant


def clamp_scale(value):
    return max(0.75, min(12.0, value))


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


def render_viewport_image(media_root: Path, payload: dict):
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

    image_bgr = np.array(canvas)[:, :, ::-1].copy()
    return image_bgr, {
        "output_width": output_width,
        "output_height": output_height,
        "image_count": len(images),
    }


def build_variants(request, media_root: Path):
    viewport = request["viewport"]
    pan_x = round(float(viewport["width"]) * 0.08, 3)
    pan_y = round(float(viewport["height"]) * 0.08, 3)
    current_scale = effective_scale(request)
    native_scale = source_native_scale(request, media_root)

    return [
        {
            "id": "golden",
            "family": "baseline",
            "description": "Exact frontend request.",
            "request": clone_request(request),
        },
        {
            "id": "pan-left",
            "family": "navigation",
            "description": "Pan viewport left by 8% of width.",
            "request": shift_request(request, dx=pan_x),
        },
        {
            "id": "pan-right",
            "family": "navigation",
            "description": "Pan viewport right by 8% of width.",
            "request": shift_request(request, dx=-pan_x),
        },
        {
            "id": "pan-up",
            "family": "navigation",
            "description": "Pan viewport up by 8% of height.",
            "request": shift_request(request, dy=pan_y),
        },
        {
            "id": "pan-down",
            "family": "navigation",
            "description": "Pan viewport down by 8% of height.",
            "request": shift_request(request, dy=-pan_y),
        },
        {
            "id": "pan-up-left",
            "family": "navigation",
            "description": "Diagonal pan up-left.",
            "request": shift_request(request, dx=pan_x, dy=pan_y),
        },
        {
            "id": "pan-up-right",
            "family": "navigation",
            "description": "Diagonal pan up-right.",
            "request": shift_request(request, dx=-pan_x, dy=pan_y),
        },
        {
            "id": "pan-down-left",
            "family": "navigation",
            "description": "Diagonal pan down-left.",
            "request": shift_request(request, dx=pan_x, dy=-pan_y),
        },
        {
            "id": "pan-down-right",
            "family": "navigation",
            "description": "Diagonal pan down-right.",
            "request": shift_request(request, dx=-pan_x, dy=-pan_y),
        },
        {
            "id": "zoom-in-sm",
            "family": "zoom",
            "description": "Zoom in by 8%.",
            "request": zoom_request(request, 1.08),
        },
        {
            "id": "zoom-out-sm",
            "family": "zoom",
            "description": "Zoom out by 8%.",
            "request": zoom_request(request, 0.92),
        },
        {
            "id": "zoom-in-lg",
            "family": "zoom",
            "description": "Zoom in by 15%.",
            "request": zoom_request(request, 1.15),
        },
        {
            "id": "zoom-out-lg",
            "family": "zoom",
            "description": "Zoom out by 15%.",
            "request": zoom_request(request, 0.85),
        },
        {
            "id": "render-source-native",
            "family": "render-policy",
            "description": "Render at estimated source-native crop resolution.",
            "request": set_effective_scale(request, clamp_scale(native_scale)),
        },
        {
            "id": "render-source-capped",
            "family": "render-policy",
            "description": "Render slightly above source-native crop resolution.",
            "request": set_effective_scale(request, clamp_scale(native_scale * 1.15)),
        },
        {
            "id": "render-downscaled",
            "family": "render-policy",
            "description": "Render below source-native crop resolution.",
            "request": set_effective_scale(request, clamp_scale(native_scale * 0.75)),
        },
        {
            "id": "render-frontend-linked",
            "family": "render-policy",
            "description": "Render at the original frontend-linked scale with DPR folded into scale=1 form.",
            "request": set_effective_scale(request, clamp_scale(current_scale)),
        },
    ]


def render_case(media_root: Path, request, output_path: Path):
    image_bgr, profile = render_viewport_image(media_root, request)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.ascontiguousarray(image_bgr[:, :, ::-1])).save(output_path)
    return profile


def collect_case_dirs(selected_seed):
    if selected_seed:
        candidate = GROUND_TRUTH_ROOT / selected_seed
        if not candidate.exists():
            raise SystemExit(f"missing case: {candidate}")
        return [candidate]
    return sorted(
        path for path in GROUND_TRUTH_ROOT.iterdir()
        if path.is_dir() and path.name != "__pycache__"
    )


def main():
    parser = argparse.ArgumentParser(description="Generate OCR perturbation cases from saved frontend requests.")
    parser.add_argument("--seed", help="Generate cases for one case directory name only.")
    parser.add_argument("--media-root", default="/home/visar/Pictures")
    parser.add_argument("--render", action="store_true", help="Also render PNGs for each generated request.")
    args = parser.parse_args()

    media_root = Path(args.media_root).resolve()
    for case_dir in collect_case_dirs(args.seed):
        if not (case_dir / "request.json").exists():
            continue
        request = load_json(case_dir / "request.json")
        transcript = (case_dir / "transcript.txt").read_text(encoding="utf-8")
        variants = build_variants(request, media_root)
        out_dir = case_dir / "generated"
        manifest = {
            "case": case_dir.name,
            "transcriptPath": str((case_dir / "transcript.txt").relative_to(ROOT)),
            "variantCount": len(variants),
            "variants": [],
        }
        for variant in variants:
            request_path = out_dir / f"{variant['id']}.request.json"
            save_json(request_path, variant["request"])
            entry = {
                "id": variant["id"],
                "family": variant["family"],
                "description": variant["description"],
                "requestPath": str(request_path.relative_to(ROOT)),
            }
            if args.render:
                image_path = out_dir / f"{variant['id']}.png"
                render_profile = render_case(media_root, variant["request"], image_path)
                entry["imagePath"] = str(image_path.relative_to(ROOT))
                entry["renderProfile"] = render_profile
            manifest["variants"].append(entry)
        (out_dir / "expected.txt").write_text(transcript, encoding="utf-8")
        save_json(out_dir / "manifest.json", manifest)
        print(f"generated {len(variants)} cases for {case_dir.name}")


if __name__ == "__main__":
    main()
