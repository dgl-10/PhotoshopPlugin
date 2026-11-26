'use strict';

/**
 * Shared plumbing for the areola tests (task20): independent expectations (the pinned binary
 * file names and hashes are transcribed here, not imported), synthetic selections and pictures,
 * and small scene helpers. Not a test file itself.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SKIN_TEXTURE_DIR = path.join(__dirname, '../skin-texture');

/**
 * The two areola variants, top to bottom, updated by the author's decision of 22 November
 * 2026: "Areola Formula 1/2" in the order of the face formulas (Fable, Gemini); GPT-6 was removed in task28.
 */
const AREOLA_VARIANTS = Object.freeze([
    { id: 'areola_fable', label: 'Fable', group: 'Areola Formula 1', visible: true, variant: 'fable_areola_v1',
        fileName: 'fable_areola.wasm', layers: ['Nipple', 'Areola Tubercles', 'Areola Skin'],
        outputs: ['areola_fable_nipple', 'areola_fable_tubercles', 'areola_fable_skin'] },
    { id: 'areola_gemini', label: 'Gemini', group: 'Areola Formula 2', visible: false, variant: 'gemini4_areola_v1',
        fileName: 'gemini4_areola.wasm', layers: ['Nipple', 'Areola Tubercles', 'Areola Skin'],
        outputs: ['areola_gemini_nipple', 'areola_gemini_tubercles', 'areola_gemini_skin'] }
]);

/** Skip reason when a private areola binary is absent from this checkout; false when all are there. */
function missingAreolaBinaryReason() {
    const missing = AREOLA_VARIANTS.filter(v => !fs.existsSync(path.join(SKIN_TEXTURE_DIR, v.fileName))).map(v => v.fileName);
    return missing.length ? `Private areola Wasm files missing: ${missing.join(', ')}` : false;
}

/** Skip reason covering the skin formula binaries as well (the default recipe needs them). */
function missingAllBinariesReason() {
    return missingAreolaBinaryReason() || require('./skinTextureTestSupport').missingBinaryReason();
}

/** SHA-256 of a private binary as it lies on disk. */
function sha256OfFile(fileName) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(SKIN_TEXTURE_DIR, fileName))).digest('hex');
}

/**
 * Two areolas of one picture, a rotated one and an axis-aligned one, as they would reach
 * ps_skin_texture_start (document pixels).
 */
function twoAreolas() {
    return [
        { areola: { center: [300, 250], radii: [40, 30], angleDeg: 20 }, nipple: [302, 251], nippleRadiusPx: 8 },
        { areola: { center: [500, 260], radii: [38, 30], angleDeg: -10 } }
    ];
}

/** Pixel box of the outline scaled by 1.5 plus 2 pixels, from the contract text (not the product code). */
function expectedBox(record) {
    const { center, radii, angleDeg } = record.areola;
    const t = angleDeg * Math.PI / 180;
    const a = radii[0] * 1.5, b = radii[1] * 1.5;
    const hx = Math.hypot(a * Math.cos(t), b * Math.sin(t));
    const hy = Math.hypot(a * Math.sin(t), b * Math.cos(t));
    return { x0: Math.floor(center[0] - hx) - 2, y0: Math.floor(center[1] - hy) - 2,
        x1: Math.ceil(center[0] + hx) + 2, y1: Math.ceil(center[1] + hy) + 2 };
}

