import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import type { Request, Response } from 'express';
import { CONFIG } from './config.js';

export type OcrBackendId = 'paddle-current';

interface OcrLookupResult {
    text: string;
    lines: string[];
    warnings: string[];
    elapsedMs: number;
    blocks?: unknown[];
    discardedBlocks?: unknown[];
    salvagedBlocks?: unknown[];
    profile?: Record<string, unknown>;
}

interface OcrBackendRun extends OcrLookupResult {
    backend: OcrBackendId;
    artifacts?: {
        requestPath?: string;
        imagePath?: string;
        resultPath?: string;
        textPath?: string;
    };
}

interface OcrLookupResponse extends OcrLookupResult {
    backend: OcrBackendId;
    availableBackends: OcrBackendId[];
    runs: OcrBackendRun[];
}

interface OcrViewportImageRequest {
    pageIndex: number;
    mediaPath: string;
    left: number;
    top: number;
    width: number;
    height: number;
}

interface OcrViewportRequest {
    viewport: {
        width: number;
        height: number;
        scale: number;
        devicePixelRatio: number;
    };
    images: OcrViewportImageRequest[];
    backend?: string;
    compareBackends?: string[];
}

interface OcrWorkerCommand {
    mediaRoot: string;
    requestPath: string;
    imagePath?: string;
}

interface OcrWorkerMessage {
    ok: boolean;
    result?: OcrLookupResult;
    error?: string;
}

function buildDebugPaths() {
    const debugDir = path.join(os.tmpdir(), 'gallery-ocr-debug');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const stem = `viewport-${timestamp}-${process.pid}`;
    return {
        debugDir,
        requestPath: path.join(debugDir, `${stem}.json`),
        imagePath: path.join(debugDir, `${stem}.png`),
        resultPath: path.join(debugDir, `${stem}.result.json`),
        textPath: path.join(debugDir, `${stem}.txt`),
    };
}

function buildDebugPathsForBackend(backend: OcrBackendId) {
    const base = buildDebugPaths();
    const suffix = `.${backend}`;
    return {
        debugDir: base.debugDir,
        requestPath: base.requestPath.replace('.json', `${suffix}.json`),
        imagePath: base.imagePath.replace('.png', `${suffix}.png`),
        resultPath: base.resultPath.replace('.result.json', `${suffix}.result.json`),
        textPath: base.textPath.replace('.txt', `${suffix}.txt`),
    };
}

const AVAILABLE_OCR_BACKENDS: OcrBackendId[] = ['paddle-current'];

function isKnownBackend(value: unknown): value is OcrBackendId {
    return typeof value === 'string' && AVAILABLE_OCR_BACKENDS.includes(value as OcrBackendId);
}

function resolveRequestedBackends(request: OcrViewportRequest): OcrBackendId[] {
    const requested = [
        request.backend,
        ...(Array.isArray(request.compareBackends) ? request.compareBackends : []),
    ].filter(isKnownBackend);
    const deduped = Array.from(new Set(requested));
    return deduped.length > 0 ? deduped : ['paddle-current'];
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isViewportRequest(body: unknown): body is OcrViewportRequest {
    if (!body || typeof body !== 'object') return false;
    const candidate = body as Partial<OcrViewportRequest>;
    if (!candidate.viewport || typeof candidate.viewport !== 'object') return false;
    if (!Array.isArray(candidate.images) || candidate.images.length === 0) return false;
    const viewport = candidate.viewport as OcrViewportRequest['viewport'];
    if (!isFiniteNumber(viewport.width) || !isFiniteNumber(viewport.height)) return false;
    if (!isFiniteNumber(viewport.scale) || !isFiniteNumber(viewport.devicePixelRatio)) return false;
    if (candidate.backend !== undefined && typeof candidate.backend !== 'string') return false;
    if (candidate.compareBackends !== undefined) {
        if (!Array.isArray(candidate.compareBackends)) return false;
        if (!candidate.compareBackends.every((item) => typeof item === 'string')) return false;
    }
    return candidate.images.every((item) =>
        item
        && typeof item.mediaPath === 'string'
        && isFiniteNumber(item.pageIndex)
        && isFiniteNumber(item.left)
        && isFiniteNumber(item.top)
        && isFiniteNumber(item.width)
        && isFiniteNumber(item.height),
    );
}

class OcrWorker {
    private process: ChildProcessWithoutNullStreams | null = null;
    private rl: ReturnType<typeof createInterface> | null = null;
    private pending: { resolve: (result: OcrLookupResult) => void; reject: (error: Error) => void } | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private idleTimer: NodeJS.Timeout | null = null;

    private ensureProcess() {
        if (this.process && this.rl) return;
        const child = spawn(CONFIG.OCR_PYTHON, [CONFIG.OCR_WORKER], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const rl = createInterface({ input: child.stdout });

        rl.on('line', (line) => {
            if (!this.pending) return;
            let message: OcrWorkerMessage;
            try {
                message = JSON.parse(line) as OcrWorkerMessage;
            } catch (error) {
                const pending = this.pending;
                this.pending = null;
                pending.reject(new Error(`Invalid OCR worker response: ${String(error)}\n${line}`));
                return;
            }

            const pending = this.pending;
            this.pending = null;
            if (message.ok && message.result) {
                pending.resolve(message.result);
            } else {
                pending.reject(new Error(message.error || 'OCR worker failed'));
            }
        });

        child.stderr.on('data', (chunk) => {
            const message = chunk.toString().trim();
            if (message) {
                console.error('[OCR worker]', message);
            }
        });

        child.on('exit', (code, signal) => {
            const pending = this.pending;
            this.pending = null;
            this.process = null;
            this.rl?.close();
            this.rl = null;
            if (pending) {
                pending.reject(new Error(`OCR worker exited unexpectedly (${code ?? 'null'} / ${signal ?? 'null'})`));
            }
        });

        this.process = child;
        this.rl = rl;
        console.log('[OCR] worker started');
    }

    private scheduleIdleStop() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.stop(), CONFIG.OCR_WARM_IDLE_MS);
    }

    private stop() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.process) {
            console.log('[OCR] worker stopped after idle timeout');
            this.process.kill();
            this.process = null;
        }
        this.rl?.close();
        this.rl = null;
    }

    run(command: OcrWorkerCommand): Promise<OcrLookupResult> {
        const runPromise = this.queue.then(async () => {
            this.ensureProcess();
            this.scheduleIdleStop();

            return new Promise<OcrLookupResult>((resolve, reject) => {
                if (!this.process) {
                    reject(new Error('OCR worker is not running'));
                    return;
                }
                if (this.pending) {
                    reject(new Error('OCR worker received overlapping request'));
                    return;
                }
                this.pending = { resolve, reject };
                this.process.stdin.write(`${JSON.stringify(command)}\n`, 'utf8', (error) => {
                    if (error) {
                        const pending = this.pending;
                        this.pending = null;
                        pending?.reject(error);
                    }
                });
            });
        });

        this.queue = runPromise.catch(() => undefined);
        return runPromise;
    }
}

