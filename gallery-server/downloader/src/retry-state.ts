import fs from 'node:fs';
import { durableAtomicWriteFileSync } from './durable-file.js';
import { DownloadFailure, retryDelay } from './download-failure.js';

export interface JobState {
    url: string; attempts: number; status: 'running' | 'retrying' | 'failed';
    lastError: string; asset?: string; nextRetryAt: number | null; updatedAt: string;
}

export class RetryState {
    private jobs = new Map<string, JobState>();
    constructor(private file: string, private now = Date.now) {
        try {
            const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(rows)) throw new Error('Invalid retry state');
            for (const row of rows) {
                if (typeof row.url !== 'string' || !Number.isInteger(row.attempts) || row.attempts < 1
                    || !['running', 'retrying', 'failed'].includes(row.status)
                    || (row.nextRetryAt !== null && !Number.isFinite(row.nextRetryAt))) throw new Error('Invalid retry record');
                this.jobs.set(row.url, row);
            }
            // A reserved attempt survives process death. Never reset its budget on restart.
            for (const row of this.jobs.values()) if (row.status === 'running') {
                this.fail(row.url, new Error('Previous attempt interrupted by process shutdown'));
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    all(): JobState[] { return [...this.jobs.values()].map(row => ({ ...row })); }
    get(url: string) { return this.jobs.get(url); }
    blocked(url: string) { return this.jobs.get(url)?.status === 'failed'; }
    begin(url: string) {
        const previous = this.jobs.get(url);
        if (previous?.status === 'failed' || (previous?.attempts ?? 0) >= 6) throw new Error('Job needs manual retry');
        this.jobs.set(url, { ...previous, url, attempts: (previous?.attempts ?? 0) + 1, status: 'running',
            lastError: previous?.lastError ?? '', nextRetryAt: null, updatedAt: new Date(this.now()).toISOString() });
        this.save(); // Reserve before launching Chromium or starting network work.
    }
    fail(url: string, error: Error) {
        const row = this.jobs.get(url)!;
        const delay = retryDelay(error, row.attempts);
        Object.assign(row, { status: delay === null ? 'failed' : 'retrying', lastError: error.message,
            asset: error instanceof DownloadFailure ? error.asset : undefined,
            nextRetryAt: delay === null ? null : this.now() + delay, updatedAt: new Date(this.now()).toISOString() });
        this.save();
        return row;
    }
    clear(url: string) { this.jobs.delete(url); this.save(); }
    private save() { durableAtomicWriteFileSync(this.file, JSON.stringify(this.all())); }
}
