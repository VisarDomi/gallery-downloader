import type { ViewMode } from '../types.js';
import { getJson, setJson, remove } from '../services/storage.js';

const SESSION_KEY = 'session';

export interface SessionSnapshot {
    viewMode: ViewMode;
    viewStack: ViewMode[];
    activeGalleryId?: number;
    activeGalleryPage?: number;
    searchQuery?: string;
    searchPage?: number;
}

export function saveSession(snapshot: SessionSnapshot): void {
    setJson(SESSION_KEY, snapshot);
}

export function loadSession(): SessionSnapshot | null {
    return getJson<SessionSnapshot | null>(SESSION_KEY, null);
}

export function clearSession(): void {
    remove(SESSION_KEY);
}