const ocrWorker = new OcrWorker();

function buildRunArtifacts(debugPaths: ReturnType<typeof buildDebugPathsForBackend> | null) {
    if (!debugPaths) return undefined;
    return {
        requestPath: debugPaths.requestPath,
        imagePath: debugPaths.imagePath,
        resultPath: debugPaths.resultPath,
        textPath: debugPaths.textPath,
    };
}

async function runBackendLookup(
    backend: OcrBackendId,
    requestBody: OcrViewportRequest,
    requestStarted: number,
): Promise<OcrBackendRun> {
    const debugPaths = CONFIG.OCR_DEBUG_ARTIFACTS ? buildDebugPathsForBackend(backend) : null;
    const requestPath = debugPaths?.requestPath ?? path.join(os.tmpdir(), `gallery-ocr-request-${backend}-${process.pid}-${Date.now()}.json`);

    try {
        const saveStarted = performance.now();
        if (debugPaths) {
            await fs.mkdir(debugPaths.debugDir, { recursive: true });
        }
        await fs.writeFile(requestPath, JSON.stringify(requestBody, null, 2), 'utf8');
        const requestSaveMs = Number((performance.now() - saveStarted).toFixed(2));
        if (debugPaths) {
            console.log(`[OCR] saved debug request ${requestPath}`);
        }

        const workerStarted = performance.now();
        const result = await ocrWorker.run({
            mediaRoot: CONFIG.MEDIA_ROOT,
            requestPath,
            imagePath: debugPaths?.imagePath,
        });
        const workerRoundtripMs = Number((performance.now() - workerStarted).toFixed(2));

        if (debugPaths) {
            console.log(`[OCR] saved debug image ${debugPaths.imagePath}`);
            await fs.writeFile(debugPaths.resultPath, JSON.stringify(result, null, 2), 'utf8');
            await fs.writeFile(debugPaths.textPath, result.text, 'utf8');
            console.log(`[OCR] saved debug result ${debugPaths.resultPath}`);
        }

        const totalRequestMs = Number((performance.now() - requestStarted).toFixed(2));
        console.log('[OCR] timing', JSON.stringify({
            backend,
            requestSaveMs,
            workerRoundtripMs,
            totalRequestMs,
            profile: result.profile ?? null,
        }));

        return {
            ...result,
            backend,
            artifacts: buildRunArtifacts(debugPaths),
        };
    } finally {
        if (!debugPaths) {
            fs.unlink(requestPath).catch(() => undefined);
        }
    }
}

export function handleOcrBackendsRequest(_req: Request, res: Response) {
    return res.json({
        availableBackends: AVAILABLE_OCR_BACKENDS,
        defaultBackend: 'paddle-current',
    });
}

export async function handleOcrLookupRequest(req: Request, res: Response) {
    const requestStarted = performance.now();
    if (!isViewportRequest(req.body)) {
        return res.status(400).json({ error: 'Invalid OCR viewport payload' });
    }
    const requestedBackends = resolveRequestedBackends(req.body);
    const requestBody: OcrViewportRequest = {
        ...req.body,
        backend: requestedBackends[0],
        compareBackends: requestedBackends.slice(1),
    };

    try {
        const runs: OcrBackendRun[] = [];
        for (const backend of requestedBackends) {
            runs.push(await runBackendLookup(backend, requestBody, requestStarted));
        }
        if (runs.length === 0) {
            throw new Error('No OCR backends selected');
        }
        const primary = runs[0];
        const response: OcrLookupResponse = {
            ...primary,
            backend: primary.backend,
            availableBackends: AVAILABLE_OCR_BACKENDS,
            runs,
        };
        return res.json(response);
    } catch (error) {
        console.error('[OCR] lookup failed', error);
        return res.status(500).json({ error: String((error as Error)?.message ?? error) });
    }
}
