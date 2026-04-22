#!/usr/bin/env python3

import json
import sys
import time
from pathlib import Path

from manga_lookup import lookup_viewport_payload


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

            result = lookup_viewport_payload(media_root, payload, image_path)
            profile = result.get("profile") or {}
            result["profile"] = {
                "request_read_ms": request_read_ms,
                **profile,
                "worker_total_ms": round(
                    request_read_ms
                    + float(profile.get("render_ms", 0))
                    + float(profile.get("temp_image_save_ms", 0))
                    + float(profile.get("paddle_total_ms", 0))
                    + float(profile.get("manga_recognize_ms", 0)),
                    2,
                ),
            }
            write_message({"ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001
            write_message({"ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
