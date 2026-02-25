import fs from 'fs';
import path from 'path';
import https from 'https';
import { CONFIG } from './config.js';

export function createHttpsServer(app: any) {
    const keyPath = path.join(CONFIG.SSL_DIR, 'key.pem');
    const certPath = path.join(CONFIG.SSL_DIR, 'cert.pem');

    try {
        const options = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        return https.createServer(options, app);
    } catch (e) {
        console.error('SSL Error: Could not load certificates from', CONFIG.SSL_DIR);
        throw e;
    }
}