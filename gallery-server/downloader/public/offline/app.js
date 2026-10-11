// Scroll settlement and image retries, matching gallery-reader's src/core/{scroll-settle,image-retry}.ts.
function onSettledScroll(callback) {
    let scrolling = false;
    let active = true;
    const schedule = () => {
        if (scrolling || !active || document.hidden)
            return;
        callback();
    };
    window.addEventListener('scroll', () => { scrolling = true; }, { passive: true });
    window.addEventListener('scrollend', () => { scrolling = false; schedule(); });
    window.addEventListener('pagehide', () => { active = false; });
    window.addEventListener('pageshow', () => { active = true; scrolling = false; });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            scrolling = false;
        }
    });
    return schedule;
}

const FIRST_IMAGE_RETRY_MS = 1_000;
const MAX_IMAGE_RETRY_MS = 2_147_483_647;
const trackedImages = new Set();
const retryStates = new WeakMap();
let retryTimer = null;
function registerImage(image) {
    trackedImages.add(image);
    scheduleRetry();
}
function registeredImageCount() {
    return trackedImages.size;
}
function resetImageRegistry() {
    trackedImages.clear();
    if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
    }
}
function scheduleRetry() {
    if (retryTimer !== null || trackedImages.size === 0)
        return;
    retryTimer = window.setTimeout(runRetry, FIRST_IMAGE_RETRY_MS);
}
function runRetry() {
    retryTimer = null;
    if (document.visibilityState === 'hidden') {
        scheduleRetry();
        return;
    }
    const now = Date.now();
    for (const image of [...trackedImages]) {
        if (!image.isConnected) {
            trackedImages.delete(image);
            continue;
        }
        const source = image.getAttribute('src');
        if (!source?.trim()) {
            trackedImages.delete(image);
            continue;
        }
        if (image.naturalWidth > 0) {
            trackedImages.delete(image);
            continue;
        }
        let state = retryStates.get(image);
        if (!state || state.source !== source) {
            state = { source, delay: FIRST_IMAGE_RETRY_MS, retryAt: now };
            retryStates.set(image, state);
        }
        if (!image.complete || now < state.retryAt)
            continue;
        const url = new URL(source);
        if (url.origin === location.origin)
            url.searchParams.set('retry', Date.now().toString());
        image.src = '';
        image.src = url.href;
        state.delay = Math.min(state.delay * 2, MAX_IMAGE_RETRY_MS);
        state.retryAt = now + state.delay;
        state.source = image.src;
    }
    scheduleRetry();
}
// End shared reader behavior.

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const readerKey = /^(hitomi|imhentai)-[1-9]\d*$/.test(params.get('read') || '') ? params.get('read') : null;
let pageNumber = Math.max(1, Math.floor(Number(params.get('p')) || 1)), changingPage = false;
const readUrl = (key, index) => `/?read=${key}&page=${index + 1}`;
let worker, rpcId = 0, catalog = [], downloads = new Map(), active = false, supported = false, suspended = false;
let gridVersion = '', renderedReader = false, openingReader = false;
const pending = new Map(), rows = new Map(), slots = new Set();
const size = bytes => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const say = text => { $('status').textContent = text; };
const mark = (label, ms = Math.round(performance.now())) => window.bootMarks.push({ label, ms });
mark('App module');

