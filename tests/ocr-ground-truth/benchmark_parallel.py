#!/usr/bin/env python3

import argparse
import base64
import json
import statistics
import tempfile
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CASE_DIR = ROOT / "tests" / "ocr-ground-truth" / "case-2026-04-22-bikini-dialogue"
GENERATED_DIR = CASE_DIR / "generated"
ROTATED_IMAGE_PATH = GENERATED_DIR / "rotate-left-lg.png"
ROTATED_RESULT_PATH = GENERATED_DIR / "results" / "paddle-vl" / "rotate-left-lg.result.json"
DEFAULT_OCR_URL = "https://localhost:11556/api/ocr/lookup"
DEFAULT_LLAMA_URL = "http://127.0.0.1:8111/v1/chat/completions"
DEFAULT_HEALTH_URL = "http://127.0.0.1:8111/health"


def post_json(url: str, payload: dict):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read().decode("utf-8"))


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=10) as response:
        return response.read().decode("utf-8")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_llama_crop():
    image = Image.open(ROTATED_IMAGE_PATH).convert("RGB")
    result = load_json(ROTATED_RESULT_PATH)
    blocks = result.get("blocks") or []
    target_blocks = blocks[:3]
    left = min(int(block["bbox"]["x"]) for block in target_blocks)
    top = min(int(block["bbox"]["y"]) for block in target_blocks)
    right = max(int(block["bbox"]["x"] + block["bbox"]["width"]) for block in target_blocks)
    bottom = max(int(block["bbox"]["y"] + block["bbox"]["height"]) for block in target_blocks)
    margin = 12
    crop = image.crop(
        (
            max(0, left - margin),
            max(0, top - margin),
            min(image.width, right + margin),
            min(image.height, bottom + margin),
        )
    )
    temp = tempfile.NamedTemporaryFile(prefix="gallery-paddlevl-bench-", suffix=".png", delete=False)
    temp_path = Path(temp.name)
    temp.close()
    crop.save(temp_path, format="PNG")
    return temp_path


def image_to_data_url(path: Path):
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def warm_paddlevl(ocr_url: str):
    payload = load_json(CASE_DIR / "request.json")
    payload["backend"] = "paddle-vl"
    payload["compareBackends"] = []
    post_json(ocr_url, payload)


def wait_for_llama(health_url: str, timeout_s: int = 120):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(health_url, timeout=5) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("llama-server did not become healthy in time")


def build_llama_payload(image_url: str):
    return {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "OCR:"},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": 256,
    }


def build_ocr_payload():
    payload = load_json(CASE_DIR / "request.json")
    payload["backend"] = "paddle-vl"
    payload["compareBackends"] = []
    return payload


def summarize_round(samples: list[dict]):
    durations = [sample["durationMs"] for sample in samples]
    durations_sorted = sorted(durations)
    return {
        "count": len(samples),
        "p50Ms": round(statistics.median(durations), 2),
        "p95Ms": round(durations_sorted[max(0, int(len(durations_sorted) * 0.95) - 1)], 2),
        "minMs": round(min(durations), 2),
        "maxMs": round(max(durations), 2),
        "avgMs": round(statistics.mean(durations), 2),
        "makespanMs": round(max(sample["finishedMs"] for sample in samples), 2),
        "throughputRps": round(len(samples) / (max(sample["finishedMs"] for sample in samples) / 1000.0), 3),
    }


def run_concurrency_round(label: str, concurrency: int, repeats: int, request_fn):
    rounds = []
    for repeat_index in range(repeats):
        start = time.perf_counter()
        samples = []
        lock = threading.Lock()

        def run_one(index: int):
            request_started = time.perf_counter()
            request_fn()
            request_finished = time.perf_counter()
            sample = {
                "index": index,
                "durationMs": (request_finished - request_started) * 1000.0,
                "finishedMs": (request_finished - start) * 1000.0,
            }
            with lock:
                samples.append(sample)

        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = [executor.submit(run_one, idx) for idx in range(concurrency)]
            for future in as_completed(futures):
                future.result()

        rounds.append(
            {
                "repeat": repeat_index + 1,
                "summary": summarize_round(samples),
                "samples": sorted(samples, key=lambda item: item["index"]),
            }
        )

    p95_values = [round_info["summary"]["p95Ms"] for round_info in rounds]
    throughput_values = [round_info["summary"]["throughputRps"] for round_info in rounds]
    return {
        "label": label,
        "concurrency": concurrency,
        "repeats": repeats,
        "rounds": rounds,
        "aggregate": {
            "avgP95Ms": round(statistics.mean(p95_values), 2),
            "avgThroughputRps": round(statistics.mean(throughput_values), 3),
            "bestThroughputRps": round(max(throughput_values), 3),
        },
    }


