#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = path.join(projectRoot, '.env');

function readEnvFile(filename) {
    if (!fs.existsSync(filename)) return {};
    return Object.fromEntries(fs.readFileSync(filename, 'utf8')
        .split(/\r?\n/)
        .map(line => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/))
        .filter(Boolean)
        .map(([, key, rawValue]) => {
            const quoted = rawValue.match(/^(['"])(.*)\1$/);
            return [key, quoted ? quoted[2] : rawValue];
        }));
}

const config = { ...readEnvFile(envPath), ...process.env };
const apiKey = config.KOMGA_API_KEY || config.KOGMA_API_KEY;
const serverUrl = (config.KOMGA_URL || config.KOGMA_URL || 'http://127.0.0.1:25600').replace(/\/$/, '');
const libraryRoot = config.KOMGA_LIBRARY_ROOT || config.KOGMA_LIBRARY_ROOT
    || path.join(os.homedir(), 'Pictures', 'komga');

if (!apiKey) throw new Error(`KOMGA_API_KEY (or KOGMA_API_KEY) is missing from ${envPath}`);

const headers = { 'X-API-Key': apiKey };
const librariesResponse = await fetch(`${serverUrl}/api/v1/libraries`, { headers });
if (!librariesResponse.ok) throw new Error(`Komga library lookup failed: HTTP ${librariesResponse.status}`);
const libraries = await librariesResponse.json();
const library = libraries.find(candidate => candidate.root === libraryRoot);
if (!library) throw new Error(`Komga has no library rooted at ${libraryRoot}`);

const scanResponse = await fetch(`${serverUrl}/api/v1/libraries/${library.id}/scan`, {
    method: 'POST',
    headers,
});
if (!scanResponse.ok) throw new Error(`Komga scan request failed: HTTP ${scanResponse.status}`);
console.log(`Komga scan requested for ${library.name} (${library.id})`);
