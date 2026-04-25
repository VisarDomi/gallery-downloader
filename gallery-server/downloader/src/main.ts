import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as u from './utils.js';
import { CONFIG } from './config.js';
import { socketService } from './socket.service.js';
import { queueManager } from './queue.manager.js';
import { runSync, getSyncStatus } from './sync.js';
import { runRemove, getRemoveStatus, gitCommit } from './remove.js';
import { loadManifest } from './manifest.js';
import { buildFilterPolicy, getPolicyCleanupStatus, runPolicyCleanup, validateGalleryInfo } from './policy.js';
import { hitomi } from 'gallery-sources';

const app = express();

const FILTERS_PATH = path.resolve(import.meta.dirname, '..', '..', 'filters.txt');
const ARTISTS_PATH = path.resolve(import.meta.dirname, '..', '..', 'artists.txt');
const QUERIES_PATH = path.resolve(import.meta.dirname, '..', '..', 'queries.txt');
const INDEX_DB_PATH = path.join(CONFIG.WORKING_DIR, 'gallery-dl', 'gallery-index.db');

const logServerInfo = (port: number) => {
    const networkInterfaces = os.networkInterfaces();
    console.log(`Downloader (Queue Manager) running securely on port ${port}`);

    Object.keys(networkInterfaces).forEach((ifaceName) => {
        networkInterfaces[ifaceName]?.forEach((iface) => {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`Queue UI Access: https://${iface.address}:${port}`);
            }
        });
    });
    console.log(`Working Directory: ${CONFIG.WORKING_DIR}`);
};

// --- SSL LOAD ---
let server: https.Server;
try {
    const httpsOptions = {
        key: fs.readFileSync(CONFIG.SSL.KEY),
        cert: fs.readFileSync(CONFIG.SSL.CERT)
    };
    server = https.createServer(httpsOptions, app);
    console.log('SSL Certificates loaded successfully.');
} catch (e) {
    console.error('Could not load SSL certificates. Check config.ts paths.');
    process.exit(1);
}

// --- INIT SOCKET ---
socketService.init(server);

// --- MIDDLEWARE ---
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));

// --- STATIC UI SERVING ---
app.use(express.static(path.join(u.findProjectRoot(), 'public')));

// --- ROUTES ---
app.get('/status', (_req, res) => {
    res.json(queueManager.getStatus());
});

app.post('/queue', (req, res) => {
    const rawUrls = (req.body.urls || '').split('\n').filter((u: string) => u.trim() !== '');
    queueManager.updateQueue(rawUrls);
    res.json({ status: 'ok' });
});

app.post('/immediate', (req, res) => {
    const rawUrls = (req.body.urls || '').split('\n').filter((u: string) => u.trim() !== '');
    if (rawUrls.length === 0) {
        res.json({ status: 'empty' });
        return;
    }
    queueManager.injectImmediate(rawUrls);
    res.json({ status: 'ok' });
});

app.post('/pause', (_req, res) => {
    queueManager.pause();
    res.json({ status: 'paused' });
});

app.post('/resume', (_req, res) => {
    queueManager.resume();
    res.json({ status: 'resumed' });
});

app.post('/cancel', (_req, res) => {
    queueManager.cancel();
    res.json({ status: 'stopped' });
});

// --- SYNC ROUTES ---
app.post('/sync', async (_req, res) => {
    res.json({ status: 'started' });
    runSync(FILTERS_PATH, ARTISTS_PATH, QUERIES_PATH).catch(console.error);
});

app.get('/sync/status', (_req, res) => {
    res.json(getSyncStatus());
});

// --- REMOVE ROUTES ---
app.post('/remove', (req, res) => {
    const { file, line } = req.body;
    if (file !== 'artists' && file !== 'queries') {
        res.status(400).json({ error: 'file must be "artists" or "queries"' });
        return;
    }
    if (!line || typeof line !== 'string') {
        res.status(400).json({ error: 'line must be a non-empty string' });
        return;
    }
    res.json({ status: 'started' });
    runRemove(file, line.trim(), FILTERS_PATH, ARTISTS_PATH, QUERIES_PATH).catch(console.error);
});

app.get('/remove/status', (_req, res) => {
    res.json(getRemoveStatus());
});

