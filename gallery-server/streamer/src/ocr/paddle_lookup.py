#!/usr/bin/env python3

import json
import math
import re
import sys
import time
from pathlib import Path

import numpy as np
from paddleocr import PaddleOCR
from PIL import Image

JP_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]")
NOISE_RE = re.compile(r"^[A-Za-z0-9]$")
OCR_INSTANCE = None


def normalize_box_points(box):
    if hasattr(box, "tolist"):
        box = box.tolist()
    if isinstance(box, tuple):
        box = list(box)
    return box


def polygon_to_bbox(box):
    box = normalize_box_points(box)
    if not isinstance(box, list) or not box:
        return None
    pts = []
    for pt in box:
        if not isinstance(pt, list) or len(pt) < 2:
            continue
        try:
            pts.append((float(pt[0]), float(pt[1])))
        except (TypeError, ValueError):
            continue
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return {
        "x": min(xs),
        "y": min(ys),
        "width": max(xs) - min(xs),
        "height": max(ys) - min(ys),
    }


def rect_to_bbox(box):
    box = normalize_box_points(box)
    if not isinstance(box, list) or len(box) < 4:
        return None
    try:
        x1, y1, x2, y2 = [float(value) for value in box[:4]]
    except (TypeError, ValueError):
        return None
    return {
        "x": min(x1, x2),
        "y": min(y1, y2),
        "width": abs(x2 - x1),
        "height": abs(y2 - y1),
    }


def infer_direction(text, bbox):
    if not bbox:
        return "unknown"
    width = max(1.0, bbox["width"])
    height = max(1.0, bbox["height"])
    ratio = height / width
    if ratio >= 2.2 and JP_RE.search(text):
        return "vertical"
    if width >= height:
        return "horizontal"
    return "unknown"


def infer_script(text):
    has_jp = bool(JP_RE.search(text))
    has_latin = any("a" <= ch.lower() <= "z" for ch in text)
    if has_jp and has_latin:
        return "mixed"
    if has_jp:
        return "japanese"
    if has_latin:
        return "latin"
    return "unknown"


def bbox_right(bbox):
    return bbox["x"] + bbox["width"]


def bbox_bottom(bbox):
    return bbox["y"] + bbox["height"]


def bbox_center_x(bbox):
    return bbox["x"] + (bbox["width"] / 2.0)


def clamp(value, low, high):
    return max(low, min(high, value))


def bbox_iou(a, b):
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = bbox_right(a), bbox_bottom(a)
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = bbox_right(b), bbox_bottom(b)
    overlap_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    overlap_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    if overlap_w <= 0 or overlap_h <= 0:
        return 0.0
    intersection = overlap_w * overlap_h
    union = (a["width"] * a["height"]) + (b["width"] * b["height"]) - intersection
    if union <= 0:
        return 0.0
    return intersection / union


def ensure_image_bgr(image_input):
    if isinstance(image_input, np.ndarray):
        return image_input
    if isinstance(image_input, Path):
        with Image.open(image_input) as opened:
            image = opened.convert("RGB")
            return np.array(image)[:, :, ::-1].copy()
    raise TypeError(f"unsupported image input: {type(image_input)!r}")


def crop_image_bgr(image_bgr, crop):
    height, width = image_bgr.shape[:2]
    x1 = clamp(int(round(crop["x"])), 0, width - 1)
    y1 = clamp(int(round(crop["y"])), 0, height - 1)
    x2 = clamp(int(round(crop["x"] + crop["width"])), x1 + 1, width)
    y2 = clamp(int(round(crop["y"] + crop["height"])), y1 + 1, height)
    return image_bgr[y1:y2, x1:x2].copy(), {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}


def offset_bbox(bbox, offset_x, offset_y):
    if not bbox:
        return None
    return {
        "x": bbox["x"] + offset_x,
        "y": bbox["y"] + offset_y,
        "width": bbox["width"],
        "height": bbox["height"],
    }


def offset_points(points, offset_x, offset_y):
    points = normalize_box_points(points)
    if not isinstance(points, list):
        return points
    shifted = []
    for point in points:
        if not isinstance(point, list) or len(point) < 2:
            shifted.append(point)
            continue
        shifted.append([point[0] + offset_x, point[1] + offset_y])
    return shifted


