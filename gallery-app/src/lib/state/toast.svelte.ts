export class ToastState {
    items = $state<{ id: number; message: string }[]>([]);
    private nextId = 0;
    private timerIds = new Set<ReturnType<typeof setTimeout>>();

    show(message: string, duration = 2000) {
        const id = this.nextId++;
        this.items = [...this.items, { id, message }];
        const timerId = setTimeout(() => {
            this.timerIds.delete(timerId);
            this.items = this.items.filter(t => t.id !== id);
        }, duration);
        this.timerIds.add(timerId);
    }

    destroy() {
        for (const t of this.timerIds) clearTimeout(t);
        this.timerIds.clear();
        this.items = [];
    }
}
