#!/usr/bin/env python3

import json
import sys
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
            image_path = Path(command["imagePath"])
            render_viewport_image(media_root, json.loads(request_path.read_text(encoding="utf-8")), image_path)
            result = lookup_image(image_path)
            write_message({"ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001
            write_message({"ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
