import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const app = readFileSync(new URL('../downloader/public/offline/app.js', import.meta.url), 'utf8');
const helpers = app.split('// End shared reader behavior.')[0];
function runtime() {
    let now = 0, id = 0;
    const timers = new Map();
    const window = new EventTarget(), document = new EventTarget();
    document.hidden = false; document.visibilityState = 'visible';
    window.setTimeout = (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; };
    window.clearTimeout = timer => timers.delete(timer);
    const context = vm.createContext({ window, document, location: { origin: 'https://gallery.test' }, URL,
        Date: { now: () => now }, console });
    vm.runInContext(helpers, context);
    return { context, window, document, timers, tick(ms) {
        const end = now + ms;
        for (;;) {
            const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            if (!entry || entry[1].at > end) break;
            now = entry[1].at; timers.delete(entry[0]); entry[1].fn();
        }
        now = end;
    } };
}

test('scroll saves wait for scrollend, with no periodic timer or post-scroll delay', () => {
    const r = runtime(); let saves = 0;
    r.context.save = () => saves++;
    const schedule = vm.runInContext('onSettledScroll(save)', r.context);
    r.window.dispatchEvent(new Event('scroll'));
    schedule(); r.tick(1000);
    assert.equal(saves, 0); assert.equal(r.timers.size, 0);
    r.window.dispatchEvent(new Event('scrollend'));
    assert.equal(saves, 1, 'No extra settling delay');
    r.window.dispatchEvent(new Event('pagehide')); schedule();
    assert.equal(saves, 1);
    r.window.dispatchEvent(new Event('pageshow')); schedule();
    assert.equal(saves, 2);
    r.document.hidden = true; schedule();
    assert.equal(saves, 2);
    assert.ok(!app.includes('positionTimer'));
    assert.ok(app.includes("event.target instanceof Element"), 'Horizontal strip checkpoint remains');
});

test('failed images retry beyond three attempts without an error event, then stop when healthy', () => {
    const r = runtime(), writes = [];
    let src = 'https://gallery.test/media/test';
    const image = { isConnected: true, naturalWidth: 0, complete: true,
        getAttribute: () => src, get src() { return src; }, set src(value) { src = value; writes.push(value); } };
    r.context.image = image;
    vm.runInContext('registerImage(image)', r.context);
    r.tick(16000);
    const attempts = writes.filter(Boolean);
    assert.equal(attempts.length, 4, 'Retry at 1, 3, 7 and 15 seconds');
    assert.deepEqual(attempts.map(url => new URL(url).searchParams.get('retry')), ['1000', '3000', '7000', '15000']);
    assert.ok(writes.every((value, index) => index % 2 ? value !== '' : value === ''), 'Clear src before retrying');
    r.document.visibilityState = 'hidden'; r.tick(20000);
    assert.equal(writes.filter(Boolean).length, 4);
    r.document.visibilityState = 'visible'; image.naturalWidth = 100; r.tick(1000);
    assert.equal(vm.runInContext('registeredImageCount()', r.context), 0);
    assert.equal(r.timers.size, 0, 'Healthy page has no retry timer');
});

test('released images stop retrying; off-origin URLs retain their original query', () => {
    const r = runtime(), writes = [];
    let src = 'https://source.test/image?signature=fixture';
    const image = { isConnected: true, naturalWidth: 0, complete: true,
        getAttribute: () => src, get src() { return src; }, set src(value) { src = value; writes.push(value); } };
    r.context.image = image; vm.runInContext('registerImage(image)', r.context);
    r.tick(1000); assert.equal(src, 'https://source.test/image?signature=fixture');
    src = ''; r.tick(1000); assert.equal(r.timers.size, 0);
    assert.equal(writes.length, 2);
    assert.ok(app.includes('img.src = slot.url;\n        registerImage(img);'), 'Register actual displayed images');
    assert.ok(!app.includes('slot.retries'));
});