def is_noise_block(block):
    text = block.get("text", "").strip()
    bbox = block.get("bbox")
    if not text:
        return True
    if len(text) == 1 and NOISE_RE.fullmatch(text):
        return True
    if bbox and bbox["width"] <= 40 and bbox["height"] <= 40 and not JP_RE.search(text):
        return True
    return False


def normalize_word_boxes(words, word_boxes):
    if hasattr(word_boxes, "tolist"):
        word_boxes = word_boxes.tolist()
    if not isinstance(words, list) or not isinstance(word_boxes, list):
        return []

    result = []
    for index, word in enumerate(words):
        box = word_boxes[index] if index < len(word_boxes) else None
        bbox = rect_to_bbox(box)
        result.append(
            {
                "text": str(word),
                "bbox": bbox,
            }
        )
    return result


def normalize_result(raw_result):
    blocks = []
    if not isinstance(raw_result, list):
        return blocks

    for item in raw_result:
        if not hasattr(item, "get"):
            continue
        rec_texts = item.get("rec_texts")
        rec_scores = item.get("rec_scores")
        rec_polys = item.get("rec_polys")
        rec_boxes = item.get("rec_boxes")
        text_words = item.get("text_word")
        text_word_boxes = item.get("text_word_boxes")
        if isinstance(rec_texts, list):
            for idx, text in enumerate(rec_texts):
                text_str = str(text).strip()
                score = rec_scores[idx] if isinstance(rec_scores, list) and idx < len(rec_scores) else None
                try:
                    score_val = float(score) if score is not None else None
                except (TypeError, ValueError):
                    score_val = None
                box = rec_polys[idx] if isinstance(rec_polys, list) and idx < len(rec_polys) else None
                rect_box = rec_boxes[idx] if rec_boxes is not None and idx < len(rec_boxes) else None
                bbox = polygon_to_bbox(box) or rect_to_bbox(rect_box)
                words = text_words[idx] if isinstance(text_words, list) and idx < len(text_words) else None
                word_boxes = text_word_boxes[idx] if isinstance(text_word_boxes, list) and idx < len(text_word_boxes) else None
                blocks.append(
                    {
                        "id": f"block-{len(blocks) + 1}",
                        "text": text_str,
                        "score": score_val,
                        "box": normalize_box_points(box),
                        "rectBox": normalize_box_points(rect_box),
                        "bbox": bbox,
                        "direction": infer_direction(text_str, bbox),
                        "script": infer_script(text_str),
                        "wordPieces": normalize_word_boxes(words, word_boxes),
                        "sourceIndex": idx,
                    }
                )
    return blocks


def sort_horizontal_blocks(blocks):
    return sorted(
        blocks,
        key=lambda block: (
            (block.get("bbox") or {}).get("y", math.inf),
            (block.get("bbox") or {}).get("x", math.inf),
        ),
    )


def vertically_related(a, b):
    if not a.get("bbox") or not b.get("bbox"):
        return False
    ab = a["bbox"]
    bb = b["bbox"]
    ay1, ay2 = ab["y"], ab["y"] + ab["height"]
    by1, by2 = bb["y"], bb["y"] + bb["height"]
    overlap = max(0.0, min(ay2, by2) - max(ay1, by1))
    min_h = max(1.0, min(ab["height"], bb["height"]))
    x_gap = abs(ab["x"] - bb["x"])
    width_ref = max(ab["width"], bb["width"])
    return overlap / min_h >= 0.45 and x_gap <= width_ref * 1.6


def cluster_vertical_blocks(blocks):
    verticals = [
        block for block in blocks
        if block.get("direction") == "vertical"
        and block.get("script") in {"japanese", "mixed"}
        and block.get("bbox")
    ]
    clusters = []
    for block in verticals:
        placed = False
        for cluster in clusters:
            if any(vertically_related(block, existing) for existing in cluster):
                cluster.append(block)
                placed = True
                break
        if not placed:
            clusters.append([block])
    return clusters


def get_vertical_japanese_blocks(blocks):
    return [
        block for block in blocks
        if block.get("direction") == "vertical"
        and block.get("script") in {"japanese", "mixed"}
        and block.get("bbox")
        and not is_noise_block(block)
    ]


