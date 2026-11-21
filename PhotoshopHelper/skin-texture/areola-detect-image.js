'use strict';

/**
 * Local search and measurement of areolas, nipples and light direction on the document's own
 * pixels (task20). Classical image measurement, no learned model: it measures colour and
 * brightness, it does not understand the picture. That is why the agent, which can look at the
 * document, gives rough positions (hints) when it can, and Helper measures them precisely; without
 * hints this module also searches by itself, less reliably, and says so through the confidence.
 *
 * Pipeline for one areola:
 *  1. Rough size: around the centre, compare the colour of an inner disc with an outer ring for a
 *     range of radii; the radius with the largest colour difference is the rough edge.
 *  2. Edge: the inner (areola) and outer (skin) colours define a direction in Lab space; every pixel
 *     gets f = how far its colour has moved from skin towards areola (0 skin, 1 areola). Along 96
 *     rays from the centre the 0.5 crossing with the largest step is the edge on that ray; rays
 *     without a clear step (covered, blurred, out of the picture) are left out and counted.
 *  3. Ellipse: a direct least-squares ellipse fit (Fitzgibbon; Halir-Flusser's stable form) to the
 *     edge points, with outliers trimmed, repeated from the new centre.
 *  4. Confidence from measured facts: colour contrast of the edge, share of rays with an edge,
 *     radial residual of the fit, and stability of the result under perturbed starts.
 *  5. Nipple: the strongest compact bump inside the areola (difference of box-blurred images at
 *     several scales, in brightness and in areola colour); not found when it does not stand out.
 *  6. Light azimuth: on the nipple, the brightness change that is not rotationally symmetric points
 *     to the light (a bump is brighter on the side facing it); on the breast around the areola, the
 *     broad brightness slope. Used only when both agree; elevation is not measurable from one frame.
 *
 * Coordinates: the grid maps to document pixels by docX = left + (x + 0.5) * scaleX. Light
 * azimuth uses the variants' convention: the lamp lies in direction (cos az, sin az) in document
 * pixels with y pointing down (contract lighting, e.g. 0 = from the right, 270 = from above).
 */

const { MAX_AREOLAS, DEFAULT_NIPPLE_SHARE } = require('./areola-geometry');

const RAYS = 96;
const DEFAULT_LIGHT = Object.freeze({ azimuthDeg: 315, elevationDeg: 45 });

// Thresholds of the confidence levels. Starting values from the design review, calibrated on the
// synthetic set in the task20 report; they describe measured quantities, not anatomy.
const LEVELS = Object.freeze({
    high: { contrast: 8, support: 0.7, residual: 0.05, centerSpread: 0.03, axisSpread: 0.08 },
    low: { contrast: 4, support: 0.45, residual: 0.1, centerSpread: 0.08, axisSpread: 0.15 }
});

// ---- Colour --------------------------------------------------------------------------------

