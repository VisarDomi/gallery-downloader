import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { loadManifest } from './manifest.js';
import { resolveManifest, resolveEntryWithFilters } from './manifest-resolver.js';
import { CONFIG } from './config.js';
import { requestDeletion } from './deletion-client.js';

const INDEX_DB_PATH = path.join(CONFIG.WORKING_DIR, 'gallery-dl', 'gallery-index.db');

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
}

function logError(msg: string) {
    console.error(`[remove] ${msg}`);
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

export function gitCommit(filePath: string, message: string): boolean {
    const repoRoot = path.resolve(filePath, '..', '..');
    try {
        execSync(`git add ${JSON.stringify(filePath)}`, { cwd: repoRoot, stdio: 'pipe' });
        execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: repoRoot, stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

export async function runRemove(
    file: 'artists' | 'queries',
    line: string,
    filtersPath: string,
    artistsPath: string,
    queriesPath: string,
): Promise<RemoveStatus> {
    if (removeRunning) return currentRemove;

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
        log(`start ${line} from ${file}.txt`);

        // Resolve the removed entry's filtered IDs (same policy as sync)
        const manifestBefore = loadManifest(filtersPath, artistsPath, queriesPath);
        const removed = await resolveEntryWithFilters(manifestBefore, file, line);
        currentRemove.removedIdCount = removed.ids.size;

        // Remove line from file (save original for rollback)
        originalContent = removeLineFromFile(filePath, line);
        if (originalContent === null) {
            currentRemove.phase = 'error';
            currentRemove.error = `line not found in ${file}.txt: ${line}`;
            logError(currentRemove.error);
            return currentRemove;
        }

        // Resolve remaining manifest (with filters applied)
        currentRemove.phase = 'resolving-remaining';
        const remaining = await resolveManifest(filtersPath, artistsPath, queriesPath, {
            onArtistResolved: (resolved, total) => {
                currentRemove.resolvedTotal = total;
                currentRemove.resolvedCount = resolved;
            },
            onQueryResolved: (_resolved, _total, _queryIds, _totalIds) => {
                currentRemove.resolvedCount++;
            },
        });
        currentRemove.wantedCount = remaining.wantedIds.size;
        currentRemove.resolvedTotal = remaining.artistCount + remaining.queryCount;

        if (remaining.errors.length > 0) {
            restoreFile(filePath, originalContent);
            originalContent = null;
            currentRemove.phase = 'error';
            currentRemove.error = `${remaining.errors.length} resolution failures, aborting`;
            for (const e of remaining.errors) logError(e);
            logError('incomplete wanted set, rolled back file change');
            return currentRemove;
        }

        // Compute orphans: (removed IDs) ∩ (local) - (still wanted)
        currentRemove.phase = 'diffing';
        const localIds = getLocalIds();
        currentRemove.localCount = localIds.size;

        const orphans: number[] = [];
        for (const id of removed.ids) {
            if (localIds.has(id) && !remaining.wantedIds.has(id)) {
                orphans.push(id);
            }
        }
        currentRemove.orphanCount = orphans.length;

        if (orphans.length > 0) {
            currentRemove.phase = 'deleting';
            log(`deleting ${orphans.length} orphans`);
            const result = await requestDeletion(orphans);
            currentRemove.deletedCount = result.deleted.length;
            currentRemove.skippedCount = result.skipped.length;
            for (const s of result.skipped) {
                logError(`skip ${s.id}: ${s.reason}`);
            }
        }

        currentRemove.phase = 'committing';
        const commitMsg = `remove ${line} from ${file}.txt`;
        if (!gitCommit(filePath, commitMsg)) {
            logError(`git commit failed: ${commitMsg}`);
        }

        currentRemove.phase = 'done';
        log(`done ${currentRemove.deletedCount} deleted, ${currentRemove.skippedCount} skipped, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return currentRemove;
    } catch (e) {
        currentRemove.phase = 'error';
        currentRemove.error = String(e);
        logError(String(e));

        if (originalContent !== null) {
            restoreFile(filePath, originalContent);
            log('rolled back file change');
        }

        return currentRemove;
    } finally {
        removeRunning = false;
    }
}
