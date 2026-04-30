import https from 'https';

export interface HitomiGalleryInfo {
    id: string;
    title?: string;
    japanese_title?: string;
    type?: string;
    language?: string;
    date?: string;
    tags?: string[];
    artist?: string[];
    group?: string[];
    parody?: string[];
    characters?: string[];
}

interface RawHitomiGalleryInfo {
    id?: unknown;
    title?: unknown;
    japanese_title?: unknown;
    type?: unknown;
    language?: unknown;
    date?: unknown;
    tags?: unknown;
    artists?: unknown;
    groups?: unknown;
    parodys?: unknown;
    characters?: unknown;
}

export type MetadataResult =
    | { kind: 'ok'; info: HitomiGalleryInfo }
    | { kind: 'error'; error: string };

const DOMAIN = 'gold-usergeneratedcontent.net';
const ORIGIN = 'https://hitomi.la';

function fetchText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request({
            hostname: parsed.hostname,
            path: parsed.pathname,
            method: 'GET',
            headers: {
                'Origin': ORIGIN,
                'Referer': `${ORIGIN}/`,
            },
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode ?? 'unknown'} for ${url}`));
                return;
            }

            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30_000, () => {
            req.destroy(new Error(`Timeout fetching ${url}`));
        });
        req.end();
    });
}

function stringArrayFromObjects(value: unknown, key: string): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const raw = (item as Record<string, unknown>)[key];
        if (typeof raw === 'string') out.push(raw);
    }
    return out;
}

function tagsFromRaw(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as Record<string, unknown>;
        const tag = raw.tag;
        if (typeof tag !== 'string') continue;
        if (raw.female) {
            out.push(`female:${tag}`);
        } else if (raw.male) {
            out.push(`male:${tag}`);
        } else {
            out.push(tag);
        }
    }
    return out;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function parseGalleryInfo(page: string): HitomiGalleryInfo {
    const json = page.slice(page.indexOf('=') + 1).trim().replace(/;$/, '');
    const raw = JSON.parse(json) as RawHitomiGalleryInfo;
    const id = typeof raw.id === 'number' || typeof raw.id === 'string' ? String(raw.id) : '';

    return {
        id,
        title: stringValue(raw.title),
        japanese_title: stringValue(raw.japanese_title),
        type: stringValue(raw.type),
        language: stringValue(raw.language),
        date: stringValue(raw.date),
        tags: tagsFromRaw(raw.tags),
        artist: stringArrayFromObjects(raw.artists, 'artist'),
        group: stringArrayFromObjects(raw.groups, 'group'),
        parody: stringArrayFromObjects(raw.parodys, 'parody'),
        characters: stringArrayFromObjects(raw.characters, 'character'),
    };
}

export async function fetchHitomiGalleryInfo(id: number): Promise<MetadataResult> {
    const url = `https://ltn.${DOMAIN}/galleries/${id}.js`;
    try {
        return { kind: 'ok', info: parseGalleryInfo(await fetchText(url)) };
    } catch (error) {
        return { kind: 'error', error: error instanceof Error ? error.message : String(error) };
    }
}
