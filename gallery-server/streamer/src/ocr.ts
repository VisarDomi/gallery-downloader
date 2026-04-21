import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { Request, Response } from 'express';
import { CONFIG } from './config.js';

interface OcrLookupResult {
    text: string;
    lines: string[];
    warnings: string[];
    elapsedMs: number;
}

function runPython(imagePath: string): Promise<OcrLookupResult> {
    return new Promise((resolve, reject) => {
        execFile(
            CONFIG.OCR_PYTHON,
            [CONFIG.OCR_RUNNER, imagePath],
            { maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                    return;
                }
                try {
                    resolve(JSON.parse(stdout) as OcrLookupResult);
                } catch (parseError) {
                    reject(new Error(`Invalid OCR response: ${String(parseError)}\n${stdout}\n${stderr}`));
                }
            },
        );
    });
}

export async function handleOcrLookupRequest(req: Request, res: Response) {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Missing image payload' });
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-ocr-'));
    const imagePath = path.join(tempDir, 'viewport.png');

    try {
        await fs.writeFile(imagePath, req.body);
        const result = await runPython(imagePath);
        return res.json(result);
    } catch (error) {
        console.error('[OCR] lookup failed', error);
        return res.status(500).json({ error: String((error as Error)?.message ?? error) });
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}
