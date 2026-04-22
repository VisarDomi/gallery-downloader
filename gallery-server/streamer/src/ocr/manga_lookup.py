#!/usr/bin/env python3

import json
import subprocess
import tempfile
import time
from pathlib import Path

from manga_ocr import MangaOcr
from PIL import Image

from viewport_lookup import render_viewport_image

OCR_INSTANCE = None

GALLERY_SERVER_ROOT = Path(__file__).resolve().parents[3]
PADDLE_PYTHON = GALLERY_SERVER_ROOT / ".venvs" / "paddleocr-venv" / "bin" / "python"
PADDLE_RUNNER = Path(__file__).resolve().with_name("paddle_lookup.py")


def get_manga_ocr():
    global OCR_INSTANCE
    if OCR_INSTANCE is None:
        OCR_INSTANCE = MangaOcr()
    return OCR_INSTANCE


def crop_block_image(image_rgb: Image.Image, bbox: dict):
    x = int(round(float(bbox.get("x", 0))))
    y = int(round(float(bbox.get("y", 0))))
    width = int(round(float(bbox.get("width", 0))))
    height = int(round(float(bbox.get("height", 0))))
    if width <= 0 or height <= 0:
        return None
    left = max(0, x)
    top = max(0, y)
    right = min(image_rgb.width, x + width)
    bottom = min(image_rgb.height, y + height)
    if right <= left or bottom <= top:
        return None
    return image_rgb.crop((left, top, right, bottom))


def run_paddle_lookup(image_path: Path):
    try:
        completed = subprocess.run(
            [str(PADDLE_PYTHON), str(PADDLE_RUNNER), str(image_path)],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        stdout = (exc.stdout or "").strip()
        stderr = (exc.stderr or "").strip()
        raise RuntimeError(
            "paddle_lookup subprocess failed"
            f" (exit_code={exc.returncode}, image={image_path}, stdout={stdout!r}, stderr={stderr!r})"
        ) from exc
    return json.loads(completed.stdout)


def lookup_viewport_payload(media_root: Path, payload: dict, output_path: Path | None = None):
    render_started = time.perf_counter()
    image_bgr, render_profile = render_viewport_image(media_root, payload, output_path)
    render_ms = round((time.perf_counter() - render_started) * 1000, 2)
    image_rgb = Image.fromarray(image_bgr[:, :, ::-1])

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_image:
        temp_path = Path(temp_image.name)
    try:
        save_started = time.perf_counter()
        image_rgb.save(temp_path, format="PNG")
        save_ms = round((time.perf_counter() - save_started) * 1000, 2)

        paddle_started = time.perf_counter()
        paddle_result = run_paddle_lookup(temp_path)
        paddle_total_ms = round((time.perf_counter() - paddle_started) * 1000, 2)

        manga = get_manga_ocr()
        recognize_started = time.perf_counter()
        recognized_blocks = []
        warnings = list(paddle_result.get("warnings") or [])

        for block in paddle_result.get("blocks") or []:
            bbox = block.get("bbox")
            cropped = crop_block_image(image_rgb, bbox or {})
            if cropped is None:
                recognized_blocks.append(block)
                continue
            text = (manga(cropped) or "").strip()
            if not text:
                warnings.append(f"manga_ocr_empty:{block.get('id', 'unknown')}")
            recognized_block = dict(block)
            recognized_block["originalText"] = block.get("text", "")
            recognized_block["text"] = text or block.get("text", "")
            recognized_blocks.append(recognized_block)

        recognize_ms = round((time.perf_counter() - recognize_started) * 1000, 2)
        lines = [block.get("text", "") for block in recognized_blocks if block.get("text")]
        return {
            "text": "\n".join(lines),
            "lines": lines,
            "warnings": warnings,
            "blocks": recognized_blocks,
            "discardedBlocks": paddle_result.get("discardedBlocks") or [],
            "salvagedBlocks": paddle_result.get("salvagedBlocks") or [],
            "elapsedMs": round((time.perf_counter() - render_started) * 1000, 2),
            "profile": {
                "render_ms": render_ms,
                "render_total_ms": render_profile.get("render_total_ms"),
                "temp_image_save_ms": save_ms,
                "paddle_total_ms": paddle_total_ms,
                "manga_recognize_ms": recognize_ms,
                "predict_ms": recognize_ms,
                "recognized_blocks": len(recognized_blocks),
                "paddle_profile": paddle_result.get("profile") or {},
            },
        }
    finally:
        temp_path.unlink(missing_ok=True)
