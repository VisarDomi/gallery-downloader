#!/usr/bin/env python3

import argparse
from collections import Counter
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH_ROOT = ROOT / "tests" / "ocr-ground-truth"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def collect_case_dirs(selected_case):
    if selected_case:
        candidate = GROUND_TRUTH_ROOT / selected_case
        if not candidate.exists():
            raise SystemExit(f"missing case: {candidate}")
        return [candidate]
    return sorted(
        path for path in GROUND_TRUTH_ROOT.iterdir()
        if path.is_dir() and (path / "request.json").exists()
    )


def post_json(url: str, payload: dict):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))


def flatten_transcript(path: Path):
    return path.read_text(encoding="utf-8").strip()


SENTENCE_STOP_RE = re.compile(r"[。！？!?][」』”\"'）)]*$")
PUNCTUATION_TRANSLATION = str.maketrans({
    "？": "?",
    "！": "!",
    "，": ",",
    "．": ".",
    "：": ":",
    "；": ";",
    "　": " ",
})
JAPANESE_TEXT_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff々ー]")
KANJI_TEXT_RE = re.compile(r"[\u3400-\u9fff々]")


def normalize_sentence_line(line: str):
    normalized = str(line).strip().translate(PUNCTUATION_TRANSLATION)
    normalized = re.sub(r"\s+", "", normalized)
    return normalized


def normalize_japanese_content(text: str):
    normalized = str(text).translate(PUNCTUATION_TRANSLATION)
    return "".join(JAPANESE_TEXT_RE.findall(normalized))


def normalize_kanji_content(text: str):
    normalized = str(text).translate(PUNCTUATION_TRANSLATION)
    return "".join(KANJI_TEXT_RE.findall(normalized))


def unordered_char_recall(expected: str, actual: str):
    if not expected:
        return {
            "expectedChars": 0,
            "actualChars": len(actual),
            "matchedChars": 0,
            "missingChars": "",
            "recall": None,
            "match": not actual,
        }

    actual_counts = Counter(actual)
    matched_count = 0
    missing = []
    for char in expected:
        if actual_counts[char] > 0:
            matched_count += 1
            actual_counts[char] -= 1
            continue
        missing.append(char)

    return {
        "expectedChars": len(expected),
        "actualChars": len(actual),
        "matchedChars": matched_count,
        "missingChars": "".join(missing),
        "recall": matched_count / len(expected),
        "match": not missing,
    }


def japanese_content_recall(expected_text: str, actual_text: str):
    japanese = unordered_char_recall(
        normalize_japanese_content(expected_text),
        normalize_japanese_content(actual_text),
    )
    kanji = unordered_char_recall(
        normalize_kanji_content(expected_text),
        normalize_kanji_content(actual_text),
    )
    return {
        "expectedJapaneseChars": japanese["expectedChars"],
        "actualJapaneseChars": japanese["actualChars"],
        "matchedJapaneseChars": japanese["matchedChars"],
        "missingJapaneseChars": japanese["missingChars"],
        "japaneseRecall": japanese["recall"],
        "japaneseContentMatch": japanese["match"],
        "expectedKanjiChars": kanji["expectedChars"],
        "actualKanjiChars": kanji["actualChars"],
        "matchedKanjiChars": kanji["matchedChars"],
        "missingKanjiChars": kanji["missingChars"],
        "kanjiRecall": kanji["recall"],
        "kanjiContentMatch": kanji["match"],
    }


def stopped_sentence_lines(lines):
    normalized = []
    for line in lines:
        stripped = str(line).strip()
        if not stripped:
            continue
        if not SENTENCE_STOP_RE.search(stripped):
            return []
        normalized.append(normalize_sentence_line(stripped))
    return normalized


def same_stopped_sentences_ignoring_order(expected_lines, actual_lines):
    expected = stopped_sentence_lines(expected_lines)
    actual = stopped_sentence_lines(actual_lines)
    if not expected or not actual:
        return False
    return sorted(expected) == sorted(actual)


def build_summary_entry(case_name: str, variant: dict, result: dict, expected_text: str):
    actual_text = (result.get("text") or "").strip()
    actual_lines = result.get("lines") or []
    expected_lines = expected_text.splitlines()
    exact_match = actual_text == expected_text
    unordered_stopped_match = (
        not exact_match
        and same_stopped_sentences_ignoring_order(expected_lines, actual_lines)
    )
    content_recall = japanese_content_recall(expected_text, actual_text)
    profile = result.get("profile") or {}
    return {
        "case": case_name,
        "variant": variant["id"],
        "family": variant["family"],
        "description": variant["description"],
        "exactMatch": exact_match,
        "unorderedStoppedSentenceMatch": unordered_stopped_match,
        **content_recall,
        "expectedLineCount": len(expected_lines),
        "actualLineCount": len(actual_lines),
        "warningCount": len(result.get("warnings") or []),
        "warnings": result.get("warnings") or [],
        "text": actual_text,
        "latencyMs": profile.get("worker_total_ms"),
        "predictMs": profile.get("predict_ms"),
        "renderMs": profile.get("render_total_ms"),
        "profile": profile,
    }