def choose_knee(results: list[dict], multiplier: float):
    if not results:
        return None
    baseline = results[0]["aggregate"]["avgP95Ms"]
    limit = baseline * multiplier
    acceptable = [item for item in results if item["aggregate"]["avgP95Ms"] <= limit]
    if not acceptable:
        return None
    return acceptable[-1]["concurrency"]


def format_report(name: str, results: list[dict]):
    baseline = results[0]["aggregate"]["avgP95Ms"] if results else None
    lines = [
        f"# Parallel Benchmark: {name}",
        "",
        "| Concurrency | Avg p95 ms | Avg throughput req/s | Best throughput req/s |",
        "| ---: | ---: | ---: | ---: |",
    ]
    for item in results:
        agg = item["aggregate"]
        lines.append(
            f"| {item['concurrency']} | {agg['avgP95Ms']:.2f} | {agg['avgThroughputRps']:.3f} | {agg['bestThroughputRps']:.3f} |"
        )
    lines.extend(
        [
            "",
            f"- Baseline p95 ms: `{baseline:.2f}`" if baseline is not None else "- Baseline p95 ms: `n/a`",
            f"- Knee @ 1.25x baseline: `{choose_knee(results, 1.25)}`",
            f"- Knee @ 1.50x baseline: `{choose_knee(results, 1.50)}`",
            "",
        ]
    )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Benchmark direct llama-server and full paddle-vl OCR concurrency.")
    parser.add_argument("--ocr-url", default=DEFAULT_OCR_URL)
    parser.add_argument("--llama-url", default=DEFAULT_LLAMA_URL)
    parser.add_argument("--health-url", default=DEFAULT_HEALTH_URL)
    parser.add_argument("--concurrency", default="1,2,4,6,8")
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--output-dir", default=str(ROOT / "tests" / "ocr-ground-truth" / "benchmarks" / "paddle-vl"))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    crop_path = build_llama_crop()
    image_url = image_to_data_url(crop_path)
    concurrency_values = [int(part.strip()) for part in args.concurrency.split(",") if part.strip()]

    warm_paddlevl(args.ocr_url)
    wait_for_llama(args.health_url)

    llama_payload = build_llama_payload(image_url)
    ocr_payload = build_ocr_payload()

    llama_results = []
    for concurrency in concurrency_values:
        llama_results.append(
            run_concurrency_round(
                "llama-server",
                concurrency,
                args.repeats,
                lambda payload=llama_payload: post_json(args.llama_url, payload),
            )
        )

    ocr_results = []
    for concurrency in concurrency_values:
        ocr_results.append(
            run_concurrency_round(
                "paddle-vl-ocr",
                concurrency,
                args.repeats,
                lambda payload=ocr_payload: post_json(args.ocr_url, payload),
            )
        )

    report = {
        "concurrencyValues": concurrency_values,
        "repeats": args.repeats,
        "llamaServer": {
            "results": llama_results,
            "knee125": choose_knee(llama_results, 1.25),
            "knee150": choose_knee(llama_results, 1.50),
        },
        "paddleVlOcr": {
            "results": ocr_results,
            "knee125": choose_knee(ocr_results, 1.25),
            "knee150": choose_knee(ocr_results, 1.50),
        },
        "cropPath": str(crop_path),
        "llamaHealth": get_json(args.health_url),
    }
    save_json(output_dir / "report.json", report)
    (output_dir / "llama-server.md").write_text(format_report("llama-server", llama_results), encoding="utf-8")
    (output_dir / "paddle-vl-ocr.md").write_text(format_report("paddle-vl-ocr", ocr_results), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
