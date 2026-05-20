import path from 'path';
import os from 'os';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STREAMER_ROOT = path.resolve(__dirname, '..');

export const CONFIG = {
    PORT: 11556,
    OCR_PORT: 11559,
    OCR_SERVICE_URL: process.env.GALLERY_OCR_SERVICE_URL ?? 'https://localhost:11559',
    MEDIA_ROOT: '/home/visar/Pictures',
    SSL_DIR: path.join(os.homedir(), '.local/share/mkcert/pwa'),
    BATCH_LIMIT: '200mb',
    FRONTEND_BUILD_PATH: path.resolve(STREAMER_ROOT, '..', '..', 'gallery-app', 'build'),
    OCR_IMAGE_LIMIT: '20mb',
    OCR_PYTHON: path.resolve(STREAMER_ROOT, '..', '.venvs', 'paddleocr-venv', 'bin', 'python'),
    OCR_MANGA_PYTHON: path.resolve(STREAMER_ROOT, '..', '.venvs', 'mangaocr-venv', 'bin', 'python'),
    OCR_RUNNER: path.resolve(STREAMER_ROOT, 'src', 'ocr', 'paddle_lookup.py'),
    OCR_VIEWPORT_RUNNER: path.resolve(STREAMER_ROOT, 'src', 'ocr', 'viewport_lookup.py'),
    OCR_WORKER: path.resolve(STREAMER_ROOT, 'src', 'ocr', 'ocr_worker.py'),
    OCR_MANGA_WORKER: path.resolve(STREAMER_ROOT, 'src', 'ocr', 'ocr_worker_manga.py'),
    OCR_PADDLE_VL_WORKER: path.resolve(STREAMER_ROOT, 'src', 'ocr', 'ocr_worker_paddlevl.py'),
    OCR_PRELOAD_DELAY_MS: Number(process.env.GALLERY_OCR_PRELOAD_DELAY_MS ?? 5 * 60 * 1000),
    OCR_DEBUG_ARTIFACTS: process.env.GALLERY_OCR_DEBUG_ARTIFACTS === '1',
};
