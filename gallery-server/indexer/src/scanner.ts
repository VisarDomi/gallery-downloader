import { spawn } from 'child_process';
import path from 'path';
import { Gallery } from './types.js';

const MEDIA_ROOT = '/home/visar/Pictures';
const BINARY_PATH = path.join(process.cwd(), 'src', 'bin', 'scanner');

export async function scanLibrary(): Promise<Gallery[]> {
    console.log('Scanning library...');
    const start = Date.now();

    return new Promise((resolve, _reject) => {
        const child = spawn(BINARY_PATH, [MEDIA_ROOT]);

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        child.on('close', (code) => {
            if (code !== 0) {
                console.error(`Scanner binary failed: ${stderr}`);
                resolve([]);
                return;
            }

            try {
                // Direct parse, no object reconstruction overhead
                const galleries: Gallery[] = JSON.parse(stdout);

                const duration = (Date.now() - start) / 1000;
                console.log(`Scan complete. Indexed ${galleries.length} galleries in ${duration}s.`);
                resolve(galleries);
            } catch (e) {
                console.error('Failed to parse scanner output', e);
                resolve([]);
            }
        });

        child.on('error', (err) => {
            console.error('Failed to spawn scanner binary', err);
            resolve([]);
        });
    });
}