// Store image data
let previewPath = null;
let imageCount = 0;
let idleTimer = null;
let isDragging = false; // Local tracking of drag state

const IDLE_TIMEOUT = 5000;    // 5 seconds for normal inactivity
const SAFETY_TIMEOUT = 10000; // 10 seconds for max drag time (safety)

// Start IDLE timer on load (in case user never interacts)
startIdleTimer();

function startIdleTimer() {
    // Only run idle timer if NOT dragging
    if (isDragging) return;

    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        window.electron.dragComplete();
    }, IDLE_TIMEOUT);
}

function stopIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

// Listen for images info from main process
window.electron.onSetImages((data) => {
    previewPath = data.previewPath;
    imageCount = data.count;

    // Display preview
    const preview = document.getElementById('preview');
    preview.src = `file://${previewPath}`;

    // Update count badge
    const countBadge = document.getElementById('count-badge');
    if (countBadge) {
        if (imageCount > 1) {
            countBadge.textContent = imageCount;
            countBadge.style.display = 'flex';
        } else {
            countBadge.style.display = 'none';
        }
    }

    // Update hint text
    const hint = document.querySelector('.hint');
    if (hint) {
        hint.textContent = imageCount > 1 ? `Drag ${imageCount} files` : 'Drag to target';
    }

    // Reset state for new session
    isDragging = false;
    startIdleTimer();
});

const dragArea = document.getElementById('dragArea');

// 1. Mouse Enter: Stop idle timer (user is interacting)
dragArea.addEventListener('mouseenter', () => {
    if (!isDragging) {
        stopIdleTimer();
    }
});

// 2. Mouse Leave: Start idle timer (user left)
// BUT: If dragging, do NOT start idle timer, let safety timer run
dragArea.addEventListener('mouseleave', () => {
    if (!isDragging) {
        startIdleTimer();
    }
});

// 3. Drag Start: Set flag, stop idle timer, start long safety timer
dragArea.addEventListener('dragstart', (event) => {
    event.preventDefault();
    isDragging = true;
    stopIdleTimer();

    // Start native drag
    window.electron.startDrag();

    // Safety timeout: force close if drag gets stuck for too long
    setTimeout(() => {
        if (isDragging) {
            window.electron.dragComplete();
        }
    }, SAFETY_TIMEOUT);
});



// This code's necessity is unclear, but it was established through trial and error.
/*
В Электроне при использовании event.sender.startDrag (который мы вызываем в главном процессе)
нативный механизм перетаскивания блокирует поток рендеринга (или просто не отправляет события в DOM),
пока операция не завершится. Поэтому событие dragend на HTML-элементе внутри окна не срабатывает.
*/
// // 4. Drag End: Successful drop or cancel
// dragArea.addEventListener('dragend', () => {
//     // Update hint text
//     const hint = document.querySelector('.hint');
//     if (hint) {
//         hint.textContent = "Drag complete";
//     }

//     isDragging = false;
//     window.electron.dragComplete();
// });
