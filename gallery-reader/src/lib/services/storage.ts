export function getJson<T>(key: string, fallback: T): T {
    if (typeof localStorage === 'undefined') return fallback;
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

export function setJson(key: string, value: unknown): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // storage full or unavailable
    }
}

export function remove(key: string): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
}
