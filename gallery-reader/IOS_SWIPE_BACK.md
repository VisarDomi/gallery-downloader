# Implementing Native Swipe-Back in an iOS PWA

## The Problem

iOS Safari and standalone PWAs lie about viewport dimensions. `window.innerHeight` returns a value ~26px shorter than `screen.height`, leaving a black bar at the bottom of the app. This isn't just cosmetic — it cascades into every layout decision involving `position: fixed`, `transform`, and scroll position management.

Building a swipe-back gesture (slide the reader away to reveal the previous view) means fighting these lies at every step.

## What iOS Lies About

| API | Returns | Truth |
|-----|---------|-------|
| `window.innerHeight` | Visual viewport height (minus browser chrome/home indicator) | Not the full screen |
| `screen.height` | Actual screen height in CSS pixels | The truth |
| `100vh` in CSS | "Large viewport height" — varies by context | Unreliable on iOS |
| `position: fixed; inset: 0` | Caps element to `window.innerHeight` | Ignores real screen height |

The ~26px gap is the iOS home indicator area. `position: fixed` elements cannot extend into it, regardless of `viewport-fit=cover` or explicit height values.

## Failed Approaches (and Why)

### 1. Body-flow views with `position: fixed` hidden views
**Idea:** Active view in normal body scroll, hidden views as `position: fixed`.
**Problem:** Switching views requires transitioning elements between flow and fixed positioning. Each transition causes iOS to recalculate scroll, producing visible jumps.

### 2. `transform: translateX()` on body-flow elements
**Idea:** Slide the reader using CSS transform while it's in body flow.
**Problem:** Applying `transform` to any element in body flow causes iOS to shift the scroll position by the lie amount (~26px). This happens with `transform`, `left`, and `margin-left` — all produce the same scroll jump.

### 3. All views as `position: fixed` scroll containers
**Idea:** Every view is always `position: fixed; inset: 0; overflow-y: auto`. No view ever changes positioning mode. Only `visibility` toggles.
**Problem:** Fixes the scroll jumps during swipe (no positioning mode transitions), but all views are capped to `window.innerHeight`. Black bar at the bottom.

### 4. `position: fixed` with explicit `height: screen.height`
**Idea:** Override the height cap with the true screen height.
**Problem:** `position: fixed` elements are clipped to the visual viewport by iOS. Setting a larger height just extends the element off-screen below the viewport boundary. The visible area remains `window.innerHeight`.

### 5. CSS variable `--app-height` set from `screen.height` on mount
**Idea:** Set the height via JavaScript after mount.
**Problem:** Same as above — `position: fixed` ignores the larger height.

### 6. `will-change: transform` pre-promotion
**Idea:** Add `will-change: transform` on touchstart (before the swipe lock) to pre-create the compositing layer, hoping the later transform won't trigger scroll recalculation.
**Problem:** No effect. The scroll jump still occurs.

### 7. `transform: translateY()` for back view positioning
**Idea:** Position the back view using `transform: translateY(-savedScrollY)` to show the correct scroll position.
**Problem:** On iOS, the transform on a fixed element doesn't account for the viewport lie. The back view appears displaced by the ~26px lie amount, then snaps to the correct position on swipe release.

### 8. `scrollTop` on hidden views for back view positioning
**Idea:** Use the element's own `scrollTop` (set when the view was hidden) instead of transform.
**Problem:** `scrollTop` appears to reset or not persist correctly across class changes on iOS, producing the same displacement.

## The Solution

The final architecture combines insights from all failed attempts:

### Architecture: Absolute-positioned scroll containers in a truthfully-sized body

```
html, body {
    height: var(--app-height, 100vh);    /* screen.height = truth */
    position: relative;
    overflow: hidden;                     /* body never scrolls */
}

.view-layer {
    position: absolute;
    inset: 0;                            /* fills the body = fills the screen */
    overflow-y: auto;                    /* each view scrolls independently */
}
```

**Key insight:** `position: absolute` sizes relative to the containing block (the body), not the visual viewport. If the body is `screen.height` tall, absolute children are too. `position: fixed` sizes relative to the viewport, which iOS caps.

### Screen height is set synchronously before CSS evaluation

```html
<!-- In app.html <head>, before any stylesheets -->
<script>document.documentElement.style.setProperty('--app-height', screen.height + 'px');</script>
```

This must be synchronous (not in `onMount` or `$effect`) so the CSS variable is available for the first paint. No flash of wrong height.

### View layer management

All 4 views (list, favorites, saved searches, reader) are always mounted in the DOM as absolute-positioned scroll containers:

```html
<div class="view-layer" class:view-hidden={not active}>
    <ListView />
</div>
```

- **Active view:** `visibility: visible` (default), scrolls via `overflow-y: auto`
- **Hidden view:** `visibility: hidden; pointer-events: none`
- **No view ever changes positioning mode.** Only visibility toggles.

Scroll positions are preserved automatically — each container maintains its own `scrollTop` across visibility changes.

### The swipe gesture

Touch events on the reader detect edge swipes (left 30px zone):

1. **touchstart:** Record start position if within edge zone
2. **touchmove:** After 10px of movement, determine direction:
   - Vertical dominant → reject (normal scroll)
   - Horizontal dominant → lock as swipe, set `isSwiping = true`
3. **During swipe:** `transform: translateX(progress%)` slides the reader. The back view (previous view) becomes visible behind it via `visibility: visible`.
4. **touchend:**
   - Progress > 30% → animate to 100%, close reader after 250ms
   - Progress < 30% → animate back to 0%, cancel after 250ms

### Why this works on iOS

1. **No positioning mode transitions.** Views are always `position: absolute`. No switching between flow/fixed/absolute. iOS has nothing to recalculate.

2. **Body is the source of truth.** `screen.height` sizes the body via CSS variable. Absolute children inherit the real height. iOS can't cap it because `position: absolute` respects the containing block, not the viewport.

3. **Scroll is per-container.** Each view owns its `scrollTop`. No `window.scrollY` management, no `scrollPositions` maps, no save/restore. The browser just preserves `scrollTop` across visibility changes.

4. **Transform only on the reader.** During swipe, only the reader gets `transform: translateX()`. Since no view changes positioning mode, the transform doesn't trigger scroll recalculation. The back view is simply made visible — it's already at the correct scroll position.

### Required meta tags

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
```

`viewport-fit=cover` extends the viewport into safe areas. `black-translucent` allows the app to render behind the status bar.

## File Map

| File | Role |
|------|------|
| `src/app.html` | Synchronous `--app-height` variable, viewport meta tags |
| `src/lib/styles.css` | View layer positioning, swipe classes |
| `src/routes/+page.svelte` | View layer mounting, swipe class bindings |
| `src/lib/components/Reader.svelte` | Touch gesture detection and swipe state management |
| `src/lib/state.svelte.ts` | `UIState` with `viewMode`, `isSwiping`, `swipeProgress` |

## Summary

The iOS viewport lie (`window.innerHeight < screen.height`) breaks `position: fixed` layouts. The fix is to never use `position: fixed` for app views. Instead, size the body with `screen.height` (the truth) and use `position: absolute` children that inherit the real dimensions. Each view is an independent scroll container. Swipe-back works because no view ever changes positioning mode — only visibility and transform toggle.