const LINEAR = new Float32Array(256);
for (let v = 0; v < 256; v++) {
    const c = v / 255;
    LINEAR[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const labF = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** sRGB 8-bit (chunky, `channels` per pixel) to CIE Lab D65 planes. */
function toLab(rgb, count, channels) {
    const L = new Float32Array(count), A = new Float32Array(count), B = new Float32Array(count);
    for (let i = 0, j = 0; i < count; i++, j += channels) {
        const r = LINEAR[rgb[j]], g = LINEAR[rgb[j + 1]], b = LINEAR[rgb[j + 2]];
        const fx = labF((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
        const fy = labF(0.2126 * r + 0.7152 * g + 0.0722 * b);
        const fz = labF((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
        L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); B[i] = 200 * (fy - fz);
    }
    return { L, A, B };
}

/** Separable box blur with clamped edges; three passes approximate a Gaussian. */
function boxBlur(src, w, h, radius, passes = 3) {
    if (radius < 1) return Float32Array.from(src);
    let a = Float32Array.from(src), b = new Float32Array(src.length);
    const size = 2 * radius + 1;
    for (let p = 0; p < passes; p++) {
        for (let y = 0; y < h; y++) {
            const row = y * w;
            let sum = 0;
            for (let k = -radius; k <= radius; k++) sum += a[row + Math.min(w - 1, Math.max(0, k))];
            for (let x = 0; x < w; x++) {
                b[row + x] = sum / size;
                sum += a[row + Math.min(w - 1, x + radius + 1)] - a[row + Math.max(0, x - radius)];
            }
        }
        for (let x = 0; x < w; x++) {
            let sum = 0;
            for (let k = -radius; k <= radius; k++) sum += b[Math.min(h - 1, Math.max(0, k)) * w + x];
            for (let y = 0; y < h; y++) {
                a[y * w + x] = sum / size;
                sum += b[Math.min(h - 1, y + radius + 1) * w + x] - b[Math.max(0, y - radius) * w + x];
            }
        }
    }
    return a;
}

/** Bilinear sample at continuous grid coordinates (pixel i spans [i, i + 1)); NaN outside. */
function sample(img, w, h, x, y) {
    const fx = x - 0.5, fy = y - 0.5;
    if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) return NaN;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const top = img[y0 * w + x0] * (1 - tx) + img[y0 * w + x1] * tx;
    const bottom = img[y1 * w + x0] * (1 - tx) + img[y1 * w + x1] * tx;
    return top * (1 - ty) + bottom * ty;
}

function median(values) {
    if (!values.length) return NaN;
    const s = Float64Array.from(values).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- Ellipse ------------------------------------------------------------------------------

/** Elliptic radius of a grid point under an ellipse { cx, cy, a, b, t } (t in radians). */
function rho(e, x, y) {
    const c = Math.cos(e.t), s = Math.sin(e.t), dx = x - e.cx, dy = y - e.cy;
    const u = (dx * c + dy * s) / e.a, v = (-dx * s + dy * c) / e.b;
    return Math.sqrt(u * u + v * v);
}

/** Distance from the centre to the outline along direction theta. */
function radiusAlong(e, theta) {
    const phi = theta - e.t;
    return 1 / Math.sqrt((Math.cos(phi) / e.a) ** 2 + (Math.sin(phi) / e.b) ** 2);
}

/** Real roots of x^3 + p2 x^2 + p1 x + p0. */
function cubicRoots(p2, p1, p0) {
    const q = (3 * p1 - p2 * p2) / 9, r = (9 * p2 * p1 - 27 * p0 - 2 * p2 * p2 * p2) / 54;
    const disc = q * q * q + r * r, shift = -p2 / 3;
    if (disc > 0) {
        const s = Math.cbrt(r + Math.sqrt(disc)), t = Math.cbrt(r - Math.sqrt(disc));
        return [shift + s + t];
    }
    const theta = Math.acos(Math.max(-1, Math.min(1, r / Math.sqrt(-q * q * q || 1e-300))));
    const m = 2 * Math.sqrt(-q);
    return [0, 1, 2].map(k => shift + m * Math.cos((theta + 2 * Math.PI * k) / 3));
}

/** Solve a 3x3 linear system by Cramer's rule; null when singular. */
function solve3(M, v) {
    const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const d = det(M);
    if (!Number.isFinite(d) || Math.abs(d) < 1e-300) return null;
    return [0, 1, 2].map(k => det(M.map((row, i) => row.map((value, j) => (j === k ? v[i] : value)))) / d);
}

/**
 * Direct least-squares ellipse fit (Halir and Flusser 1998). Points are centred and scaled first
 * for numerical stability. Returns { cx, cy, a, b, t } with a >= b, or null.
 */
function fitEllipse(points) {
    if (points.length < 6) return null;
    let mx = 0, my = 0;
    for (const [x, y] of points) { mx += x; my += y; }
    mx /= points.length; my /= points.length;
    let sc = 0;
    for (const [x, y] of points) sc += Math.hypot(x - mx, y - my);
    sc = sc / points.length || 1;
    const S1 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], S2 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], S3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const [px, py] of points) {
        const x = (px - mx) / sc, y = (py - my) / sc;
        const d1 = [x * x, x * y, y * y], d2 = [x, y, 1];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            S1[i][j] += d1[i] * d1[j]; S2[i][j] += d1[i] * d2[j]; S3[i][j] += d2[i] * d2[j];
        }
    }
    // T = -S3^-1 S2^T, column by column.
    const T = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let col = 0; col < 3; col++) {
        const x = solve3(S3, [S2[col][0], S2[col][1], S2[col][2]]);
        if (!x) return null;
        for (let row = 0; row < 3; row++) T[row][col] = -x[row];
    }
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let s = S1[i][j];
        for (let k = 0; k < 3; k++) s += S2[i][k] * T[k][j];
        M[i][j] = s;
    }
    // Premultiply by the inverse constraint matrix: rows M2/2, -M1, M0/2.
    const N = [M[2].map(v => v / 2), M[1].map(v => -v), M[0].map(v => v / 2)];
    const tr = N[0][0] + N[1][1] + N[2][2];
    const minors = N[0][0] * N[1][1] - N[0][1] * N[1][0] + N[0][0] * N[2][2] - N[0][2] * N[2][0] + N[1][1] * N[2][2] - N[1][2] * N[2][1];
    const det = N[0][0] * (N[1][1] * N[2][2] - N[1][2] * N[2][1]) - N[0][1] * (N[1][0] * N[2][2] - N[1][2] * N[2][0])
        + N[0][2] * (N[1][0] * N[2][1] - N[1][1] * N[2][0]);
    let best = null;
    for (const lambda of cubicRoots(-tr, minors, -det)) {
        const R = N.map((row, i) => row.map((v, j) => v - (i === j ? lambda : 0)));
        // Null vector: the largest cross product of two rows.
        const crosses = [[0, 1], [0, 2], [1, 2]].map(([i, j]) => [
            R[i][1] * R[j][2] - R[i][2] * R[j][1], R[i][2] * R[j][0] - R[i][0] * R[j][2], R[i][0] * R[j][1] - R[i][1] * R[j][0]]);
        const vec = crosses.reduce((acc, c) => (Math.hypot(...c) > Math.hypot(...acc) ? c : acc));
        if (4 * vec[0] * vec[2] - vec[1] * vec[1] > 0 && Math.hypot(...vec) > 0) { best = vec; break; }
    }
    if (!best) return null;
    const a2 = [0, 1, 2].map(row => T[row][0] * best[0] + T[row][1] * best[1] + T[row][2] * best[2]);
    let [A, B, C] = best, [D, E, F] = a2;
    // Undo the scaling and centring: conic in (x - mx)/sc, (y - my)/sc.
    const cx0 = (B * E - 2 * C * D) / (4 * A * C - B * B), cy0 = (B * D - 2 * A * E) / (4 * A * C - B * B);
    const F0 = A * cx0 * cx0 + B * cx0 * cy0 + C * cy0 * cy0 + D * cx0 + E * cy0 + F;
    const half = (A + C) / 2, diff = Math.sqrt(((A - C) / 2) ** 2 + (B / 2) ** 2);
    const l1 = half - diff, l2 = half + diff;
    if (l1 * F0 >= 0 || l2 * F0 >= 0) return null;
    const r1 = Math.sqrt(-F0 / l1) * sc, r2 = Math.sqrt(-F0 / l2) * sc;
    // Eigenvector of the smaller eigenvalue l1 is the direction of the longer axis r1.
    let t = Math.abs(B) < 1e-12 && A <= C ? 0 : Math.atan2(l1 - A, B / 2);
    if (Math.abs(B) < 1e-12 && A > C) t = Math.PI / 2;
    const e = { cx: cx0 * sc + mx, cy: cy0 * sc + my, a: r1, b: r2, t };
    if (e.b > e.a) { [e.a, e.b] = [e.b, e.a]; e.t += Math.PI / 2; }
    if (!Number.isFinite(e.a) || !Number.isFinite(e.b) || !Number.isFinite(e.cx)) return null;
    return e;
}

