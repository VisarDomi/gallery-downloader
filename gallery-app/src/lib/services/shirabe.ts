export function openShirabeLookup(text: string) {
    const query = text.trim();
    if (!query) throw new Error('No OCR text to look up');
    window.location.href = `shirabelookup://search?w=${encodeURIComponent(query)}`;
}
