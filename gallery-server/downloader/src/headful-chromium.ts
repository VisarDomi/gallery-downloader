import { chromium, type Page } from 'playwright-core';
import { CONFIG } from './config.js';
import fs from 'node:fs';
import path from 'node:path';

export function protectBrowserMetrics(profile: string): void {
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const metrics = path.join(profile, 'BrowserMetrics');
    fs.mkdirSync(metrics, { recursive: true, mode: 0o500 });
    const stat = fs.lstatSync(metrics);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe Chromium metrics directory');
    fs.chmodSync(metrics, 0o500);
}

export async function withHeadfulChromiumPage<T>(run: (page: Page) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    protectBrowserMetrics(CONFIG.CHROMIUM.USER_DATA_DIR);
    console.log(`[chromium] opening visible browser with profile ${CONFIG.CHROMIUM.USER_DATA_DIR}`);
    const context = await chromium.launchPersistentContext(CONFIG.CHROMIUM.USER_DATA_DIR, {
        executablePath: CONFIG.CHROMIUM.EXECUTABLE,
        headless: false,
        viewport: null,
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
    }).catch((error: unknown) => {
        throw new Error(
            'Could not launch the IMHentai Chromium profile. Close any browser already using it. '
            + (error instanceof Error ? error.message : String(error)),
        );
    });

    const abort = () => { void context.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        signal?.throwIfAborted();
        const page = context.pages()[0] ?? await context.newPage();
        return await run(page);
    } finally {
        signal?.removeEventListener('abort', abort);
        await context.close();
        console.log('[chromium] visible browser closed');
    }
}