/**
 * Fit an ellipse to edge points of which a large share may belong to something else (a hand or
 * fabric over part of the edge, a shadow border). Random six-point fits (RANSAC, fixed sequence so
 * results are reproducible) propose ellipses; the one most points agree with (radial residual
 * under 3%) is refined on its agreeing points. Candidates far from the starting ellipse in centre
 * or size are not considered, so a few collinear points cannot propose a huge ellipse.
 */
function consensusFit(points, start) {
    const R0 = Math.sqrt(start.a * start.b);
    let seed = 12345;
    const next = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    let best = null;
    for (let trial = 0; trial < 160; trial++) {
        const pick = new Set();
        while (pick.size < 6) pick.add(Math.floor(next() * points.length));
        const e = fitEllipse([...pick].map(i => points[i]));
        if (!e) continue;
        const R = Math.sqrt(e.a * e.b);
        if (R < 0.5 * R0 || R > 2 * R0 || e.b < 0.3 * e.a || Math.hypot(e.cx - start.cx, e.cy - start.cy) > 0.6 * R0) continue;
        let agree = 0;
        for (const [x, y] of points) if (Math.abs(rho(e, x, y) - 1) < 0.03) agree++;
        if (!best || agree > best.agree) best = { e, agree };
    }
    if (!best || best.agree < 8) return robustFit(points);
    const inliers = points.filter(([x, y]) => Math.abs(rho(best.e, x, y) - 1) < 0.03);
    return robustFit(inliers) || { e: best.e, inliers };
}

/** Fit, then drop points whose radial residual is far from the rest, and fit again. */
function robustFit(points) {
    let current = points, e = fitEllipse(current);
    for (let pass = 0; pass < 3 && e; pass++) {
        const res = current.map(([x, y]) => Math.abs(rho(e, x, y) - 1));
        const mad = median(res) * 1.4826 + 0.01;
        const kept = current.filter((p, i) => res[i] <= 2.5 * mad);
        if (kept.length === current.length || kept.length < 6) break;
        current = kept;
        e = fitEllipse(current) || e;
    }
    return e ? { e, inliers: current } : null;
}

// ---- One areola ---------------------------------------------------------------------------

/** Median Lab of pixels whose elliptic radius under `e` lies in [r0, r1], sampled on a polar grid. */
function ringColour(lab, w, h, e, r0, r1) {
    const L = [], A = [], B = [];
    for (let k = 0; k < 64; k++) {
        const theta = (2 * Math.PI * k) / 64, rr = radiusAlong(e, theta);
        for (let j = 0; j < 6; j++) {
            const s = (r0 + ((r1 - r0) * (j + 0.5)) / 6) * rr;
            const x = e.cx + s * Math.cos(theta), y = e.cy + s * Math.sin(theta);
            const l = sample(lab.L, w, h, x, y);
            if (Number.isNaN(l)) continue;
            L.push(l); A.push(sample(lab.A, w, h, x, y)); B.push(sample(lab.B, w, h, x, y));
        }
    }
    return L.length < 32 ? null : [median(L), median(A), median(B)];
}

/**
 * Rough radius around a centre from the disc-to-ring colour difference over a range of radii.
 * A dark or pigmented nipple gives a strong difference at a small radius, the areola a second one
 * further out; the areola is the outermost local maximum that reaches 60% of the strongest.
 */
function roughRadius(lab, w, h, cx, cy, rMin, rMax) {
    const profile = [];
    for (let r = rMin; r <= rMax; r *= 1.08) {
        const e = { cx, cy, a: r, b: r, t: 0 };
        const inner = ringColour(lab, w, h, e, 0.3, 0.7), outer = ringColour(lab, w, h, e, 1.3, 1.8);
        if (!inner || !outer) continue;
        profile.push({ r, contrast: Math.hypot(inner[0] - outer[0], inner[1] - outer[1], inner[2] - outer[2]) });
    }
    if (!profile.length) return null;
    const strongest = Math.max(...profile.map(p => p.contrast));
    const peaks = profile.filter((p, i) => p.contrast >= 0.6 * strongest
        && (i === 0 || p.contrast >= profile[i - 1].contrast)
        && (i === profile.length - 1 || p.contrast >= profile[i + 1].contrast));
    const top = profile.reduce((a, b) => (b.contrast > a.contrast ? b : a));
    // Calibration run 2: the outermost peak alone sometimes starts outside the areola and finds no
    // edge, so the strongest radius is kept as a second start (detectInImage tries both).
    return { ...(peaks.length ? peaks[peaks.length - 1] : top), strongest: top.r };
}

/**
 * One refinement from a starting ellipse: colours, rays, robust fit. Returns the new ellipse and
 * the measures of this pass, or null when there is no usable edge.
 */
