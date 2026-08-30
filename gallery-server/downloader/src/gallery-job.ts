export interface CandidateGallery {
    url: string;
}

export function candidateFromId(provider: 'hitomi' | 'imhentai', id: number): CandidateGallery {
    return {
        url: provider === 'hitomi'
            ? `https://hitomi.la/galleries/${id}.html`
            : `https://imhentai.xxx/gallery/${id}/`,
    };
}
