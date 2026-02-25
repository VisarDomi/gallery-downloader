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

const app = express();

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

app.post('/cancel', (_req, res) => {
    queueManager.cancel();
    res.json({ status: 'stopped' });
});

// --- START ---
server.listen(CONFIG.PORT, '0.0.0.0', () => {
    logServerInfo(CONFIG.PORT);
});