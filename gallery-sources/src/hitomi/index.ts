// Requires a fork of gallery-dl that adds thumbnail downloading for Hitomi:
// https://github.com/VisarDomi/gallery-dl (branch: hitomi-thumbnails)
// The changes are small and limited to the Hitomi extractor, so rebasing
// onto upstream gallery-dl should be straightforward.

import type { Source, Gallery } from '../types.js';

function checkMatch(g: Gallery, ns: string, val: string): boolean {
    const v = val.toLowerCase();

    switch (ns) {
        case 'type':
            return g.type?.toLowerCase() === v;
        case 'language':
            return g.language?.toLowerCase() === v;
        case 'artist':
            return !!g.artist?.some(x => x.toLowerCase() === v);
        case 'group':
            return !!g.group?.some(x => x.toLowerCase() === v);
        case 'series':
            return !!g.parody?.some(x => x.toLowerCase() === v);
        case 'character':
            return !!g.characters?.some(x => x.toLowerCase() === v);
        case 'female':
            return g.tags.some(t => t.startsWith('female:') && t.toLowerCase() === `female:${v}`);
        case 'male':
            return g.tags.some(t => t.startsWith('male:') && t.toLowerCase() === `male:${v}`);
        case 'tag':
            return g.tags.some(t => {
                if (t.startsWith('female:') || t.startsWith('male:')) return false;
                return t.toLowerCase() === v;
            });
        default:
            return false;
    }
}

export const hitomi: Source = {
    id: 'hitomi',
    name: 'Hitomi.la',
    url: 'https://hitomi.la',
    nsfw: true,
    gallerySubdir: 'gallery-dl/hitomi',
    galleryIdPattern: /^(\d+)$/,
    metadataFile: 'info.json',
    thumbnailMarker: '_thumb_',
    downloadingMarker: (id: string) => `.downloading-${id}`,
    searchNamespaces: [
        'type', 'language', 'tag', 'female', 'male',
        'artist', 'group', 'series', 'character',
    ],
    checkMatch,
    facetFields: ['language', 'artist', 'group'],
    download: {
        tool: 'gallery-dl',
        baseArgs: ['--write-info-json'],
        archivePath: (mediaRoot: string) => `${mediaRoot}/gallery-dl/hitomi.sqlite3`,
        parseIdFromUrl: (url: string) => {
            const match = url.match(/(\d+)\.html/);
            return match ? match[1] : null;
        },
    },
    toSourceUrl: (input: string) => {
        const trimmed = input.trim();
        if (/^https?:\/\//.test(trimmed)) return trimmed;
        if (/^\d+$/.test(trimmed)) return `https://hitomi.la/galleries/${trimmed}.html`;
        return `https://hitomi.la/search.html?${encodeURIComponent(trimmed)}`;
    },
};
