import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hitomi, imhentai, type Source, type SourceId } from 'gallery-sources';
import * as u from './utils.js';
import { CONFIG } from './config.js';
import { socketService } from './socket.service.js';
import { isSupportedGalleryUrl, queueManager } from './queue.manager.js';
import { readFavorites, writeFavorites } from './favorites-store.js';
import { FavoritesSyncController } from './favorites-sync.js';
import { offlineApi } from './offline-api.js';
import { webUi } from './web-ui.js';

const app = express();
const SOURCES: Record<SourceId, Source> = { hitomi, imhentai };
const FAVORITES_DIR = path.resolve(import.meta.dirname, '..', '..', 'favorites');
const favoritesPath = (provider: SourceId) => path.join(FAVORITES_DIR, `${provider}.json`);
const favoriteSync = Object.fromEntries(
    (Object.keys(SOURCES) as SourceId[]).map(provider => [provider, new FavoritesSyncController(SOURCES[provider])]),
) as Record<SourceId, FavoritesSyncController>;

function logServerInfo(port: number) {
    console.log(`Downloader running securely on port ${port}`);
    for (const interfaces of Object.values(os.networkInterfaces())) {
        for (const iface of interfaces ?? []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`PWA: https://${iface.address}:${port}/`);
                console.log(`Queue UI: https://${iface.address}:${port}/downloader`);
            }
        }
    }
    console.log(`Working directory: ${CONFIG.WORKING_DIR}`);
}

let server: https.Server;
try {
    server = https.createServer({
        key: fs.readFileSync(CONFIG.SSL.KEY),
        cert: fs.readFileSync(CONFIG.SSL.CERT),
    }, app);
} catch {
    console.error('Could not load SSL certificates. Check config.ts paths.');
    process.exit(1);
}

socketService.init(server);
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
    if (req.path === '/status' || req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
    }
    next();
});
app.use(webUi(path.join(u.findProjectRoot(), 'public')));
app.use('/offline-api', offlineApi(path.join(CONFIG.WORKING_DIR, 'gallery-dl'), FAVORITES_DIR));

app.get('/status', (_req, res) => {
    res.json(queueManager.getStatus());
});

function validGalleryUrls(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    return value
        .split('\n')
        .map(url => url.trim())
        .filter(url => url.length > 0 && isSupportedGalleryUrl(url));
}

app.post('/queue', (req, res) => {
    const urls = validGalleryUrls(req.body.urls);
    queueManager.updateQueue(urls);
    res.json({ status: 'ok', accepted: urls.length });
});

app.post('/immediate', (req, res) => {
    const urls = validGalleryUrls(req.body.urls);
    if (urls.length > 0) queueManager.injectImmediate(urls);
    res.json({ status: urls.length > 0 ? 'ok' : 'empty', accepted: urls.length });
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

app.post('/retry-failed', (req, res) => {
    const url = req.body?.url;
    if (url !== undefined && (typeof url !== 'string' || !isSupportedGalleryUrl(url))) {
        res.status(400).json({ error: 'Invalid gallery URL' }); return;
    }
    res.json({ retried: queueManager.retryFailed(url) });
});

for (const provider of Object.keys(SOURCES) as SourceId[]) {
    const snapshotPath = favoritesPath(provider);
    const controller = favoriteSync[provider];

    app.get(`/api/favorites/${provider}`, (_req, res) => {
        try {
            res.json(readFavorites(snapshotPath, provider));
        } catch (error) {
            res.status(500).json({ error: String((error as Error)?.message ?? error) });
        }
    });

    app.put(`/api/favorites/${provider}`, (req, res) => {
        try {
            const snapshot = writeFavorites(snapshotPath, provider, req.body?.ids);
            controller.requestSync(snapshotPath);
            res.json({ ...snapshot, sync: 'started' });
        } catch (error) {
            res.status(400).json({ error: String((error as Error)?.message ?? error) });
        }
    });

    app.post(`/api/favorites/${provider}/sync`, (_req, res) => {
        controller.requestSync(snapshotPath);
        res.json({ status: 'started' });
    });

    app.get(`/api/favorites/${provider}/sync/status`, (_req, res) => {
        res.json(controller.getSyncStatus());
    });

    app.post(`/api/favorites/${provider}/reconcile`, (_req, res) => {
        const status = controller.getReconcileStatus();
        if (status.phase === 'diffing' || status.phase === 'deleting') {
            res.status(409).json({ error: 'reconcile is already running' });
            return;
        }
        res.json({ status: 'started' });
        void controller.reconcile(snapshotPath);
    });

    app.get(`/api/favorites/${provider}/reconcile/status`, (_req, res) => {
        res.json(controller.getReconcileStatus());
    });
}

server.listen(CONFIG.PORT, '0.0.0.0', () => {
    logServerInfo(CONFIG.PORT);
    queueManager.restore(false);
    for (const provider of Object.keys(SOURCES) as SourceId[]) {
        favoriteSync[provider].requestSync(favoritesPath(provider));
    }
});
