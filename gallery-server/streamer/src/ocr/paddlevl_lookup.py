#!/usr/bin/env python3

import atexit
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import re
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

from paddle_lookup import lookup_image
from viewport_lookup import render_viewport_image

LLAMA_SERVER_PROCESS = None

GALLERY_SERVER_ROOT = Path(__file__).resolve().parents[3]
LOCAL_LLM_ROOT = Path.home() / "Documents" / "work" / "ai" / "local-llm"
LLAMA_SERVER_PATH = LOCAL_LLM_ROOT / "engine" / "stable" / "llama.cpp" / "build" / "bin" / "llama-server"
MODEL_DIR = GALLERY_SERVER_ROOT / ".models" / "paddleocr-vl-1.5"
MODEL_PATH = MODEL_DIR / "PaddleOCR-VL-1.5.gguf"
MMPROJ_PATH = MODEL_DIR / "PaddleOCR-VL-1.5-mmproj.gguf"
SERVER_PORT = 8111
SERVER_URL = f"http://127.0.0.1:{SERVER_PORT}/v1/chat/completions"
HEALTH_URL = f"http://127.0.0.1:{SERVER_PORT}/health"
SERVER_LOG_PATH = Path(tempfile.gettempdir()) / "gallery-ocr-paddlevl-llama-server.log"
ROTATION_ESCALATION_DEGREES = [20.0, -20.0]
JAPANESE_CHAR_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60々ー]")
PUNCTUATION_RE = re.compile(r"[。！？!?…ー]")


def stop_llama_server():
    global LLAMA_SERVER_PROCESS
    if LLAMA_SERVER_PROCESS is None:
        return
    if LLAMA_SERVER_PROCESS.poll() is None:
        try:
            LLAMA_SERVER_PROCESS.terminate()
            LLAMA_SERVER_PROCESS.wait(timeout=10)
        except subprocess.TimeoutExpired:
            LLAMA_SERVER_PROCESS.kill()
    LLAMA_SERVER_PROCESS = None


def _handle_shutdown(signum, _frame):
    stop_llama_server()
    raise SystemExit(128 + signum)


atexit.register(stop_llama_server)
signal.signal(signal.SIGTERM, _handle_shutdown)
signal.signal(signal.SIGINT, _handle_shutdown)


def model_files_present():
    return MODEL_PATH.exists() and MMPROJ_PATH.exists()


def wait_for_server(timeout_s=120):
    deadline = time.time() + timeout_s
    last_error = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=5) as response:
                if response.status == 200:
                    return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        time.sleep(1)
    raise RuntimeError(f"PaddleOCR-VL server did not become healthy: {last_error}")


def ensure_llama_server():
    global LLAMA_SERVER_PROCESS
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:
            if response.status == 200:
                return
    except Exception:
        pass

    if not model_files_present():
        raise FileNotFoundError(
            "missing PaddleOCR-VL model files under "
            f"{MODEL_DIR}. Expected {MODEL_PATH.name} and {MMPROJ_PATH.name}"
        )
    if not LLAMA_SERVER_PATH.exists():
        raise FileNotFoundError(f"missing llama-server: {LLAMA_SERVER_PATH}")

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    log_handle = SERVER_LOG_PATH.open("ab")
    LLAMA_SERVER_PROCESS = subprocess.Popen(
        [
            str(LLAMA_SERVER_PATH),
            "-m",
            str(MODEL_PATH),
            "--mmproj",
            str(MMPROJ_PATH),
            "--port",
            str(SERVER_PORT),
            "--host",
            "127.0.0.1",
            "--temp",
            "0",
            "-ngl",
            "99",
            "-c",
            "8192",
        ],
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        env={**os.environ, "NO_COLOR": "1"},
    )
    wait_for_server()


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


def image_to_data_url(image_rgb: Image.Image):
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_image:
        temp_path = Path(temp_image.name)
    try:
        image_rgb.save(temp_path, format="PNG")
        encoded = base64.b64encode(temp_path.read_bytes()).decode("ascii")
        return f"data:image/png;base64,{encoded}"
    finally:
        temp_path.unlink(missing_ok=True)


def run_vl_ocr(image_rgb: Image.Image):
    ensure_llama_server()
    payload = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "OCR:"},
                    {"type": "image_url", "image_url": {"url": image_to_data_url(image_rgb)}},
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": 256,
    }
    request = urllib.request.Request(
        SERVER_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"PaddleOCR-VL request failed: {exc.code} {body}") from exc
    choices = data.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content", "")
    if isinstance(content, list):
        text_parts = [item.get("text", "") for item in content if isinstance(item, dict)]
        return "".join(text_parts).strip()
    return str(content).strip()


def count_japanese_chars(text: str):
    return len(JAPANESE_CHAR_RE.findall(text))


