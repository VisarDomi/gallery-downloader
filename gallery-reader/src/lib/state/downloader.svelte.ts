import * as api from '../services/api.js';
import type { ToastState } from './toast.svelte.js';

export class DownloaderState {
    private toast: ToastState;

    constructor(toast: ToastState) {
        this.toast = toast;
    }

    async sendToDownloader(query: string) {
        if (!query) return;
        try {
            await api.sendToDownloader(query);
            this.toast.show('Queued for download');
        } catch (e) {
            console.error('Download failed:', e);
        }
    }
}