// Persistent positions are logical anchors; WebKit still owns live history,
// gestures, zoom, and bfcache restoration.
let savedPosition = null, positionReady = false, skipPositionSave = false;
let heldAnchor, anchorFrame;
const focalY = () => (window.visualViewport?.offsetTop || 0) + (window.visualViewport?.height || innerHeight) / 2;
function capturePosition() {
    const center = focalY();
    const candidates = readerKey ? [...slots] : [...rows.values()];
    let anchor = candidates.find(node => {
        const rect = node.getBoundingClientRect(); return rect.top <= center && rect.bottom > center;
    });
    if (!anchor && readerKey && candidates.length) {
        anchor = center < candidates[0].getBoundingClientRect().top ? candidates[0] : candidates.at(-1);
    }
    const rect = anchor?.getBoundingClientRect();
    const strips = { ...(savedPosition?.strips || {}) };
    if (!readerKey) for (const [key, row] of rows) {
        const strip = row.querySelector('.hs-row'); if (strip) strips[key] = strip.scrollLeft;
    }
    const page = readerKey && anchor ? anchor.index : null;
    if (page !== null) history.replaceState(null, '', readUrl(readerKey, page));
    return { path: location.pathname + location.search, anchor: readerKey ? null : anchor?.galleryItem.key || null,
        page, fraction: rect ? Math.max(0, Math.min(1, (center - rect.top) / rect.height)) : 0,
        y: Math.max(0, scrollY), strips: readerKey ? {} : strips };
}
function savePosition() {
    if (!positionReady || suspended || skipPositionSave) return Promise.resolve();
    const position = capturePosition();
    return window.nativeGallery?.savePosition(position) || Promise.resolve();
}
const schedulePositionSave = onSettledScroll(() => { void savePosition(); });
function alignAnchor() {
    if (!heldAnchor?.node.isConnected) return;
    const rect = heldAnchor.node.getBoundingClientRect();
    const y = scrollY + rect.top + rect.height * heldAnchor.fraction - focalY();
    if (Math.abs(y - scrollY) > 0.5) scrollTo(0, Math.max(0, y));
}
function restorePosition() {
    if (positionReady) return;
    if (savedPosition) {
        const node = readerKey ? $(`page-${(savedPosition.page ?? 0) + 1}`) : rows.get(savedPosition.anchor);
        if (node) { heldAnchor = { node, fraction: savedPosition.fraction }; alignAnchor(); }
        else scrollTo(0, savedPosition.y);
    }
    positionReady = true;
    requestAnimationFrame(() => { alignAnchor(); schedulePositionSave(); });
}
// The list's first screen is complete: the strips on screen are built (or failed) and their
// on-screen thumbnails have loaded (or failed).
function screenComplete() {
    for (const row of rows.values()) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= innerHeight || row.failed) continue;
        if (!row.details) return false;
        const strip = row.querySelector('.hs-row');
        for (const slot of strip.children) {
            const left = slot.offsetLeft - strip.scrollLeft;
            if (left + slot.offsetWidth > 0 && left < strip.clientWidth && (!slot.url || slot.loading)) return false;
        }
    }
    return true;
}
window.galleryViewState = {
    receive(position, skipSaving) {
        skipPositionSave = skipSaving;
        if (positionReady) return; // Existing bfcache document already has its exact position.
        if (position && (!readerKey || position.path === location.pathname + location.search)) savedPosition = position;
    },
    save: savePosition,
    // A launch that reopens the reader opens it over a finished list (or after `limit` ms), so
    // the first swipe back returns to the list as it was left instead of one filling in.
    whenScreenComplete(limit) {
        const until = performance.now() + limit;
        return new Promise(resolve => {
            const check = () => {
                if (screenComplete() || performance.now() > until) requestAnimationFrame(() => requestAnimationFrame(resolve));
                else setTimeout(check, 30);
            };
            check();
        });
    }
};
const positionResize = new ResizeObserver(() => {
    if (!heldAnchor) return;
    cancelAnimationFrame(anchorFrame); anchorFrame = requestAnimationFrame(alignAnchor);
});
positionResize.observe($('reader-pages'));
for (const type of ['touchstart', 'pointerdown', 'wheel', 'keydown']) {
    addEventListener(type, () => { heldAnchor = null; }, { passive: true });
}
// Strip scrollend does not bubble to the window's vertical settling handler.
addEventListener('scrollend', event => { if (event.target instanceof Element) void savePosition(); }, { passive: true, capture: true });
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void savePosition(); });
addEventListener('click', event => { if (event.target.closest?.('a[href]')) void savePosition(); }, { capture: true });

