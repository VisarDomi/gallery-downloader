export class ToastState {
    items = $state<{ id: number; message: string }[]>([]);
    private nextId = 0;

    show(message: string, duration = 2000) {
        const id = this.nextId++;
        this.items = [...this.items, { id, message }];
        setTimeout(() => {
            this.items = this.items.filter(t => t.id !== id);
        }, duration);
    }
}
