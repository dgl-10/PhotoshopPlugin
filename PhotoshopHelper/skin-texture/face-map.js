'use strict';

// Shared by Helper's Photoshop script and the local SkinBench preview runner.
// This module reads the common raster grid. Face fitting and the texture belong to Rust.
var SkinFaceMap = (function () {
    const OUTPUT = 'face_map';
    const LAYER_NAME = 'Face Map';
    const MAGIC = 'SKFACE01';
    const HEADER_BYTES = 40;
    const FACE_BYTES = 96;
    const NODE_VALUES = 15;
    const MAX_GRID = 257;
    // RGB colors follow the wire order: cheek, nose, forehead, under-eye, lip, chin.
    const palette = [[36, 194, 150], [244, 99, 77], [84, 151, 255],
        [245, 202, 65], [222, 104, 206], [135, 105, 248]];

    /** Decode a versioned, document-wide map and prepare premultiplied palette values. */
    function decode(bytes, document) {
        const fail = () => { throw new Error('FACE_MAP_INVALID: invalid v1 numeric map'); };
        if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_BYTES
            || MAGIC.split('').some((c, i) => bytes[i] !== c.charCodeAt(0))) fail();
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const width = view.getUint32(8, true);
        const height = view.getUint32(12, true);
        const cols = view.getUint32(16, true);
        const rows = view.getUint32(20, true);
        const scale = view.getFloat64(24, true);
        const faces = view.getUint32(32, true);
        const base = view.getUint32(36, true);
        const nodeStart = HEADER_BYTES + faces * FACE_BYTES;
        if (!width || !height || (document && (width !== document.width || height !== document.height))
            || cols < 2 || cols > MAX_GRID || rows < 2 || rows > MAX_GRID
            || !Number.isFinite(scale) || scale <= 0 || faces < 1 || faces > 16 || base >= palette.length
            || bytes.length !== nodeStart + cols * rows * NODE_VALUES * 8) fail();

        const markers = [];
        for (let face = 0; face < faces; face++) {
            const offset = HEADER_BYTES + face * FACE_BYTES;
            const points = Array.from({ length: 6 }, (_, i) =>
                [view.getFloat64(offset + i * 16, true), view.getFloat64(offset + i * 16 + 8, true)]);
            if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) fail();
            const distance = Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1]);
            const arm = Math.max(4, Math.min(12, Math.round(distance * 0.035)));
            // The marked pixel contains the fractional document coordinate; clipping happens
            // only when painting, so an offset texture rectangle can never move these points.
            for (const [x, y] of points) markers.push({ x: Math.floor(x), y: Math.floor(y), arm });
        }

        const colors = new Float64Array(cols * rows * 4);
        let left = cols, top = rows, right = -1, bottom = -1;
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const at = j * cols + i;
                const offset = nodeStart + at * NODE_VALUES * 8;
                const coverage = view.getFloat64(offset, true);
                if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) fail();
                if (coverage === 0) continue;
                colors[at * 4 + 3] = coverage;
                // The published zone shares include the flat base. Remove that contribution
                // before mixing colors so the edge fades without picking up the base color.
                for (const [zone, rgb] of palette.entries()) {
                    const share = view.getFloat64(offset + (zone + 1) * 8, true);
                    if (!Number.isFinite(share)) fail();
                    const weight = zone === base ? Math.max(0, share - (1 - coverage)) : share;
                    for (let c = 0; c < 3; c++) colors[at * 4 + c] += rgb[c] * weight;
                }
                left = Math.min(left, i);
                right = Math.max(right, i);
                top = Math.min(top, j);
                bottom = Math.max(bottom, j);
            }
        }
        // Include each nonzero node's neighboring cells, which also receive its color.
        const faceBounds = right < 0 ? null : {
            left: Math.floor((left - 1) * width / (cols - 1)),
            top: Math.floor((top - 1) * height / (rows - 1)),
            right: Math.ceil((right + 1) * width / (cols - 1)),
            bottom: Math.ceil((bottom + 1) * height / (rows - 1))
        };
        return {
            width, height, cols, rows, scale, markers, colors, faceBounds,
            // Preserve the legacy sampling order: nominal millimetres, then grid fractions.
            sx: (width / scale) / (cols - 1), sy: (height / scale) / (rows - 1)
        };
    }

    /** Render sRGB with straight alpha in the supplied document rectangle. */
    function rasterize(map, rect) {
        const { cols, rows, scale, sx, sy, colors } = map;
        const { x, y, width, height } = rect;
        const rgba = new Uint8Array(width * height * 4);
        let hasPixels = false;
        const xCells = Array.from({ length: width }, (_, k) => {
            const fraction = Math.min(cols - 1, ((x + k + 0.5) / scale) / sx);
            const i = Math.min(Math.floor(fraction), cols - 2);
            return [i, fraction - i];
        });
        for (let j = 0; j < height; j++) {
            const fraction = Math.min(rows - 1, ((y + j + 0.5) / scale) / sy);
            const row = Math.min(Math.floor(fraction), rows - 2);
            const ty = fraction - row;
            for (let i = 0; i < width; i++) {
                const [col, tx] = xCells[i];
                const a = (row * cols + col) * 4;
                const b = a + cols * 4;
                // Match the legacy viewer's bilinear expression. Interpolation of the
                // premultiplied color keeps both the outline and inter-zone fades smooth.
                const blend = c => {
                    const top = colors[a + c] + (colors[a + 4 + c] - colors[a + c]) * tx;
                    const bottom = colors[b + c] + (colors[b + 4 + c] - colors[b + c]) * tx;
                    return top + (bottom - top) * ty;
                };
                const coverage = blend(3);
                const alpha = Math.round(coverage * 114);
                if (!alpha) continue;
                const out = (j * width + i) * 4;
                for (let c = 0; c < 3; c++) rgba[out + c] = Math.max(0, Math.min(255, Math.round(blend(c) / coverage)));
                rgba[out + 3] = alpha;
                hasPixels = true;
            }
        }
        // Paint all outlines first so another landmark's outline cannot erase a center.
        for (const outline of [true, false]) {
            for (const marker of map.markers) {
                const cx = marker.x - x;
                const cy = marker.y - y;
                const arm = marker.arm + (outline ? 1 : 0);
                for (let j = Math.max(0, cy - arm); j < Math.min(height, cy + arm + 1); j++) {
                    for (let i = Math.max(0, cx - arm); i < Math.min(width, cx + arm + 1); i++) {
                        const dx = Math.abs(i - cx), dy = Math.abs(j - cy);
                        if (Math.min(dx, dy) > (outline ? 1 : 0)) continue;
                        const out = (j * width + i) * 4;
                        rgba.fill(outline ? 24 : 255, out, out + 3);
                        rgba[out + 3] = 255;
                        hasPixels = true;
                    }
                }
            }
        }
        return { rgba, hasPixels };
    }

    /** Yield only document tiles that might have color or an in-bounds landmark. */
    function* tiles(map, size = 768) {
        const bounds = map.markers.map(({ x, y, arm }) =>
            ({ left: x - arm - 1, top: y - arm - 1, right: x + arm + 2, bottom: y + arm + 2 }));
        if (map.faceBounds) bounds.unshift(map.faceBounds);
        const seen = new Set();
        for (const { left, top, right, bottom } of bounds) {
            for (let y = Math.floor(Math.max(0, top) / size) * size; y < Math.min(map.height, bottom); y += size) {
                for (let x = Math.floor(Math.max(0, left) / size) * size; x < Math.min(map.width, right); x += size) {
                    const key = y * map.width + x;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    yield { x, y, width: Math.min(size, map.width - x), height: Math.min(size, map.height - y) };
                }
            }
        }
    }

    return { OUTPUT, LAYER_NAME, decode, rasterize, tiles };
})();
if (typeof module !== 'undefined') module.exports = SkinFaceMap;
