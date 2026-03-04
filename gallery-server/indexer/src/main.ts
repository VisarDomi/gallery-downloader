import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runScan } from './scanner.js';
import { searchGalleries, getGalleryDetail, getGalleryListItems, getFacets, reopenDb } from './db.js';

const app = express();
const PORT = 11557;

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
runScan().then(() => {
    console.log('Initial scan complete, DB ready.');
});

// --- ENDPOINTS ---
app.get('/facets', (_req, res) => {
    res.json(getFacets());
});

app.get('/search', (req, res) => {
    const q = (req.query.q as string || '');
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;

    res.json(searchGalleries(q, limit, offset));
});

app.get('/gallery/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid ID format' });
        return;
    }

    const gallery = getGalleryDetail(id);
    if (!gallery) {
        res.status(404).json({ error: 'Gallery not found' });
        return;
    }
    res.json(gallery);
});

// Bulk fetch for Favorites — returns slim items
app.post('/galleries', (req, res) => {
    const ids = req.body.ids as number[];
    if (!Array.isArray(ids) || ids.some(id => isNaN(id))) {
        res.status(400).json({ error: 'ids must be an array of numbers' });
        return;
    }

    res.json(getGalleryListItems(ids));
});

app.post('/refresh', async (_req, res) => {
    console.log('Refresh requested...');
    res.json({ status: 'scanning' });
    await runScan();
    reopenDb();
});

server.listen(PORT, '0.0.0.0', () => {
    logServerInfo(PORT);
});