def count_punctuation(text: str):
    return len(PUNCTUATION_RE.findall(text))


def clone_payload_with_rotation(payload: dict, degrees: float):
    cloned = json.loads(json.dumps(payload))
    if abs(degrees) <= 1e-6:
        cloned.pop("ocrImageRotationDegrees", None)
    else:
        cloned["ocrImageRotationDegrees"] = degrees
    return cloned


def score_result(result: dict):
    lines = [str(line).strip() for line in (result.get("lines") or []) if str(line).strip()]
    text = "\n".join(lines)
    japanese_chars = count_japanese_chars(text)
    punctuation = count_punctuation(text)
    line_lengths = [count_japanese_chars(line) for line in lines]
    long_lines = sum(1 for length in line_lengths if length >= 8)
    medium_lines = sum(1 for length in line_lengths if length >= 4)
    short_lines = sum(1 for length in line_lengths if length <= 2)
    warning_count = len(result.get("warnings") or [])
    score = (
        japanese_chars
        + (long_lines * 10)
        + (medium_lines * 3)
        + (punctuation * 2)
        - (short_lines * 6)
        - warning_count
    )
    return {
        "score": score,
        "japanese_chars": japanese_chars,
        "punctuation": punctuation,
        "line_lengths": line_lengths,
        "line_count": len(lines),
        "long_lines": long_lines,
        "medium_lines": medium_lines,
        "short_lines": short_lines,
        "warning_count": warning_count,
    }


def analyze_block_geometry(result: dict):
    blocks = result.get("blocks") or []
    profile = result.get("profile") or {}
    render_width = int(profile.get("render_width") or 0)
    render_height = int(profile.get("render_height") or 0)
    canvas_area = max(1, render_width * render_height)
    block_areas = []
    tall_blocks = 0
    wide_blocks = 0
    max_height_ratio = 0.0
    max_width_ratio = 0.0

    for block in blocks:
        bbox = block.get("bbox") or {}
        width = max(0.0, float(bbox.get("width") or 0.0))
        height = max(0.0, float(bbox.get("height") or 0.0))
        if width <= 0 or height <= 0:
            continue
        block_areas.append(width * height)
        if height >= width * 2.0:
            tall_blocks += 1
        if width >= height * 1.5:
            wide_blocks += 1
        if render_height > 0:
            max_height_ratio = max(max_height_ratio, height / render_height)
        if render_width > 0:
            max_width_ratio = max(max_width_ratio, width / render_width)

    return {
        "block_count": len(blocks),
        "coverage_ratio": sum(block_areas) / canvas_area,
        "tall_blocks": tall_blocks,
        "wide_blocks": wide_blocks,
        "max_height_ratio": round(max_height_ratio, 4),
        "max_width_ratio": round(max_width_ratio, 4),
    }


def evaluate_baseline(metrics: dict, geometry: dict):
    reasons = []

    sentence_rich = False
    if metrics["long_lines"] >= 2 and metrics["japanese_chars"] >= 20:
        sentence_rich = True
        reasons.append("rich-long-lines")
    elif metrics["medium_lines"] >= 3 and metrics["japanese_chars"] >= 18:
        sentence_rich = True
        reasons.append("rich-medium-lines")

    dialogue_like_geometry = (
        geometry["tall_blocks"] >= 2
        or geometry["coverage_ratio"] >= 0.14
        or geometry["max_height_ratio"] >= 0.24
    )
    if dialogue_like_geometry:
        reasons.append("dialogue-like-geometry")

    sentence_poor = (
        metrics["japanese_chars"] < 18
        or metrics["long_lines"] == 0
        or (metrics["line_count"] >= 3 and metrics["short_lines"] >= 2)
    )
    if sentence_poor:
        reasons.append("sentence-poor")

    noise_heavy = metrics["warning_count"] >= 6
    if noise_heavy:
        reasons.append("noise-heavy")

    weak = False
    if sentence_poor:
        weak = True
    elif noise_heavy and metrics["japanese_chars"] < 14:
        weak = True

    strong = sentence_rich or not weak
    return {
        "strong": strong,
        "weak": weak,
        "sentence_rich": sentence_rich,
        "dialogue_like_geometry": dialogue_like_geometry,
        "sentence_poor": sentence_poor,
        "noise_heavy": noise_heavy,
        "reasons": reasons,
    }


