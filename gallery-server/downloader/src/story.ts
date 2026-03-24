import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

const LOGS_DIR = path.join(CONFIG.WORKING_DIR, 'gallery-dl', 'logs');
const STORIES_PATH = path.join(LOGS_DIR, 'stories.jsonl');

interface StoryEvent {
    ts: string;
    level: 'info' | 'error';
    msg: string;
    data?: Record<string, unknown>;
}

export interface Story {
    operation: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    status: 'done' | 'error';
    params: Record<string, unknown>;
    events: StoryEvent[];
    result: Record<string, unknown>;
    error?: string;
}

export class StoryLog {
    private readonly operation: string;
    private readonly params: Record<string, unknown>;
    private readonly startTime: number;
    private readonly events: StoryEvent[] = [];
    private finalized = false;

    constructor(operation: string, params: Record<string, unknown>) {
        this.operation = operation;
        this.params = params;
        this.startTime = Date.now();
    }

    event(msg: string, data?: Record<string, unknown>) {
        if (this.finalized) return;
        this.events.push({ ts: new Date().toISOString(), level: 'info', msg, data });
        const suffix = data ? ' ' + JSON.stringify(data) : '';
        console.log(`[${this.operation}] ${msg}${suffix}`);
    }

    error(msg: string, data?: Record<string, unknown>) {
        if (this.finalized) return;
        this.events.push({ ts: new Date().toISOString(), level: 'error', msg, data });
        const suffix = data ? ' ' + JSON.stringify(data) : '';
        console.error(`[${this.operation}] ERROR: ${msg}${suffix}`);
    }

    finalize(status: 'done' | 'error', result: Record<string, unknown>, errorMsg?: string) {
        if (this.finalized) return;
        this.finalized = true;

        const story: Story = {
            operation: this.operation,
            startedAt: new Date(this.startTime).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - this.startTime,
            status,
            params: this.params,
            events: this.events,
            result,
        };
        if (errorMsg) story.error = errorMsg;

        console.log(`[${this.operation}] ${status} in ${(story.durationMs / 1000).toFixed(1)}s`);

        try {
            fs.mkdirSync(LOGS_DIR, { recursive: true });
            fs.appendFileSync(STORIES_PATH, JSON.stringify(story) + '\n');
        } catch (e) {
            console.error(`[story] Failed to persist story: ${e}`);
        }
    }
}
