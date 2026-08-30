export interface Source {
    id: SourceId;
    gallerySubdir: string;
    metadataFile: string;
    downloadingMarker: (id: string) => string;
    download: {
        baseArgs: string[];
        archivePath: (mediaRoot: string) => string;
        parseIdFromUrl: (url: string) => string | null;
    };
    toSourceUrl: (input: string) => string;
}

export type SourceId = 'hitomi' | 'imhentai';