def lookup_single_payload(media_root: Path, payload: dict, output_path: Path | None = None):
    render_started = time.perf_counter()
    image_bgr, render_profile = render_viewport_image(media_root, payload, output_path)
    render_ms = round((time.perf_counter() - render_started) * 1000, 2)
    image_rgb = Image.fromarray(image_bgr[:, :, ::-1])

    paddle_started = time.perf_counter()
    paddle_result = lookup_image(image_bgr)
    paddle_total_ms = round((time.perf_counter() - paddle_started) * 1000, 2)

    recognize_started = time.perf_counter()
    recognized_blocks = []
    warnings = list(paddle_result.get("warnings") or [])
    vl_request_ms = 0.0

    for block in paddle_result.get("blocks") or []:
        bbox = block.get("bbox")
        cropped = crop_block_image(image_rgb, bbox or {})
        if cropped is None:
            recognized_blocks.append(block)
            continue
        request_started = time.perf_counter()
        text = run_vl_ocr(cropped)
        vl_request_ms += (time.perf_counter() - request_started) * 1000
        if not text:
            warnings.append(f"paddlevl_empty:{block.get('id', 'unknown')}")
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
            "render_width": int(image_bgr.shape[1]),
            "render_height": int(image_bgr.shape[0]),
            "paddle_total_ms": paddle_total_ms,
            "vl_request_ms": round(vl_request_ms, 2),
            "predict_ms": recognize_ms,
            "recognized_blocks": len(recognized_blocks),
            "paddle_profile": paddle_result.get("profile") or {},
            "llama_server_log_path": str(SERVER_LOG_PATH),
        },
    }


def lookup_viewport_payload(media_root: Path, payload: dict, output_path: Path | None = None):
    sweep_started = time.perf_counter()
    baseline_payload = clone_payload_with_rotation(payload, 0.0)
    baseline_result = lookup_single_payload(media_root, baseline_payload, output_path)
    baseline_metrics = score_result(baseline_result)
    baseline_geometry = analyze_block_geometry(baseline_result)
    baseline_evaluation = evaluate_baseline(baseline_metrics, baseline_geometry)
    candidates = [
        {
            "rotationDegrees": 0.0,
            "result": baseline_result,
            "metrics": baseline_metrics,
            "geometry": baseline_geometry,
        }
    ]

    if baseline_evaluation["strong"]:
        selected = candidates[0]
        sweep_used = False
        escalation_stage_used = False
    else:
        sweep_used = True
        escalation_stage_used = True

        def run_rotation_candidate(degrees: float):
            rotated_payload = clone_payload_with_rotation(payload, degrees)
            result = lookup_single_payload(media_root, rotated_payload, None)
            return {
                "rotationDegrees": degrees,
                "result": result,
                "metrics": score_result(result),
                "geometry": analyze_block_geometry(result),
            }

        with ThreadPoolExecutor(max_workers=2) as executor:
            future_map = {
                executor.submit(run_rotation_candidate, degrees): degrees
                for degrees in ROTATION_ESCALATION_DEGREES
            }
            for future in as_completed(future_map):
                candidates.append(future.result())

        selected = max(candidates, key=lambda item: item["metrics"]["score"])
        if output_path is not None and abs(selected["rotationDegrees"]) > 1e-6:
            selected = {
                "rotationDegrees": selected["rotationDegrees"],
                "result": lookup_single_payload(
                    media_root,
                    clone_payload_with_rotation(payload, selected["rotationDegrees"]),
                    output_path,
                ),
            }
            selected["metrics"] = score_result(selected["result"])
            selected["geometry"] = analyze_block_geometry(selected["result"])

    final_result = selected["result"]
    profile = dict(final_result.get("profile") or {})
    profile.update(
        {
            "rotation_strategy": "baseline-then-parallel-pair",
            "rotation_sweep_used": sweep_used,
            "rotation_escalation_stage_used": escalation_stage_used,
            "selected_rotation_degrees": selected["rotationDegrees"],
            "baseline_rotation_degrees": 0.0,
            "baseline_candidate_score": baseline_metrics["score"],
            "selected_candidate_score": selected["metrics"]["score"],
            "baseline_geometry": baseline_geometry,
            "baseline_evaluation": baseline_evaluation,
            "rotation_candidates": [
                {
                    "rotationDegrees": candidate["rotationDegrees"],
                    "score": candidate["metrics"]["score"],
                    "japaneseChars": candidate["metrics"]["japanese_chars"],
                    "lineCount": candidate["metrics"]["line_count"],
                    "longLines": candidate["metrics"]["long_lines"],
                    "warningCount": candidate["metrics"]["warning_count"],
                    "coverageRatio": round(candidate["geometry"]["coverage_ratio"], 4),
                    "tallBlocks": candidate["geometry"]["tall_blocks"],
                    "maxHeightRatio": candidate["geometry"]["max_height_ratio"],
                }
                for candidate in candidates
            ],
            "rotation_sweep_total_ms": round((time.perf_counter() - sweep_started) * 1000, 2),
        }
    )
    final_result["profile"] = profile
    final_result["elapsedMs"] = round((time.perf_counter() - sweep_started) * 1000, 2)
    return final_result
