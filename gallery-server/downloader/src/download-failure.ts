export class DownloadFailure extends Error {
    constructor(message: string, public status?: number, public retryAfterMs = 0, public asset?: string) { super(message); }
}

export function retryAfter(value: string | null, now = Date.now()): number {
    if (!value) return 0;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export function retryDelay(error: Error, attempts: number): number | null {
    const status = (error instanceof DownloadFailure ? error.status : Number(error.message.match(/\b(?:HTTP|status(?: code)?)[ :]+(\d{3})\b/i)?.[1])) || 0;
    if (attempts >= 6 || /ENOSPC|EACCES|EROFS|quota|permission denied/i.test(error.message)) return null;
    // Re-extract once for an expired URL/challenge; repeated permanent responses need attention.
    if (status >= 400 && status < 500 && ![408, 429].includes(status) && attempts >= 2) return null;
    const delay = [30_000, 120_000, 600_000, 3_600_000, 21_600_000][attempts - 1] ?? 21_600_000;
    return Math.max(delay, error instanceof DownloadFailure ? error.retryAfterMs : 0);
}