function refineOnce(lab, w, h, start, { threshold = 0.5, raySubset = null } = {}) {
    const inner = ringColour(lab, w, h, start, 0.35, 0.7), outer = ringColour(lab, w, h, start, 1.35, 1.9);
    if (!inner || !outer) return null;
    const delta = [inner[0] - outer[0], inner[1] - outer[1], inner[2] - outer[2]];
    const contrast = Math.hypot(...delta);
    if (contrast < 1.5) return null;
    const dir = delta.map(v => v / contrast);
    const f = (x, y) => {
        const l = sample(lab.L, w, h, x, y);
        if (Number.isNaN(l)) return NaN;
        return ((l - outer[0]) * dir[0] + (sample(lab.A, w, h, x, y) - outer[1]) * dir[1]
            + (sample(lab.B, w, h, x, y) - outer[2]) * dir[2]) / contrast;
    };
    const points = [];
    let tried = 0;
    for (let k = 0; k < RAYS; k++) {
        if (raySubset !== null && k % 2 !== raySubset) continue;
        tried++;
        const theta = (2 * Math.PI * k) / RAYS, rr = radiusAlong(start, theta);
        const c = Math.cos(theta), s = Math.sin(theta);
        const step = 0.5, from = 0.55 * rr, to = 1.6 * rr;
        const rawValues = [];
        for (let d = from; d <= to; d += step) rawValues.push(f(start.cx + d * c, start.cy + d * s));
        if (rawValues.some(Number.isNaN)) continue;
        // Normalize the ray by its own levels just inside and just outside the expected edge.
        // Shading changes brightness slowly across the breast; a common level would move the
        // 0.5 crossing towards the shaded side, while each ray's own levels carry its shading.
        const at = d => Math.round((d * rr - from) / step);
        const innerLevel = median(rawValues.slice(0, Math.max(1, at(0.8))));
        const outerLevel = median(rawValues.slice(Math.min(rawValues.length - 1, at(1.25))));
        if (!(innerLevel - outerLevel > 0.35)) continue;
        const values = rawValues.map(v => (v - outerLevel) / (innerLevel - outerLevel));
        const window = Math.max(2, Math.round((0.12 * rr) / step));
        let best = null;
        for (let i = window; i < values.length - window; i++) {
            if (!(values[i] >= threshold && values[i + 1] < threshold)) continue;
            let before = 0, after = 0;
            for (let j = 1; j <= window; j++) { before += values[i + 1 - j]; after += values[i + j]; }
            const strength = (before - after) / window;
            if (!best || strength > best.strength) {
                const frac = (values[i] - threshold) / (values[i] - values[i + 1]);
                best = { d: from + (i + frac) * step, strength };
            }
        }
        if (best && best.strength >= 0.4) points.push([start.cx + best.d * c, start.cy + best.d * s]);
    }
    if (points.length < 12) return null;
    const fit = consensusFit(points, start);
    if (!fit) return null;
    const res = fit.inliers.map(([x, y]) => rho(fit.e, x, y) - 1);
    const residual = Math.sqrt(res.reduce((sum, v) => sum + v * v, 0) / res.length);
    return { e: fit.e, contrast, support: fit.inliers.length / tried, residual, outer, inner };
}

/** Repeated refinement from a starting ellipse, until the centre settles. */
function refine(lab, w, h, start, options) {
    let current = start, result = null;
    for (let iteration = 0; iteration < 4; iteration++) {
        const next = refineOnce(lab, w, h, current, options);
        if (!next) return result;
        const moved = Math.hypot(next.e.cx - current.cx, next.e.cy - current.cy) / Math.sqrt(next.e.a * next.e.b);
        result = next;
        current = next.e;
        if (moved < 0.005) break;
    }
    return result;
}

/** Spread of the result under perturbed starts: centre shift and axis change relative to R. */
function stability(lab, w, h, main) {
    const R = Math.sqrt(main.e.a * main.e.b);
    const starts = [];
    for (const [dx, dy] of [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]]) {
        starts.push([{ ...main.e, cx: main.e.cx + dx * R, cy: main.e.cy + dy * R, a: R, b: R, t: 0 }, {}]);
    }
    starts.push([main.e, { threshold: 0.4 }], [main.e, { threshold: 0.6 }], [main.e, { raySubset: 0 }], [main.e, { raySubset: 1 }]);
    let centerSpread = 0, axisSpread = 0, failed = 0;
    for (const [start, options] of starts) {
        const r = refine(lab, w, h, start, options);
        if (!r) { failed++; continue; }
        centerSpread = Math.max(centerSpread, Math.hypot(r.e.cx - main.e.cx, r.e.cy - main.e.cy) / R);
        axisSpread = Math.max(axisSpread, Math.abs(r.e.a - main.e.a) / main.e.a, Math.abs(r.e.b - main.e.b) / main.e.b);
    }
    return { centerSpread, axisSpread, failed, runs: starts.length };
}

/** Grade measured facts against LEVELS; the worst fact decides. */
function grade(m) {
    const reasons = [];
    const check = (value, high, low, worse, text) => {
        const bad = worse === 'lower' ? value < low : value > low;
        const good = worse === 'lower' ? value >= high : value <= high;
        if (bad) reasons.push(`${text} (low)`);
        else if (!good) reasons.push(`${text} (medium)`);
        return bad ? 0 : good ? 2 : 1;
    };
    const scores = [
        check(m.contrast, LEVELS.high.contrast, LEVELS.low.contrast, 'lower', `edge colour contrast ${m.contrast.toFixed(1)} dE`),
        check(m.support, LEVELS.high.support, LEVELS.low.support, 'lower', `edge found on ${(m.support * 100).toFixed(0)}% of the outline`),
        check(m.residual, LEVELS.high.residual, LEVELS.low.residual, 'higher', `outline deviates ${(m.residual * 100).toFixed(1)}% from an ellipse`),
        check(m.centerSpread, LEVELS.high.centerSpread, LEVELS.low.centerSpread, 'higher', `centre moves ${(m.centerSpread * 100).toFixed(1)}% of the radius under perturbed starts`),
        check(m.axisSpread, LEVELS.high.axisSpread, LEVELS.low.axisSpread, 'higher', `size changes ${(m.axisSpread * 100).toFixed(1)}% under perturbed starts`)
    ];
    if (m.failedRuns > 2) { scores.push(0); reasons.push(`${m.failedRuns} of ${m.runs} perturbed starts found no edge (low)`); }
    // With a hint, the measured centre must stay near where the agent saw the areola; a centre far
    // from it means another edge (a nipple, a ring, a shadow) was measured.
    if (Number.isFinite(m.hintDistance)) {
        scores.push(check(m.hintDistance, 0.35, 0.7, 'higher', `measured centre lies ${(m.hintDistance * 100).toFixed(0)}% of the radius from the hint`));
    }
    const worst = Math.min(...scores);
    return { level: worst === 2 ? 'high' : worst === 1 ? 'medium' : 'low', reasons };
}

// ---- Nipple ---------------------------------------------------------------------------------

/**
 * The nipple: the strongest compact concentration of brightness and colour change inside the
 * areola. A lit bump is not a dark or bright spot but a lit side next to a shaded side, so the
 * search runs on the local change itself, |grad L|^2 + |grad (f * contrast)|^2: a protrusion (or a
 * differently coloured nipple) concentrates it inside its outline, while the areola's fine texture
 * spreads it thinly. For each radius r (8% to 45% of the areola radius) the score at a point is the
 * mean change inside a box of half-size r minus the mean in the surrounding box of half-size 1.6 r;
 * the best (point, r) wins, and its centre is then refined as the change-weighted centroid.
 * `ratio` compares the winner with the typical score inside the areola: how much it stands out.
 */
