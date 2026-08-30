import { chromium, type Page } from 'playwright-core';
import { CONFIG } from './config.js';

export async function withHeadfulChromiumPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
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

    try {
        const page = context.pages()[0] ?? await context.newPage();
        return await run(page);
    } finally {
        await context.close();
        console.log('[chromium] visible browser closed');
    }
}
