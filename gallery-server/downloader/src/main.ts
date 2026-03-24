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
import { runRemove, getRemoveStatus } from './remove.js';
import { loadManifest } from './manifest.js';

const app = express();

const ARTISTS_PATH = path.resolve(import.meta.dirname, '..', '..', 'artists.txt');
const QUERIES_PATH = path.resolve(import.meta.dirname, '..', '..', 'queries.txt');

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
    runSync(ARTISTS_PATH, QUERIES_PATH).catch(console.error);
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
    runRemove(file, line.trim(), ARTISTS_PATH, QUERIES_PATH).catch(console.error);
});

app.get('/remove/status', (_req, res) => {
    res.json(getRemoveStatus());
});

// --- QUERIES ENDPOINT (for frontend saved searches) ---
app.get('/queries', (_req, res) => {
    const manifest = loadManifest(ARTISTS_PATH, QUERIES_PATH);
    res.json(manifest.queries.map(q => q.raw));
});

// --- FILE WATCH: auto-sync on manifest changes ---
function watchManifests() {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const triggerSync = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            console.log('[watch] Manifest changed, triggering sync...');
            runSync(ARTISTS_PATH, QUERIES_PATH).catch(console.error);
        }, 2000);
    };

    for (const filePath of [ARTISTS_PATH, QUERIES_PATH]) {
        try {
            fs.watch(filePath, () => triggerSync());
            console.log(`[watch] Watching ${path.basename(filePath)}`);
        } catch {
            console.log(`[watch] Could not watch ${path.basename(filePath)} (file may not exist)`);
        }
    }
}

// --- START ---
server.listen(CONFIG.PORT, '0.0.0.0', () => {
    logServerInfo(CONFIG.PORT);
    queueManager.restore();
    watchManifests();
});