function findNipple(lab, w, h, e, f, contrast) {
    const R = Math.sqrt(e.a * e.b);
    const x0 = Math.max(1, Math.floor(e.cx - e.a)), x1 = Math.min(w - 2, Math.ceil(e.cx + e.a));
    const y0 = Math.max(1, Math.floor(e.cy - e.a)), y1 = Math.min(h - 2, Math.ceil(e.cy + e.a));
    const energy = new Float32Array(w * h), valid = new Float32Array(w * h);
    const inside = [];
    for (let y = y0 - 1; y <= y1 + 1 && y < h - 1; y++) {
        for (let x = x0 - 1; x <= x1 + 1 && x < w - 1; x++) {
            if (x < 1 || y < 1) continue;
            const i = y * w + x;
            // Only the inside of the areola counts; its own edge must not look like a nipple.
            if (rho(e, x + 0.5, y + 0.5) > 0.8) continue;
            const lx = (lab.L[i + 1] - lab.L[i - 1]) / 2, ly = (lab.L[i + w] - lab.L[i - w]) / 2;
            const fx = ((f[i + 1] - f[i - 1]) / 2) * contrast, fy = ((f[i + w] - f[i - w]) / 2) * contrast;
            energy[i] = lx * lx + ly * ly + fx * fx + fy * fy;
            valid[i] = 1;
            inside.push(i);
        }
    }
    // A mole or a hair is a few extreme pixels; a nipple is a whole area of change. Capping the
    // change at the 97th percentile of the inside keeps the few extremes from outweighing an area.
    if (inside.length > 50) {
        const sorted = Float32Array.from(inside.map(i => energy[i])).sort();
        const cap = sorted[Math.floor(0.97 * (sorted.length - 1))];
        for (const i of inside) if (energy[i] > cap) energy[i] = cap;
    }
    // Coarse place and size: the excess change inside a box over its surrounding ring, summed over
    // the box (not averaged), so the whole bump wins over its single most contrasted side. Means
    // count valid (inside the areola) pixels only, so the quiet outside never inflates the excess.
    // Once a box holds the whole bump, larger boxes add nothing: the smallest box within 85% of
    // the best excess gives the size.
    // Nipples are at least about an eighth of the areola radius across; smaller compact spots are
    // moles or pores. The nipple usually sits near the middle, so a mild weight favours the centre.
    const perScale = [];
    const scores = [];
    for (const share of [0.12, 0.15, 0.2, 0.26, 0.34, 0.45]) {
        const r = Math.max(1, Math.round(share * R)), r2 = Math.max(r + 1, Math.round(1.6 * share * R));
        const eIn = boxBlur(energy, w, h, r, 1), eOut = boxBlur(energy, w, h, r2, 1);
        const vIn = boxBlur(valid, w, h, r, 1), vOut = boxBlur(valid, w, h, r2, 1);
        const aIn = (2 * r + 1) ** 2, aOut = (2 * r2 + 1) ** 2;
        const map = [];
        let top = null;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const where = rho(e, x + 0.5, y + 0.5);
                if (where > 0.6) continue;
                const i = y * w + x;
                const nIn = vIn[i] * aIn, nRing = vOut[i] * aOut - nIn;
                if (nIn < 0.5 * aIn || nRing < 0.25 * (aOut - aIn)) continue;
                const sIn = eIn[i] * aIn, ring = (eOut[i] * aOut - sIn) / nRing;
                const excess = (sIn - ring * nIn) * (1 - 0.5 * (where / 0.6) ** 2);
                scores.push(excess / nIn);
                map.push({ score: excess, x: x + 0.5, y: y + 0.5 });
                if (!top || excess > top.score) top = { score: excess, mean: excess / nIn, x: x + 0.5, y: y + 0.5, radius: share * R };
            }
        }
        if (top) perScale.push({ ...top, map });
    }
    if (!perScale.length || scores.length < 20) return null;
    const strongest = Math.max(...perScale.map(item => item.score));
    const chosen = perScale.find(item => item.score >= 0.85 * strongest);
    // A second, separate place almost as strong means the nipple is not clear (a mole, a crossing
    // hair or a shadow border competes with it).
    const rival = chosen.map.reduce((acc, p) => (Math.hypot(p.x - chosen.x, p.y - chosen.y) > 2 * chosen.radius && p.score > acc ? p.score : acc), 0);
    const best = { score: chosen.score, mean: chosen.mean, x: chosen.x, y: chosen.y, radius: chosen.radius,
        rival: chosen.score > 0 ? rival / chosen.score : 1 };
    // Precise outline: on rays from the coarse centre, the sharpest change of brightness or colour;
    // a circle fitted to those points gives the centre and radius.
    const fitted = nippleOutline(lab, w, h, f, contrast, best.x, best.y, best.radius);
    if (fitted && rho(e, fitted.x, fitted.y) <= 0.75 && fitted.radius >= 0.04 * R && fitted.radius <= 0.6 * R) {
        best.x = fitted.x; best.y = fitted.y; best.radius = fitted.radius; best.outlineSupport = fitted.support;
    }
    const typical = median(scores.map(Math.abs));
    best.ratio = best.mean / (typical + 1e-6);
    return best;
}

