#!/usr/bin/env node

import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [provider, galleryId, ...options] = process.argv.slice(2);
const force = options.includes('--force');
const allowActive = options.includes('--allow-active');
const supportedProviders = new Set(['hitomi', 'imhentai']);
const downloadRoot = process.env.GALLERY_DOWNLOAD_ROOT
    ?? path.join(os.homedir(), 'Pictures', 'gallery-dl');
const libraryRoot = process.env.KOMGA_LIBRARY_ROOT
    ?? process.env.KOGMA_LIBRARY_ROOT
    ?? path.join(os.homedir(), 'Pictures', 'komga');

if (provider === '--all') {
    let exported = 0;
    for (const candidateProvider of supportedProviders) {
        const providerDir = path.join(downloadRoot, candidateProvider);
        if (!existsSync(providerDir)) continue;
        const galleryIds = readdirSync(providerDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
            .map(entry => entry.name)
            .filter(id => existsSync(path.join(providerDir, id, 'info.json')))
            .filter(id => !existsSync(path.join(providerDir, `.downloading-${id}`)))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        for (const id of galleryIds) {
            const childArgs = [fileURLToPath(import.meta.url), candidateProvider, id];
            if (galleryId === '--force' || options.includes('--force')) childArgs.push('--force');
            const result = spawnSync(process.execPath, childArgs, { stdio: 'inherit' });
            if (result.error) throw result.error;
            if (result.status !== 0) process.exit(result.status ?? 1);
            exported++;
        }
    }
    console.log(`Processed ${exported} completed galleries.`);
    process.exit(0);
}

if (!supportedProviders.has(provider) || !/^\d+$/.test(galleryId ?? '')) {
    console.error('Usage: npm run export:komga -- <hitomi|imhentai> <gallery-id> [--force]');
    console.error('       npm run export:komga -- --all [--force]');
    process.exit(2);
}

const sourceDir = path.join(downloadRoot, provider, galleryId);
const infoPath = path.join(sourceDir, 'info.json');
const activeMarker = path.join(downloadRoot, provider, `.downloading-${galleryId}`);
const destinationDir = path.join(libraryRoot, '_oneshots');
const destination = path.join(destinationDir, `${provider}-${galleryId}.cbz`);

if (!existsSync(infoPath)) {
    console.error(`Gallery is not complete (missing info.json): ${sourceDir}`);
    process.exit(1);
}

if (!allowActive && existsSync(activeMarker)) {
    console.error(`Gallery is still downloading: ${sourceDir}`);
    process.exit(1);
}

const pagePattern = new RegExp(`^${provider}_${galleryId}_(\\d+)\\.(?:avif|gif|jpe?g|png|webp)$`, 'i');
const pages = readdirSync(sourceDir)
    .filter(name => pagePattern.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

if (pages.length === 0) {
    console.error(`No full-size gallery pages found: ${sourceDir}`);
    process.exit(1);
}

const newestInput = Math.max(statSync(infoPath).mtimeMs, ...pages.map(name => statSync(path.join(sourceDir, name)).mtimeMs));
if (!force && existsSync(destination) && statSync(destination).mtimeMs >= newestInput) {
    console.log(`Already current: ${destination}`);
    process.exit(0);
}

const metadata = JSON.parse(readFileSync(infoPath, 'utf8'));
const xmlEscape = value => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const title = metadata.title || `${provider} ${galleryId}`;
const tags = Array.isArray(metadata.tags) ? metadata.tags.join(', ') : '';
const languageNamesToIso = new Map([
    ['chinese', 'zh'],
    ['english', 'en'],
    ['french', 'fr'],
    ['german', 'de'],
    ['italian', 'it'],
    ['japanese', 'ja'],
    ['korean', 'ko'],
    ['portuguese', 'pt'],
    ['russian', 'ru'],
    ['spanish', 'es'],
]);
const rawLanguage = String(metadata.language || metadata.lang || '').toLowerCase();
const language = languageNamesToIso.get(rawLanguage) ?? rawLanguage;
const sourceUrl = provider === 'hitomi'
    ? `https://hitomi.la/galleries/${galleryId}.html`
    : `https://imhentai.xxx/gallery/${galleryId}/`;
const comicInfo = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Title>${xmlEscape(title)}</Title>
  <Series>${xmlEscape(title)}</Series>
  <Number>1</Number>
  <Count>1</Count>
  <PageCount>${pages.length}</PageCount>
  <Genre>${xmlEscape(tags)}</Genre>
  <Tags>${xmlEscape(tags)}</Tags>
  <LanguageISO>${xmlEscape(language)}</LanguageISO>
  <Web>${xmlEscape(sourceUrl)}</Web>
  <Manga>YesAndRightToLeft</Manga>
  <Notes>Exported from Gallery Downloader (${provider}:${galleryId})</Notes>
</ComicInfo>
`;

mkdirSync(destinationDir, { recursive: true });
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'gallery-komga-'));
const comicInfoPath = path.join(temporaryDirectory, 'ComicInfo.xml');
const temporaryArchive = path.join(destinationDir, `.${provider}-${galleryId}.${process.pid}.cbz`);

function runZip(args, cwd) {
    const result = spawnSync('/usr/bin/zip', args, { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`/usr/bin/zip exited with status ${result.status}`);
}

try {
    writeFileSync(comicInfoPath, comicInfo, { mode: 0o600 });
    runZip(['-0', '-q', temporaryArchive, ...pages], sourceDir);
    runZip(['-q', temporaryArchive, 'ComicInfo.xml'], temporaryDirectory);

    const archiveFd = openSync(temporaryArchive, 'r');
    try {
        fsyncSync(archiveFd);
    } finally {
        closeSync(archiveFd);
    }
    renameSync(temporaryArchive, destination);
    const directoryFd = openSync(destinationDir, 'r');
    try {
        fsyncSync(directoryFd);
    } finally {
        closeSync(directoryFd);
    }

    console.log(`Exported ${pages.length} pages: ${destination}`);
} finally {
    rmSync(temporaryArchive, { force: true });
    rmSync(temporaryDirectory, { recursive: true, force: true });
}