app.post('/policy-cleanup', (_req, res) => {
    res.json({ status: 'started' });
    runPolicyCleanup(FILTERS_PATH, ARTISTS_PATH, QUERIES_PATH, INDEX_DB_PATH).catch(console.error);
});

app.get('/policy-cleanup/status', (_req, res) => {
    res.json(getPolicyCleanupStatus());
});

// --- ARTISTS ENDPOINTS ---
app.get('/artists', (_req, res) => {
    const manifest = loadManifest(FILTERS_PATH, ARTISTS_PATH, QUERIES_PATH);
    const entries = manifest.artists.map(a => `${a.namespace}:${a.value}`);
    console.log(`[artists] GET /artists: ${entries.length} entries`);
    res.json(entries);
});

app.post('/artists/add', (req, res) => {
    const { line } = req.body;
    if (!line || typeof line !== 'string') {
        res.status(400).json({ error: 'line must be a non-empty string' });
        return;
    }

    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
        res.status(400).json({ error: 'line must be namespace:value format' });
        return;
    }
    const ns = trimmed.slice(0, colonIdx);
    if (ns !== 'artist' && ns !== 'group') {
        res.status(400).json({ error: 'namespace must be artist or group' });
        return;
    }

    const content = fs.readFileSync(ARTISTS_PATH, 'utf-8');
    const lines = content.split('\n').map(l => l.trim());
    if (lines.includes(trimmed)) {
        console.log(`[artists] add ${trimmed}: already_exists`);
        res.json({ status: 'already_exists' });
        return;
    }

    const separator = content.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(ARTISTS_PATH, `${separator}${trimmed}\n`);
    gitCommit(ARTISTS_PATH, `add ${trimmed} to artists.txt`);

    console.log(`[artists] added ${trimmed}`);
    res.json({ status: 'added' });
});

// --- QUERIES ENDPOINT (for frontend saved searches) ---
app.get('/queries', (_req, res) => {
    const manifest = loadManifest(FILTERS_PATH, ARTISTS_PATH, QUERIES_PATH);
    res.json(manifest.queries.map(q => q.raw));
});

// --- FILE WATCH: auto-sync on manifest changes ---
function watchManifests() {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const triggerSync = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            console.log('[watch] Manifest changed, triggering sync...');
            runSync(FILTERS_PATH, ARTISTS_PATH, QUERIES_PATH).catch(console.error);
        }, 2000);
    };

    for (const filePath of [FILTERS_PATH, ARTISTS_PATH, QUERIES_PATH]) {
        try {
            fs.watch(filePath, () => triggerSync());
            console.log(`[watch] Watching ${path.basename(filePath)}`);
        } catch {
            console.log(`[watch] Could not watch ${path.basename(filePath)} (file may not exist)`);
        }
    }
}

// --- POST-DOWNLOAD HOOKS ---
// Rejects galleries whose language doesn't match filters.txt.
// Hitomi's nozomi sometimes returns wrong-language IDs for an artist.
const GALLERY_ROOT = path.join(CONFIG.WORKING_DIR, hitomi.gallerySubdir);

queueManager.setValidator((galleryId) => {
    const infoPath = path.join(GALLERY_ROOT, galleryId, hitomi.metadataFile);
    try {
        const filterPolicy = buildFilterPolicy(loadManifest(FILTERS_PATH, ARTISTS_PATH, QUERIES_PATH).filters);
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
        const decision = validateGalleryInfo(info, filterPolicy);
        if (decision.kind === 'reject') {
            return { valid: false, reason: decision.reason };
        }
        return { valid: true };
    } catch {
        return { valid: true };
    }
});

// Notify indexer after each successful download
const INDEXER_PORT = 11557;
queueManager.setOnComplete((galleryId) => {
    const req = https.request({
        hostname: 'localhost',
        port: INDEXER_PORT,
        path: `/index/${galleryId}`,
        method: 'POST',
        rejectUnauthorized: false,
    }, (res) => { res.resume(); });
    req.on('error', (err) => {
        console.log(`[index-notify] failed for ${galleryId}: ${err.message}`);
    });
    req.end();
});

// --- START ---
server.listen(CONFIG.PORT, '0.0.0.0', () => {
    logServerInfo(CONFIG.PORT);
    queueManager.restore();
    watchManifests();
    runPolicyCleanup(FILTERS_PATH, ARTISTS_PATH, QUERIES_PATH, INDEX_DB_PATH).catch(console.error);
});
