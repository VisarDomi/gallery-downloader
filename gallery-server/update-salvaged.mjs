#!/usr/bin/env node
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import url from 'url';
import Database from 'better-sqlite3';
import { resolveManifest } from './downloader/dist/manifest-resolver.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filtersPath = path.join(__dirname, 'filters.txt');
const artistsPath = path.join(__dirname, 'artists.txt');
const queriesPath = path.join(__dirname, 'queries.txt');
const aliasMissingPath = path.join(__dirname, 'salvaged-alias-missing.txt');
const metadataMissingPath = path.join(__dirname, 'salvaged-metadata-missing.txt');
const unaliasedPath = path.join(__dirname, 'salvaged-unaliased.txt');
const indexDbPath = path.join(os.homedir(), 'Pictures', 'gallery-dl', 'gallery-index.db');

function loadLocalIds() {
    const db = new Database(indexDbPath, { readonly: true });
    try {
        db.pragma('journal_mode = WAL');
        const rows = db.prepare('SELECT gallery_id FROM galleries ORDER BY gallery_id').all();
        return rows.map((row) => row.gallery_id);
    } finally {
        db.close();
    }
}

function formatUrl(id) {
    return `https://hitomi.la/galleries/${id}.html`;
}

function writeLines(filePath, lines) {
    fs.writeFileSync(filePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}

function deleteLocalGalleries(ids) {
    if (ids.length === 0) {
        return Promise.resolve({ deleted: [], skipped: [] });
    }

    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ ids });
        const req = https.request(
            {
                hostname: 'localhost',
                port: 11556,
                path: '/api/delete',
                method: 'POST',
                rejectUnauthorized: false,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`delete failed (${res.statusCode}): ${data}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error(`bad delete response: ${data}`));
                    }
                });
            },
        );
        req.on('error', (error) => reject(error));
        req.write(body);
        req.end();
    });
}

async function resolveMetadataId(id) {
    const response = await fetch(`https://ltn.gold-usergeneratedcontent.net/galleries/${id}.js`, {
        headers: {
            'user-agent': 'Mozilla/5.0',
            referer: 'https://hitomi.la/',
        },
    });

    if (!response.ok) {
        if (response.status === 404) {
            return { kind: 'missing' };
        }
        throw new Error(`${id}: metadata HTTP ${response.status}`);
    }

    const text = await response.text();
    const match = text.match(/"id":"(\d+)"/);
    if (!match) {
        throw new Error(`${id}: metadata ID not found`);
    }

    return { kind: 'found', id: Number(match[1]) };
}

const resolution = await resolveManifest(filtersPath, artistsPath, queriesPath);
if (resolution.errors.length > 0) {
    for (const error of resolution.errors) {
        console.error(`[salvaged] ${error}`);
    }
    process.exit(1);
}

const localIds = loadLocalIds();
const localIdSet = new Set(localIds);
const salvagedIds = localIds.filter((id) => !resolution.wantedIds.has(id));

const aliasLocalIds = [];
const aliasMissing = [];
const metadataMissing = [];
const unaliased = [];

for (const id of salvagedIds) {
    const metadata = await resolveMetadataId(id);
    if (metadata.kind === 'missing') {
        metadataMissing.push(formatUrl(id));
        continue;
    }

    const metadataId = metadata.id;
    if (metadataId === id) {
        unaliased.push(formatUrl(id));
    } else if (localIdSet.has(metadataId)) {
        if (resolution.wantedIds.has(id)) {
            throw new Error(`${id}: refusing alias-local cleanup because source is still wanted`);
        }
        aliasLocalIds.push(id);
    } else {
        aliasMissing.push(`${formatUrl(id)} -> ${formatUrl(metadataId)}`);
    }
}

const deleteResult = await deleteLocalGalleries(aliasLocalIds);
for (const skipped of deleteResult.skipped ?? []) {
    console.error(`[salvaged] cleanup skipped ${skipped.id}: ${skipped.reason}`);
}

writeLines(aliasMissingPath, aliasMissing);
writeLines(metadataMissingPath, metadataMissing);
writeLines(unaliasedPath, unaliased);

for (const oldPath of [
    path.join(__dirname, 'salvaged.txt'),
    path.join(__dirname, 'salvaged-alias-local.txt'),
]) {
    try {
        fs.unlinkSync(oldPath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

console.log(
    `[salvaged] wrote ${salvagedIds.length} entries ` +
    `(alias-local-deleted=${deleteResult.deleted?.length ?? 0}, ` +
    `alias-local-skipped=${deleteResult.skipped?.length ?? 0}, alias-missing=${aliasMissing.length}, ` +
    `metadata-missing=${metadataMissing.length}, unaliased=${unaliased.length}, ` +
    `local=${localIds.length}, wanted=${resolution.wantedIds.size})`,
);
