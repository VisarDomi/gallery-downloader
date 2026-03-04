import { spawn } from 'child_process';
import path from 'path';

const MEDIA_ROOT = '/home/visar/Pictures';
const DB_PATH = path.join(MEDIA_ROOT, 'gallery-dl', 'gallery-index.db');
const BINARY_PATH = path.join(process.cwd(), 'src', 'bin', 'scanner');

export async function runScan(): Promise<void> {
    console.log('Scanning library...');
    const start = Date.now();

    return new Promise((resolve, _reject) => {
        const child = spawn(BINARY_PATH, [MEDIA_ROOT, DB_PATH]);

        let stderr = '';

        child.stdout.on('data', (chunk) => {
            // Scanner now prints summary to stdout
            process.stdout.write(chunk);
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        child.on('close', (code) => {
            const duration = (Date.now() - start) / 1000;
            if (code !== 0) {
                console.error(`Scanner failed (${duration}s): ${stderr}`);
            } else {
                console.log(`Scan finished in ${duration}s`);
            }
            resolve();
        });

        child.on('error', (err) => {
            console.error('Failed to spawn scanner binary', err);
            resolve();
        });
    });
}
