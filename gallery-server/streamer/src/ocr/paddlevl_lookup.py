#!/usr/bin/env python3

import atexit
import base64
import json
import os
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

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
        "max_tokens": 1024,
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


def lookup_single_payload(media_root: Path, payload: dict, output_path: Path | None = None):
    render_started = time.perf_counter()
    image_bgr, render_profile = render_viewport_image(media_root, payload, output_path)
    render_ms = round((time.perf_counter() - render_started) * 1000, 2)
    image_rgb = Image.fromarray(image_bgr[:, :, ::-1])

    recognize_started = time.perf_counter()
    text = run_vl_ocr(image_rgb)
    recognize_ms = round((time.perf_counter() - recognize_started) * 1000, 2)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return {
        "text": "\n".join(lines),
        "lines": lines,
        "warnings": [],
        "blocks": [
            {
                "id": "viewport",
                "text": "\n".join(lines),
                "bbox": {
                    "x": 0,
                    "y": 0,
                    "width": int(image_bgr.shape[1]),
                    "height": int(image_bgr.shape[0]),
                },
            }
        ] if lines else [],
        "discardedBlocks": [],
        "salvagedBlocks": [],
        "elapsedMs": round((time.perf_counter() - render_started) * 1000, 2),
        "profile": {
            "mode": "full-viewport-vl",
            "render_ms": render_ms,
            "render_total_ms": render_profile.get("render_total_ms"),
            "render_width": int(image_bgr.shape[1]),
            "render_height": int(image_bgr.shape[0]),
            "vl_request_ms": recognize_ms,
            "predict_ms": recognize_ms,
            "recognized_blocks": 1 if lines else 0,
            "llama_server_log_path": str(SERVER_LOG_PATH),
        },
    }


def lookup_viewport_payload(media_root: Path, payload: dict, output_path: Path | None = None):
    sweep_started = time.perf_counter()
    final_result = lookup_single_payload(media_root, payload, output_path)
    profile = dict(final_result.get("profile") or {})
    profile.update(
        {
            "harness": "full-viewport-vl",
            "rotation_sweep_used": False,
            "rotation_sweep_total_ms": round((time.perf_counter() - sweep_started) * 1000, 2),
        }
    )
    final_result["profile"] = profile
    final_result["elapsedMs"] = round((time.perf_counter() - sweep_started) * 1000, 2)
    return final_result
