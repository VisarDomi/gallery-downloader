import Database from 'better-sqlite3';
import fs from 'fs';
import { loadManifest, type Filters } from './manifest.js';
import { requestDeletion } from './deletion-client.js';

const DIRECT_NAMESPACES = new Set(['type', 'language']);

export interface PolicyToken {
    namespace: string;
    value: string;
    raw: string;
}

export interface FilterPolicy {
    language: string;
    exclusions: PolicyToken[];
}

export type PolicyDecision =
    | { kind: 'allow' }
    | { kind: 'reject'; reason: string };

export type CleanupPhase = 'idle' | 'scanning' | 'deleting' | 'done' | 'error';

export interface PolicyCleanupStatus {
    phase: CleanupPhase;
    filterCount: number;
    violationCount: number;
    deletedCount: number;
    skippedCount: number;
    error: string | null;
}

export interface PolicyCleanupResult {
    kind: 'ok' | 'error';
    status: PolicyCleanupStatus;
}

let cleanupRunning = false;
let cleanupStatus: PolicyCleanupStatus = {
    phase: 'idle',
    filterCount: 0,
    violationCount: 0,
    deletedCount: 0,
    skippedCount: 0,
    error: null,
};

export function getPolicyCleanupStatus(): PolicyCleanupStatus {
    return { ...cleanupStatus };
}

function log(message: string) {
    console.log(`[policy-cleanup] ${message}`);
}

function normalizeValue(value: string): string {
    return value.trim().replace(/_/g, ' ').toLowerCase();
}

export function buildFilterPolicy(filters: Filters): FilterPolicy {
    const exclusions: PolicyToken[] = [];
    for (const negative of filters.negatives) {
        const colonIdx = negative.indexOf(':');
        if (colonIdx === -1) continue;

        const namespace = negative.slice(0, colonIdx).trim();
        const value = normalizeValue(negative.slice(colonIdx + 1));
        if (!namespace || !value) continue;

        exclusions.push({ namespace, value, raw: negative });
    }

    return {
        language: normalizeValue(filters.language),
        exclusions,
    };
}

function galleryHasToken(info: unknown, token: PolicyToken): boolean {
    const gallery = info as {
        type?: unknown;
        language?: unknown;
        artist?: unknown;
        group?: unknown;
        parody?: unknown;
        characters?: unknown;
        tags?: unknown;
    };

    const stringArray = (value: unknown): string[] => Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
    const hasValue = (values: string[]) => values.some((value) => normalizeValue(value) === token.value);

    switch (token.namespace) {
        case 'type':
            return typeof gallery.type === 'string' && normalizeValue(gallery.type) === token.value;
        case 'language':
            return typeof gallery.language === 'string' && normalizeValue(gallery.language) === token.value;
        case 'artist':
            return hasValue(stringArray(gallery.artist));
        case 'group':
            return hasValue(stringArray(gallery.group));
        case 'series':
            return hasValue(stringArray(gallery.parody));
        case 'character':
            return hasValue(stringArray(gallery.characters));
        case 'female':
        case 'male':
            return stringArray(gallery.tags).some((tag) => normalizeValue(tag) === `${token.namespace}:${token.value}`);
        case 'tag':
            return stringArray(gallery.tags).some((tag) => {
                const normalized = normalizeValue(tag);
                return !normalized.startsWith('female:')
                    && !normalized.startsWith('male:')
                    && normalized === token.value;
            });
        default:
            return false;
    }
}

export function validateGalleryInfo(info: unknown, policy: FilterPolicy): PolicyDecision {
    const language = (info as { language?: unknown }).language;
    if (typeof language === 'string' && normalizeValue(language) !== policy.language) {
        return { kind: 'reject', reason: `language "${language}" != "${policy.language}"` };
    }

    for (const token of policy.exclusions) {
        if (galleryHasToken(info, token)) {
            return { kind: 'reject', reason: `excluded by ${token.raw}` };
        }
    }

    return { kind: 'allow' };
}

function findPolicyViolations(indexDbPath: string, policy: FilterPolicy): number[] {
    if (!fs.existsSync(indexDbPath) || policy.exclusions.length === 0) return [];

    const clauses: string[] = [];
    const params: unknown[] = [];

    for (const token of policy.exclusions) {
        if (DIRECT_NAMESPACES.has(token.namespace)) {
            clauses.push(`LOWER(g.${token.namespace}) = ?`);
            params.push(token.value);
        } else {
            clauses.push(`EXISTS (
                SELECT 1 FROM tags t
                WHERE t.gallery_id = g.gallery_id
                    AND t.namespace = ?
                    AND LOWER(t.value) = ?
            )`);
            params.push(token.namespace, token.value);
        }
    }

    const db = new Database(indexDbPath, { readonly: true });
    try {
        db.pragma('journal_mode = WAL');
        const rows = db.prepare(`
            SELECT g.gallery_id
            FROM galleries g
            WHERE ${clauses.join(' OR ')}
            ORDER BY g.gallery_id
        `).all(...params) as { gallery_id: number }[];
        return rows.map((row) => row.gallery_id);
    } finally {
        db.close();
    }
}

export async function runPolicyCleanup(filtersPath: string, artistsPath: string, queriesPath: string, indexDbPath: string): Promise<PolicyCleanupResult> {
    if (cleanupRunning) {
        log('already running, skipping');
        return { kind: 'ok', status: getPolicyCleanupStatus() };
    }

    cleanupRunning = true;
    const t0 = Date.now();

    try {
        const policy = buildFilterPolicy(loadManifest(filtersPath, artistsPath, queriesPath).filters);
        cleanupStatus = {
            phase: 'scanning',
            filterCount: policy.exclusions.length,
            violationCount: 0,
            deletedCount: 0,
            skippedCount: 0,
            error: null,
        };

        log(`start filters=${policy.exclusions.length}`);
        const ids = findPolicyViolations(indexDbPath, policy);
        cleanupStatus.violationCount = ids.length;

        if (ids.length === 0) {
            cleanupStatus.phase = 'done';
            log(`done 0 violations, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            return { kind: 'ok', status: getPolicyCleanupStatus() };
        }

        cleanupStatus.phase = 'deleting';
        log(`deleting ${ids.length} policy violations`);
        const result = await requestDeletion(ids);
        cleanupStatus.deletedCount = result.deleted.length;
        cleanupStatus.skippedCount = result.skipped.length;
        for (const skipped of result.skipped) {
            log(`skip ${skipped.id}: ${skipped.reason}`);
        }

        cleanupStatus.phase = 'done';
        log(`done ${cleanupStatus.deletedCount} deleted, ${cleanupStatus.skippedCount} skipped, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return { kind: 'ok', status: getPolicyCleanupStatus() };
    } catch (e) {
        cleanupStatus.phase = 'error';
        cleanupStatus.error = String(e);
        log(`error ${String(e)}`);
        return { kind: 'error', status: getPolicyCleanupStatus() };
    } finally {
        cleanupRunning = false;
    }
}
