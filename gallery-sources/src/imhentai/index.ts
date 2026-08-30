import type { Source } from '../types.js';

export const imhentai: Source = {
    id: 'imhentai',
    gallerySubdir: 'gallery-dl/imhentai',
    metadataFile: 'info.json',
    downloadingMarker: (id: string) => `.downloading-${id}`,
    download: {
        baseArgs: [],
        archivePath: (mediaRoot: string) => `${mediaRoot}/gallery-dl/imhentai.sqlite3`,
        parseIdFromUrl: (url: string) => {
            const match = url.match(/imhentai\.xxx\/(?:gallery|view)\/(\d+)/i);
            return match ? match[1] : null;
        },
    },
    toSourceUrl: (input: string) => {
        const trimmed = input.trim();
        if (/^https?:\/\//.test(trimmed)) return trimmed;
        if (/^\d+$/.test(trimmed)) return `https://imhentai.xxx/gallery/${trimmed}/`;
        throw new Error(`Expected an IMHentai gallery ID or URL: ${trimmed}`);
    },
};
