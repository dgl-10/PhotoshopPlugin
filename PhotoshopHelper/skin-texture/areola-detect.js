'use strict';

/**
 * Local measurement of areolas for task20, in Helper, on pixels read from the task's document.
 * Pure functions on typed arrays: no host dependencies, no Photoshop, no network. The agent gets
 * the numbers this module returns and never the pixels.
 *
 * Coordinates: the analysed grid maps to the document by
 *     docX = map.left + (x + 0.5) * map.scaleX,  docY = map.top + (y + 0.5) * map.scaleY,
 * so a grid read at a reduced size still yields document pixels.
 *
 * This file holds the selection fit (the person selected the areola, a hole cut out of a selected
 * part marks the nipple). The image search lives in areola-detect-image.js.
 */

const { MAX_AREOLAS, DEFAULT_NIPPLE_SHARE } = require('./areola-geometry');

// Hole qualification thresholds: ignore semi-transparent brush dips and tiny pinholes inside a selection.
const HOLE_BLACK_SHARE = 0.15; // Max relative mask value (<= 15% of full) counted as true black core.
const HOLE_MIN_DARK_SHARE = 0.05; // At least 5% of a hole's cells must fall inside that black core.
const HOLE_MIN_AREA_SHARE = 0.004; // Minimum hole area relative to the filled areola (~6.3% of radius).

/**
 * Label 8-connected components of the cells where `inside(i)` is true.
 *
 * @returns {{ labels: Int32Array, sizes: number[] }} labels: -1 outside, component index inside.
 */
function labelComponents(width, height, inside, connectivity = 8) {
    const labels = new Int32Array(width * height).fill(-1);
    const sizes = [];
    const stack = new Int32Array(width * height);
    for (let start = 0; start < labels.length; start++) {
        if (labels[start] !== -1 || !inside(start)) continue;
        const id = sizes.length;
        let top = 0, size = 0;
        stack[top++] = start;
        labels[start] = id;
        while (top) {
            const i = stack[--top];
            size++;
            const x = i % width, y = (i - x) / width;
            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    if (connectivity === 4 && dx && dy) continue;
                    const nx = x + dx;
                    if (nx < 0 || nx >= width) continue;
                    const j = ny * width + nx;
                    if (labels[j] === -1 && inside(j)) { labels[j] = id; stack[top++] = j; }
                }
            }
        }
        sizes.push(size);
    }
    return { labels, sizes };
}

/**
 * Ellipse with the same area centroid and second moments as a set of grid cells, in document
 * pixels. A filled ellipse with half-axes a >= b has covariance eigenvalues a^2/4 and b^2/4; each
 * cell is a unit square, which adds 1/12 to the variance along both grid axes, removed here.
 *
 * @param {{n: number, sx: number, sy: number, sxx: number, syy: number, sxy: number}} m - Sums over cells.
 * @param {{left: number, top: number, scaleX: number, scaleY: number}} map
 * @returns {{ center: number[], radii: number[], angleDeg: number }}
 */
function ellipseFromMoments(m, map) {
    const mx = m.sx / m.n, my = m.sy / m.n;
    const cxx = (m.sxx / m.n - mx * mx + 1 / 12) * map.scaleX * map.scaleX;
    const cyy = (m.syy / m.n - my * my + 1 / 12) * map.scaleY * map.scaleY;
    const cxy = (m.sxy / m.n - mx * my) * map.scaleX * map.scaleY;
    const half = (cxx + cyy) / 2, diff = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
    const l1 = half + diff, l2 = Math.max(half - diff, 1e-9);
    // Eigenvector of the larger eigenvalue; for a circle any direction is right and 0 is reported.
    let angle = diff < 1e-9 ? 0 : 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    let angleDeg = angle * 180 / Math.PI;
    if (angleDeg <= -90) angleDeg += 180;
    if (angleDeg > 90) angleDeg -= 180;
    return {
        center: [map.left + (mx + 0.5) * map.scaleX, map.top + (my + 0.5) * map.scaleY],
        radii: [2 * Math.sqrt(l1), 2 * Math.sqrt(l2)],
        angleDeg
    };
}

