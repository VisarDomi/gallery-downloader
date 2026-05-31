export type LogEvent =
    // Boot & lifecycle
    | { event: 'boot-start' }
    | { event: 'boot-ready'; ms: number; view: string }
    | { event: 'init-crash'; message: string; stack: string; ms: number }
    | { event: 'crash-detected'; lastAction: string; lastView: string; lastPage: number }
    | { event: 'restore-none' }
    | { event: 'restore-start'; view: string; galleryId: number | null; hasQuery: boolean }
    | { event: 'restore-ok'; view: string; galleryId?: number }
    | { event: 'restore-fallback'; view: string; reason: string }
    | { event: 'resume'; kind: string; elapsedMs: number }
    | { event: 'refresh-index-failed'; message: string }
    // Navigation
    | { event: 'view-push'; from: string; to: string }
    | { event: 'view-pop'; from: string; to: string }
    | { event: 'view-transition'; from: string; to: string; frameMs: number }
    // Pagination
    | { event: 'page-change'; view: string; from: number; to: number; totalItems: number }
    // Search & favorites
    | { event: 'search-failed'; error: string }
    | { event: 'favorites-load-failed'; error: string }
    | { event: 'queries-load-failed'; error: string }
    // Artists
    | { event: 'artists-loaded'; count: number }
    | { event: 'artists-load-failed'; error: string }
    | { event: 'artists-enqueue'; type: string; line: string }
    | { event: 'artists-add-ok'; line: string; status: string }
    | { event: 'artists-remove-start'; line: string }
    | { event: 'artists-remove-ok'; line: string }
    | { event: 'artists-remove-poll'; phase: string }
    | { event: 'artists-op-failed'; type: string; line: string; error: string }
    // Reader loading
    | { event: 'reader-setup'; galleryId: number; pageCount: number; startPage: number; hasRoot: boolean }
    | { event: 'reader-idle-done'; galleryId: number; idleCallbacks: number; pagesScheduled: number }
    | { event: 'reader-drop'; galleryId: number; total: number; loaded: number; failed: number; idle: number; observer: number; eager: number; idleCallbacks: number; idleComplete: boolean; elapsedMs: number }
    | { event: 'reader-ocr-button-toggle'; visible: boolean }
    | { event: 'reader-ocr-trigger'; source: 'swipe' | 'button' }
    | { event: 'reader-ocr-request-built'; source: 'swipe' | 'button'; elapsedMs: number; imageCount: number; viewportWidth: number; viewportHeight: number; scale: number }
    | { event: 'reader-ocr-response'; source: 'swipe' | 'button'; backend: string; runCount: number; elapsedMs: number; textLength: number; lineCount: number }
    | { event: 'reader-ocr-handoff'; source: 'swipe' | 'button'; elapsedMs: number }
    | { event: 'reader-ocr-failed'; source: 'swipe' | 'button'; phase: string; elapsedMs: number; message: string }
    // Database
    | { event: 'db-error'; op: string; error: string }
    // Global errors
    | { event: 'uncaught-error'; message: string; source: string; line: number; col: number; stack: string }
    | { event: 'unhandled-rejection'; message: string; stack: string };

type EventName = LogEvent['event'];
type PayloadOf<E extends EventName> = Omit<Extract<LogEvent, { event: E }>, 'event'>;
type HasPayload<E extends EventName> = keyof PayloadOf<E> extends never ? false : true;

export type LogEmit = <E extends EventName>(
    ...args: HasPayload<E> extends true ? [event: E, data: PayloadOf<E>] : [event: E]
) => void;

export class LogService {
    private cleanups: (() => void)[] = [];

    start(): void {
        if (typeof window === 'undefined') return;

        const onError = (event: ErrorEvent) => {
            this.emit('uncaught-error', {
                message: event.message,
                source: event.filename ?? '',
                line: event.lineno ?? 0,
                col: event.colno ?? 0,
                stack: event.error?.stack ?? '',
            });
        };

        const onRejection = (event: PromiseRejectionEvent) => {
            const reason = event.reason;
            this.emit('unhandled-rejection', {
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

    emit: LogEmit = ((event: string, data?: Record<string, unknown>) => {
        fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, data }),
        }).catch(() => {});
    }) as LogEmit;

    destroy(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
    }
}
