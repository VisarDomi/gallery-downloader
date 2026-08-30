import fs from 'node:fs';
import path from 'node:path';
import { imhentai } from 'gallery-sources';
import { CONFIG } from './config.js';
import { withHeadfulChromiumPage } from './headful-chromium.js';
import { durableAtomicWriteFileSync } from './durable-file.js';

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
                    thumbnailUrl: base + page + 't.' + extension,
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
        return manifest;
    });
}

async function downloadFile(url: string, destination: string, signal?: AbortSignal): Promise<'downloaded' | 'reused'> {
    try {
        if (fs.statSync(destination).size > 0) return 'reused';
    } catch { /* missing file */ }

    throwIfAborted(signal);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
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
        const thumbnailPath = path.join(directory, `imhentai_${galleryId}_thumb_${number}.${image.extension}`);
        for (const [sourceUrl, destination] of [[image.fullUrl, fullPath], [image.thumbnailUrl, thumbnailPath]] as const) {
            const outcome = await downloadFile(sourceUrl, destination, options.signal);
            if (outcome === 'downloaded') downloadedFiles++;
            else reusedFiles++;
        }
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
    log(`Saved IMHentai gallery ${galleryId}: ${manifest.images.length} pages`);
    return { galleryId, directory, downloadedFiles, reusedFiles };
}