/** Accumulate moment sums for the cells of one label (or of a predicate). */
function momentsOf(width, height, belongs) {
    const m = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!belongs(y * width + x)) continue;
            m.n++; m.sx += x; m.sy += y; m.sxx += x * x; m.syy += y * y; m.sxy += x * y;
        }
    }
    return m;
}

/** Share of agreement between a set of cells and a document-space ellipse (intersection over union). */
function ellipseAgreement(width, height, belongs, ellipse, map) {
    const t = ellipse.angleDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    let both = 0, either = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dx = map.left + (x + 0.5) * map.scaleX - ellipse.center[0];
            const dy = map.top + (y + 0.5) * map.scaleY - ellipse.center[1];
            const u = (dx * c + dy * s) / ellipse.radii[0], v = (-dx * s + dy * c) / ellipse.radii[1];
            const inE = u * u + v * v <= 1, inS = belongs(y * width + x);
            if (inE && inS) both++;
            if (inE || inS) either++;
        }
    }
    return either ? both / either : 0;
}

const round2 = value => Math.round(value * 100) / 100;

/**
 * Fit areolas to a selection mask. Every separate selected part (8-connected) is one areola; a
 * hole inside a part (background not reachable from outside the part) marks the nipple. Parts
 * smaller than 2% of the largest are treated as stray clicks and ignored, and said so.
 *
 * @param {Uint8Array|Uint16Array} mask - Selection values, 0 = not selected.
 * @param {number} width
 * @param {number} height
 * @param {{left: number, top: number, scaleX: number, scaleY: number, full: number}} map - full is
 *   the value of a fully selected cell (255 for 8-bit, 32768 for Photoshop's 16-bit range).
 * @returns {{ areolas: object[], notes: string[] }} Each areola: record, nipple info, confidence.
 */
