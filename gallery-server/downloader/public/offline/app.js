const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const readerKey = /^(hitomi|imhentai)-[1-9]\d*$/.test(params.get('read') || '') ? params.get('read') : null;
const pageNumber = Math.max(1, Math.floor(Number(params.get('p')) || 1));
const readUrl = (key, index) => `/?read=${key}&page=${index + 1}`;
let worker, rpcId = 0, catalog = [], downloads = new Map(), active = false, supported = false, suspended = false;
let gridVersion = '', renderedReader = false, openingReader = false, observer, rowObserver;
const pending = new Map(), rows = new Map(), slots = new Set();
const size = bytes => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const say = text => { $('status').textContent = text; };
const mark = (label, ms = Math.round(performance.now())) => window.bootMarks.push({ label, ms });
mark('App module');

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
    $('download').disabled = !supported || (!catalog.length && !window.nativeGallery);
    if (!active) say(`${originals.filter(s => s.complete).length}/${catalog.length} saved · ${size([...originals, ...thumbs].reduce((n, s) => n + s.bytes, 0))} · ${thumbs.filter(s => s.complete).length} thumbnail sets`);
}
function release(slot) {
    slot.token = (slot.token || 0) + 1; slot.loading = false;
    if (slot.url) URL.revokeObjectURL(slot.url);
    slot.url = undefined;
    const img = slot.querySelector('img');
    if (img) { img.onload = img.onerror = null; img.removeAttribute('src'); }
}
// Bound concurrent blobs/network previews, including horizontal strip scrolling.
const work = [], backgroundWork = []; let working = 0, backgroundScheduled = false;
function enqueue(task, background = false) {
    (background ? backgroundWork : work).push(task); pump();
}
function continueBackground() {
    if (backgroundScheduled || suspended || !backgroundWork.length) return;
    backgroundScheduled = true;
    setTimeout(() => {
        backgroundScheduled = false;
        if (!suspended && !work.length && working < 2 && backgroundWork.length) {
            working++;
            Promise.resolve().then(backgroundWork.shift()).catch(() => {}).finally(() => { working--; pump(); });
        }
        continueBackground();
    }, 16);
}
function pump() {
    while (working < 6 && work.length && !suspended) {
        working++; Promise.resolve().then(work.shift()).catch(() => {}).finally(() => { working--; pump(); });
    }
    continueBackground();
}
function pageError(slot, text) {
    let error = slot.querySelector('.page-error');
    if (!error) { error = document.createElement('span'); error.className = 'page-error'; slot.append(error); }
    error.textContent = `Page ${slot.index + 1}: ${text}`;
}
async function loadImage(slot) {
    if (!slot.visible || slot.loading || slot.url || suspended) return;
    const token = slot.token = (slot.token || 0) + 1;
    slot.loading = true;
    const img = slot.querySelector('img');
    try {
        let blob, localUrl;
        if (readerKey) ({ blob, url: localUrl } = await call('page', { key: readerKey, index: slot.index }));
        else {
            try { ({ blob, url: localUrl } = await call('thumbnail', { key: slot.key, index: slot.index })); }
            catch {
                if (window.nativeGallery) throw new Error('Thumbnail not saved');
                if (!slot.source || navigator.onLine === false) throw new Error('Thumbnail not saved');
                const response = await fetch(slot.source, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
                if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Thumbnail unavailable');
                blob = await response.blob();
            }
        }
        if (token !== slot.token || suspended || !slot.isConnected) return;
        slot.url = localUrl || URL.createObjectURL(blob);
        img.onload = () => {
            slot.retries = 0;
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
            if (token !== slot.token) return;
            if (readerKey) pageError(slot, 'Saved image could not be decoded.');
            if (window.nativeGallery) {
                slot.url = undefined;
                slot.retries = (slot.retries || 0) + 1;
                if (slot.retries <= 3) setTimeout(() => {
                    if (!suspended && slot.visible && slot.isConnected && token === slot.token) enqueue(() => loadImage(slot));
                }, 1000 * 2 ** (slot.retries - 1));
            }
        };
        img.src = slot.url;
    } catch (error) {
        if (token === slot.token && !suspended) {
            if (readerKey) pageError(slot, error.message);
            else img.alt = `${slot.index + 1} · ${error.message}`;
        }
    } finally { if (token === slot.token) slot.loading = false; }
}
function observeImages() {
    observer?.disconnect();
    observer = new IntersectionObserver(entries => {
        for (const { target: slot, isIntersecting } of entries) {
            slot.visible = isIntersecting;
            if (isIntersecting) enqueue(() => loadImage(slot)); else release(slot);
        }
    }, { rootMargin: readerKey ? '1000px 0px' : '300px 0px' });
    for (const slot of slots) observer.observe(slot);
    rowObserver?.disconnect();
    rowObserver = new IntersectionObserver(entries => {
        for (const { target: row, isIntersecting } of entries) {
            if (isIntersecting) enqueue(() => populateRow(row, row.galleryItem));
        }
    }, { rootMargin: '600px 0px' });
    for (const row of rows.values()) rowObserver.observe(row);
}
async function populateRow(row, item) {
    if (!row || row.populating || row.details) return;
    row.populating = true;
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
            link.key = item.key; link.index = index;
            link.source = data.manifest.thumbnails?.pages[index]?.url;
            link.append(img); strip.append(link); slots.add(link);
        });
        row.querySelector('.row-message')?.remove(); row.prepend(strip);
        for (const slot of strip.children) observer.observe(slot);
    } catch (error) {
        if (!suspended && row.isConnected) row.querySelector('.row-message').textContent = `${item.title} · ${error.message}`;
    } finally { row.populating = false; }
}
function renderCatalog() {
    totals();
    if (readerKey) return;
    const signature = JSON.stringify(catalog.map(i => [i.key, i.title, i.ready]));
    if (signature === gridVersion) return; // Keep DOM/strip scroll when returning through bfcache.
    gridVersion = signature; observer?.disconnect();
    for (const slot of slots) release(slot);
    slots.clear(); rows.clear();
    const fragment = document.createDocumentFragment();
    const totalPages = Math.max(1, Math.ceil(catalog.length / 25)), current = Math.min(pageNumber, totalPages);
    const items = catalog.slice((current - 1) * 25, current * 25);
    for (const item of items) {
        const row = document.createElement('div'); row.className = 'hs-row-wrap'; row.galleryItem = item;
        const message = document.createElement('p'); message.className = 'row-message';
        const link = document.createElement('a'); link.href = readUrl(item.key, 0); link.textContent = item.title; message.append(link);
        const overlay = document.createElement('div'); overlay.className = 'row-title-overlay';
        const info = document.createElement('button'); info.className = 'row-action-btn info-btn'; info.textContent = 'i';
        info.setAttribute('aria-label', `Information: ${item.title}`); info.onclick = () => showInfo(row, item);
        overlay.append(info); row.append(message, overlay); rows.set(item.key, row); fragment.append(row);
    }
    $('hs-grid').replaceChildren(fragment);
    const pagination = document.createDocumentFragment(), favs = document.createElement('a');
    favs.href = '/'; favs.className = 'hs-page-favs'; favs.textContent = 'Favs'; pagination.append(favs);
    for (let page = 1; page <= totalPages; page++) {
        const link = document.createElement('a'); link.href = `/?p=${page}`; link.textContent = page;
        link.className = page === current ? 'hs-page-active' : 'hs-page-link';
        if (page === current) link.setAttribute('aria-current', 'page'); pagination.append(link);
    }
    $('pagination').replaceChildren(pagination); observeImages();
    mark('Catalog rows rendered');
    for (const item of items) enqueue(() => populateRow(rows.get(item.key), item), true);
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
            const available = window.nativeGallery ? manifest.pages.length : state.downloaded;
            manifest.pages.slice(0, available).forEach((page, index) => {
                const slot = document.createElement('div'), img = new Image();
                slot.className = 'page'; slot.index = index; slot.id = `page-${index + 1}`;
                slot.style.aspectRatio = page.width > 0 && page.height > 0 ? `${page.width}/${page.height}` : '2/3';
                img.className = 'hs-reader-img'; img.alt = ''; img.decoding = 'async';
                slot.append(img); slots.add(slot); fragment.append(slot);
            });
            $('reader-pages').replaceChildren(fragment); renderedReader = true;
            const selected = Math.max(0, Math.min(available - 1, Math.floor(Number(params.get('page')) || 1) - 1));
            if (!window.nativeGallery && Number(params.get('page')) > state.downloaded) $('reader-message').textContent = `Page ${params.get('page')} is not saved. Only the first ${state.downloaded} pages are available.`;
            const target = $(`page-${selected + 1}`);
            if (target) window.scrollTo(0, Math.max(0, target.offsetTop - window.innerHeight / 2));
        }
        observeImages();
    } catch (error) { $('reader-message').textContent = error.message; }
    finally { openingReader = false; }
}
let scrollTimer;
window.addEventListener('scroll', () => {
    if (!readerKey || !renderedReader) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
        const slot = document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('.page');
        if (slot) history.replaceState(null, '', readUrl(readerKey, slot.index));
    }, 150);
}, { passive: true });
async function start(restoring = false) {
    suspended = false; mark(restoring ? 'bfcache resumed' : 'UI yielded a paint');
    worker = window.nativeGallery ? window.nativeGallery.createWorker() : new Worker('/worker.js', { type: 'module' });
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
            for (const slot of slots) if (slot.key === data.key && slot.visible) {
                if (window.nativeGallery) { if (!slot.url && !slot.loading) enqueue(() => loadImage(slot)); }
                else { release(slot); enqueue(() => loadImage(slot)); }
            }
        }
        if (data.type === 'download-status') { active = data.running; totals(); say(data.message); }
    };
    try {
        supported = (await call('init')).supported; totals();
        if (readerKey) await openReader();
        else if (restoring) {
            observeImages();
            for (const row of rows.values()) enqueue(() => populateRow(row, row.galleryItem), true);
            pump();
        }
    } catch (error) { if (readerKey) $('reader-message').textContent = error.message; else say(error.message); }
    requestAnimationFrame(() => requestAnimationFrame(() => window.nativeGallery?.continueLoading()));
}
$('download').onclick = async () => {
    try {
        if (active) { $('download').disabled = true; await call('stop'); }
        else {
            active = true; totals(); say('Downloading thumbnails, then remaining pages…');
            if (!window.nativeGallery) void navigator.storage.persist?.().catch(() => {});
            await call('download');
        }
    } catch (error) { active = false; totals(); say(error.message); }
};
window.addEventListener('pagehide', () => {
    suspended = true; worker?.terminate(); worker = undefined; active = false;
    observer?.disconnect(); rowObserver?.disconnect(); clearTimeout(scrollTimer); work.length = 0; backgroundWork.length = 0;
    // Keep DOM, dimensions, blob URLs and both scroll axes for bfcache. Release
    // IDB/write handles by terminating the worker, without blocking navigation.
    for (const slot of slots) { slot.token = (slot.token || 0) + 1; slot.loading = false; }
    for (const request of pending.values()) request.reject(new Error('App suspended')); pending.clear();
});
window.addEventListener('pageshow', event => { if (event.persisted) requestAnimationFrame(() => requestAnimationFrame(() => start(true))); });
function prepareShell() {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(async registration => {
        const notice = () => { if (registration.waiting) $('sw-status').textContent = 'Update ready. Close all app windows and reopen; saved downloads stay.'; };
        registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', notice));
        registration.installing?.addEventListener('statechange', notice);
        await navigator.serviceWorker.ready; notice();
    }).catch(error => { $('sw-status').textContent = `Offline shell unavailable: ${error.message}`; });
}
if (window.nativeGallery) requestAnimationFrame(() => requestAnimationFrame(() => { void start(); }));
else if (!isSecureContext || !('serviceWorker' in navigator)) say('Trusted HTTPS is required.');
else requestAnimationFrame(() => requestAnimationFrame(() => { void start(); prepareShell(); }));
