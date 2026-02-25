import path from 'path';
import os from 'os';

export const CONFIG = {
    PORT: 29749,
    MEDIA_ROOT: '/home/visar/Pictures',
    SSL_DIR: path.join(os.homedir(), '.local/share/mkcert/pwa'),
    BATCH_LIMIT: '200mb',
    FRONTEND_BUILD_PATH: '/home/visar/Documents/manga-repos/hitomi-frontend/build'
};
