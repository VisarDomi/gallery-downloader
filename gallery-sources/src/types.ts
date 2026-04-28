export interface ImageDimension {
    width: number;
    height: number;
}

export interface Gallery {
    // Pure info.json fields
    gallery_id: number;
    title: string;
    title_jpn: string;
    type: string;
    language: string;
    lang: string;
    date: string;
    tags: string[];
    artist: string[];
    group: string[];
    parody: string[];
    characters: string[];
    count: number;
    category: string;
    subcategory: string;

    // Filesystem fields
    files: string[];
    fullFiles: string[];
    thumbnailFiles: string[];
    dimensions: ImageDimension[];
    path: string;
}

export interface Source {
    id: string;
    name: string;
    url: string;
    nsfw: boolean;
    gallerySubdir: string;
    galleryIdPattern: RegExp;
    metadataFile: string;
    thumbnailMarker: string;
    downloadingMarker: (id: string) => string;
    searchNamespaces: string[];
    checkMatch: (gallery: Gallery, namespace: string, value: string) => boolean;
    facetFields: string[];
    download: {
        tool: string;
        baseArgs: string[];
        archivePath: (mediaRoot: string) => string;
        parseIdFromUrl: (url: string) => string | null;
    };
    toSourceUrl: (input: string) => string;
}
