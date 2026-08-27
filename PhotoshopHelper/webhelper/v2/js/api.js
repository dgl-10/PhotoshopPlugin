/** Same-origin WebHelper API. Contracts match the current Helper server. */

export async function fetchJson(url, options = {}, timeoutMs = 0) {
    const controller = timeoutMs ? new AbortController() : null;
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const res = await fetch(url, {
            ...options,
            signal: controller ? controller.signal : options.signal
        });
        let data = null;
        try {
            data = await res.json();
        } catch {
            data = null;
        }
        if (!res.ok) {
            const err = new Error((data && data.error) || `Request failed (${res.status})`);
            err.status = res.status;
            err.body = data;
            throw err;
        }
        return data;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export function loadEnvironmentInfo() {
    return fetchJson('/api/is-local');
}

export function loadProviders() {
    return fetchJson('/api/webhelper/providers');
}

export function pollQueue(threadId) {
    const url = new URL('/api/webhelper/queue', window.location.origin);
    if (threadId) url.searchParams.set('threadId', threadId);
    return fetchJson(url, {}, 3000);
}

export function markOpened(taskIds) {
    return fetchJson('/api/webhelper/mark_opened', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds })
    });
}

export function getTask(taskId) {
    return fetchJson(`/api/webhelper/task/${encodeURIComponent(taskId)}`);
}

export function createTask(body) {
    return fetchJson('/api/webhelper/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

export function createTaskFromFile(body) {
    return fetchJson('/api/webhelper/task/from-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

export function generate(payload) {
    return fetchJson('/api/webhelper/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

export function copyToClipboard(filename) {
    return fetchJson('/api/webhelper/file/copy2clipboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
    });
}
