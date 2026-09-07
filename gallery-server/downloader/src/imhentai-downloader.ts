import fs from 'node:fs';
import path from 'node:path';
import { imhentai } from 'gallery-sources';
import { CONFIG } from './config.js';
import { withHeadfulChromiumPage } from './headful-chromium.js';
import { durableAtomicWriteFileSync } from './durable-file.js';
import { DownloadFailure, retryAfter } from './download-failure.js';

export function sourceThumbnailUrl(template: string, page: number): string {
    const url = new URL(template);
    if (!Number.isSafeInteger(page) || page < 1 || !/\/\d+t\.(?:jpe?g|png|webp|avif|gif)$/i.test(url.pathname)) {
        throw new Error('Invalid source thumbnail pattern');
    }
    url.pathname = url.pathname.replace(/\/\d+t(?=\.)/, `/${page}t`);
    return url.href;
}

export function completeSourceThumbnails(images: { page: number; thumbnailUrl: string }[]): void {
    // Match gallery-reader: keep explicitly listed URLs, then derive later
    // pages from the first source thumbnail, independently of original formats.
    const template = images.find(image => image.thumbnailUrl)?.thumbnailUrl;
    if (!template) throw new DownloadFailure('Source page exposes no thumbnail URL pattern', 404);
    for (const image of images) image.thumbnailUrl ||= sourceThumbnailUrl(template, image.page);
}

interface BrowserImage {
    page: number;
    extension: string;
    width: number;
    height: number;
    fullUrl: string;
    thumbnailUrl: string;
}

interface BrowserManifest {
    galleryId: number;
    title: string;
    titleJpn: string;
    type: string;
    language: string;
    date: string;
    artists: string[];
    groups: string[];
    parody: string[];
    characters: string[];
    tags: string[];
    images: BrowserImage[];
}

export interface ImhentaiDownloadResult {
    galleryId: string;
    directory: string;
    downloadedFiles: number;
    reusedFiles: number;
}

export interface ImhentaiDownloadOptions {
    signal?: AbortSignal;
    log?: (message: string) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new Error('download aborted');
}

async function extractManifest(url: string, expectedId: string, signal?: AbortSignal): Promise<BrowserManifest> {
    throwIfAborted(signal);
    return withHeadfulChromiumPage(async page => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.locator('[data-src]').first().waitFor({ state: 'attached', timeout: 120_000 });
        throwIfAborted(signal);

        const manifest = await page.evaluate<BrowserManifest>(`(() => {
            const galleryId = Number(location.pathname.match(/\\/(?:gallery|view)\\/(\\d+)/)?.[1] || 0);
            const cleanLinkText = (element) => {
                const copy = element.cloneNode(true);
                copy.querySelectorAll('.badge').forEach(node => node.remove());
                return copy.textContent.trim().replace(/\\s+/g, ' ');
            };
            const values = (namespace) => [...document.querySelectorAll('.galleries_info a[href^="/' + namespace + '/"]')]
                .map(cleanLinkText)
                .filter(Boolean);
            const firstImage = document.querySelector('[data-src]')?.getAttribute('data-src') || '';
            const base = firstImage.slice(0, firstImage.lastIndexOf('/') + 1);
            const extensionNames = { j: 'jpg', p: 'png', g: 'gif', w: 'webp', a: 'avif' };
            let imageData = globalThis.g_th;
            if (!imageData) {
                const source = [...document.scripts].map(script => script.textContent || '').find(text => text.includes('$.parseJSON')) || '';
                const match = source.match(/\\$\\.parseJSON\\('(.+)'\\)/);
                imageData = match ? JSON.parse(match[1]) : null;
            }
            if (!base || !imageData) throw new Error('IMHentai page did not expose its image manifest');
            const thumbnailUrls = new Map([...document.querySelectorAll('[data-src]')].map(element => {
                const url = element.getAttribute('data-src');
                const match = url?.match(/\\/(\\d+)t\\.(?:jpe?g|png|webp|avif|gif)(?:\\?|$)/i);
                return match ? [Number(match[1]), new URL(url, location.href).href] : [0, ''];
            }));
            thumbnailUrls.delete(0);
            const images = Object.keys(imageData).sort((a, b) => Number(a) - Number(b)).map(key => {
                const page = Number(key);
                const [extensionCode, width, height] = String(imageData[key]).split(',');
                const extension = extensionNames[extensionCode] || 'jpg';
                return {
                    page,
                    extension,
                    width: Number(width) || 0,
                    height: Number(height) || 0,
                    fullUrl: base + page + '.' + extension,
                    thumbnailUrl: thumbnailUrls.get(page) || '',
                };
            });
            return {
                galleryId,
                title: document.querySelector('h1')?.textContent?.trim() || '',
                titleJpn: document.querySelector('.subtitle')?.textContent?.trim() || '',
                type: values('category')[0] || '',
                language: values('language')[0] || '',
                date: document.querySelector('.galleries_info .posted')?.textContent?.replace(/^Posted:\\s*/, '').trim() || '',
                artists: values('artist'),
                groups: values('group'),
                parody: values('parody'),
                characters: values('character'),
                tags: values('tag'),
                images,
            };
        })()`);

        if (String(manifest.galleryId) !== expectedId) {
            throw new Error(`Chromium opened gallery ${manifest.galleryId || 'unknown'} instead of ${expectedId}`);
        }
        if (manifest.images.length === 0) throw new Error(`IMHentai gallery ${expectedId} contains no images`);
        // Same one-gallery manifest approach as gallery-reader. Thumbnails have
        // their own source-supplied URL pattern; never use the full image suffix.
        completeSourceThumbnails(manifest.images);
        return manifest;
    }, signal);
}

