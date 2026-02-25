import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanLibrary } from './scanner.js';
import { Gallery } from './types.js';
import { searchLibrary } from './search.js';

const app = express();
const PORT = 11557;

let libraryCache: Gallery[] = [];

const logServerInfo = (port: number) => {
    const networkInterfaces = os.networkInterfaces();
    console.log(`Indexer running securely on port ${port}`);

    Object.keys(networkInterfaces).forEach((ifaceName) => {
        networkInterfaces[ifaceName]?.forEach((iface) => {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`LAN Access: https://${iface.address}:${port}`);
            }
        });
    });
};

// --- SSL CONFIGURATION ---
const mkcertPath = path.join(os.homedir(), '.local/share/mkcert');
const pwaCertPath = path.join(mkcertPath, 'pwa');
const keyPath = path.join(pwaCertPath, 'key.pem');
const certPath = path.join(pwaCertPath, 'cert.pem');

let server;

try {
    const httpsOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
    server = https.createServer(httpsOptions, app);
} catch (e) {
    console.error('INDEXER: Could not load SSL certificates. Exiting.');
    process.exit(1);
}

app.use(cors({ origin: "*" }));
app.use(express.json());

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
});

// --- INITIAL SCAN ---
scanLibrary().then(data => libraryCache = data);

// --- ENDPOINTS ---
app.get('/facets', (_req, res) => {
    const langMap = new Map<string, number>();
    const artistMap = new Map<string, number>();
    const groupMap = new Map<string, number>();

    for (const g of libraryCache) {
        if (g.language) langMap.set(g.language, (langMap.get(g.language) ?? 0) + 1);
        for (const a of g.artist) artistMap.set(a, (artistMap.get(a) ?? 0) + 1);
        for (const gr of g.group) groupMap.set(gr, (groupMap.get(gr) ?? 0) + 1);
    }

    const sorted = (m: Map<string, number>) =>
        [...m.entries()].sort((a, b) => b[1] - a[1]);

    res.json({
        languages: sorted(langMap),
        artists: sorted(artistMap),
        groups: sorted(groupMap),
    });
});

app.get('/search', (req, res) => {
    const q = (req.query.q as string || '');
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;

    const result = searchLibrary(libraryCache, q, limit, offset);

    res.json(result);
});

app.get('/gallery/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid ID format' });
        return;
    }

    const gallery = libraryCache.find(g => g.gallery_id === id);
    if (!gallery) {
        res.status(404).json({ error: 'Gallery not found' });
        return;
    }
    res.json(gallery);
});

// Bulk fetch for Favorites
app.post('/galleries', (req, res) => {
    const ids = req.body.ids as number[];
    if (!Array.isArray(ids) || ids.some(id => isNaN(id))) {
        res.status(400).json({ error: 'ids must be an array of numbers' });
        return;
    }

    // Strict number comparison
    const found = libraryCache.filter(g => ids.includes(g.gallery_id));
    res.json(found);
});

app.post('/refresh', async (_req, res) => {
    console.log('Refresh requested...');
    res.json({ status: 'scanning' });
    libraryCache = await scanLibrary();
});

server.listen(PORT, '0.0.0.0', () => {
    logServerInfo(PORT);
});