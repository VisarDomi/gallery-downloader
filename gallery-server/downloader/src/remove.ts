import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { loadManifest } from './manifest.js';
import { CONFIG } from './config.js';
import { requestDeletion } from './deletion-client.js';
import { planLocalRemove } from './local-manifest.js';

const INDEX_DB_PATH = path.join(CONFIG.WORKING_DIR, 'gallery-dl', 'gallery-index.db');

export interface RemoveStatus {
    phase: 'idle' | 'removing-line' | 'planning' | 'deleting' | 'committing' | 'done' | 'error';
    removedLine: string;
    candidateCount: number;
    retainedCount: number;
    localCount: number;
    orphanCount: number;
    deletedCount: number;
    deleteSkippedCount: number;
    error: string | null;
}

let currentRemove: RemoveStatus = {
    phase: 'idle',
    removedLine: '',
    candidateCount: 0,
    retainedCount: 0,
    localCount: 0,
    orphanCount: 0,
    deletedCount: 0,
    deleteSkippedCount: 0,
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
        phase: 'removing-line',
        removedLine: line,
        candidateCount: 0,
        retainedCount: 0,
        localCount: 0,
        orphanCount: 0,
        deletedCount: 0,
        deleteSkippedCount: 0,
        error: null,
    };

    let originalContent: string | null = null;

    try {
        log(`start ${line} from ${file}.txt`);

        // Remove line from file (save original for rollback)
        originalContent = removeLineFromFile(filePath, line);
        if (originalContent === null) {
            currentRemove.phase = 'error';
            currentRemove.error = `line not found in ${file}.txt: ${line}`;
            logError(currentRemove.error);
            return currentRemove;
        }
        log(`removed line from ${file}.txt: ${line}`);

        currentRemove.phase = 'planning';
        const manifestAfterRemoval = loadManifest(filtersPath, artistsPath, queriesPath);
        const plan = planLocalRemove(INDEX_DB_PATH, manifestAfterRemoval, file, line);
        currentRemove.localCount = plan.localCount;
        currentRemove.candidateCount = plan.candidateIds.length;
        currentRemove.retainedCount = plan.retainedIds.length;
        currentRemove.orphanCount = plan.orphanIds.length;
        log(`planned local remove: ${plan.candidateIds.length} candidates, ${plan.retainedIds.length} retained, ${plan.orphanIds.length} orphans`);

        if (plan.orphanIds.length > 0) {
            currentRemove.phase = 'deleting';
            log(`deleting ${plan.orphanIds.length} orphans`);
            const result = await requestDeletion(plan.orphanIds);
            currentRemove.deletedCount = result.deleted.length;
            currentRemove.deleteSkippedCount = result.skipped.length;
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
        log(`done ${currentRemove.deletedCount} deleted, ${currentRemove.deleteSkippedCount} delete-skipped, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