export async function downloadFile(url: string, destination: string, signal?: AbortSignal): Promise<'downloaded' | 'reused'> {
    try { return await acquireFile(url, destination, signal); }
    catch (error) {
        if (error instanceof DownloadFailure) throw error;
        throw new DownloadFailure(`${(error as Error).message} for ${url}`, undefined, 0, path.basename(destination));
    }
}

async function acquireFile(url: string, destination: string, signal?: AbortSignal): Promise<'downloaded' | 'reused'> {
    try {
        const stat = fs.lstatSync(destination);
        if (stat.isFile() && stat.size > 0) return 'reused';
    } catch { /* missing file */ }

    throwIfAborted(signal);
    if (!url) throw new DownloadFailure(`Source thumbnail URL missing for ${path.basename(destination)}`, 404, 0, path.basename(destination));
    const transferSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    // Keep acquisition polite; retries must not turn rate limiting into bursts.
    await new Promise<void>((resolve, reject) => {
        transferSignal.throwIfAborted();
        const aborted = () => { clearTimeout(timer); reject(transferSignal.reason); };
        const timer = setTimeout(() => { transferSignal.removeEventListener('abort', aborted); resolve(); }, 200);
        transferSignal.addEventListener('abort', aborted, { once: true });
    });
    const response = await fetch(url, { signal: transferSignal });
    if (!response.ok) {
        await response.body?.cancel();
        throw new DownloadFailure(`HTTP ${response.status} for ${url}`, response.status, retryAfter(response.headers.get('retry-after')), path.basename(destination));
    }
    if (!response.headers.get('content-type')?.startsWith('image/')) {
        await response.body?.cancel();
        throw new DownloadFailure(`Non-image response for ${url}`, 403, 0, path.basename(destination));
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new DownloadFailure(`Empty image for ${url}`, 502, 0, path.basename(destination));
    throwIfAborted(signal);
    durableAtomicWriteFileSync(destination, bytes);
    return 'downloaded';
}

function languageCode(language: string): string {
    const codes: Record<string, string> = {
        chinese: 'zh', english: 'en', japanese: 'ja', korean: 'ko', spanish: 'es',
    };
    return codes[language.toLowerCase()] ?? '';
}

export async function downloadImhentaiGallery(
    url: string,
    options: ImhentaiDownloadOptions = {},
): Promise<ImhentaiDownloadResult> {
    const galleryId = imhentai.download.parseIdFromUrl(url);
    if (!galleryId) throw new Error(`unsupported IMHentai URL: ${url}`);
    const log = options.log ?? (() => undefined);
    log(`Opening IMHentai gallery ${galleryId} in visible Chromium...`);
    const manifest = await extractManifest(`https://imhentai.xxx/gallery/${galleryId}/`, galleryId, options.signal);

    const directory = path.join(CONFIG.WORKING_DIR, imhentai.gallerySubdir, galleryId);
    fs.mkdirSync(directory, { recursive: true });
    let downloadedFiles = 0;
    let reusedFiles = 0;

    for (const image of manifest.images) {
        throwIfAborted(options.signal);
        const number = String(image.page).padStart(4, '0');
        const fullPath = path.join(directory, `imhentai_${galleryId}_${number}.${image.extension}`);
        // Source thumbnails need their own source URLs, not guessed extensions.
        const outcome = await downloadFile(image.fullUrl, fullPath, options.signal);
        if (outcome === 'downloaded') downloadedFiles++;
        else reusedFiles++;
        log(`IMHentai ${galleryId}: ${image.page}/${manifest.images.length}`);
    }

    const info = {
        gallery_id: manifest.galleryId,
        title: manifest.title,
        title_jpn: manifest.titleJpn,
        type: manifest.type,
        language: manifest.language,
        lang: languageCode(manifest.language),
        date: manifest.date,
        tags: manifest.tags,
        artist: manifest.artists,
        group: manifest.groups,
        parody: manifest.parody,
        characters: manifest.characters,
        count: manifest.images.length,
        category: 'imhentai',
        subcategory: 'gallery',
    };
    const infoPath = path.join(directory, imhentai.metadataFile);
    durableAtomicWriteFileSync(infoPath, `${JSON.stringify(info, null, 2)}\n`);
    // Full originals are complete before thumbnail acquisition. A failed preview
    // never invalidates or causes these originals to be downloaded again.
    for (const image of manifest.images) {
        const number = String(image.page).padStart(4, '0');
        const ext = image.thumbnailUrl.match(/\.(jpe?g|png|webp|avif|gif)(?:\?|$)/i)?.[1]?.toLowerCase() || 'jpg';
        const thumbnailPath = path.join(directory, `imhentai_${galleryId}_thumb_${number}.${ext}`);
        const outcome = await downloadFile(image.thumbnailUrl, thumbnailPath, options.signal);
        if (outcome === 'downloaded') downloadedFiles++;
        else reusedFiles++;
        log(`IMHentai ${galleryId} thumbnail: ${image.page}/${manifest.images.length}`);
    }
    log(`Saved IMHentai gallery ${galleryId}: ${manifest.images.length} pages`);
    return { galleryId, directory, downloadedFiles, reusedFiles };
}
