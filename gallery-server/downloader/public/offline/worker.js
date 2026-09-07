import { openDatabase, record, stateKey, versionKey, packName, validateManifest, recoverCheckpoint, appendPage } from './storage.js';

let db, rootPromise, catalog = { items: [] }, running, controller, readerFile, readerManifest, readerState;
let readerGeneration = 0;
let thumbnailRootPromise;
const previews = new Map();
async function thumbnailRoot() {
    // Separate from the multi-GB original packs. Open only for visible previews
    // after the catalog has rendered, never during worker init.
    return thumbnailRootPromise ??= navigator.storage.getDirectory()
        .then(root => root.getDirectoryHandle('gallery-offline-thumbnails-v1', { create: true }))
        .catch(error => { thumbnailRootPromise = undefined; throw error; });
}
const emit = (type, data) => postMessage({ type, ...data });
const timing = (label, since) => emit('timing', { label, ms: Math.round(performance.now() - since) });
const reason = error => error?.name === 'QuotaExceededError'
    ? 'Device storage quota reached. Saved pages are retained. Free space, then Resume.'
    : String(error?.message || error);

async function opfs() {
    if (!rootPromise) {
        const start = performance.now();
        emit('timing', { label: 'OPFS opening (only after your action)', ms: null });
        rootPromise = navigator.storage.getDirectory().then(root => root.getDirectoryHandle('gallery-offline-test-v1', { create: true }))
            .then(root => { timing('OPFS opened', start); return root; })
            .catch(error => { rootPromise = undefined; throw error; });
    }
    return rootPromise;
}

async function json(url, signal) {
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(url, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`PC request failed (HTTP ${response.status})`);
    return response.json();
}

async function refresh() {
    try {
        const next = await json('/offline-api/catalog', AbortSignal.timeout(15000));
        if (next.version !== 1 || !Array.isArray(next.items)) throw new Error('Invalid favorites catalog');
        await record(db, 'kv', 'put', next, 'catalog');
        catalog = next;
        emit('catalog', { catalog, source: 'PC' });
    } catch (error) {
        emit('notice', { message: catalog.items.length ? 'PC unavailable. Using the saved favorites list.' : `Open once on your home network to load favorites. ${reason(error)}` });
    }
}

async function init() {
    const start = performance.now();
    emit('timing', { label: 'Small catalog database opening', ms: null });
    db = await openDatabase();
    timing('Catalog database opened', start);
    const [cached, downloads] = await Promise.all([record(db, 'kv', 'get', 'catalog'), record(db, 'downloads', 'getAll')]);
    catalog = cached || { items: [] };
    emit('catalog', { catalog, downloads, source: 'device' });
    timing('Local catalog read (no image storage)', start);
    void refresh();
    return { supported: !!navigator.storage?.getDirectory && !!navigator.locks };
}

async function stop() {
    controller?.abort();
    await running;
}

async function details(item, signal) {
    const manifest = validateManifest(await json(`/offline-api/${item.provider}/${item.id}/manifest`, signal), item.key);
    await record(db, 'manifests', 'put', manifest, versionKey(manifest));
    await record(db, 'manifests', 'put', manifest, `details-${item.key}`);
    return manifest;
}

async function downloadGallery(item, signal, thumbnails = false) {
    const full = thumbnails ? await details(item, signal)
        : await record(db, 'manifests', 'get', `details-${item.key}`) || await details(item, signal);
    if (thumbnails && !full.thumbnails) throw new Error('Source thumbnails are not complete on the PC yet');
    const manifest = validateManifest(thumbnails ? full.thumbnails : full, item.key);
    const key = stateKey(manifest);
    const root = thumbnails ? await thumbnailRoot() : await opfs();
    const file = await root.getFileHandle(packName(manifest), { create: true });
    if (!file.createSyncAccessHandle) throw new Error('This browser does not support OPFS synchronous handles in workers. Use Safari on the iPhone.');
    const access = await file.createSyncAccessHandle();
    let state;
    try {
        state = recoverCheckpoint(manifest, await record(db, 'downloads', 'get', key), access.getSize());
        // Discard only the uncommitted tail of this app-owned partial download.
        access.truncate(state.bytes);
        access.flush();
        await record(db, 'manifests', 'put', manifest, versionKey(manifest));
        await record(db, 'downloads', 'put', state, key);
        emit('progress', { state });
        for (let index = state.downloaded; index < manifest.pages.length; index++) {
            signal.throwIfAborted();
            const page = manifest.pages[index];
            // Timeout also covers the body; stopping aborts the same stream.
            const transferSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
            const response = await fetch(page.url, { signal: transferSignal, cache: 'no-store' });
            await appendPage(access, response, page, transferSignal);
            const next = { ...state, downloaded: index + 1, bytes: page.offset + page.size,
                complete: index + 1 === manifest.pages.length, error: undefined };
            await record(db, 'downloads', 'put', next, key);
            state = next;
            emit('progress', { state });
        }
    } finally {
        // A failed fetch/database commit leaves this checkpoint's prefix valid.
        try { if (state) { access.truncate(state.bytes); access.flush(); } }
        finally { access.close(); }
    }
    if (thumbnails) { previews.delete(item.key); emit('previews-ready', { key: item.key }); }
}

