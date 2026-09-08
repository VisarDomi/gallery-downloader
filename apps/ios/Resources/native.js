document.getElementById('download').hidden = true;
// Reuse the PWA UI and document navigation. Storage RPCs go to Swift actors.
window.nativeGallery = {
    createWorker() {
        let alive = true;
        const previews = new Map();
        const worker = {
            onmessage: null,
            async postMessage({ id, command, args = {} }) {
                try {
                    const result = JSON.parse(await window.webkit.messageHandlers.gallery.postMessage({ command, args }));
                    if (!alive) return;
                    if (command === 'init') update(result);
                    worker.onmessage?.({ data: { id, result } });
                } catch (error) {
                    if (alive) worker.onmessage?.({ data: { id, error: error.message } });
                }
            },
            terminate() { alive = false; window.removeEventListener('native-library', receive); }
        };
        function update(state) {
            if (state.catalog) worker.onmessage?.({ data: { type: 'catalog', catalog: state.catalog, downloads: state.downloads } });
            else worker.onmessage?.({ data: { type: 'native-progress', states: state.downloads } });
            worker.onmessage?.({ data: { type: 'download-status', running: state.running, message: state.message } });
            for (const item of state.downloads) {
                if (!item.key.endsWith(':thumbs')) continue;
                if (previews.get(item.key) !== item.downloaded) {
                    previews.set(item.key, item.downloaded);
                    worker.onmessage?.({ data: { type: 'previews-ready', key: item.key.slice(0, -7) } });
                }
            }
            document.getElementById('download').hidden = true;
        }
        function receive(event) { if (alive) update(event.detail); }
        window.addEventListener('native-library', receive);
        return worker;
    }
};
