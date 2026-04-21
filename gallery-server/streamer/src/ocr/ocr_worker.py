#!/usr/bin/env python3

import json
import sys
import time
from pathlib import Path

from viewport_lookup import render_viewport_image
from paddle_lookup import lookup_image


def write_message(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
            media_root = Path(command["mediaRoot"]).resolve()
            request_path = Path(command["requestPath"])
            image_path_value = command.get("imagePath")
            image_path = Path(image_path_value) if image_path_value else None
            request_read_started = time.perf_counter()
            payload = json.loads(request_path.read_text(encoding="utf-8"))
            request_read_ms = round((time.perf_counter() - request_read_started) * 1000, 2)

            output_path = image_path if image_path else None
            image_bgr, render_profile = render_viewport_image(media_root, payload, output_path)
            result = lookup_image(image_bgr)
            result["profile"] = {
                "request_read_ms": request_read_ms,
                **render_profile,
                **(result.get("profile") or {}),
                "worker_total_ms": round(
                    request_read_ms
                    + float(render_profile.get("render_total_ms", 0))
                    + float(result.get("elapsedMs", 0)),
                    2,
                ),
            }
            write_message({"ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001
            write_message({"ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
