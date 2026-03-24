/**
 * Remove orchestrator: removes a manifest entry and deletes orphaned galleries.
 *
 * Owns: manifest parsing, resolution, orphan computation, file mutation, git commit.
 * Delegates: gallery deletion to the streamer (single owner of gallery state on disk).
 *
 * See /decisions.md for architectural rationale.
 */

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

function log(msg: string) {
    console.log(`[remove] ${msg}`);
    socketService.emitLog(`[remove] ${msg}\n`);
}

// -- File manipulation --

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

// -- Read-only DB access (same pattern as diff.ts) --

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

// -- Delegation: call streamer's POST /api/delete --

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

// -- Git --

function gitCommit(filePath: string, message: string) {
    const repoRoot = path.resolve(filePath, '..', '..');
    try {
        execSync(`git add ${JSON.stringify(filePath)}`, { cwd: repoRoot, stdio: 'pipe' });
        execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: repoRoot, stdio: 'pipe' });
        log(`Committed: ${message}`);
    } catch (e) {
        log(`Git commit failed: ${e}`);
    }
}

// -- Entry resolution helpers --

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
            log(`Resolving: ${currentRemove.resolvedCount}/${totalEntries}`);
        }
    }

    for (const entry of manifest.queries) {
        const result = await resolveQuery(entry.raw);
        for (const id of result.ids) wantedIds.add(id);
        currentRemove.resolvedCount++;
        log(`Resolved query ${currentRemove.resolvedCount}/${totalEntries}`);
    }

    return wantedIds;
}

// -- Main orchestrator --

export async function runRemove(
    file: 'artists' | 'queries',
    line: string,
    artistsPath: string,
    queriesPath: string,
): Promise<RemoveStatus> {
    if (removeRunning) {
        log('Remove already running, skipping.');
        return currentRemove;
    }

    removeRunning = true;

    const filePath = file === 'artists' ? artistsPath : queriesPath;

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
        // Step 1: Resolve the entry being removed (before modifying the file)
        const manifestBefore = loadManifest(artistsPath, queriesPath);
        const removedIds = await resolveRemovedIds(file, line, manifestBefore);
        currentRemove.removedIdCount = removedIds.size;
        log(`Resolved removed entry "${line}": ${removedIds.size} gallery IDs`);

        // Step 2: Remove the line from the file
        originalContent = removeLineFromFile(filePath, line);
        if (originalContent === null) {
            currentRemove.phase = 'error';
            currentRemove.error = `Line not found in ${file}.txt: ${line}`;
            log(currentRemove.error);
            return currentRemove;
        }
        log(`Removed "${line}" from ${file}.txt`);

        // Step 3: Re-resolve the remaining manifest
        currentRemove.phase = 'resolving-remaining';
        const wantedIds = await resolveRemainingManifest(artistsPath, queriesPath);
        currentRemove.wantedCount = wantedIds.size;
        log(`Still wanted: ${wantedIds.size} IDs`);

        // Step 4: Compute orphans = (removed IDs) ∩ (local IDs) - (still wanted IDs)
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
        log(`Orphans: ${orphans.length} (from ${removedIds.size} removed, ${localIds.size} local, ${wantedIds.size} still wanted)`);

        // Step 5: Delegate deletion to the streamer
        if (orphans.length > 0) {
            currentRemove.phase = 'deleting';
            const result = await requestDeletion(orphans);
            currentRemove.deletedCount = result.deleted.length;
            currentRemove.skippedCount = result.skipped.length;
            log(`Deleted ${result.deleted.length}, skipped ${result.skipped.length}`);
            if (result.skipped.length > 0) {
                for (const s of result.skipped) {
                    log(`  skipped ${s.id}: ${s.reason}`);
                }
            }
        }

        // Step 6: Git commit
        currentRemove.phase = 'committing';
        gitCommit(filePath, `remove ${line} from ${file}.txt`);

        currentRemove.phase = 'done';
        log('Remove complete');
        return currentRemove;
    } catch (e) {
        currentRemove.phase = 'error';
        currentRemove.error = String(e);
        log(`Remove failed: ${e}`);

        if (originalContent !== null) {
            restoreFile(filePath, originalContent);
            log('Rolled back file change');
        }

        return currentRemove;
    } finally {
        removeRunning = false;
    }
}
