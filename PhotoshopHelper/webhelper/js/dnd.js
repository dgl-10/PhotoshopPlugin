/** Drag / drop / touch for reference strips and Global Stage. */

const TOUCH_MOVE_THRESHOLD = 8;

let altHeld = false;
let altTracking = false;

function ensureAltTracking() {
    if (altTracking) return;
    altTracking = true;
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Alt') altHeld = true;
    });
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Alt') altHeld = false;
    });
    window.addEventListener('blur', () => {
        altHeld = false;
    });
}

export function isAltHeld(event) {
    return Boolean((event && event.altKey) || altHeld);
}

export function tryElectronDrag(event, images) {
    try {
        const ev = event && event.altKey ? event : { altKey: isAltHeld(event) };
        if (window.WHConfig?.tryElectronDrag?.(ev, images)) return true;
    } catch {
        /* fall through to in-app drag */
    }
    return false;
}

export function calcInsertionIdx(items, mouseX, mouseY) {
    if (!items.length) return 0;
    let bestIdx = items.length;
    let bestDist = Infinity;
    for (let i = 0; i < items.length; i++) {
        const rect = items[i].getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dist = Math.hypot(mouseX - cx, mouseY - cy);
        if (dist < bestDist) {
            bestDist = dist;
            bestIdx = mouseX < cx ? i : i + 1;
        }
    }
    return bestIdx;
}

/**
 * Bind reorder + cross-pool copy on a thumbnail strip.
 * payloadPrefix: 'ref' for task refs, 'glb' for Global Stage.
 */
