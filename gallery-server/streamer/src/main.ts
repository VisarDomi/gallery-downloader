import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { CONFIG } from './config.js';
import { createHttpsServer } from './ssl.js';
import { handleBatchRequest } from './batch.js';
import { handleDeleteRequest } from './delete.js';
import { handleOcrLookupRequest } from './ocr.js';

const app = express();

// CORS first (needed for all routes including proxied ones)
app.use(cors({ origin: "*" }));

// Proxy to indexer (pathFilter so Express doesn't strip the path prefix)
app.use(createProxyMiddleware({
    target: 'https://localhost:11557',
    secure: false,
    changeOrigin: true,
    pathFilter: ['/search', '/gallery', '/galleries', '/refresh', '/facets', '/index'],
}));

// Proxy to downloader
app.use(createProxyMiddleware({
    target: 'https://localhost:11558',
    secure: false,
    changeOrigin: true,
    pathFilter: ['/immediate', '/sync', '/sync/status', '/queries', '/remove', '/remove/status', '/artists'],
}));

// Body parsing (after proxy routes, so proxied requests keep their raw stream)
app.use(express.json({ limit: CONFIG.BATCH_LIMIT }));

// Frontend static serving (built SvelteKit)
if (fs.existsSync(CONFIG.FRONTEND_BUILD_PATH)) {
    app.use(express.static(CONFIG.FRONTEND_BUILD_PATH));
}

// Frontend log endpoint — receives client-side errors for journalctl visibility
app.post('/api/log', (req, res) => {
    const { event, data } = req.body;
    if (!event || typeof event !== 'string') {
        return res.status(400).end();
    }
    console.log(`[Frontend] ${event}`, data ? JSON.stringify(data) : '');
    res.status(204).end();
});

// API Routes
app.get('/api/cert', (_req, res) => {
    const certPath = path.join(os.homedir(), '.local/share/mkcert/rootCA.pem');
    if (fs.existsSync(certPath)) {
        res.setHeader('Content-Type', 'application/x-pem-file');
        res.sendFile(certPath);
    } else {
        res.status(404).json({ error: 'Root CA not found' });
    }
});

app.post('/api/ocr/lookup', handleOcrLookupRequest);
app.post('/api/batch', handleBatchRequest);
app.post('/api/delete', handleDeleteRequest);

// Media static serving (gallery images)
app.use('/media', express.static(CONFIG.MEDIA_ROOT, {
    dotfiles: 'allow',
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
}));

// SPA fallback — serve index.html for non-API, non-media routes
app.get(/^\/(?!api|media).*/, (_req, res) => {
    const indexPath = path.join(CONFIG.FRONTEND_BUILD_PATH, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Frontend not built');
    }
});

// Start Server
try {
    const server = createHttpsServer(app);
    server.listen(CONFIG.PORT, '0.0.0.0', () => {
        console.log(`Streamer running on port ${CONFIG.PORT}`);
        console.log(`Serving media: ${CONFIG.MEDIA_ROOT}`);
        console.log(`Serving frontend: ${CONFIG.FRONTEND_BUILD_PATH}`);

        // Log Network Interfaces
        const networkInterfaces = os.networkInterfaces();
        Object.keys(networkInterfaces).forEach((ifaceName) => {
            networkInterfaces[ifaceName]?.forEach((iface) => {
                if (iface.family === 'IPv4' && !iface.internal) {
                    console.log(`LAN: https://${iface.address}:${CONFIG.PORT}`);
                }
            });
        });
    });
} catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
}
