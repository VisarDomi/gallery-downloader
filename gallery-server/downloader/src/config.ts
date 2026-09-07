import path from 'path';
import os from 'os';
import url from 'url';
import { hitomi } from 'gallery-sources';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GALLERY_DL = path.join(REPO_ROOT, 'gallery-dl');
const MEDIA_ROOT = path.join(os.homedir(), 'Pictures');

export const CONFIG = {
    PORT: 7777,
    PYTHON_PATH: path.join(GALLERY_DL, '.venv', 'bin', 'python3'),
    GALLERY_DL_SCRIPT: path.join(GALLERY_DL, 'gallery_dl'),
    WORKING_DIR: MEDIA_ROOT,
    BASE_ARGS: [
        ...hitomi.download.baseArgs,
        // Files, not a stale archive entry, decide what needs repair. gallery-dl
        // skips existing files and resumes .part files without an archive DB.
        '-o', 'extractor.hitomi.archive=null',
    ],
    CHROMIUM: {
        EXECUTABLE: process.env.GALLERY_CHROMIUM_EXECUTABLE ?? '/usr/bin/chromium',
        USER_DATA_DIR: process.env.GALLERY_CHROMIUM_PROFILE ?? path.join(os.homedir(), '.config', 'chromium-gallery'),
    },
    SSL: {
        KEY: path.join(os.homedir(), '.local/share/mkcert/pwa/key.pem'),
        CERT: path.join(os.homedir(), '.local/share/mkcert/pwa/cert.pem'),
    }
};