def reorder_vertical_japanese_blocks(blocks):
    warnings = []
    cleaned = [block for block in blocks if not is_noise_block(block)]
    noise = [block for block in blocks if is_noise_block(block)]

    clusters = cluster_vertical_blocks(cleaned)
    clustered_ids = {block["id"] for cluster in clusters for block in cluster}
    non_vertical = [block for block in cleaned if block["id"] not in clustered_ids]

    ordered_clusters = sorted(
        clusters,
        key=lambda cluster: sum(block["bbox"]["x"] for block in cluster) / len(cluster),
        reverse=True,
    )

    result = []
    for cluster in ordered_clusters:
        result.extend(sorted(cluster, key=lambda item: (-item["bbox"]["x"], item["bbox"]["y"])))
    result.extend(sort_horizontal_blocks(non_vertical))

    original_order = [block["id"] for block in cleaned]
    if [block["id"] for block in result] != original_order:
        warnings.append("vertical_order_corrected")
    for block in blocks:
        if not block.get("bbox"):
            warnings.append(f"missing_bbox:{block['id']}")
    for block in blocks:
        if not block.get("text", "").strip():
            warnings.append(f"empty_text_detected:{block['id']}")
    for block in noise:
        warnings.append(f"noise_filtered:{block['text']}")
    return result, noise, warnings


def build_gap_salvage_candidates(blocks, image_bgr):
    image_height, image_width = image_bgr.shape[:2]
    vertical_blocks = sorted(
        get_vertical_japanese_blocks(blocks),
        key=lambda block: bbox_center_x(block["bbox"]),
        reverse=True,
    )
    candidates = []
    for rightward, leftward in zip(vertical_blocks, vertical_blocks[1:]):
        right_bbox = rightward["bbox"]
        left_bbox = leftward["bbox"]
        gap_width = right_bbox["x"] - bbox_right(left_bbox)
        if gap_width < 48:
            continue
        band_width = clamp(
            gap_width + max(32.0, min(right_bbox["width"], left_bbox["width"]) * 0.25),
            120.0,
            240.0,
        )
        center_x = (right_bbox["x"] + bbox_right(left_bbox)) / 2.0
        top = clamp(min(right_bbox["y"], left_bbox["y"]) - 80.0, 0.0, float(image_height - 1))
        bottom = clamp(
            max(bbox_bottom(right_bbox), bbox_bottom(left_bbox)) + 80.0,
            top + 1.0,
            float(image_height),
        )
        x = clamp(center_x - (band_width / 2.0), 0.0, max(0.0, float(image_width) - band_width))
        candidates.append(
            {
                "id": f"gap-{rightward['id']}-{leftward['id']}",
                "crop": {
                    "x": x,
                    "y": top,
                    "width": band_width,
                    "height": bottom - top,
                },
                "pair": [rightward["id"], leftward["id"]],
                "gapWidth": round(gap_width, 2),
            }
        )
    return candidates


def translate_salvage_block(block, crop_bbox, candidate_id, index):
    translated = dict(block)
    translated["id"] = f"salvage-{candidate_id}-{index + 1}"
    translated["bbox"] = offset_bbox(block.get("bbox"), crop_bbox["x"], crop_bbox["y"])
    translated["box"] = offset_points(block.get("box"), crop_bbox["x"], crop_bbox["y"])
    translated["rectBox"] = offset_points(block.get("rectBox"), crop_bbox["x"], crop_bbox["y"])
    translated["wordPieces"] = [
        {
            **piece,
            "bbox": offset_bbox(piece.get("bbox"), crop_bbox["x"], crop_bbox["y"]),
        }
        for piece in block.get("wordPieces") or []
    ]
    translated["salvagedFrom"] = candidate_id
    return translated


def salvage_block_is_duplicate(block, existing_blocks):
    bbox = block.get("bbox")
    if not bbox:
        return True
    for existing in existing_blocks:
        existing_bbox = existing.get("bbox")
        if not existing_bbox:
            continue
        if bbox_iou(bbox, existing_bbox) >= 0.2:
            return True
    return False