/** The union of the boxes of the given records, clipped to a document, as { x, y, width, height }. */
function expectedRegion(records, document) {
    const boxes = records.map(expectedBox);
    const x0 = Math.max(0, Math.min(...boxes.map(b => b.x0))), y0 = Math.max(0, Math.min(...boxes.map(b => b.y0)));
    const x1 = Math.min(document.width, Math.max(...boxes.map(b => b.x1))), y1 = Math.min(document.height, Math.max(...boxes.map(b => b.y1)));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Capture every exchange file Helper put into the data folder before the apply script runs,
 * decoded with the exchange module. The files are the independent record of what Helper computed.
 *
 * @param {object} fake - The fake Photoshop of a harness.
 * @param {string} dataFolder - Its data folder.
 * @returns {Map<string, {header: object, payload: Uint8Array}>} By output key, filled when apply runs.
 */
function captureExchangeFiles(fake, dataFolder) {
    const exchange = require('../skin-texture/exchange');
    const captured = new Map();
    fake.state.beforeScript = payload => {
        if (!payload.code.includes('Skin texture: write')) return;
        for (const name of fs.readdirSync(dataFolder).filter(n => n.startsWith('skin-texture-') && !n.endsWith('.partial'))) {
            const bytes = new Uint8Array(fs.readFileSync(path.join(dataFolder, name)));
            const decoded = exchange.decode(bytes);
            captured.set(decoded.header.output, { header: decoded.header, payload: Uint8Array.from(decoded.payload) });
        }
    };
    return captured;
}

/** Photoshop's reduced 16-bit range and its inverse, as the texture layers use them. */
const to16 = v => Math.round(v * 32768 / 255);
const from16 = w => Math.round(w * 255 / 32768);
// task20: texture layers use the relief mapping (128 -> 16384, the Linear Light neutral); its inverse.
const fromRelief16 = w => (w <= 16384 ? Math.round(w / 128) : Math.round(128 + (w - 16384) * 127 / 16384));

/**
 * Plain recursive view of a fake layer tree, for "the old scene is unchanged" checks.
 *
 * @param {object[]} layers - Sibling layers.
 * @returns {object[]} Parentage, order and visible properties.
 */
function snapshotLayerTree(layers) {
    return Array.from(layers || []).map(layer => ({
        id: layer.id, name: layer.name, kind: layer.kind, visible: layer.visible, opacity: layer.opacity,
        blendMode: String(layer.blendMode), parentId: layer.parent ? layer.parent.id : null,
        hasMask: Boolean(layer.mask), children: snapshotLayerTree(layer.layers)
    }));
}

/** All layers depth-first, as the original objects. */
function flattenLayers(layers) {
    const result = [];
    for (const layer of layers || []) {
        result.push(layer, ...flattenLayers(layer.layers));
    }
    return result;
}

// ---- Synthetic selections and pictures ------------------------------------------------------

/**
 * A selection mask (255 selected) with filled ellipses, optionally with a round hole in each.
 *
 * @param {number} width - Document width.
 * @param {number} height - Document height.
 * @param {{center: number[], radii: number[], angleDeg: number, hole?: {center: number[], radius: number}}[]} shapes
 * @returns {Uint8Array}
 */
function ellipseMask(width, height, shapes) {
    const mask = new Uint8Array(width * height);
    for (const shape of shapes) {
        const t = shape.angleDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
        const [cx, cy] = shape.center, [rx, ry] = shape.radii;
        const reach = Math.ceil(Math.max(rx, ry)) + 2;
        for (let y = Math.max(0, Math.floor(cy) - reach); y < Math.min(height, Math.ceil(cy) + reach); y++) {
            for (let x = Math.max(0, Math.floor(cx) - reach); x < Math.min(width, Math.ceil(cx) + reach); x++) {
                const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
                const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
                if (u * u + v * v > 1) continue;
                if (shape.hole && Math.hypot(x + 0.5 - shape.hole.center[0], y + 0.5 - shape.hole.center[1]) <= shape.hole.radius) continue;
                mask[y * width + x] = 255;
            }
        }
    }
    return mask;
}

/** CIE Lab (D65) to sRGB 8-bit, the inverse of what the areola search measures on. */
function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = t => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
    const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
    const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.2040 * Y + 1.0570 * Z];
    return lin.map(v => {
        const c = Math.min(1, Math.max(0, v));
        return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
    });
}

const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * A clean synthetic picture of skin with one areola and a shaded bump nipple, chunky 8-bit RGB.
 * Skin Lab about (72, 12, 18), areola about (50, 20, 20) with a soft edge; the nipple is a
 * hemispherical bump, darker and redder, brighter on the side that faces the light.
 *
 * @param {object} spec
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number[]} spec.center - Areola centre, document pixels.
 * @param {number[]} spec.radii - Half-axes.
 * @param {number} spec.angleDeg
 * @param {number[]} spec.nipple - Nipple centre.
 * @param {number} spec.nippleRadius
 * @param {number} spec.lightAzimuthDeg - Direction towards the lamp, from the x axis towards y.
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
function areolaPicture(spec) {
    const { width, height, center, radii, angleDeg, nipple, nippleRadius, lightAzimuthDeg } = spec;
    const data = new Uint8Array(width * height * 3);
    const t = angleDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const lx = Math.cos(lightAzimuthDeg * Math.PI / 180), ly = Math.sin(lightAzimuthDeg * Math.PI / 180);
    const edge = 0.04;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dx = x + 0.5 - center[0], dy = y + 0.5 - center[1];
            const rho = Math.hypot((dx * c + dy * s) / radii[0], (-dx * s + dy * c) / radii[1]);
            const f = 1 - smooth((rho - (1 - edge)) / (2 * edge));
            let L = 72 + (50 - 72) * f, A = 12 + (20 - 12) * f, B = 18 + (20 - 18) * f;
            const nx = x + 0.5 - nipple[0], ny = y + 0.5 - nipple[1];
            const nr = Math.hypot(nx, ny) / nippleRadius;
            if (nr < 1) {
                const rise = Math.sqrt(1 - nr * nr);
                const facing = (nx * lx + ny * ly) / nippleRadius;
                L = 44 + 10 * rise + 9 * facing;
                A = 22;
                B = 21;
            }
            const [r, g, b] = labToRgb(L, A, B);
            data[(y * width + x) * 3] = r; data[(y * width + x) * 3 + 1] = g; data[(y * width + x) * 3 + 2] = b;
        }
    }
    return { width, height, data };
}

module.exports = {
    SKIN_TEXTURE_DIR, AREOLA_VARIANTS, missingAreolaBinaryReason, missingAllBinariesReason, sha256OfFile,
    twoAreolas, expectedBox, expectedRegion, captureExchangeFiles, to16, from16, fromRelief16, snapshotLayerTree,
    flattenLayers, ellipseMask, labToRgb, areolaPicture
};