/** Circle through the sharpest brightness or colour change on 48 rays around a coarse centre. */
function nippleOutline(lab, w, h, f, contrast, cx, cy, r) {
    const points = [];
    const value = (x, y) => [sample(lab.L, w, h, x, y), sample(f, w, h, x, y) * contrast];
    for (let k = 0; k < 48; k++) {
        const theta = (2 * Math.PI * k) / 48, c = Math.cos(theta), s = Math.sin(theta);
        const steps = [];
        for (let d = 0.4 * r; d <= 1.8 * r; d += 0.5) {
            const [l0, f0] = value(cx + (d - 0.5) * c, cy + (d - 0.5) * s);
            const [l1, f1] = value(cx + (d + 0.5) * c, cy + (d + 0.5) * s);
            steps.push({ d, g: Math.abs(l1 - l0) + Math.abs(f1 - f0) });
        }
        if (steps.some(item => Number.isNaN(item.g))) continue;
        const top = steps.reduce((acc, item) => (item.g > acc.g ? item : acc));
        if (top.g > 2 * median(steps.map(item => item.g)) + 0.2) points.push([cx + top.d * c, cy + top.d * s]);
    }
    if (points.length < 10) return null;
    let current = points, circle = null;
    for (let pass = 0; pass < 3; pass++) {
        circle = fitCircle(current);
        if (!circle) return null;
        const res = current.map(([x, y]) => Math.abs(Math.hypot(x - circle.x, y - circle.y) - circle.radius));
        const mad = median(res) * 1.4826 + 0.3;
        const kept = current.filter((p, i) => res[i] <= 2.5 * mad);
        if (kept.length === current.length || kept.length < 8) break;
        current = kept;
    }
    return { ...circle, support: current.length / 48 };
}

/** Algebraic (Kasa) circle fit: x^2 + y^2 + D x + E y + F = 0 by linear least squares. */
function fitCircle(points) {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
    for (const [x, y] of points) {
        const row = [x, y, 1], rhs = -(x * x + y * y);
        for (let i = 0; i < 3; i++) { v[i] += row[i] * rhs; for (let j = 0; j < 3; j++) M[i][j] += row[i] * row[j]; }
    }
    const s = solve3(M, v);
    if (!s) return null;
    const x = -s[0] / 2, y = -s[1] / 2, r2 = x * x + y * y - s[2];
    return r2 > 0 ? { x, y, radius: Math.sqrt(r2) } : null;
}

// ---- Light ----------------------------------------------------------------------------------

/**
 * Brightness slope that is not rotationally symmetric, around (cx, cy) up to radius r, in L units
 * per pixel. Ring means are removed first, so a symmetric bump or a dark core does not count.
 */
function asymmetricSlope(img, w, h, cx, cy, r, exclude = null) {
    const bins = Math.max(4, Math.round(r));
    const sum = new Float64Array(bins), count = new Float64Array(bins);
    const pts = [];
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy);
        if (d > r || (exclude && exclude(x + 0.5, y + 0.5))) continue;
        const bin = Math.min(bins - 1, Math.floor((d / r) * bins));
        const v = img[y * w + x];
        sum[bin] += v; count[bin]++;
        pts.push([dx, dy, bin, v]);
    }
    if (pts.length < 30) return null;
    let sxx = 0, syy = 0, sxy = 0, sxv = 0, syv = 0;
    for (const [dx, dy, bin, v] of pts) {
        const res = v - sum[bin] / count[bin];
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy; sxv += dx * res; syv += dy * res;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-9) return null;
    const gx = (sxv * syy - syv * sxy) / det, gy = (syv * sxx - sxv * sxy) / det;
    let noise = 0;
    for (const [dx, dy, bin, v] of pts) noise += (v - sum[bin] / count[bin] - gx * dx - gy * dy) ** 2;
    return { gx, gy, magnitude: Math.hypot(gx, gy), noise: Math.sqrt(noise / pts.length), n: pts.length };
}

/** Fine grain of the areola: robust spread of brightness around its local mean, away from the nipple. */
function textureGrain(L, w, h, e, nipple) {
    const local = boxBlur(L, w, h, 2, 2);
    const values = [];
    const x0 = Math.max(0, Math.floor(e.cx - e.a)), x1 = Math.min(w - 1, Math.ceil(e.cx + e.a));
    const y0 = Math.max(0, Math.floor(e.cy - e.a)), y1 = Math.min(h - 1, Math.ceil(e.cy + e.a));
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
        const r = rho(e, x + 0.5, y + 0.5);
        if (r < 0.4 || r > 0.75 || Math.hypot(x + 0.5 - nipple.x, y + 0.5 - nipple.y) < 1.6 * nipple.radius) continue;
        values.push(Math.abs(L[y * w + x] - local[y * w + x]));
    }
    return values.length ? median(values) * 1.4826 : 0;
}

const angleOf = (gx, gy) => ((Math.atan2(gy, gx) * 180) / Math.PI + 360) % 360;
const angleBetween = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Light azimuth from one areola: the nipple's own shading and the breast's broad slope.
 * Returns { azimuthDeg, reasons } when both agree, else { azimuthDeg: null, reasons }.
 */
function lightFrom(lab, w, h, e, nipple) {
    const reasons = [];
    const R = Math.sqrt(e.a * e.b);
    let fromNipple = null;
    if (nipple) {
        const rn = nipple.radius;
        const sL = asymmetricSlope(lab.L, w, h, nipple.x, nipple.y, 1.5 * rn);
        const sA = asymmetricSlope(lab.A, w, h, nipple.x, nipple.y, 1.5 * rn);
        if (sL) {
            // The lit side must stand out from the areola's own fine grain, measured on the areola
            // away from the nipple. The residual of the plane fit is not used as noise: on a lit
            // bump it is mostly the bump's own non-linear shading.
            const grain = textureGrain(lab.L, w, h, e, nipple);
            const across = sL.magnitude * rn;
            const az = angleOf(sL.gx, sL.gy);
            const pigment = sA && sA.magnitude > 0.6 * sL.magnitude && angleBetween(az, angleOf(sA.gx, sA.gy)) < 30;
            if (across < Math.max(1.5, 3 * grain)) reasons.push('the nipple shows no clear lit side');
            else if (pigment) reasons.push('the nipple brightness follows its colour, not the light');
            else fromNipple = az;
        }
    } else {
        reasons.push('no nipple to read the light from');
    }
    const outside = (x, y) => rho(e, x, y) < 1.15;
    const sB = asymmetricSlope(lab.L, w, h, e.cx, e.cy, 3 * R, outside);
    let fromBreast = null;
    if (sB && sB.magnitude * R > 1) fromBreast = angleOf(sB.gx, sB.gy);
    else reasons.push('the skin around the areola has no clear brightness slope');
    if (fromNipple === null || fromBreast === null) return { azimuthDeg: null, nipple: fromNipple, breast: fromBreast, reasons };
    const gap = angleBetween(fromNipple, fromBreast);
    if (gap > 35) {
        reasons.push(`the nipple (${fromNipple.toFixed(0)} deg) and the breast (${fromBreast.toFixed(0)} deg) disagree by ${gap.toFixed(0)} deg`);
        return { azimuthDeg: null, nipple: fromNipple, breast: fromBreast, reasons };
    }
    const x = 2 * Math.cos((fromNipple * Math.PI) / 180) + Math.cos((fromBreast * Math.PI) / 180);
    const y = 2 * Math.sin((fromNipple * Math.PI) / 180) + Math.sin((fromBreast * Math.PI) / 180);
    return { azimuthDeg: angleOf(x, y), nipple: fromNipple, breast: fromBreast, reasons };
}

