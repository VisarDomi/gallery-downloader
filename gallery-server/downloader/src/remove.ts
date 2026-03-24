import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { loadManifest, type ArtistEntry } from './manifest.js';
import { resolveArtistEntry, resolveQuery } from './resolver.js';
import { CONFIG } from './config.js';
import { socketService } from './socket.service.js';

const INDEX_DB_PATH = path.join(CONFIG.WORKING_DIR, 'gallery-dl', 'gallery-index.db');
const STREAMER_PORT = 11556;

export interface RemoveStatus {
    phase: 'idle' | 'resolving-removed' | 'resolving-remaining' | 'diffing' | 'deleting' | 'committing' | 'done' | 'error';
    removedLine: string;
    removedIdCount: number;
    resolvedCount: number;
    resolvedTotal: number;
    wantedCount: number;
    localCount: number;
    orphanCount: number;
    deletedCount: number;
    skippedCount: number;
    error: string | null;
}

let currentRemove: RemoveStatus = {
    phase: 'idle',
    removedLine: '',
    removedIdCount: 0,
    resolvedCount: 0,
    resolvedTotal: 0,
    wantedCount: 0,
    localCount: 0,
    orphanCount: 0,
    deletedCount: 0,
    skippedCount: 0,
    error: null,
};

let removeRunning = false;

export function getRemoveStatus(): RemoveStatus {
    return { ...currentRemove };
}

function story(msg: string) {
    console.log(`[remove] ${msg}`);
}

function storyError(msg: string) {
    console.error(`[remove] ${msg}`);
}

function progress(msg: string) {
    socketService.emitLog(`[remove] ${msg}\n`);
}

function removeLineFromFile(filePath: string, line: string): string | null {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const target = line.trim();
    const idx = lines.findIndex(l => l.trim() === target);
    if (idx === -1) return null;
    lines.splice(idx, 1);
    fs.writeFileSync(filePath, lines.join('\n'));
    return content;
}

function restoreFile(filePath: string, originalContent: string) {
    fs.writeFileSync(filePath, originalContent);
}

function getLocalIds(): Set<number> {
    const ids = new Set<number>();
    if (fs.existsSync(INDEX_DB_PATH)) {
        const db = new Database(INDEX_DB_PATH, { readonly: true });
        db.pragma('journal_mode = WAL');
        const rows = db.prepare('SELECT gallery_id FROM galleries').all() as { gallery_id: number }[];
        for (const row of rows) ids.add(row.gallery_id);
        db.close();
    }
    return ids;
}

function requestDeletion(ids: number[]): Promise<{ deleted: number[]; skipped: { id: number; reason: string }[] }> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ ids });
        const req = https.request(
            {
                hostname: 'localhost',
                port: STREAMER_PORT,
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
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error(`Bad response from streamer: ${data}`));
                    }
                });
            },
        );
        req.on('error', (err) => reject(new Error(`Streamer connection failed: ${err.message}`)));
        req.write(body);
        req.end();
    });
}

