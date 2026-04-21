import path from 'path';
import os from 'os';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STREAMER_ROOT = path.resolve(__dirname, '..');

export const CONFIG = {
    PORT: 11556,
    MEDIA_ROOT: '/home/visar/Pictures',
    SSL_DIR: path.join(os.homedir(), '.local/share/mkcert/pwa'),
    BATCH_LIMIT: '200mb',
    FRONTEND_BUILD_PATH: path.resolve(STREAMER_ROOT, '..', '..', 'gallery-app', 'build'),
    OCR_IMAGE_LIMIT: '20mb',
    OCR_PYTHON: path.join(os.homedir(), '.local', 'share', 'ocr', 'paddleocr-venv', 'bin', 'python'),
    OCR_RUNNER: path.resolve(STREAMER_ROOT, 'src', 'ocr', 'paddle_lookup.py'),
    OCR_VIEWPORT_RUNNER: path.resolve(STREAMER_ROOT, 'src', 'ocr', 'viewport_lookup.py'),
    OCR_WORKER: path.resolve(STREAMER_ROOT, 'src', 'ocr', 'ocr_worker.py'),
    OCR_WARM_IDLE_MS: 60 * 60 * 1000,
};