def salvage_block_is_useful(block, crop_bbox, existing_blocks):
    text = block.get("text", "").strip()
    bbox = block.get("bbox")
    if not text or not bbox or is_noise_block(block):
        return False
    if block.get("direction") != "vertical" or block.get("script") not in {"japanese", "mixed"}:
        return False
    if len(text) < 3:
        return False
    center_x = bbox_center_x(bbox)
    crop_left = crop_bbox["x"]
    crop_right = crop_left + crop_bbox["width"]
    if center_x < crop_left or center_x > crop_right:
        return False
    if salvage_block_is_duplicate(block, existing_blocks):
        return False
    return True


def salvage_vertical_gap_blocks(image_input, ocr, blocks):
    image_bgr = ensure_image_bgr(image_input)
    candidates = build_gap_salvage_candidates(blocks, image_bgr)
    salvaged_blocks = []
    warnings = []
    predict_ms = 0.0
    if not candidates:
        return salvaged_blocks, warnings, predict_ms

    for candidate in candidates:
        crop_image, crop_bbox = crop_image_bgr(image_bgr, candidate["crop"])
        if crop_bbox["width"] < 32 or crop_bbox["height"] < 32:
            continue
        predict_started = time.perf_counter()
        raw_result = ocr.predict(crop_image)
        predict_ms += (time.perf_counter() - predict_started) * 1000
        crop_blocks = normalize_result(raw_result)
        accepted = 0
        for index, block in enumerate(crop_blocks):
            translated = translate_salvage_block(block, crop_bbox, candidate["id"], index)
            if not salvage_block_is_useful(translated, crop_bbox, blocks + salvaged_blocks):
                continue
            salvaged_blocks.append(translated)
            accepted += 1
        if accepted > 0:
            warnings.append(f"gap_salvaged:{candidate['id']}:{accepted}")
    return salvaged_blocks, warnings, round(predict_ms, 2)


def get_ocr():
    global OCR_INSTANCE
    if OCR_INSTANCE is None:
        OCR_INSTANCE = PaddleOCR(
            lang="japan",
            text_detection_model_name="PP-OCRv5_server_det",
            text_recognition_model_name="PP-OCRv5_server_rec",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            return_word_box=True,
            device="gpu:0",
        )
    return OCR_INSTANCE


def lookup_image(image_input):
    if isinstance(image_input, Path):
        if not image_input.exists():
            raise FileNotFoundError(f"missing image: {image_input}")
        predict_input = str(image_input)
    else:
        predict_input = image_input
    started = time.perf_counter()
    ocr = get_ocr()
    predict_started = time.perf_counter()
    raw_result = ocr.predict(predict_input)
    predict_ms = round((time.perf_counter() - predict_started) * 1000, 2)

    normalize_started = time.perf_counter()
    blocks = normalize_result(raw_result)
    normalize_result_ms = round((time.perf_counter() - normalize_started) * 1000, 2)

    salvage_started = time.perf_counter()
    salvaged_blocks, salvage_warnings, salvage_predict_ms = salvage_vertical_gap_blocks(image_input, ocr, blocks)
    salvage_ms = round((time.perf_counter() - salvage_started) * 1000, 2)

    reorder_started = time.perf_counter()
    ordered_blocks, discarded_blocks, warnings = reorder_vertical_japanese_blocks(blocks + salvaged_blocks)
    reorder_ms = round((time.perf_counter() - reorder_started) * 1000, 2)
    lines = [block["text"] for block in ordered_blocks]
    return {
        "text": "\n".join(lines),
        "lines": lines,
        "warnings": warnings + salvage_warnings,
        "blocks": ordered_blocks,
        "discardedBlocks": discarded_blocks,
        "salvagedBlocks": salvaged_blocks,
        "elapsedMs": round((time.perf_counter() - started) * 1000, 2),
        "profile": {
            "predict_ms": predict_ms,
            "normalize_result_ms": normalize_result_ms,
            "salvage_predict_ms": salvage_predict_ms,
            "salvage_ms": salvage_ms,
            "reorder_ms": reorder_ms,
            "raw_result_items": len(raw_result) if isinstance(raw_result, list) else None,
            "normalized_blocks": len(blocks),
            "salvaged_blocks": len(salvaged_blocks),
            "ordered_blocks": len(ordered_blocks),
            "discarded_blocks": len(discarded_blocks),
        },
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: paddle_lookup.py <image-path>")

    image_path = Path(sys.argv[1])
    payload = lookup_image(image_path)
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