function fitSelection(mask, width, height, map) {
    const full = map.full || 255;
    const half = full / 2;
    const selected = i => mask[i] >= half;
    const { labels, sizes } = labelComponents(width, height, selected, 8);
    const notes = [];
    if (!sizes.length) return { areolas: [], notes: ['The selection is empty.'] };
    const largest = Math.max(...sizes);
    let parts = sizes.map((size, id) => ({ id, size })).filter(p => p.size >= Math.max(2, 0.02 * largest))
        .sort((a, b) => b.size - a.size);
    const ignored = sizes.length - parts.length;
    if (ignored) notes.push(`${ignored} tiny selected part(s) were ignored as stray.`);
    if (parts.length > MAX_AREOLAS) {
        notes.push(`The selection has ${parts.length} separate parts; the ${MAX_AREOLAS} largest were taken as areolas.`);
        parts = parts.slice(0, MAX_AREOLAS);
    }
    let ignoredHoles = 0;
    const areolas = parts.map(part => {
        // Background reachable from outside the part's box is outside; the rest are its holes.
        let x0 = width, y0 = height, x1 = -1, y1 = -1;
        for (let i = 0; i < labels.length; i++) {
            if (labels[i] !== part.id) continue;
            const x = i % width, y = (i - x) / width;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        const bw = x1 - x0 + 3, bh = y1 - y0 + 3;
        const inPart = (bx, by) => {
            const x = bx + x0 - 1, y = by + y0 - 1;
            return x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] === part.id;
        };
        const outside = new Uint8Array(bw * bh);
        const queue = [0];
        outside[0] = 1;
        while (queue.length) {
            const i = queue.pop();
            const bx = i % bw, by = (i - bx) / bw;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = bx + dx, ny = by + dy;
                if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
                const j = ny * bw + nx;
                if (!outside[j] && !inPart(nx, ny)) { outside[j] = 1; queue.push(j); }
            }
        }
        const filledAt = i => {
            const x = i % width, y = (i - x) / width;
            if (x < x0 || x > x1 || y < y0 || y > y1) return false;
            return !outside[(y - y0 + 1) * bw + (x - x0 + 1)];
        };
        const filledMoments = momentsOf(width, height, filledAt);
        const outline = ellipseFromMoments(filledMoments, map);
        const agreement = ellipseAgreement(width, height, filledAt, outline, map);

        // Holes: cells filled but not in the part, grouped 4-connected. Only holes with a real
        // unselected (black) core and non-trivial area count, so semi-transparent brush dips and
        // tiny pinholes do not override automatic nipple detection.
        const holeCell = i => filledAt(i) && labels[i] !== part.id;
        const holes = labelComponents(width, height, holeCell, 4);
        const darkCounts = new Int32Array(holes.sizes.length);
        if (holes.sizes.length) {
            const blackLimit = HOLE_BLACK_SHARE * full;
            for (let y = y0; y <= y1; y++) {
                const row = y * width;
                for (let x = x0; x <= x1; x++) {
                    const hid = holes.labels[row + x];
                    if (hid !== -1 && mask[row + x] <= blackLimit) darkCounts[hid]++;
                }
            }
        }
        const minHoleCells = Math.max(3, Math.ceil(HOLE_MIN_AREA_SHARE * filledMoments.n));
        const seriousHoles = [];
        for (let hid = 0; hid < holes.sizes.length; hid++) {
            const size = holes.sizes[hid];
            if (size >= minHoleCells && darkCounts[hid] >= Math.max(2, Math.ceil(HOLE_MIN_DARK_SHARE * size))) {
                seriousHoles.push({ id: hid, size });
            }
        }
        ignoredHoles += holes.sizes.length - seriousHoles.length;
        const reasons = [];
        let nipple = null;
        if (seriousHoles.length === 1) {
            const m = momentsOf(width, height, i => holes.labels[i] === seriousHoles[0].id);
            const area = m.n * map.scaleX * map.scaleY;
            nipple = {
                center: [map.left + (m.sx / m.n + 0.5) * map.scaleX, map.top + (m.sy / m.n + 0.5) * map.scaleY],
                radius: Math.sqrt(area / Math.PI)
            };
        } else if (seriousHoles.length > 1) {
            reasons.push(`${seriousHoles.length} clear holes in the selected part; fill accidental gaps or leave at most one hole for the nipple`);
        }
        let level = 'high';
        if (agreement < 0.9) { level = 'medium'; reasons.push(`the selected shape is not elliptical (agreement ${agreement.toFixed(2)}); the ellipse approximates it`); }
        if (agreement < 0.75) level = 'low';
        if (Math.min(outline.radii[0], outline.radii[1]) < 6) { level = 'low'; reasons.push('the selected part is tiny'); }
        if (seriousHoles.length > 1) level = 'low';
        const record = {
            areola: { center: outline.center.map(round2), radii: outline.radii.map(round2), angleDeg: round2(outline.angleDeg) },
            nipple: (nipple ? nipple.center : outline.center).map(round2),
            nippleRadiusPx: round2(nipple ? Math.min(nipple.radius, outline.radii[0]) : DEFAULT_NIPPLE_SHARE * outline.radii[0])
        };
        return {
            record,
            nipple: nipple ? { found: true, source: 'hole in the selection' } : { found: false, source: 'not marked: centre of the areola and 0.3 of the long half-axis' },
            confidence: {
                level,
                reasons,
                agreement: round2(agreement),
                ...(seriousHoles.length > 1 ? { holes: seriousHoles.length } : {})
            }
        };
    });
    if (ignoredHoles > 0) {
        notes.push(`${ignoredHoles} faint or tiny gap(s) inside the selection were ignored as uneven brushing.`);
    }
    return { areolas, notes };
}

/** Whether a fitted selection part has multiple clear holes and must be sent back to the user. */
function hasAmbiguousHoles(areola) {
    return Boolean(areola && areola.confidence && areola.confidence.holes > 1);
}

module.exports = { labelComponents, ellipseFromMoments, ellipseAgreement, fitSelection, hasAmbiguousHoles };
