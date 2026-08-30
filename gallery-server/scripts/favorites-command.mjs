import https from 'https';

const action = process.argv[2];
const provider = process.argv[3] ?? 'hitomi';
if (action !== 'sync' && action !== 'reconcile') {
    console.error('Usage: node favorites-command.mjs <sync|reconcile> [hitomi|imhentai]');
    process.exit(2);
}
if (provider !== 'hitomi' && provider !== 'imhentai') {
    console.error('provider must be hitomi or imhentai');
    process.exit(2);
}

const serverUrl = (process.env.GALLERY_SERVER_URL ?? 'https://localhost:7777').replace(/\/$/, '');
const operationPath = `/api/favorites/${provider}/${action}`;
const statusPath = `${operationPath}/status`;

function request(method, requestPath) {
    return new Promise((resolve, reject) => {
        const request = https.request(`${serverUrl}${requestPath}`, {
            method,
            rejectUnauthorized: false,
            headers: method === 'POST' ? { 'Content-Length': '0' } : undefined,
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                let data;
                try { data = body ? JSON.parse(body) : {}; }
                catch { data = { body }; }
                if ((response.statusCode ?? 500) >= 400) {
                    reject(new Error(`${response.statusCode}: ${JSON.stringify(data)}`));
                    return;
                }
                resolve(data);
            });
        });
        request.on('error', reject);
        request.end();
    });
}

await request('POST', operationPath);

while (true) {
    const status = await request('GET', statusPath);
    if (status.phase === 'done') {
        console.log(JSON.stringify(status, null, 2));
        break;
    }
    if (status.phase === 'error') {
        console.error(JSON.stringify(status, null, 2));
        process.exit(1);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
}
