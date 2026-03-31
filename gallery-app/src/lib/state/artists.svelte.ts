import * as api from '../services/api.js';
import type { ToastState } from './toast.svelte.js';
import type { LogEmit } from '../services/LogService.js';

interface ArtistOp {
    type: 'add' | 'remove';
    line: string;
}

export class ArtistsState {
    tracked = $state(new Set<string>());
    processing = $state(new Set<string>());
    private queue: ArtistOp[] = [];
    private draining = false;
    private toast: ToastState;
    private emit: LogEmit;

    constructor(toast: ToastState, emit: LogEmit) {
        this.toast = toast;
        this.emit = emit;
    }

    async init() {
        try {
            const entries = await api.getTrackedArtists();
            this.tracked = new Set(entries);
            this.emit('artists-loaded', { count: entries.length });
        } catch (e) {
            this.emit('artists-load-failed', { error: String(e) });
        }
    }

    /** Build the artists.txt line from gallery metadata (spaces -> underscores) */
    private toLine(namespace: string, name: string): string {
        return `${namespace}:${name.replace(/ /g, '_')}`;
    }

    isTracked(namespace: string, name: string): boolean {
        return this.tracked.has(this.toLine(namespace, name));
    }

    isProcessing(namespace: string, name: string): boolean {
        return this.processing.has(this.toLine(namespace, name));
    }

    enqueue(namespace: string, name: string) {
        const line = this.toLine(namespace, name);
        if (this.processing.has(line)) return;

        const type = this.tracked.has(line) ? 'remove' : 'add';
        this.emit('artists-enqueue', { type, line });
        this.processing = new Set([...this.processing, line]);
        this.queue.push({ type, line });
        this.drain();
    }

    private async drain() {
        if (this.draining) return;
        this.draining = true;

        while (this.queue.length > 0) {
            const op = this.queue.shift()!;
            try {
                if (op.type === 'add') {
                    const result = await api.addArtist(op.line);
                    this.emit('artists-add-ok', { line: op.line, status: result.status });
                    this.tracked = new Set([...this.tracked, op.line]);
                    this.toast.show(`Added ${op.line}`);
                } else {
                    this.emit('artists-remove-start', { line: op.line });
                    await api.removeArtist(op.line);
                    await this.pollRemoveUntilDone();
                    this.emit('artists-remove-ok', { line: op.line });
                    const next = new Set(this.tracked);
                    next.delete(op.line);
                    this.tracked = next;
                    this.toast.show(`Removed ${op.line}`);
                }
            } catch (e) {
                this.emit('artists-op-failed', { type: op.type, line: op.line, error: String(e) });
                this.toast.show(`Failed: ${op.line} — ${e}`, 3000);
            }
            const nextProcessing = new Set(this.processing);
            nextProcessing.delete(op.line);
            this.processing = nextProcessing;
        }

        this.draining = false;
    }

    private async pollRemoveUntilDone(): Promise<void> {
        await new Promise(r => setTimeout(r, 500));

        while (true) {
            const status = await api.getRemoveStatus();
            this.emit('artists-remove-poll', { phase: status.phase });
            if (status.phase === 'done' || status.phase === 'idle') return;
            if (status.phase === 'error') {
                throw new Error(status.error || 'Remove failed');
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}
