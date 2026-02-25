import { hitomi } from 'gallery-sources';
import type { Gallery } from './types.js';

interface SearchToken {
    negated: boolean;
    namespace?: string;
    value: string;
}

interface ParsedQuery {
    tokens: SearchToken[];
    freeText: string[];
}

export interface SearchResult {
    total: number;
    normalized: string;
    items: Gallery[];
}

const KNOWN_NAMESPACES = new Set(hitomi.searchNamespaces);

export function searchLibrary(library: Gallery[], rawQuery: string, limit: number, offset: number): SearchResult {
    const { tokens, freeText } = parseQuery(rawQuery);

    // Filter
    const filtered = library.filter(gallery => {
        // 1. Check Named Filters
        for (const token of tokens) {
            const isMatch = hitomi.checkMatch(gallery, token.namespace!, token.value);
            if (token.negated && isMatch) return false;
            if (!token.negated && !isMatch) return false;
        }

        // 2. Check Free Text (if any)
        if (freeText.length > 0) {
            const searchText = freeText.join(' ').toLowerCase();
            const titleMatch = gallery.title.toLowerCase().includes(searchText);
            const jpnMatch = gallery.title_jpn?.toLowerCase().includes(searchText) || false;

            if (!titleMatch && !jpnMatch) return false;
        }

        return true;
    });

    // Construct Normalized String
    const normalizedParts: string[] = [];
    tokens.forEach(t => {
        const prefix = t.negated ? '-' : '';
        normalizedParts.push(`${prefix}${t.namespace}:${t.value}`);
    });
    if (freeText.length > 0) {
        normalizedParts.push(freeText.join(' '));
    }

    return {
        total: filtered.length,
        normalized: normalizedParts.join(' '),
        items: filtered.slice(offset, offset + limit)
    };
}

function parseQuery(query: string): ParsedQuery {
    const parts = query.trim().split(/\s+/).filter(p => p.length > 0);
    const tokens: SearchToken[] = [];
    const freeText: string[] = [];

    for (const part of parts) {
        // Check for negation
        let cleanPart = part;
        let negated = false;
        if (cleanPart.startsWith('-')) {
            negated = true;
            cleanPart = cleanPart.substring(1);
        }

        // Check for namespace
        if (cleanPart.includes(':')) {
            const [ns, ...valParts] = cleanPart.split(':');
            const val = valParts.join(':'); // Re-join in case value has colons

            if (KNOWN_NAMESPACES.has(ns)) {
                // Normalize value: replace underscores with spaces
                const normalizedVal = val.replace(/_/g, ' ');
                tokens.push({ negated, namespace: ns, value: normalizedVal });
                continue;
            }
        }

        // Fallback to free text (negation on free text is not standard per spec but we handle it as text)
        // Per spec: "leftover search term should search title"
        // We assume free text cannot be negated in this simple implementation logic unless specified
        if (!negated) {
            freeText.push(part); // Keep original spacing logic for free text parts
        }
    }

    return { tokens, freeText };
}
