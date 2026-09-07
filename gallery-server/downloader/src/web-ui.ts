import express from 'express';
import path from 'node:path';

export function webUi(publicDir: string) {
    const router = express.Router();
    router.get(['/downloader', '/downloader/'], (_req, res) => {
        res.sendFile(path.join(publicDir, 'index.html'));
    });
    // The old /offline/ URL is intentionally not mounted or redirected.
    router.use(express.static(path.join(publicDir, 'offline')));
    return router;
}
