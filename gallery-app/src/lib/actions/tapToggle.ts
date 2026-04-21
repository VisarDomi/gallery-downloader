interface TapToggleOptions {
    onTap: () => void;
}

export function tapToggle(node: HTMLElement, options: TapToggleOptions) {
    let opts = options;

    function isInteractiveTarget(target: EventTarget | null): boolean {
        return target instanceof Element && !!target.closest('button, a, input, textarea, select, [role="button"]');
    }

    function onClick(event: MouseEvent) {
        if (isInteractiveTarget(event.target)) return;
        opts.onTap();
    }

    node.addEventListener('click', onClick);

    return {
        update(newOptions: TapToggleOptions) {
            opts = newOptions;
        },
        destroy() {
            node.removeEventListener('click', onClick);
        }
    };
}