def format_summary_markdown(case_name: str, backend: str, transcript_path: Path, entries: list[dict]):
    lines = [
        f"# OCR Results: {case_name}",
        "",
        f"- Backend: `{backend}`",
        f"- Transcript: `{transcript_path.relative_to(ROOT)}`",
        "",
        "| Variant | Match | JP Content | JP Recall | Kanji | Kanji Recall | Unordered Stopped Sentence Match | Expected Lines | Actual Lines | Total ms | Predict ms | Warnings |",
        "| --- | --- | --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for entry in entries:
        lines.append(
            f"| `{entry['variant']}` | "
            f"{'yes' if entry['exactMatch'] else 'no'} | "
            f"{'yes' if entry['japaneseContentMatch'] else 'no'} | "
            f"{format_percent(entry['japaneseRecall'])} | "
            f"{'yes' if entry['kanjiContentMatch'] else 'no'} | "
            f"{format_percent(entry['kanjiRecall'])} | "
            f"{'yes' if entry['unorderedStoppedSentenceMatch'] else 'no'} | "
            f"{entry['expectedLineCount']} | "
            f"{entry['actualLineCount']} | "
            f"{format_metric(entry['latencyMs'])} | "
            f"{format_metric(entry['predictMs'])} | "
            f"{entry['warningCount']} |"
        )
    lines.append("")
    for entry in entries:
        lines.extend(
            [
                f"## {entry['variant']}",
                "",
                f"- Family: `{entry['family']}`",
                f"- Match: `{'yes' if entry['exactMatch'] else 'no'}`",
                f"- Japanese content match: `{'yes' if entry['japaneseContentMatch'] else 'no'}`",
                f"- Japanese recall: `{format_percent(entry['japaneseRecall'])}`",
                f"- Missing Japanese chars: `{entry['missingJapaneseChars'] or 'none'}`",
                f"- Kanji content match: `{'yes' if entry['kanjiContentMatch'] else 'no'}`",
                f"- Kanji recall: `{format_percent(entry['kanjiRecall'])}`",
                f"- Missing kanji chars: `{entry['missingKanjiChars'] or 'none'}`",
                f"- Unordered stopped sentence match: `{'yes' if entry['unorderedStoppedSentenceMatch'] else 'no'}`",
                f"- Total ms: `{format_metric(entry['latencyMs'])}`",
                f"- Predict ms: `{format_metric(entry['predictMs'])}`",
                f"- Render ms: `{format_metric(entry['renderMs'])}`",
                f"- Warnings: `{', '.join(entry['warnings']) if entry['warnings'] else 'none'}`",
                "",
                "```text",
                entry["text"],
                "```",
                "",
            ]
        )
    return "\n".join(lines)


def format_metric(value):
    if value is None:
        return "n/a"
    return f"{float(value):.2f}"


def format_percent(value):
    if value is None:
        return "n/a"
    return f"{float(value) * 100:.1f}%"


def main():
    parser = argparse.ArgumentParser(description="Run OCR over generated case requests and store per-variant outputs.")
    parser.add_argument("--case", help="Run one case only.")
    parser.add_argument("--backend", default="paddle-current")
    parser.add_argument("--url", default="https://localhost:11556/api/ocr/lookup")
    args = parser.parse_args()

    for case_dir in collect_case_dirs(args.case):
        generated_dir = case_dir / "generated"
        manifest_path = generated_dir / "manifest.json"
        if not manifest_path.exists():
            raise SystemExit(f"missing manifest: {manifest_path}")

        manifest = load_json(manifest_path)
        transcript_path = case_dir / "transcript.txt"
        expected_text = flatten_transcript(transcript_path)
        results_dir = generated_dir / "results" / args.backend
        entries = []

        for variant in manifest["variants"]:
            request_path = ROOT / variant["requestPath"]
            payload = load_json(request_path)
            payload["backend"] = args.backend
            payload["compareBackends"] = []
            try:
                result = post_json(args.url, payload)
            except urllib.error.URLError as exc:
                raise SystemExit(f"OCR request failed for {variant['id']}: {exc}") from exc

            variant_json_path = results_dir / f"{variant['id']}.result.json"
            variant_text_path = results_dir / f"{variant['id']}.txt"
            save_json(variant_json_path, result)
            variant_text_path.write_text((result.get("text") or "") + "\n", encoding="utf-8")
            entries.append(build_summary_entry(case_dir.name, variant, result, expected_text))

        summary = {
            "case": case_dir.name,
            "backend": args.backend,
            "transcriptPath": str(transcript_path.relative_to(ROOT)),
            "resultsDir": str(results_dir.relative_to(ROOT)),
            "variantCount": len(entries),
            "entries": entries,
        }
        save_json(results_dir / "summary.json", summary)
        (results_dir / "summary.md").write_text(
            format_summary_markdown(case_dir.name, args.backend, transcript_path, entries),
            encoding="utf-8",
        )
        print(f"ran {len(entries)} variants for {case_dir.name} -> {results_dir.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
