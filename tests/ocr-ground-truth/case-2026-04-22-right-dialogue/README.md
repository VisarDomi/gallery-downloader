# OCR Ground Truth

- Case: `case-2026-04-22-right-dialogue`
- Source image: `source.png`
- Ground-truth transcript: `test.txt`
- Current app output after `Plan 1, pass 1`: `plan1-pass1-paddle-current.txt`
- Reading direction: vertical Japanese, columns right-to-left
- Verified visually from the right-side dialogue in the captured OCR composite image on 2026-04-22
- Original debug artifact: `/tmp/gallery-ocr-debug/viewport-2026-04-22T09-36-15-941Z-2001676.png`

## Current App State

- Backend: `paddle-current`
- Status: ordering improved after parser fix and vertical-column reorder
- Remaining gap: recognizer still returns 4 non-empty lines for a 5-line ground truth

### Ground Truth

```text
「な…なにを!?」
何って旦那さんと会えないから
ご無沙汰でしょう？
前まで盛り上がってたじゃないですか
聞こえてましたよ壁から。
```

### Current App Output

```text
「な…なにを!8
つて旦那さんと会えないから
ご無沙汰でし
聞こえてましたよ壁から
```