function downloadAll() {
    if (running) return { started: false };
    if (!navigator.locks) throw new Error('Web Locks unavailable; cannot safely download from multiple app windows.');
    controller = new AbortController();
    const signal = controller.signal;
    running = navigator.locks.request('gallery-offline-test-download', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Another app window is downloading. Stop it first.');
        const items = catalog.items.filter(item => item.ready);
        if (!items.length) throw new Error('No completed PC galleries are available yet.');
        emit('download-status', { running: true, message: 'Downloading. Keep this app open; Stop preserves completed pages.' });
        let failures = 0;
        // Save the small previews for the whole library first, then originals.
        // Each has an independent checkpoint; old original packs are untouched.
        for (const thumbnails of [true, false]) for (const item of items) {
            if (signal.aborted) break;
            try { await downloadGallery(item, signal, thumbnails); }
            catch (error) {
                if (signal.aborted) break;
                failures++;
                emit('notice', { message: `${item.key}: ${reason(error)}` });
                const key = thumbnails ? `${item.key}:thumbs` : item.key;
                const state = await record(db, 'downloads', 'get', key);
                if (state) {
                    state.error = reason(error);
                    await record(db, 'downloads', 'put', state, key);
                    emit('progress', { state });
                }
                // Quota/security failures won't improve by trying 559 galleries.
                if (['QuotaExceededError', 'SecurityError', 'NotAllowedError', 'TypeError', 'TimeoutError'].includes(error.name)) throw error;
            }
        }
        emit('download-status', { running: false, message: signal.aborted ? 'Stopped. Resume continues from the last saved page.'
            : failures ? `Finished with ${failures} failed galleries. Resume retries them; completed files are retained.` : 'All available favorites are saved on this device.' });
    }).catch(error => emit('download-status', { running: false, message: reason(error) }))
        .finally(() => { running = undefined; controller = undefined; });
    return { started: true };
}

async function openGallery(key) {
    const generation = ++readerGeneration;
    await stop(); // Release the current pack's write handle before reading.
    readerFile = readerManifest = readerState = undefined;
    const start = performance.now();
    const state = await record(db, 'downloads', 'get', key);
    if (!state?.downloaded) throw new Error('No saved pages yet. Return to the list and press Download all.');
    const manifest = await record(db, 'manifests', 'get', `${key}-${state.revision}`);
    if (!manifest) throw new Error('Saved manifest missing. Resume downloads to repair it.');
    try {
        const root = await opfs();
        const file = await (await root.getFileHandle(packName(manifest))).getFile();
        if (file.size < state.bytes) throw new Error('Saved file is incomplete.');
        if (generation !== readerGeneration) throw new Error('Reader navigation changed');
        readerFile = file;
    } catch { throw new Error('Saved file is missing or incomplete. Return to the list and Resume to repair it.'); }
    readerManifest = manifest;
    readerState = state;
    timing('Selected gallery opened', start);
    return { manifest, state };
}

function page(index) {
    if (!readerFile || !Number.isInteger(index) || index < 0 || index >= readerState.downloaded) throw new Error('Page is not downloaded');
    const p = readerManifest.pages[index];
    const ext = p.name.split('.').pop().toLowerCase();
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' }[ext];
    return { blob: readerFile.slice(p.offset, p.offset + p.size, mime) };
}

async function describe(key) {
    if (!/^(hitomi|imhentai)-[1-9]\d*$/.test(key)) throw new Error('Invalid gallery');
    const state = await record(db, 'downloads', 'get', key);
    let manifest = await record(db, 'manifests', 'get', `details-${key}`);
    if (!manifest && state) manifest = await record(db, 'manifests', 'get', `${key}-${state.revision}`);
    if (!manifest?.thumbnails && navigator.onLine !== false) {
        const [provider, id] = key.split('-');
        try { manifest = await details({ key, provider, id }); } catch { /* Offline/old saved originals remain usable. */ }
    }
    if (!manifest) throw new Error('Gallery details not saved. Connect to the PC and Resume downloads.');
    return { manifest, state, thumbnailState: await record(db, 'downloads', 'get', `${key}:thumbs`) };
}

async function thumbnail(key, index) {
    if (!/^(hitomi|imhentai)-[1-9]\d*$/.test(key) || !Number.isInteger(index) || index < 0) throw new Error('Invalid thumbnail');
    let preview = previews.get(key);
    if (!preview) {
        const state = await record(db, 'downloads', 'get', `${key}:thumbs`);
        if (!state?.complete) throw new Error('Thumbnail not saved');
        const manifest = await record(db, 'manifests', 'get', `${key}:thumbs-${state.revision}`);
        if (!manifest) throw new Error('Thumbnail manifest missing');
        const file = await (await (await thumbnailRoot()).getFileHandle(packName(manifest))).getFile();
        if (file.size < state.bytes) throw new Error('Thumbnails evicted. Resume downloads to repair.');
        preview = { file, manifest };
        if (previews.size >= 25) previews.delete(previews.keys().next().value);
        previews.set(key, preview);
    }
    const p = preview.manifest.pages[index];
    if (!p) throw new Error('Thumbnail not saved');
    const ext = p.name.split('.').pop().toLowerCase();
    return { blob: preview.file.slice(p.offset, p.offset + p.size,
        { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' }[ext]) };
}

self.onmessage = async ({ data: { id, command, args = {} } }) => {
    try {
        let result;
        switch (command) {
            case 'init': result = await init(); break;
            case 'download': result = downloadAll(); break;
            case 'stop': result = await stop(); break;
            case 'open': result = await openGallery(args.key); break;
            case 'page': result = page(args.index); break;
            case 'describe': result = await describe(args.key); break;
            case 'thumbnail': result = await thumbnail(args.key, args.index); break;
            case 'close': readerGeneration++; readerFile = readerManifest = readerState = undefined; break;
            default: throw new Error('Unknown worker command');
        }
        postMessage({ id, result });
    } catch (error) { postMessage({ id, error: reason(error) }); }
};
