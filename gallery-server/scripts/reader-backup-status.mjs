import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../backups/readers/', import.meta.url));
const rows = [];
for (const app of ['gallery-reader', 'manga-reader']) {
    const directory = path.join(root, app);
    if (!fs.existsSync(directory)) continue;
    for (const provider of fs.readdirSync(directory)) {
        for (const file of fs.readdirSync(path.join(directory, provider)).filter(file => file.endsWith('.json'))) {
            const value = JSON.parse(fs.readFileSync(path.join(directory, provider, file), 'utf8'));
            const data = value.current.data;
            rows.push({ reader: app, provider, phone: value.label, id: value.id.slice(0, 8), saved: value.current.savedAt,
                records: app === 'gallery-reader'
                    ? `${data.indexedDB.favorites.length} favorites; ${data.indexedDB.searches.length} searches`
                    : `${data.indexedDB.progress.length} series; ${data.indexedDB.tokens.length} session records`,
                previous: value.previous?.savedAt ?? 'none',
            });
        }
    }
}
if (rows.length) console.table(rows);
else console.log('No phone backups received yet. Install the new userscripts and visit each provider home before formatting.');
