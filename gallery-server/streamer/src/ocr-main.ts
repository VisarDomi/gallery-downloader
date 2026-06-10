import express from 'express';
import cors from 'cors';
import os from 'os';
import { CONFIG } from './config.js';
import { createHttpsServer } from './ssl.js';
import { handleOcrBackendsRequest, handleOcrLookupRequest, handleHitomiOcrLookupRequest, scheduleDefaultOcrWarmup } from './ocr.js';

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: CONFIG.BATCH_LIMIT }));

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/ocr/status', (_req, res) => {
    res.json({ available: true });
});

app.get('/api/ocr/backends', handleOcrBackendsRequest);
app.post('/api/ocr/lookup', handleOcrLookupRequest);
app.post('/api/ocr/hitomi', handleHitomiOcrLookupRequest);

try {
    const server = createHttpsServer(app);
    server.listen(CONFIG.OCR_PORT, '0.0.0.0', () => {
        console.log(`Gallery OCR running on port ${CONFIG.OCR_PORT}`);

        // Log network interfaces for phone access
        const networkInterfaces = os.networkInterfaces();
        Object.keys(networkInterfaces).forEach((ifaceName) => {
            networkInterfaces[ifaceName]?.forEach((iface) => {
                if (iface.family === 'IPv4' && !iface.internal) {
                    console.log(`LAN OCR: https://${iface.address}:${CONFIG.OCR_PORT}`);
                }
            });
        });

        scheduleDefaultOcrWarmup();
    });
} catch (e) {
    console.error('Failed to start OCR service:', e);
    process.exit(1);
}