function call(command, args) {
    if (!worker || suspended) return Promise.reject(new Error('App suspended'));
    return new Promise((resolve, reject) => {
        const id = ++rpcId; pending.set(id, { resolve, reject });
        worker.postMessage({ id, command, args });
    });
}
function totals() {
    const originals = catalog.map(item => downloads.get(item.key)).filter(Boolean);
    const thumbs = catalog.map(item => downloads.get(`${item.key}:thumbs`)).filter(Boolean);
    $('count').textContent = `${catalog.length} Favorites`;
    $('download').textContent = active ? 'Stop' : downloads.size ? 'Resume downloads' : 'Download all';
    $('download').disabled = !supported;
    if (!active) say(`${originals.filter(s => s.complete).length}/${catalog.length} saved · ${size([...originals, ...thumbs].reduce((n, s) => n + s.bytes, 0))} · ${thumbs.filter(s => s.complete).length} thumbnail sets`);
}
function release(slot) {
    slot.token = (slot.token || 0) + 1; slot.loading = false;
    slot.url = undefined; slot.settle?.();
    waitingImages.delete(slot);
    const img = slot.querySelector('img');
    if (img) { img.onload = img.onerror = null; img.removeAttribute('src'); }
}
// Every saved image loads, with no viewport window and nothing released offscreen (September
// 17), the ones on screen first: a few at a time, each next one the closest to the screen (a
// strip's own scroll included), re-ordered as scrolling moves.
const IMAGE_LOADS = 8, IMAGE_TIMEOUT_MS = 10_000;
const waitingImages = new Set();
let imageQueue = [], imageQueueStale = false, imageQueueSorted = 0, imageLoads = 0, imageGeneration = 0, imagePump = false;
function wantImage(slot) {
    if (slot.url || slot.loading) return;
    waitingImages.add(slot); imageQueueStale = true;
    if (!imagePump) { imagePump = true; queueMicrotask(pumpImages); }
}
function pumpImages() {
    imagePump = false;
    while (!suspended && imageLoads < IMAGE_LOADS && waitingImages.size) {
        if (!imageQueue.length || (imageQueueStale && performance.now() - imageQueueSorted > 100)) sortImageQueue();
        const slot = imageQueue.pop();
        if (!slot) break;
        if (!waitingImages.delete(slot) || !slot.isConnected) continue;
        const generation = imageGeneration;
        imageLoads++;
        void loadImage(slot).finally(() => {
            if (generation !== imageGeneration) return;
            imageLoads--; pumpImages();
        });
    }
}
// Farthest first, so the nearest pops; on screen is distance 0, in page order.
function sortImageQueue() {
    const frames = new Map(), height = innerHeight;
    const outside = (start, end, size) => end < 0 ? -end : start > size ? start - size : 0;
    const distance = slot => {
        if (readerKey) { const top = slot.offsetTop - scrollY; return outside(top, top + slot.offsetHeight, height); }
        let frame = frames.get(slot.row);
        if (!frame) {
            const rect = slot.row.getBoundingClientRect(), strip = slot.parentElement;
            frame = { vertical: outside(rect.top, rect.bottom, height), left: strip.scrollLeft, width: strip.clientWidth };
            frames.set(slot.row, frame);
        }
        const left = slot.offsetLeft - frame.left;
        return frame.vertical + outside(left, left + slot.offsetWidth, frame.width);
    };
    imageQueue = [...waitingImages].map((slot, order) => ({ slot, order, distance: distance(slot) }))
        .sort((a, b) => b.distance - a.distance || b.order - a.order).map(entry => entry.slot);
    imageQueueStale = false; imageQueueSorted = performance.now();
}
addEventListener('scroll', () => { imageQueueStale = true; }, { passive: true, capture: true });
addEventListener('resize', () => { imageQueueStale = true; }, { passive: true });
function pageError(slot, text) {
    let error = slot.querySelector('.page-error');
    if (!error) { error = document.createElement('span'); error.className = 'page-error'; slot.append(error); }
    error.textContent = `Page ${slot.index + 1}: ${text}`;
}
// Resolves once the image has loaded or failed (or after IMAGE_TIMEOUT_MS), so the queue moves on.
// Saved files have fixed addresses; the app reads (or first downloads) them.
async function loadImage(slot) {
    if (slot.loading || slot.url || suspended) return;
    const token = slot.token = (slot.token || 0) + 1;
    slot.loading = true;
    const img = slot.querySelector('img');
    slot.url = `gallery://app/media/${encodeURIComponent(readerKey || slot.key)}/${readerKey ? 'pages' : 'thumbnails'}/${slot.index}`;
    try {
        await new Promise(resolve => {
            const timeout = setTimeout(resolve, IMAGE_TIMEOUT_MS);
            slot.settle = () => { clearTimeout(timeout); slot.settle = undefined; resolve(); };
            img.onload = () => {
                slot.settle?.();
                if (!window.bootMarks.some(mark => mark.label === 'First image loaded')) {
                    mark('First image loaded');
                    window.nativeGallery?.reportStartup(window.bootMarks);
                }
                if (readerKey && token === slot.token) {
                    slot.style.aspectRatio = `${img.naturalWidth}/${img.naturalHeight}`;
                    slot.querySelector('.page-error')?.remove();
                }
            };
            img.onerror = () => {
                slot.settle?.();
                if (token === slot.token && readerKey) pageError(slot, 'Saved image could not be loaded.');
            };
            img.src = slot.url;
            registerImage(img);
        });
    } finally { if (token === slot.token) slot.loading = false; }
}
// Rows nearest the screen describe their galleries first.
function loadImages() {
    for (const slot of slots) wantImage(slot);
    const nearest = row => Math.abs(row.getBoundingClientRect().top + 150 - innerHeight / 2);
    for (const row of [...rows.values()].sort((a, b) => nearest(a) - nearest(b))) void populateRow(row, row.galleryItem);
}
async function populateRow(row, item) {
    if (!row || row.populating || row.details) return;
    row.populating = true; row.failed = false;
    try {
        const data = await call('describe', { key: item.key });
        if (!row.isConnected || suspended) return;
        row.details = data;
        const strip = document.createElement('div'); strip.className = 'hs-row';
        data.manifest.pages.forEach((_page, index) => {
            const link = document.createElement('a'), img = new Image();
            link.className = 'thumb-link'; link.href = readUrl(item.key, index);
            link.setAttribute('aria-label', `${item.title} · page ${index + 1}`);
            img.className = 'hs-thumb'; img.alt = ''; img.decoding = 'async';
            link.key = item.key; link.index = index; link.row = row;
            link.append(img); strip.append(link); slots.add(link);
        });
        row.querySelector('.row-message')?.remove(); row.prepend(strip);
        if (savedPosition?.strips?.[item.key]) strip.scrollLeft = savedPosition.strips[item.key];
        for (const slot of strip.children) wantImage(slot);
    } catch (error) {
        if (!suspended && row.isConnected) { row.failed = true; row.querySelector('.row-message').textContent = `${item.title} · ${error.message}`; }
    } finally { row.populating = false; }
}
function renderCatalog() {
    totals();
    if (readerKey) return;
    const signature = JSON.stringify([pageNumber, catalog.map(i => [i.key, i.title, i.ready])]);
    if (signature === gridVersion) return; // Keep DOM/strip scroll when returning through bfcache.
    gridVersion = signature;
    // A later list (favorites changed on the PC, a gallery finished saving) keeps the rows it
    // still has, with their loaded thumbnails, and the reader's place, re-anchored after the rebuild.
    const kept = positionReady && !changingPage ? capturePosition() : null;
    const previous = new Map(rows);
    rows.clear();
    const fragment = document.createDocumentFragment();
    const totalPages = Math.max(1, Math.ceil(catalog.length / 25)), current = Math.min(pageNumber, totalPages);
    const items = catalog.slice((current - 1) * 25, current * 25);
    for (const item of items) {
        const existing = previous.get(item.key);
        if (existing && existing.galleryItem.title === item.title) {
            previous.delete(item.key); existing.galleryItem = item;
            existing.querySelector('.info-btn').onclick = () => showInfo(existing, item);
            rows.set(item.key, existing); fragment.append(existing); continue;
        }
        const row = document.createElement('div'); row.className = 'hs-row-wrap'; row.galleryItem = item;
        const message = document.createElement('p'); message.className = 'row-message';
        const link = document.createElement('a'); link.href = readUrl(item.key, 0); link.textContent = item.title; message.append(link);
        const overlay = document.createElement('div'); overlay.className = 'row-title-overlay';
        const info = document.createElement('button'); info.className = 'row-action-btn info-btn'; info.textContent = 'i';
        info.setAttribute('aria-label', `Information: ${item.title}`); info.onclick = () => showInfo(row, item);
        overlay.append(info); row.append(message, overlay); rows.set(item.key, row); fragment.append(row);
    }
    for (const row of previous.values()) for (const slot of row.querySelectorAll('.thumb-link')) { release(slot); slots.delete(slot); }
    $('hs-grid').replaceChildren(fragment);
    if (kept) {
        for (const [key, left] of Object.entries(kept.strips)) { const strip = rows.get(key)?.querySelector('.hs-row'); if (strip) strip.scrollLeft = left; }
        savedPosition = kept; positionReady = false;
    }
    const pagination = document.createDocumentFragment(), favs = document.createElement('a');
    favs.href = '/'; favs.className = 'hs-page-favs'; favs.textContent = 'Favs'; pagination.append(favs);
    // As Hitomi and Imhen: another page replaces the rows in place and starts at its first row.
    for (let page = 1; page <= totalPages; page++) {
        if (page === current) {
            const active = document.createElement('span'); active.className = 'hs-page-active'; active.textContent = page;
            active.setAttribute('aria-current', 'page'); pagination.append(active); continue;
        }
        const link = document.createElement('a'); link.href = `/?p=${page}`; link.textContent = page; link.className = 'hs-page-link';
        link.onclick = event => { event.preventDefault(); showPage(page); };
        pagination.append(link);
    }
    $('pagination').replaceChildren(pagination);
    restorePosition(); loadImages();
    mark('Catalog rows rendered');
}
function showPage(page) {
    pageNumber = page;
    history.replaceState(null, '', `/?p=${page}`);
    heldAnchor = null; savedPosition = null;
    changingPage = true;
    try { renderCatalog(); } finally { changingPage = false; }
    $('hs-grid').scrollIntoView();
    void savePosition();
}
async function showInfo(row, item) {
    const dialog = document.createElement('dialog'); dialog.className = 'hs-modal';
    dialog.setAttribute('closedby', 'any'); dialog.setAttribute('aria-label', 'Gallery information');
    const header = document.createElement('div'); header.className = 'hs-modal-header';
    const title = document.createElement('h2'); title.textContent = item.title; header.append(title);
    const body = document.createElement('div'); body.className = 'hs-modal-body';
    const footer = document.createElement('form'); footer.method = 'dialog'; footer.className = 'hs-modal-footer';
    const close = document.createElement('button'); close.textContent = 'Close'; footer.append(close);
    dialog.append(header, body, footer); document.body.append(dialog);
    dialog.onclose = () => dialog.remove(); dialog.onclick = e => { if (e.target === dialog) dialog.close(); }; dialog.showModal();
    const textRow = (label, value) => {
        if (!value?.length) return;
        const div = document.createElement('div'); div.className = 'hs-modal-row';
        const key = document.createElement('span'), val = document.createElement('span');
        key.className = 'hs-modal-label'; key.textContent = label;
        val.className = 'hs-modal-value'; val.textContent = value; div.append(key, val); body.append(div);
    };
    try {
        const { manifest } = row.details || await call('describe', { key: item.key });
        const meta = manifest.metadata || {};
        if (meta.title && meta.title !== item.title) { const other = document.createElement('h2'); other.textContent = meta.title; header.append(other); }
        for (const [label, key] of [['Artist','artists'],['Group','groups'],['Series','parody'],['Characters','characters']]) textRow(label, meta[key]?.join(', '));
        for (const [label, key] of [['Type','type'],['Language','language'],['Date','date']]) textRow(label, meta[key]);
        textRow('Pages', String(manifest.pages.length)); textRow('Source', item.key);
        const saved = downloads.get(item.key), thumbs = downloads.get(`${item.key}:thumbs`);
        textRow('Device', `${saved?.downloaded || 0}/${manifest.pages.length} pages · ${thumbs?.downloaded || 0} thumbnails`);
        textRow('Error', saved?.error || thumbs?.error);
        if (meta.tags?.length) {
            const cloud = document.createElement('div'); cloud.className = 'hs-tag-cloud';
            for (const tag of meta.tags) { const chip = document.createElement('span'); chip.className = 'hs-tag-chip'; chip.textContent = tag; cloud.append(chip); } body.append(cloud);
        }
    } catch (error) { textRow('Status', error.message); }
}
async function openReader() {
    if (openingReader) return;
    openingReader = true;
    $('library').hidden = $('library-footer').hidden = true; $('reader').hidden = false;
    if (!renderedReader) $('reader-message').textContent = 'Opening saved pages…';
    try {
        const { manifest, state } = await call('open', { key: readerKey }); document.title = manifest.title;
        $('reader-message').textContent = state.complete ? '' : `${state.downloaded}/${state.total} pages saved`;
        if (!renderedReader) {
            const fragment = document.createDocumentFragment();
            const available = manifest.pages.length;
            manifest.pages.slice(0, available).forEach((page, index) => {
                const slot = document.createElement('div'), img = new Image();
                slot.className = 'page'; slot.index = index; slot.id = `page-${index + 1}`;
                slot.style.aspectRatio = page.width > 0 && page.height > 0 ? `${page.width}/${page.height}` : '2/3';
                img.className = 'hs-reader-img'; img.alt = ''; img.decoding = 'async';
                slot.append(img); slots.add(slot); fragment.append(slot);
            });
            $('reader-pages').replaceChildren(fragment); renderedReader = true;
            const selected = Math.max(0, Math.min(available - 1, Math.floor(Number(params.get('page')) || 1) - 1));
            const target = $(`page-${selected + 1}`);
            if (target && !savedPosition) window.scrollTo(0, Math.max(0, target.offsetTop - window.innerHeight / 2));
            restorePosition();
        }
        loadImages();
    } catch (error) { $('reader-message').textContent = error.message; }
    finally { openingReader = false; }
}
async function start(restoring = false) {
    suspended = false; mark(restoring ? 'bfcache resumed' : 'UI yielded a paint');
    worker = window.nativeGallery.createWorker();
    worker.onerror = error => {
        for (const request of pending.values()) request.reject(new Error(error.message)); pending.clear();
        active = false; supported = false; totals(); say(`Storage error: ${error.message}`);
    };
    worker.onmessage = ({ data }) => {
        if ('id' in data) {
            const request = pending.get(data.id); pending.delete(data.id);
            if (data.error) request?.reject(new Error(data.error)); else request?.resolve(data.result); return;
        }
        if (data.type === 'timing') mark(data.label, data.ms);
        if (data.type === 'notice') say(data.message);
        if (data.type === 'catalog') {
            catalog = data.catalog.items;
            if (data.downloads) downloads = new Map(data.downloads.map(s => [s.key, s])); renderCatalog();
        }
        if (data.type === 'native-progress') {
            for (const state of data.states) downloads.set(state.key, state);
            if (readerKey && renderedReader && (downloads.get(readerKey)?.downloaded || 0) > slots.size) void openReader();
        }
        if (data.type === 'progress') {
            downloads.set(data.state.key, data.state); totals();
            if (active) say(`${data.state.key.replace(':thumbs', ' thumbnails')} · ${data.state.downloaded}/${data.state.total}`);
        }
        if (data.type === 'previews-ready') {
            for (const slot of slots) if (slot.key === data.key) wantImage(slot);
        }
        if (data.type === 'download-status') { active = data.running; totals(); say(data.message); }
    };
    try {
        supported = (await call('init')).supported; totals();
        if (readerKey) await openReader();
        else if (restoring) {
            loadImages();
            schedulePositionSave();
        }
    } catch (error) { if (readerKey) $('reader-message').textContent = error.message; else say(error.message); }
    requestAnimationFrame(() => requestAnimationFrame(() => window.nativeGallery?.continueLoading()));
}
$('download').onclick = async () => {
    try {
        if (active) { $('download').disabled = true; await call('stop'); }
        else {
            active = true; totals(); say('Downloading thumbnails, then remaining pages…');
            await call('download');
        }
    } catch (error) { active = false; totals(); say(error.message); }
};
window.addEventListener('pagehide', () => {
    void savePosition();
    suspended = true; worker?.terminate(); worker = undefined; active = false;
    // Keep DOM, dimensions, loaded images and both scroll axes for bfcache. Images still on their
    // way start again from the queue on return.
    imageGeneration++; imageLoads = 0;
    for (const slot of slots) if (slot.loading) { release(slot); waitingImages.add(slot); }
    for (const request of pending.values()) request.reject(new Error('App suspended')); pending.clear();
});
window.addEventListener('pageshow', event => { if (event.persisted) requestAnimationFrame(() => requestAnimationFrame(() => start(true))); });
requestAnimationFrame(() => requestAnimationFrame(() => { void start(); }));
