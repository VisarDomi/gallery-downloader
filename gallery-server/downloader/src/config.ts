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
    PORT: 29748,
    PYTHON_PATH: path.join(GALLERY_DL, '.venv', 'bin', 'python3'),
    GALLERY_DL_SCRIPT: path.join(GALLERY_DL, 'gallery_dl'),
    WORKING_DIR: MEDIA_ROOT,
    BASE_ARGS: [
        ...hitomi.download.baseArgs,
        '--download-archive',
        hitomi.download.archivePath(MEDIA_ROOT),
    ],
    SSL: {
        KEY: path.join(os.homedir(), '.local/share/mkcert/pwa/key.pem'),
        CERT: path.join(os.homedir(), '.local/share/mkcert/pwa/cert.pem'),
    }
};
