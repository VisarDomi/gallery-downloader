import assert from 'node:assert/strict';
import test from 'node:test';
import { freshState, recoverCheckpoint, validateManifest, appendPage } from '../downloader/public/offline/storage.js';

const manifest = { key: 'hitomi-123', revision: 'a'.repeat(24), bytes: 11, pages: [
    { size: 5, offset: 0, url: '/offline-api/hitomi/123/pages/hitomi_123_1.jpg' },
    { size: 6, offset: 5, url: '/offline-api/hitomi/123/pages/hitomi_123_2.jpg' },
] };

test('manifest validation rejects bad offsets, lengths, revisions and foreign URLs', () => {
    assert.equal(validateManifest(manifest, 'hitomi-123'), manifest);
    assert.throws(() => validateManifest(manifest, 'imhentai-123'));
    for (const patch of [{ revision: '../bad' }, { bytes: 20 }, { pages: [{ size: 5, offset: 0, url: 'https://other.test/page.jpg' }] }]) {
        assert.throws(() => validateManifest({ ...manifest, ...patch }, manifest.key));
    }
    assert.throws(() => validateManifest({ ...manifest, pages: manifest.pages.map(p => ({ ...p, url: p.url.replace('/hitomi/123/', '/imhentai/123/') })) }, manifest.key));
    assert.throws(() => validateManifest({ ...manifest, kind: 'thumbnails' }, manifest.key), /page manifest/);
});

test('resume trusts only the committed prefix; missing files restart and incomplete tails do not advance', () => {
    const partial = { ...freshState(manifest), downloaded: 1, bytes: 5 };
    assert.equal(recoverCheckpoint(manifest, partial, 8).downloaded, 1);
    assert.equal(recoverCheckpoint(manifest, partial, 4).downloaded, 0);
    assert.equal(recoverCheckpoint(manifest, { ...partial, bytes: 8 }, 8).downloaded, 0);
    assert.equal(recoverCheckpoint(manifest, { ...partial, revision: 'b'.repeat(24) }, 11).downloaded, 0);
    assert.equal(recoverCheckpoint(manifest, { ...partial, downloaded: 2, bytes: 11 }, 11).complete, true);
});

test('page streaming handles short writes and flushes only a complete page', async () => {
    const bytes = new Uint8Array(11); let flushes = 0;
    const access = { write(chunk, { at }) { const n = Math.min(2, chunk.length); bytes.set(chunk.subarray(0, n), at); return n; }, flush() { flushes++; } };
    await appendPage(access, new Response('first', { headers: { 'content-type': 'image/jpeg' } }), manifest.pages[0], new AbortController().signal);
    assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), 'first');
    assert.equal(flushes, 1);
    await assert.rejects(appendPage(access, new Response('short', { headers: { 'content-type': 'image/jpeg' } }), manifest.pages[1], new AbortController().signal), /truncated/);
    assert.equal(flushes, 1);
    await assert.rejects(appendPage(access, new Response('not an image'), manifest.pages[0], new AbortController().signal), /failed/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(appendPage(access, new Response('first', { headers: { 'content-type': 'image/jpeg' } }), manifest.pages[0], controller.signal), { name: 'AbortError' });
    assert.equal(flushes, 1);
});
