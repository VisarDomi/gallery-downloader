export const SEARCH_NAMESPACES = [
    'type',
    'language',
    'tag',
    'female',
    'male',
    'artist',
    'group',
    'series',
    'character',
] as const;

export type SearchNamespace = typeof SEARCH_NAMESPACES[number];

export interface SearchToken {
    namespace: SearchNamespace;
    value: string;
    negated: boolean;
}

const SEARCH_NAMESPACE_SET = new Set<string>(SEARCH_NAMESPACES);
const MARKER_PATTERN = new RegExp(
    `(^|\\s)(-?)(${SEARCH_NAMESPACES.join('|')}):`,
    'gi',
);

export function normalizeSearchValue(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isSearchNamespace(value: string): value is SearchNamespace {
    return SEARCH_NAMESPACE_SET.has(value);
}

export function parseTaggedQuery(rawQuery: string): SearchToken[] {
    const raw = rawQuery.trim();
    if (!raw) return [];

    const markers = Array.from(raw.matchAll(MARKER_PATTERN));
    if (markers.length === 0) {
        throw new Error('Search must use namespace:value tokens');
    }

    const prefix = raw.slice(0, markers[0].index).trim();
    if (prefix) {
        throw new Error(`Invalid text before first token: ${prefix}`);
    }

    const tokens: SearchToken[] = [];
    for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        const markerIndex = marker.index;
        if (markerIndex === undefined) {
            throw new Error('Invalid query token');
        }

        const leading = marker[1] ?? '';
        const tokenStart = markerIndex + leading.length;
        const valueStart = tokenStart + marker[0].length - leading.length;
        const valueEnd = i + 1 < markers.length ? markers[i + 1].index : raw.length;
        if (valueEnd === undefined) {
            throw new Error('Invalid query token');
        }

        const namespace = marker[3].toLowerCase();
        if (!isSearchNamespace(namespace)) {
            throw new Error(`Unknown namespace: ${namespace}`);
        }

        const value = normalizeSearchValue(raw.slice(valueStart, valueEnd));
        if (!value) {
            throw new Error(`Missing value for ${namespace}:`);
        }
        const unknownMarker = value.match(/(^|\s)-?([a-z][a-z0-9_-]*):/i);
        if (unknownMarker && !isSearchNamespace(unknownMarker[2].toLowerCase())) {
            throw new Error(`Unknown namespace: ${unknownMarker[2].toLowerCase()}`);
        }

        tokens.push({
            namespace,
            value,
            negated: marker[2] === '-',
        });
    }

    return tokens;
}

export function serializeTaggedQuery(tokens: SearchToken[]): string {
    return tokens
        .map((token) => `${token.negated ? '-' : ''}${token.namespace}:${token.value}`)
        .join(' ');
}

export function normalizeTaggedQuery(rawQuery: string): string {
    return serializeTaggedQuery(parseTaggedQuery(rawQuery));
}

export function tokenToQuery(namespace: SearchNamespace, value: string, negated = false): string {
    const normalizedValue = normalizeSearchValue(value);
    if (!normalizedValue) {
        throw new Error(`Missing value for ${namespace}:`);
    }
    return serializeTaggedQuery([{ namespace, value: normalizedValue, negated }]);
}
