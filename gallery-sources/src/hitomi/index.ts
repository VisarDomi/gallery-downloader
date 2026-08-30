import type { Source } from '../types.js';

export const hitomi: Source = {
    id: 'hitomi',
    gallerySubdir: 'gallery-dl/hitomi',
    metadataFile: 'info.json',
    downloadingMarker: (id: string) => `.downloading-${id}`,
    download: {
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
        throw new Error(`Expected a Hitomi gallery ID or URL: ${trimmed}`);
    },
};
