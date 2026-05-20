import express from 'express';
import cors from 'cors';
import { CONFIG } from './config.js';
import { createHttpsServer } from './ssl.js';
import { handleOcrBackendsRequest, handleOcrLookupRequest, scheduleDefaultOcrWarmup } from './ocr.js';

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: CONFIG.BATCH_LIMIT }));

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/ocr/backends', handleOcrBackendsRequest);
app.post('/api/ocr/lookup', handleOcrLookupRequest);

try {
    const server = createHttpsServer(app);
    server.listen(CONFIG.OCR_PORT, '127.0.0.1', () => {
        console.log(`Gallery OCR running on port ${CONFIG.OCR_PORT}`);
        scheduleDefaultOcrWarmup();
    });
} catch (e) {
    console.error('Failed to start OCR service:', e);
    process.exit(1);
}
