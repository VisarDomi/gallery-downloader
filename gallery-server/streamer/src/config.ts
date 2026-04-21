import path from 'path';
import os from 'os';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CONFIG = {
    PORT: 11556,
    MEDIA_ROOT: '/home/visar/Pictures',
    SSL_DIR: path.join(os.homedir(), '.local/share/mkcert/pwa'),
    BATCH_LIMIT: '200mb',
    FRONTEND_BUILD_PATH: path.resolve(__dirname, '..', '..', '..', 'gallery-app', 'build'),
    OCR_IMAGE_LIMIT: '20mb',
    OCR_PYTHON: path.join(os.homedir(), '.local', 'share', 'ocr', 'paddleocr-venv', 'bin', 'python'),
    OCR_RUNNER: path.resolve(__dirname, 'ocr', 'paddle_lookup.py'),
};
