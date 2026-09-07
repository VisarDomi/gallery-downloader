// Small IndexedDB records only: catalog, per-gallery checkpoint, and manifests.
// No image blobs, OPFS handles, page-by-page database rows, or startup file scans.
export function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('gallery-offline-test-v1', 1);
        request.onupgradeneeded = () => {
            for (const name of ['kv', 'downloads', 'manifests']) request.result.createObjectStore(name);
        };
        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Database is blocked by another open app window. Close it and retry.'));
    });
}

export function record(db, store, method, ...args) {
    return new Promise((resolve, reject) => {
        const write = ['put', 'delete'].includes(method);
        const tx = db.transaction(store, write ? 'readwrite' : 'readonly');
        const request = tx.objectStore(store)[method](...args);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error || request.error || new Error('Storage transaction aborted'));
        tx.onerror = () => {}; // onabort is the final result, not request.onsuccess.
    });
}

export const stateKey = manifest => manifest.kind === 'thumbnails' ? `${manifest.key}:thumbs` : manifest.key;
export const versionKey = manifest => `${stateKey(manifest)}-${manifest.revision}`;
export const packName = manifest => `${manifest.key}-${manifest.revision}.${manifest.kind === 'thumbnails' ? 'thumbs' : 'pages'}`;

export function validateManifest(manifest, expectedKey) {
    if (manifest.key !== expectedKey || !/^(hitomi|imhentai)-[1-9]\d*$/.test(manifest.key)
        || !/^[a-f0-9]{24}$/.test(manifest.revision) || !Array.isArray(manifest.pages) || !manifest.pages.length) {
        throw new Error('Invalid gallery manifest');
    }
    if (manifest.kind && manifest.kind !== 'thumbnails') throw new Error('Invalid manifest kind');
    const [provider, id] = expectedKey.split('-');
    const kind = manifest.kind === 'thumbnails' ? 'thumbnails' : 'pages';
    const filename = `${provider}_${id}_${kind === 'thumbnails' ? 'thumb_' : ''}\\d+\\.(?:avif|gif|jpe?g|png|webp)`;
    const urlPattern = new RegExp(`^/offline-api/${provider}/${id}/${kind}/${filename}$`, 'i');
    let offset = 0;
    for (const page of manifest.pages) {
        if (!Number.isSafeInteger(page.size) || page.size <= 0 || page.offset !== offset
            || !urlPattern.test(page.url)) {
            throw new Error('Invalid page manifest');
        }
        offset += page.size;
    }
    if (!Number.isSafeInteger(offset) || offset !== manifest.bytes) throw new Error('Invalid gallery size');
    return manifest;
}

export function freshState(manifest) {
    return { key: stateKey(manifest), kind: manifest.kind, revision: manifest.revision, downloaded: 0, bytes: 0,
        total: manifest.pages.length, totalBytes: manifest.bytes, complete: false };
}

export function recoverCheckpoint(manifest, saved, fileSize) {
    if (!saved || saved.revision !== manifest.revision || !Number.isInteger(saved.downloaded)
        || saved.downloaded < 0 || saved.downloaded > manifest.pages.length) return freshState(manifest);
    const expected = saved.downloaded === manifest.pages.length ? manifest.bytes : manifest.pages[saved.downloaded].offset;
    if (saved.bytes !== expected || fileSize < expected) return freshState(manifest);
    return { ...saved, total: manifest.pages.length, totalBytes: manifest.bytes,
        complete: saved.downloaded === manifest.pages.length, error: undefined };
}

export async function appendPage(access, response, page, signal) {
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/') || !response.body) {
        throw new Error(`Page download failed (HTTP ${response.status})`);
    }
    const reader = response.body.getReader();
    let received = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            if (received + value.byteLength > page.size) throw new Error('Page is larger than its manifest');
            let written = 0;
            while (written < value.byteLength) {
                const n = access.write(value.subarray(written), { at: page.offset + received + written });
                if (!n) throw new Error('OPFS write made no progress');
                written += n;
            }
            received += value.byteLength;
        }
        signal.throwIfAborted();
        if (received !== page.size) throw new Error('Page download was truncated');
        // Flush bytes BEFORE committing the IndexedDB checkpoint. A crash can
        // leave extra bytes, never a checkpoint knowingly ahead of the write.
        access.flush();
    } finally { await reader.cancel().catch(() => {}); }
}
