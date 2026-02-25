import path from 'path';
import os from 'os';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CONFIG = {
    PORT: 29749,
    MEDIA_ROOT: '/home/visar/Pictures',
    SSL_DIR: path.join(os.homedir(), '.local/share/mkcert/pwa'),
    BATCH_LIMIT: '200mb',
    FRONTEND_BUILD_PATH: path.resolve(__dirname, '..', '..', '..', 'gallery-reader', 'build'),
};