export function bindStrip(container, options) {
    const {
        itemSelector,
        getItems,
        setItems,
        payloadPrefix,
        onExternalFiles,
        onWhRefImage,
        onPromptTag,
        onCrossPoolDrop,
        highlightSelector,
        autoOpen,
        skipSelfWhRef = false
    } = options;

    if (!container) return () => {};

    const cleanups = [];
    let dropInsertIdx = null;
    let touchDragFromIdx = null;
    let nativeDragActive = false;
    let touchStartX = 0;
    let touchStartY = 0;

    const removeSeparator = () => {
        container.querySelector('.wh-drop-separator')?.remove();
    };

    const showSeparator = (insertIdx) => {
        if (insertIdx === dropInsertIdx) return;
        removeSeparator();
        const sep = document.createElement('div');
        sep.className = 'wh-drop-separator';
        const items = [...container.querySelectorAll(itemSelector)];
        const addBtn = container.querySelector('.thumb-add');
        if (insertIdx < items.length) container.insertBefore(sep, items[insertIdx]);
        else container.insertBefore(sep, addBtn || null);
        dropInsertIdx = insertIdx;
    };

    ensureAltTracking();

    const items = [...container.querySelectorAll(itemSelector)];
    items.forEach((item) => {
        const idx = parseInt(item.dataset.index, 10);
        const img = item.querySelector('img');
        if (img) img.draggable = false;

        const onPointerDown = (e) => {
            if (payloadPrefix !== 'glb' || e.button !== 0) return;
            if (e.target.closest('.thumb-remove')) return;
            if (!isAltHeld(e)) return;
            const value = getItems()[idx];
            if (!value) return;
            if (tryElectronDrag(e, value)) {
                e.preventDefault();
            }
        };

        const onDragStart = (e) => {
            const list = getItems();
            const value = list[idx];
            if (payloadPrefix === 'glb' && isAltHeld(e) && tryElectronDrag(e, value)) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.setData('text/plain', `${payloadPrefix}:${idx}`);
            if (payloadPrefix === 'glb') {
                e.dataTransfer.setData('wh/ref-image', value);
                e.dataTransfer.effectAllowed = 'copy';
            } else {
                e.dataTransfer.effectAllowed = 'move';
            }
            e.stopPropagation();
            nativeDragActive = true;
            item.classList.add('is-dragging');
            item._dragSource = true;
        };

        const onDragEnd = () => {
            nativeDragActive = false;
            item.classList.remove('is-dragging');
            removeSeparator();
            dropInsertIdx = null;
        };

        const onTouchStart = (e) => {
            if (e.target.closest('.thumb-remove')) return;
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            touchDragFromIdx = idx;
        };

        item.addEventListener('pointerdown', onPointerDown);
        item.addEventListener('dragstart', onDragStart);
        item.addEventListener('dragend', onDragEnd);
        item.addEventListener('touchstart', onTouchStart, { passive: true });
        item.addEventListener('contextmenu', (e) => e.preventDefault());
        cleanups.push(() => {
            item.removeEventListener('pointerdown', onPointerDown);
            item.removeEventListener('dragstart', onDragStart);
            item.removeEventListener('dragend', onDragEnd);
            item.removeEventListener('touchstart', onTouchStart);
        });
    });

    const onDragOver = (e) => {
        const types = e.dataTransfer.types;
        const isRef = types.includes('text/plain') || types.includes('wh/ref-image');
        const isFile = types.includes('Files');
        if (!isRef && !isFile) return;
        e.preventDefault();
        e.stopPropagation();
        if (isRef) {
            showSeparator(calcInsertionIdx([...container.querySelectorAll(itemSelector)], e.clientX, e.clientY));
        }
    };

    const onDragLeave = (e) => {
        if (!container.contains(e.relatedTarget)) {
            removeSeparator();
            dropInsertIdx = null;
        }
    };

    const applyReorder = (fromIdx, toIdx) => {
        if (Number.isNaN(fromIdx) || Number.isNaN(toIdx) || fromIdx === toIdx) return;
        if (toIdx > fromIdx) toIdx -= 1;
        const list = getItems().slice();
        const [moved] = list.splice(fromIdx, 1);
        list.splice(toIdx, 0, moved);
        setItems(list);
    };

    const onDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeSeparator();
        const refImage = e.dataTransfer.getData('wh/ref-image');
        const plain = e.dataTransfer.getData('text/plain');
        if (refImage) {
            if (skipSelfWhRef && container.querySelector(`${itemSelector}.is-dragging`)) return;
            onWhRefImage?.(refImage);
            return;
        }
        if (plain && plain.startsWith(`${payloadPrefix}:`)) {
            const fromIdx = parseInt(plain.slice(payloadPrefix.length + 1), 10);
            let toIdx = dropInsertIdx !== null
                ? dropInsertIdx
                : calcInsertionIdx([...container.querySelectorAll(itemSelector)], e.clientX, e.clientY);
            dropInsertIdx = null;
            applyReorder(fromIdx, toIdx);
            return;
        }
        if (plain && plain.startsWith('ref:') && payloadPrefix === 'glb') {
            onCrossPoolDrop?.(plain);
            return;
        }
        if (plain && plain.startsWith('src:') && payloadPrefix === 'glb') {
            onCrossPoolDrop?.(plain);
            return;
        }
        if (e.dataTransfer.files?.length) onExternalFiles?.(e.dataTransfer.files);
    };

    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', onDragLeave);
    container.addEventListener('drop', onDrop);
    cleanups.push(() => {
        container.removeEventListener('dragover', onDragOver);
        container.removeEventListener('dragleave', onDragLeave);
        container.removeEventListener('drop', onDrop);
    });

    const onTouchMove = (e) => {
        if (touchDragFromIdx === null) return;
        const touch = e.touches[0];
        const moved = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY);
        if (moved < TOUCH_MOVE_THRESHOLD) return;
        e.preventDefault();

        const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
        document.querySelectorAll(highlightSelector || '.drop-target').forEach((el) => el.classList.remove('drag-over'));
        const highlighted = dropTarget && dropTarget.closest(highlightSelector || '[data-drop-target]');
        if (highlighted) {
            highlighted.classList.add('drag-over');
            if (autoOpen) autoOpen(highlighted, dropTarget);
        }

        const rect = container.getBoundingClientRect();
        if (
            touch.clientX >= rect.left && touch.clientX <= rect.right
            && touch.clientY >= rect.top && touch.clientY <= rect.bottom
        ) {
            const draggingEl = container.querySelector(`${itemSelector}[data-index="${touchDragFromIdx}"]`);
            if (draggingEl) draggingEl.classList.add('is-dragging');
            showSeparator(calcInsertionIdx([...container.querySelectorAll(itemSelector)], touch.clientX, touch.clientY));
        } else {
            removeSeparator();
            dropInsertIdx = null;
        }
    };

    const onTouchEnd = (e) => {
        if (touchDragFromIdx === null) return;
        const fromIdx = touchDragFromIdx;
        touchDragFromIdx = null;
        container.querySelectorAll(`${itemSelector}.is-dragging`).forEach((el) => el.classList.remove('is-dragging'));
        removeSeparator();
        document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
        if (nativeDragActive) {
            dropInsertIdx = null;
            return;
        }
        const touch = e.changedTouches[0];
        const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
        if (onCrossPoolDrop && dropTarget) {
            const other = dropTarget.closest('[data-drop-target]');
            if (other && !container.contains(other)) {
                onCrossPoolDrop(`${payloadPrefix}:${fromIdx}`, other);
                dropInsertIdx = null;
                return;
            }
        }
        let toIdx = dropInsertIdx;
        dropInsertIdx = null;
        if (toIdx === null) return;
        applyReorder(fromIdx, toIdx);
    };

    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    cleanups.push(() => {
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
    });

    if (onPromptTag) {
        const prompt = document.querySelector('#prompt-input');
        if (prompt) {
            const over = (e) => {
                if (e.dataTransfer.types.includes('text/plain')) e.preventDefault();
            };
            const drop = (e) => {
                const raw = e.dataTransfer.getData('text/plain');
                if (!raw || !raw.startsWith(`${payloadPrefix}:`)) return;
                e.preventDefault();
                const idx = parseInt(raw.slice(payloadPrefix.length + 1), 10);
                onPromptTag(prompt, idx);
            };
            prompt.addEventListener('dragover', over);
            prompt.addEventListener('drop', drop);
            cleanups.push(() => {
                prompt.removeEventListener('dragover', over);
                prompt.removeEventListener('drop', drop);
            });
        }
    }

    return () => cleanups.forEach((fn) => fn());
}