function gitCommit(filePath: string, message: string): boolean {
    const repoRoot = path.resolve(filePath, '..', '..');
    try {
        execSync(`git add ${JSON.stringify(filePath)}`, { cwd: repoRoot, stdio: 'pipe' });
        execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: repoRoot, stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

function findArtistEntry(manifest: ReturnType<typeof loadManifest>, line: string): ArtistEntry | null {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return null;
    const ns = line.slice(0, colonIdx);
    const val = line.slice(colonIdx + 1);
    return manifest.artists.find(a => a.namespace === ns && a.value === val) ?? null;
}

async function resolveRemovedIds(
    file: 'artists' | 'queries',
    line: string,
    manifest: ReturnType<typeof loadManifest>,
): Promise<Set<number>> {
    if (file === 'artists') {
        const entry = findArtistEntry(manifest, line);
        if (!entry) return new Set();
        const result = await resolveArtistEntry(entry.namespace, entry.value, entry.language);
        return result.ids;
    } else {
        const result = await resolveQuery(line);
        return result.ids;
    }
}

async function resolveRemainingManifest(
    artistsPath: string,
    queriesPath: string,
): Promise<Set<number>> {
    const manifest = loadManifest(artistsPath, queriesPath);
    const totalEntries = manifest.artists.length + manifest.queries.length;
    currentRemove.resolvedTotal = totalEntries;

    const wantedIds = new Set<number>();

    for (const entry of manifest.artists) {
        const result = await resolveArtistEntry(entry.namespace, entry.value, entry.language);
        for (const id of result.ids) wantedIds.add(id);
        currentRemove.resolvedCount++;

        if (currentRemove.resolvedCount % 20 === 0) {
            progress(`Resolving: ${currentRemove.resolvedCount}/${totalEntries}`);
        }
    }

    for (const entry of manifest.queries) {
        const result = await resolveQuery(entry.raw);
        for (const id of result.ids) wantedIds.add(id);
        currentRemove.resolvedCount++;
        progress(`Resolved query ${currentRemove.resolvedCount}/${totalEntries}`);
    }

    return wantedIds;
}

export async function runRemove(
    file: 'artists' | 'queries',
    line: string,
    artistsPath: string,
    queriesPath: string,
): Promise<RemoveStatus> {
    if (removeRunning) {
        story('already running, skipping');
        return currentRemove;
    }

    removeRunning = true;

    const filePath = file === 'artists' ? artistsPath : queriesPath;
    const t0 = Date.now();

    currentRemove = {
        phase: 'resolving-removed',
        removedLine: line,
        removedIdCount: 0,
        resolvedCount: 0,
        resolvedTotal: 0,
        wantedCount: 0,
        localCount: 0,
        orphanCount: 0,
        deletedCount: 0,
        skippedCount: 0,
        error: null,
    };

    let originalContent: string | null = null;

    try {
        story(`started: ${line} from ${file}.txt`);

        const manifestBefore = loadManifest(artistsPath, queriesPath);
        const removedIds = await resolveRemovedIds(file, line, manifestBefore);
        currentRemove.removedIdCount = removedIds.size;
        story(`resolved removed entry: ${removedIds.size} IDs`);

        originalContent = removeLineFromFile(filePath, line);
        if (originalContent === null) {
            currentRemove.phase = 'error';
            currentRemove.error = `line not found in ${file}.txt: ${line}`;
            storyError(currentRemove.error);
            return currentRemove;
        }
        story(`removed line from ${file}.txt`);

        currentRemove.phase = 'resolving-remaining';
        const wantedIds = await resolveRemainingManifest(artistsPath, queriesPath);
        currentRemove.wantedCount = wantedIds.size;
        story(`resolved remaining manifest: ${wantedIds.size} still wanted`);

        currentRemove.phase = 'diffing';
        const localIds = getLocalIds();
        currentRemove.localCount = localIds.size;

        const orphans: number[] = [];
        for (const id of removedIds) {
            if (localIds.has(id) && !wantedIds.has(id)) {
                orphans.push(id);
            }
        }
        currentRemove.orphanCount = orphans.length;
        story(`orphans: ${orphans.length} (${removedIds.size} removed ∩ ${localIds.size} local - ${wantedIds.size} wanted)`);

        if (orphans.length > 0) {
            currentRemove.phase = 'deleting';
            const result = await requestDeletion(orphans);
            currentRemove.deletedCount = result.deleted.length;
            currentRemove.skippedCount = result.skipped.length;
            story(`deleted ${result.deleted.length}, skipped ${result.skipped.length}`);
            for (const s of result.skipped) {
                storyError(`skip ${s.id}: ${s.reason}`);
            }
        } else {
            story('no orphans to delete');
        }

        currentRemove.phase = 'committing';
        const commitMsg = `remove ${line} from ${file}.txt`;
        if (gitCommit(filePath, commitMsg)) {
            story(`committed: ${commitMsg}`);
        } else {
            storyError(`git commit failed: ${commitMsg}`);
        }

        currentRemove.phase = 'done';
        story(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return currentRemove;
    } catch (e) {
        currentRemove.phase = 'error';
        currentRemove.error = String(e);
        storyError(`failed: ${e}`);

        if (originalContent !== null) {
            restoreFile(filePath, originalContent);
            story('rolled back file change');
        }

        return currentRemove;
    } finally {
        removeRunning = false;
    }
}
