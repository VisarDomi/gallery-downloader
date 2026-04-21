export class ToastState {
    items = $state<{ id: number; message: string }[]>([]);
    private nextId = 0;
    private timerIds = new Map<number, ReturnType<typeof setTimeout>>();

    private clearTimer(id: number) {
        const timerId = this.timerIds.get(id);
        if (!timerId) return;
        clearTimeout(timerId);
        this.timerIds.delete(id);
    }

    private scheduleDismiss(id: number, duration: number) {
        this.clearTimer(id);
        const timerId = setTimeout(() => {
            this.timerIds.delete(id);
            this.items = this.items.filter((t) => t.id !== id);
        }, duration);
        this.timerIds.set(id, timerId);
    }

    show(message: string, duration = 2000) {
        const id = this.nextId++;
        this.items = [...this.items, { id, message }];
        this.scheduleDismiss(id, duration);
        return id;
    }

    showPersistent(message: string) {
        const id = this.nextId++;
        this.items = [...this.items, { id, message }];
        return id;
    }

    update(id: number, message: string) {
        this.items = this.items.map((toast) => (toast.id === id ? { ...toast, message } : toast));
    }

    dismiss(id: number) {
        this.clearTimer(id);
        this.items = this.items.filter((toast) => toast.id !== id);
    }

    dismissLater(id: number, duration = 2000) {
        if (!this.items.some((toast) => toast.id === id)) return;
        this.scheduleDismiss(id, duration);
    }

    destroy() {
        for (const timerId of this.timerIds.values()) clearTimeout(timerId);
        this.timerIds.clear();
        this.items = [];
    }
}
