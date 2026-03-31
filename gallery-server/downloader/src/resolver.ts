/**
 * Resolver: fetches gallery IDs from hitomi's nozomi API.
 *
 * Pure function: (tags) → Set<number>. No side effects, no DB access.
 * Only reads from hitomi's CDN.
 *
 * Nozomi format: array of big-endian 32-bit unsigned integers.
 * URL pattern: https://ltn.{DOMAIN}/n/{ns}/{tag}-{language}.nozomi
 */

import https from 'https';
import { URL } from 'url';

const DOMAIN = 'gold-usergeneratedcontent.net';
const ORIGIN = 'https://hitomi.la';

function decodeNozomi(buffer: Buffer): Set<number> {
    const ids = new Set<number>();
    for (let i = 0; i + 3 < buffer.length; i += 4) {
        ids.add(buffer.readUInt32BE(i));
    }
    return ids;
}

function buildNozomiUrl(query: string, language: string): string {
    const colonIdx = query.indexOf(':');
    if (colonIdx === -1) throw new Error(`Invalid query token: ${query}`);

    const ns = query.slice(0, colonIdx);
    const tag = query.slice(colonIdx + 1).replace(/_/g, ' ');

    if (ns === 'language') {
        return `https://ltn.${DOMAIN}/n/${encodeURIComponent('index')}-${encodeURIComponent(tag)}.nozomi`;
    }

    // female: and male: tags live under tag/ with the full prefix
    if (ns === 'female' || ns === 'male') {
        const fullTag = `${ns}:${tag}`;
        return `https://ltn.${DOMAIN}/n/tag/${encodeURIComponent(fullTag)}-${encodeURIComponent(language)}.nozomi`;
    }

    // tag: namespace also lives under tag/
    if (ns === 'tag') {
        return `https://ltn.${DOMAIN}/n/tag/${encodeURIComponent(tag)}-${encodeURIComponent(language)}.nozomi`;
    }

    // artist, group, series, character, type
    return `https://ltn.${DOMAIN}/n/${ns}/${encodeURIComponent(tag)}-${encodeURIComponent(language)}.nozomi`;
}

function fetchNozomi(url: string): Promise<Set<number>> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request({
            hostname: parsed.hostname,
            path: parsed.pathname,
            method: 'GET',
            headers: {
                'Origin': ORIGIN,
                'Referer': ORIGIN + '/',
            },
        }, (res) => {
            if (res.statusCode === 404) {
                // Tag doesn't exist on hitomi — empty set, not an error
                resolve(new Set());
                res.resume();
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(decodeNozomi(Buffer.concat(chunks))));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30_000, () => {
            req.destroy(new Error(`Timeout fetching ${url}`));
        });
        req.end();
    });
}

/** Small delay between requests to avoid hammering hitomi */
function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

export interface ResolveResult {
    ids: Set<number>;
    errors: string[];
}

/**
 * Fetch the ID set for a single tag token (e.g. "tag:anthology") in a language.
 */
export async function resolveTag(token: string, language: string): Promise<ResolveResult> {
    const url = buildNozomiUrl(token, language);
    const errors: string[] = [];
    try {
        const ids = await fetchNozomi(url);
        return { ids, errors };
    } catch (e) {
        errors.push(`${token}: ${e instanceof Error ? e.message : String(e)}`);
        return { ids: new Set(), errors };
    }
}

/**
 * Resolve a single artist/group entry from artists.txt.
 * Returns all gallery IDs for that entry on hitomi.
 */
export async function resolveArtistEntry(
    namespace: string,
    value: string,
    language: string,
): Promise<ResolveResult> {
    const query = `${namespace}:${value}`;
    const url = buildNozomiUrl(query, language);
    const errors: string[] = [];
    try {
        const ids = await fetchNozomi(url);
        return { ids, errors };
    } catch (e) {
        errors.push(`${query}: ${e instanceof Error ? e.message : String(e)}`);
        return { ids: new Set(), errors };
    }
}

/**
 * Resolve a full search query (like queries.txt lines).
 * Positive tokens are intersected, negative tokens are subtracted.
 */
export async function resolveQuery(queryLine: string): Promise<ResolveResult> {
    const tokens = queryLine.trim().split(/\s+/).filter(t => t.length > 0);
    const positive: string[] = [];
    const negative: string[] = [];

    for (const t of tokens) {
        if (t.startsWith('-')) {
            negative.push(t.slice(1));
        } else {
            positive.push(t);
        }
    }

    // Determine language from positive tokens (default: "all")
    let language = 'all';
    const nonLangPositive: string[] = [];
    for (const t of positive) {
        if (t.startsWith('language:')) {
            language = t.slice('language:'.length).replace(/_/g, ' ');
        } else {
            nonLangPositive.push(t);
        }
    }

    const errors: string[] = [];

    // Start with the language set if specified, otherwise all
    let result: Set<number> | null = null;

    if (language !== 'all') {
        const url = buildNozomiUrl(`language:${language}`, language);
        try {
            result = await fetchNozomi(url);
        } catch (e) {
            errors.push(`language:${language}: ${e instanceof Error ? e.message : String(e)}`);
            return { ids: new Set(), errors };
        }
        await delay(100);
    }

    // Intersect positive (non-language) tokens
    for (const tag of nonLangPositive) {
        const url = buildNozomiUrl(tag, language);
        try {
            const ids = await fetchNozomi(url);
            if (result === null) {
                result = ids;
            } else {
                // Intersect in place
                for (const id of result) {
                    if (!ids.has(id)) result.delete(id);
                }
            }
        } catch (e) {
            errors.push(`${tag}: ${e instanceof Error ? e.message : String(e)}`);
        }
        await delay(100);
    }

    if (result === null) {
        return { ids: new Set(), errors };
    }

    // Subtract negative tokens
    for (const tag of negative) {
        const url = buildNozomiUrl(tag, language);
        try {
            const ids = await fetchNozomi(url);
            for (const id of ids) {
                result.delete(id);
            }
        } catch (e) {
            errors.push(`-${tag}: ${e instanceof Error ? e.message : String(e)}`);
        }
        await delay(100);
    }

    return { ids: result, errors };
}
