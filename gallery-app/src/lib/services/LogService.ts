export type LogFn = (event: string, data?: Record<string, unknown>) => void;

export class LogService {
    private cleanups: (() => void)[] = [];

    /** Register global error handlers. Call once during app init. */
    start(): void {
        if (typeof window === 'undefined') return;

        const onError = (event: ErrorEvent) => {
            this.log('uncaught-error', {
                message: event.message,
                source: event.filename ?? '',
                line: event.lineno ?? 0,
                col: event.colno ?? 0,
                stack: event.error?.stack ?? '',
            });
        };

        const onRejection = (event: PromiseRejectionEvent) => {
            const reason = event.reason;
            this.log('unhandled-rejection', {
                message: String(reason?.message ?? reason),
                stack: reason?.stack ?? '',
            });
        };

        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        this.cleanups.push(
            () => window.removeEventListener('error', onError),
            () => window.removeEventListener('unhandledrejection', onRejection),
        );
    }

    log(event: string, data?: Record<string, unknown>): void {
        fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, data }),
        }).catch(() => {});
    }

    destroy(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
    }
}
