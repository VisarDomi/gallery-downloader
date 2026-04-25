import https from 'https';

const STREAMER_PORT = 11556;

export interface DeletionResult {
    deleted: number[];
    skipped: { id: number; reason: string }[];
}

export function requestDeletion(ids: number[]): Promise<DeletionResult> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ ids });
        const req = https.request(
            {
                hostname: 'localhost',
                port: STREAMER_PORT,
                path: '/api/delete',
                method: 'POST',
                rejectUnauthorized: false,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`Streamer deletion failed (${res.statusCode}): ${data}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data) as DeletionResult);
                    } catch {
                        reject(new Error(`Bad response from streamer: ${data}`));
                    }
                });
            },
        );
        req.on('error', (err) => reject(new Error(`Streamer connection failed: ${err.message}`)));
        req.write(body);
        req.end();
    });
}
