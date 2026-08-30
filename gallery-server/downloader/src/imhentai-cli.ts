import { imhentai } from 'gallery-sources';
import { downloadImhentaiGallery } from './imhentai-downloader.js';

const input = process.argv[2];
if (!input) {
    console.error('Usage: npm run download:imhentai -- <gallery ID or IMHentai URL>');
    process.exit(2);
}

const url = /^\d+$/.test(input) ? imhentai.toSourceUrl(input) : input;
try {
    const result = await downloadImhentaiGallery(url, { log: console.log });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
} catch (error) {
    console.error(error);
    process.exit(1);
}
