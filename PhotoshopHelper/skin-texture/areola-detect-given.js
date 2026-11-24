'use strict';

/**
 * Nipple and light for areolas whose outline is already known (task20): the person selected the
 * areola, so the outline is theirs and exact, but they did not cut the nipple out of the
 * selection. Helper then measures the nipple and the light on the document pixels inside that
 * outline, with the same steps the image search uses (areola-detect-image.js). The outline itself
 * is never changed here.
 */

const image = require('./areola-detect-image');
const { hasAmbiguousHoles } = require('./areola-detect');

const I = image._internals;
const round2 = value => Math.round(value * 100) / 100;

/**
 * @param {Uint8Array} rgb - 8-bit sRGB grid, chunky.
 * @param {number} w
 * @param {number} h
 * @param {number} channels
 * @param {{left: number, top: number, scaleX: number, scaleY: number}} map - Grid to document.
 * @param {object[]} areolas - Fitted areolas: { record, nipple: { found }, ... } from fitSelection.
 * @returns {{ areolas: object[], light: object }} The same areolas, with the nipple filled where it
 *   was missing and measured clearly, and one light for the picture.
 */
function measureGiven(rgb, w, h, channels, map, areolas) {
    const raw = image.toLab(rgb, w * h, channels);
    const blur = Math.max(1, Math.round(Math.min(w, h) / 600));
    const lab = { L: image.boxBlur(raw.L, w, h, blur, 2), A: image.boxBlur(raw.A, w, h, blur, 2), B: image.boxBlur(raw.B, w, h, blur, 2) };
    const scale = Math.sqrt(map.scaleX * map.scaleY);
    const lights = [];
    const out = areolas.map(item => {
        // Ambiguous multi-hole selections are sent back to the user rather than having a nipple measured.
        if (hasAmbiguousHoles(item)) return item;
        const r = item.record;
        const e = { cx: (r.areola.center[0] - map.left) / map.scaleX, cy: (r.areola.center[1] - map.top) / map.scaleY,
            a: r.areola.radii[0] / scale, b: r.areola.radii[1] / scale, t: (r.areola.angleDeg * Math.PI) / 180 };
        const inner = I.ringColour(lab, w, h, e, 0.35, 0.7), outer = I.ringColour(lab, w, h, e, 1.35, 1.9);
        if (!inner || !outer) return item;
        const contrast = Math.hypot(inner[0] - outer[0], inner[1] - outer[1], inner[2] - outer[2]);
        if (contrast < 1.5) return item;
        const dir = [0, 1, 2].map(k => (inner[k] - outer[k]) / contrast);
        const f = new Float32Array(w * h);
        for (let i = 0; i < f.length; i++) {
            f[i] = ((lab.L[i] - outer[0]) * dir[0] + (lab.A[i] - outer[1]) * dir[1] + (lab.B[i] - outer[2]) * dir[2]) / contrast;
        }
        // A nipple the person marked (a hole in the selection) stays exactly as marked.
        let nipplePoint = null;
        if (item.nipple.found) {
            nipplePoint = { x: (r.nipple[0] - map.left) / map.scaleX, y: (r.nipple[1] - map.top) / map.scaleY, radius: r.nippleRadiusPx / scale };
            lights.push(I.lightFrom(lab, w, h, e, nipplePoint));
            return item;
        }
        const found = I.findNipple(lab, w, h, e, f, contrast);
        const clear = Boolean(found && found.ratio >= 2.2 && (found.outlineSupport || 0) >= 0.6 && found.rival <= 0.75);
        lights.push(I.lightFrom(lab, w, h, e, clear ? found : null));
        if (!clear) return item;
        return {
            ...item,
            record: { ...r,
                nipple: [round2(map.left + found.x * map.scaleX), round2(map.top + found.y * map.scaleY)],
                nippleRadiusPx: round2(Math.min(found.radius * scale, r.areola.radii[0])) },
            nipple: { found: true, source: 'measured by Helper inside the selected outline', strength: round2(found.ratio),
                outline: round2(found.outlineSupport || 0), rival: round2(found.rival) }
        };
    });
    const given = lights.filter(l => l && l.azimuthDeg !== null);
    let light;
    if (given.length && given.every(l => image.angleBetween(l.azimuthDeg, given[0].azimuthDeg) <= 45)) {
        const x = given.reduce((s, l) => s + Math.cos((l.azimuthDeg * Math.PI) / 180), 0);
        const y = given.reduce((s, l) => s + Math.sin((l.azimuthDeg * Math.PI) / 180), 0);
        light = { azimuthDeg: round2(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360), elevationDeg: image.DEFAULT_LIGHT.elevationDeg,
            kind: 'estimated', note: 'azimuth from the nipple shading and the breast slope inside and around the selected outline; elevation is the default 45', reasons: [] };
    } else {
        light = { ...image.DEFAULT_LIGHT, kind: 'default', note: 'default 315/45: the picture gave no reliable light direction',
            reasons: lights.flatMap(l => (l ? l.reasons : [])) };
    }
    return { areolas: out, light };
}

module.exports = { measureGiven };
