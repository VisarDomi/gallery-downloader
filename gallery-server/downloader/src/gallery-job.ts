export interface CandidateGallery {
    kind: 'candidate';
    id: number;
    url: string;
}

export interface AllowedGallery {
    kind: 'allowed';
    id: number;
    url: string;
    metadata: unknown;
}

export interface RejectedGallery {
    kind: 'rejected';
    id: number;
    url: string;
    reason: string;
    metadata?: unknown;
}

export type ClassifiedGallery = AllowedGallery | RejectedGallery;

export function candidateFromId(id: number): CandidateGallery {
    return {
        kind: 'candidate',
        id,
        url: `https://hitomi.la/galleries/${id}.html`,
    };
}
