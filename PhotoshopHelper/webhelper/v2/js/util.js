/** Shared helpers for WebHelper v2. */

export const ALL_ASPECT_RATIOS = [
    '21:9', '2:1', '16:9', '3:2', '4:3', '5:4',
    '1:1',
    '4:5', '3:4', '2:3', '9:16', '1:2', '9:21'
];

export const IMPLEMENTED_GENERATION_MODES = Object.freeze(['t2i', 'i2i']);

export const TASK_COLORS = [
    '#ce1aa1', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
    '#e67e22', '#1abc9c', '#d35400', '#34495e', '#c0392b'
];

/** Map a task-dot color onto one of the six soft SVG stage palettes. */
export function stageBgIndexFromColor(hex) {
    const hue = hexToHue(hex);
    if (hue < 20 || hue >= 330) return 5;
    if (hue < 55) return 0;
    if (hue < 85) return 2;
    if (hue < 180) return 3;
    if (hue < 250) return 4;
    return 1;
}

function hexToHue(hex) {
    const raw = String(hex || '').replace('#', '');
    if (raw.length < 6) return 0;
    const r = parseInt(raw.slice(0, 2), 16) / 255;
    const g = parseInt(raw.slice(2, 4), 16) / 255;
    const b = parseInt(raw.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    let hue;
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = Math.round(hue * 60);
    return hue < 0 ? hue + 360 : hue;
}

export const COOKIE_FAVS = 'wh_v2_favs';
export const COOKIE_COMBO = 'wh_v2_combo';

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function getPreviewUrl(url) {
    if (!url) return url;
    return url.replace('/api/webhelper/file/', '/api/webhelper/filePreview/');
}

export function resultImageUrl(url, isLocal) {
    if (!url) return url;
    return isLocal ? url : getPreviewUrl(url);
}

export function filenameFromUrl(url) {
    if (!url) return '';
    return String(url).split('/').pop();
}

export function fixAspectRatio(aspectRatio, allowedList) {
    if (!aspectRatio || allowedList.includes(aspectRatio)) return aspectRatio;
    try {
        if (aspectRatio.includes(':')) {
            const parts = aspectRatio.split(':');
            if (parts.length === 2) {
                const [w, h] = parts.map(Number);
                const target = w / h;
                let bestMatch = aspectRatio;
                let minDiff = Infinity;
                for (const a of allowedList) {
                    try {
                        const [aw, ah] = a.split(':').map(Number);
                        const diff = Math.abs(target - aw / ah);
                        if (diff < minDiff) {
                            minDiff = diff;
                            bestMatch = a;
                        }
                    } catch { /* skip */ }
                }
                return bestMatch;
            }
        }
    } catch { /* skip */ }
    return aspectRatio;
}

export function readJsonCookie(name, fallback) {
    const prefix = `${name}=`;
    const row = document.cookie.split('; ').find((r) => r.startsWith(prefix));
    if (!row) return fallback;
    try {
        return JSON.parse(decodeURIComponent(row.slice(prefix.length)));
    } catch {
        return fallback;
    }
}

export function writeJsonCookie(name, value, days = 365) {
    const maxAge = Math.max(1, Math.floor(days * 86400));
    document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

export function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}

export async function filesToDataUrls(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type && f.type.startsWith('image/'));
    const out = [];
    for (const file of files) {
        out.push(await fileToDataUrl(file));
    }
    return out;
}

export async function urlToDataUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to load image');
    const blob = await res.blob();
    return fileToDataUrl(blob);
}

export function clipboardImageFiles(clipboardData) {
    if (!clipboardData || !clipboardData.items) return [];
    const files = [];
    for (let i = 0; i < clipboardData.items.length; i++) {
        if (clipboardData.items[i].type.startsWith('image/')) {
            const file = clipboardData.items[i].getAsFile();
            if (file) files.push(file);
        }
    }
    return files;
}

export function shortTaskId(taskId) {
    return String(taskId || '').replace('task_', '').substring(0, 12);
}