// ---- Candidates without hints ----------------------------------------------------------------

/**
 * Centres and rough radii where the colour of a disc differs most from the ring around it, in the
 * direction an areola usually differs from skin (darker and/or redder). Integral images make every
 * disc/ring comparison constant time; boxes stand in for discs at this stage.
 */
function candidates(lab, w, h, rMin, rMax) {
    const integral = src => {
        const I = new Float64Array((w + 1) * (h + 1));
        for (let y = 0; y < h; y++) {
            let row = 0;
            for (let x = 0; x < w; x++) { row += src[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
        }
        return I;
    };
    const IL = integral(lab.L), IA = integral(lab.A), IB = integral(lab.B);
    const boxMean = (I, x0, y0, x1, y1) => {
        x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
        const n = (x1 - x0) * (y1 - y0);
        if (n <= 0) return { s: 0, n: 0 };
        return { s: I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0], n };
    };
    const found = [];
    for (let r = rMin; r <= rMax; r *= 1.15) {
        const step = Math.max(2, Math.round(r / 4));
        const ri = Math.round(0.6 * r), r1 = Math.round(1.3 * r), r2 = Math.round(1.9 * r);
        for (let cy = r2; cy < h - r2; cy += step) {
            for (let cx = r2; cx < w - r2; cx += step) {
                const mean = I => {
                    const inner = boxMean(I, cx - ri, cy - ri, cx + ri, cy + ri);
                    const big = boxMean(I, cx - r2, cy - r2, cx + r2, cy + r2), small = boxMean(I, cx - r1, cy - r1, cx + r1, cy + r1);
                    return [inner.s / inner.n, (big.s - small.s) / (big.n - small.n)];
                };
                const [Li, Lo] = mean(IL), [Ai, Ao] = mean(IA), [Bi, Bo] = mean(IB);
                if (!(Lo - Li > 2 || Ai - Ao > 2)) continue;
                const score = Math.hypot(Li - Lo, Ai - Ao, Bi - Bo);
                found.push({ x: cx + 0.5, y: cy + 0.5, r, score });
            }
        }
    }
    found.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of found) {
        if (kept.length >= 6) break;
        if (kept.some(k => Math.hypot(k.x - c.x, k.y - c.y) < 1.5 * Math.max(k.r, c.r))) continue;
        kept.push(c);
    }
    return kept;
}

// ---- Entry point ----------------------------------------------------------------------------

const round2 = value => Math.round(value * 100) / 100;

/**
 * Find and measure up to two areolas on an RGB grid.
 *
 * @param {Uint8Array} rgb - 8-bit sRGB, chunky.
 * @param {number} w
 * @param {number} h
 * @param {number} channels - 3 or 4.
 * @param {{left: number, top: number, scaleX: number, scaleY: number}} map - Grid to document.
 * @param {{hints?: {center: number[], radius?: number}[]}} [options] - Hints in document pixels.
 * @returns {{ areolas: object[], light: object, notes: string[], searched: string }}
 */
