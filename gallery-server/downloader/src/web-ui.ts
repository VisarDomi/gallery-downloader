import express from 'express';
import path from 'node:path';

export function webUi(publicDir: string) {
    const router = express.Router();
    router.get(['/downloader', '/downloader/'], (_req, res) => {
        res.sendFile(path.join(publicDir, 'index.html'));
    });
    return router;
}