function detectInImage(rgb, w, h, channels, map, { hints = [] } = {}) {
    const raw = toLab(rgb, w * h, channels);
    const blur = Math.max(1, Math.round(Math.min(w, h) / 600));
    const lab = { L: boxBlur(raw.L, w, h, blur, 2), A: boxBlur(raw.A, w, h, blur, 2), B: boxBlur(raw.B, w, h, blur, 2) };
    const toGrid = ([x, y]) => [(x - map.left) / map.scaleX, (y - map.top) / map.scaleY];
    const scale = Math.sqrt(map.scaleX * map.scaleY);
    const notes = [];
    const rMin = Math.max(4, Math.min(w, h) / 60), rMax = Math.min(w, h) / 4;

    let starts;
    if (hints.length) {
        starts = hints.slice(0, MAX_AREOLAS).map(hint => {
            const [gx, gy] = toGrid(hint.center);
            if (hint.radius) return { x: gx, y: gy, r: hint.radius / scale, hinted: true };
            const rough = roughRadius(lab, w, h, gx, gy, rMin, rMax);
            return { x: gx, y: gy, r: rough ? rough.r : rMin * 3, alt: rough && rough.strongest !== rough.r ? rough.strongest : null, hinted: true };
        });
    } else {
        starts = candidates(lab, w, h, rMin, rMax);
        if (!starts.length) notes.push('No place in the searched area differs from the skin around it like an areola.');
    }

    const measured = [];
    const rank = { high: 2, medium: 1, low: 0 };
    for (const start of starts) {
        // Each rough radius is tried; the better graded result wins (support breaks a tie).
        let pick = null;
        for (const radius of [start.r, start.alt].filter(Boolean)) {
            const r = refine(lab, w, h, { cx: start.x, cy: start.y, a: radius, b: radius, t: 0 });
            if (!r) continue;
            const st = stability(lab, w, h, r);
            const measures = { contrast: r.contrast, support: r.support, residual: r.residual,
                centerSpread: st.centerSpread, axisSpread: st.axisSpread, failedRuns: st.failed, runs: st.runs };
            if (start.hinted) measures.hintDistance = Math.hypot(r.e.cx - start.x, r.e.cy - start.y) / Math.sqrt(r.e.a * r.e.b);
            const candidate = { r, measures, confidence: grade(measures), start };
            if (!pick || rank[candidate.confidence.level] > rank[pick.confidence.level]
                || (rank[candidate.confidence.level] === rank[pick.confidence.level] && measures.support > pick.measures.support)) pick = candidate;
        }
        if (pick) measured.push(pick);
        else if (start.hinted) measured.push({ failed: true, start });
    }
    let found = measured.filter(m => !m.failed);
    if (!hints.length) {
        // Without hints keep the two best by confidence and contrast; drop clear non-areolas.
        const order = { high: 2, medium: 1, low: 0 };
        found = found.filter(m => m.confidence.level !== 'low' || found.length <= 2)
            .sort((a, b) => order[b.confidence.level] - order[a.confidence.level] || b.measures.contrast - a.measures.contrast)
            .slice(0, MAX_AREOLAS);
        if (measured.length > found.length) notes.push(`${measured.length - found.length} weaker candidate place(s) were not taken.`);
    }
    for (const m of measured.filter(m => m.failed)) {
        notes.push(`No areola edge was found around the hint at ${m.start.x * map.scaleX + map.left},${m.start.y * map.scaleY + map.top}.`);
    }

    const areolas = [], lights = [];
    for (const m of found) {
        const e = m.r.e;
        const outer = m.r.outer, inner = m.r.inner, contrast = m.r.contrast;
        const dir = [0, 1, 2].map(k => (inner[k] - outer[k]) / contrast);
        const f = new Float32Array(w * h);
        for (let i = 0; i < f.length; i++) {
            f[i] = ((lab.L[i] - outer[0]) * dir[0] + (lab.A[i] - outer[1]) * dir[1] + (lab.B[i] - outer[2]) * dir[2]) / contrast;
        }
        const nipple = findNipple(lab, w, h, e, f, contrast);
        // Found only when it stands out, its outline is traced on most rays and nothing else
        // inside the areola competes with it.
        // Calibration run 2: wrong nipples were mostly large (median 0.47 of the areola radius
        // against 0.30 for right ones) and stood out less (strength median 4.0 against 6.6).
        const nippleShare = nipple ? nipple.radius / Math.sqrt(e.a * e.b) : 0;
        const nippleFound = Boolean(nipple && nipple.ratio >= 3.5 && (nipple.outlineSupport || 0) >= 0.6
            && nipple.rival <= 0.75 && nippleShare <= 0.42);
        const light = lightFrom(lab, w, h, e, nippleFound ? nipple : null);
        lights.push(light);
        const docCenter = [map.left + e.cx * map.scaleX, map.top + e.cy * map.scaleY];
        const a = e.a * scale, b = e.b * scale;
        let angleDeg = (e.t * 180) / Math.PI;
        angleDeg = ((angleDeg % 180) + 180) % 180;
        if (angleDeg > 90) angleDeg -= 180;
        const record = {
            areola: { center: docCenter.map(round2), radii: [round2(a), round2(b)], angleDeg: round2(angleDeg) },
            nipple: nippleFound ? [round2(map.left + nipple.x * map.scaleX), round2(map.top + nipple.y * map.scaleY)] : docCenter.map(round2),
            nippleRadiusPx: round2(nippleFound ? Math.min(nipple.radius * scale, a) : DEFAULT_NIPPLE_SHARE * a)
        };
        areolas.push({
            record,
            nipple: Object.assign(nippleFound
                ? { found: true, source: 'measured: compact bump inside the areola' }
                : { found: false, source: 'not found clearly: centre of the areola and 0.3 of the long half-axis' },
            nipple ? { strength: round2(nipple.ratio), outline: round2(nipple.outlineSupport || 0), rival: round2(nipple.rival),
                radiusShare: round2(nipple.radius / Math.sqrt(e.a * e.b)) } : { strength: 0 }),
            edge: { visible_share: round2(m.measures.support) },
            confidence: { level: m.confidence.level, reasons: m.confidence.reasons,
                measures: Object.fromEntries(Object.entries(m.measures).map(([k, v]) => [k, round2(v)])) },
            hinted: Boolean(m.start.hinted)
        });
    }
    areolas.sort((p, q) => p.record.areola.center[0] - q.record.areola.center[0]);

    // One light for the picture: every areola that gave a direction must agree.
    const given = lights.filter(l => l.azimuthDeg !== null);
    let light;
    const reasons = lights.flatMap(l => l.reasons);
    if (given.length && given.every(l => angleBetween(l.azimuthDeg, given[0].azimuthDeg) <= 45)) {
        const x = given.reduce((s, l) => s + Math.cos((l.azimuthDeg * Math.PI) / 180), 0);
        const y = given.reduce((s, l) => s + Math.sin((l.azimuthDeg * Math.PI) / 180), 0);
        light = { azimuthDeg: round2(angleOf(x, y)), elevationDeg: DEFAULT_LIGHT.elevationDeg, kind: 'estimated',
            note: 'azimuth from the nipple shading and the breast slope; elevation is the default 45, one frame does not show it', reasons };
    } else {
        if (given.length) reasons.push('the areolas give different light directions');
        light = { ...DEFAULT_LIGHT, kind: 'default', note: 'default 315/45: the picture gave no reliable light direction', reasons };
    }
    return { areolas, light, notes, searched: hints.length ? 'around the hints' : 'whole area without hints' };
}

module.exports = {
    detectInImage, fitEllipse, robustFit, toLab, boxBlur, LEVELS, DEFAULT_LIGHT, angleBetween,
    // Exported for testing only: the separate steps, so calibration can check each on its own.
    _internals: { refine, findNipple, nippleOutline, fitCircle, lightFrom, asymmetricSlope, candidates, roughRadius, ringColour }
};
