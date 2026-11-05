/*
 * Cheek microrelief prototype. All distances are millimetres and heights are
 * micrometres until the normal calculation. This file has no host dependencies.
 * Paste the entire file into a script and call SkinTexture.render(parameters).
 * The staged API lets a caller measure time without introducing a clock here.
 */
'use strict';
var SkinTexture = (function () {
    const VERSION = 'task01-1';
    const GAIN = 128;
    // Fixed-point illumination makes box sums exact, independent of ROI size.
    // Its quantization error is below 0.0005 output levels, before byte rounding.
    const LIGHT_SCALE = 262144;
    const defaults = {
        width: 1024, height: 1024, rect: null, pxPerMm: 6, seed: 1,
        zone: 'cheek', mode: 'lines', azimuthDeg: 225, elevationDeg: 45,
        relief: 1, pores: true, furrows: true, roughness: true,
        spacingMm: 0.45, secondaryRatio: 2.5,
        primaryDepthUm: 30, secondaryDepthUm: 8,
        primaryWidthMm: 0.06, secondaryWidthMm: 0.025,
        aspect: 1.7, directionDeg: 35, warpFraction: 0.35,
        warpLengthCells: 3, lineLengthCells: 2.5,
        poreDensity: 0.45, smallPoreDensity: 1.6,
        poreRadiusMm: 0.18, smallPoreRadiusMm: 0.055,
        poreRadiusMinMm: 0.125, poreRadiusMaxMm: 0.32,
        smallRadiusMinMm: 0.025, smallRadiusMaxMm: 0.11,
        radiusLogSigma: 0.32, poreDepthUm: 45, smallPoreDepthUm: 12,
        minPoreDistanceMm: 0.35, smallMinDistanceMm: 0.14,
        densityVariation: 0.45, densityLengthMm: 5,
        clusterFraction: 0.55, clusterRadiusMm: 0.7,
        smallClusterRadiusMm: 0.3, nodeFraction: 0.45,
        nodeAttractMm: 0.4, poreAspect: 1.2, droplet: 0.14,
        poreDirectionDeg: 60, roughnessWavelengthMm: 0.16,
        roughnessAmplitudeUm: 1.5, roughnessOctaves: 3,
        highPassCells: 3, heightPreviewUm: 100
    };
    const calibrationCache = new Map();
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
    const fade = pixels => smooth(pixels - 2);

    // Math.imul forces the same 32-bit arithmetic in every conforming JS host.
    // Independent salts separate geometry, thinning, sizes and local directions.
    function hash(x, y, seed, salt) {
        let h = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(y | 0, 0x5f356495) ^ seed ^ salt;
        h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
        h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
        return (h ^ (h >>> 16)) >>> 0;
    }
    const random = (x, y, s, t) => (hash(x, y, s, t) + 0.5) / 4294967296;
    function noise(x, y, seed, salt) {
        const ix = Math.floor(x), iy = Math.floor(y);
        const fx = smooth(x - ix), fy = smooth(y - iy);
        const a = random(ix, iy, seed, salt), b = random(ix + 1, iy, seed, salt);
        const c = random(ix, iy + 1, seed, salt), d = random(ix + 1, iy + 1, seed, salt);
        return 2 * ((a + fx * (b - a)) * (1 - fy) + (c + fx * (d - c)) * fy) - 1;
    }
    function resolveParams(input = {}) {
        // Unknown options are errors: misspelled physical units must not silently
        // produce a plausible but incorrectly scaled photograph overlay.
        for (const key of Object.keys(input)) {
            if (!Object.prototype.hasOwnProperty.call(defaults, key)) throw new Error('Unknown parameter: ' + key);
        }
        const p = Object.assign({}, defaults, input);
        for (const key of Object.keys(defaults)) {
            if (typeof defaults[key] === 'number' && !Number.isFinite(p[key]))
                throw new Error('Expected finite number: ' + key);
        }
        for (const key of ['pores', 'furrows', 'roughness'])
            if (typeof p[key] !== 'boolean') throw new Error('Expected boolean: ' + key);
        if (p.zone !== 'cheek' || !['lines', 'cells'].includes(p.mode))
            throw new Error('Only cheek and modes lines/cells are implemented');
        for (const key of ['width', 'height'])
            if (!Number.isInteger(p[key]) || p[key] < 1 || p[key] > 65536)
                throw new Error(key + ' must be an integer in 1..65536');
        if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 4294967295)
            throw new Error('seed must be an unsigned 32-bit integer');
        const positive = ['pxPerMm', 'spacingMm', 'secondaryRatio', 'primaryWidthMm',
            'secondaryWidthMm', 'aspect', 'warpLengthCells', 'lineLengthCells',
            'poreRadiusMm', 'smallPoreRadiusMm', 'poreRadiusMinMm', 'poreRadiusMaxMm',
            'smallRadiusMinMm', 'smallRadiusMaxMm', 'minPoreDistanceMm', 'smallMinDistanceMm',
            'densityLengthMm', 'clusterRadiusMm', 'smallClusterRadiusMm', 'poreAspect',
            'roughnessWavelengthMm', 'highPassCells', 'heightPreviewUm'];
        for (const key of positive) if (p[key] <= 0) throw new Error(key + ' must be positive');
        for (const key of ['relief', 'primaryDepthUm', 'secondaryDepthUm', 'poreDensity',
            'smallPoreDensity', 'poreDepthUm', 'smallPoreDepthUm', 'radiusLogSigma',
            'roughnessAmplitudeUm', 'nodeAttractMm', 'warpFraction'])
            if (p[key] < 0) throw new Error(key + ' must be nonnegative');
        for (const key of ['clusterFraction', 'nodeFraction', 'densityVariation', 'droplet'])
            if (p[key] < 0 || p[key] > 1) throw new Error(key + ' must be in 0..1');
        if (p.densityVariation > 0.8 || p.droplet > 0.5 || p.aspect < 1 || p.aspect > 4 ||
            p.poreAspect < 1 || p.poreAspect > 3 || p.warpFraction > 0.4 ||
            p.warpLengthCells < 3 || p.secondaryRatio < 1.5 || p.pxPerMm > 1000 ||
            p.elevationDeg < 5 || p.elevationDeg > 90 || p.highPassCells < 2 ||
            p.poreDensity > 1 || p.smallPoreDensity > 10)
            throw new Error('Parameters exceed the supported prototype range');
        if (!Number.isInteger(p.roughnessOctaves) || p.roughnessOctaves < 0 || p.roughnessOctaves > 6)
            throw new Error('roughnessOctaves must be an integer in 0..6');
        if (p.poreRadiusMinMm > p.poreRadiusMaxMm || p.smallRadiusMinMm > p.smallRadiusMaxMm)
            throw new Error('Minimum pore radius exceeds maximum radius');
        const r = p.rect === null ? { x: 0, y: 0, width: p.width, height: p.height } : p.rect;
        if (!r || Object.keys(r).some(k => !['x', 'y', 'width', 'height'].includes(k)) ||
            !['x', 'y', 'width', 'height'].every(k => Number.isInteger(r[k])) ||
            r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1 ||
            r.x + r.width > p.width || r.y + r.height > p.height)
            throw new Error('rect must be a positive integer rectangle inside the document');
        p.rect = Object.assign({}, r);
        return p;
    }
    function expand(r, amount, p) {
        const x = Math.max(0, r.x - amount), y = Math.max(0, r.y - amount);
        return { x, y, width: Math.min(p.width, r.x + r.width + amount) - x,
            height: Math.min(p.height, r.y + r.height + amount) - y };
    }
    function inside(x, y, b) { return x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height; }

    function geometry(p, level = 0) {
        const step = p.spacingMm / (level ? p.secondaryRatio : 1);
        const theta = p.directionDeg * Math.PI / 180;
        const co = Math.cos(theta), si = Math.sin(theta);
        const seed = (p.seed ^ (level ? 0x7ac91763 : 0x2d5ac387)) >>> 0;
        const amplitude = step * p.warpFraction, wavelength = step * p.warpLengthCells;
        const siteCache = new Map(), tileCache = new Map();
        const normals = [0, 68, 137].map(deg => {
            const a = deg * Math.PI / 180, nx = Math.cos(a), ny = Math.sin(a);
            return { nx, ny, metric: Math.hypot(nx / p.aspect, ny) };
        });
        function warp(x, y) {
            return [x + amplitude * noise(x / wavelength, y / wavelength, seed, 101),
                y + amplitude * noise(x / wavelength, y / wavelength, seed, 102)];
        }
        function transform(x, y) {
            const w = warp(x, y);
            return [(co * w[0] + si * w[1]) / (p.aspect * step),
                (-si * w[0] + co * w[1]) / step];
        }
        function inverse(u, v) {
            const wx = step * (co * p.aspect * u - si * v);
            const wy = step * (si * p.aspect * u + co * v);
            let x = wx, y = wy;
            // The bounded, low-frequency warp is a contraction in the supported
            // range. Iteration also keeps the same node in independent ROIs.
            for (let i = 0; i < 18; i++) {
                const w = warp(x, y); x += wx - w[0]; y += wy - w[1];
            }
            return [x, y];
        }
        function centre(ix, iy) {
            // Bounded jitter guarantees that a 5x5 nearest search is sufficient
            // in transformed coordinates. Stretching never changes this metric.
            return [ix + 0.2 + 0.6 * random(ix, iy, seed, 11),
                iy + 0.2 + 0.6 * random(ix, iy, seed, 12), ix, iy];
        }
        function nearest(u, v) {
            const ix = Math.floor(u), iy = Math.floor(v), key = ix + ',' + iy;
            let points = tileCache.get(key);
            if (!points) {
                points = [];
                for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
                    points.push(centre(ix + dx, iy + dy));
                if (tileCache.size >= 2048) tileCache.clear();
                tileCache.set(key, points);
            }
            let best = points[0], ds = Infinity;
            for (const point of points) {
                const d = (point[0] - u) ** 2 + (point[1] - v) ** 2;
                if (d < ds) { ds = d; best = point; }
            }
            return best;
        }
        function cell(site) {
            const key = site[2] + ',' + site[3];
            let item = siteCache.get(key);
            if (item) return item;
            const planes = [];
            // Each bisector is represented by its exact equation. Dividing by
            // |A^T n| converts transformed distance back to physical millimetres;
            // using F2-F1 would incorrectly widen the groove at its junctions.
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                if (!dx && !dy) continue;
                const other = centre(site[2] + dx, site[3] + dy);
                const nx = other[0] - site[0], ny = other[1] - site[1];
                const c = 0.5 * (other[0] ** 2 + other[1] ** 2 - site[0] ** 2 - site[1] ** 2);
                const scale = step / Math.hypot(nx / p.aspect, ny);
                planes.push([nx, ny, c, scale]);
            }
            item = { planes, vertices: null };
            if (siteCache.size >= 2048) siteCache.clear();
            siteCache.set(key, item);
            return item;
        }
        function vertices(site) {
            const item = cell(site);
            if (item.vertices) return item.vertices;
            // Convex clipping produces actual Voronoi vertices (circumcentres
            // of Delaunay triples), avoiding spurious circumcentres inside cells.
            let poly = [[site[0] - 3, site[1] - 3], [site[0] + 3, site[1] - 3],
                [site[0] + 3, site[1] + 3], [site[0] - 3, site[1] + 3]];
            for (const [nx, ny, c] of item.planes) {
                const next = [];
                for (let i = 0; i < poly.length; i++) {
                    const a = poly[i], b = poly[(i + 1) % poly.length];
                    const da = nx * a[0] + ny * a[1] - c, db = nx * b[0] + ny * b[1] - c;
                    if (da <= 0) next.push(a);
                    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
                        const t = da / (da - db);
                        next.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
                    }
                }
                poly = next;
            }
            item.vertices = poly;
            return poly;
        }
        const linePosition = (i, family) => i + 0.5 + 0.7 * (random(i, family, seed, 41) - 0.5);
        function lineStrength(i, family, v) {
            // A substantial fraction is genuinely absent, rather than merely
            // faint: long uninterrupted strokes read as ruled material.
            return smooth((noise(v / p.lineLengthCells, i * 0.753, seed, 62 + family) + 0.2) / 0.8);
        }
        function profile(distance, halfWidth) {
            const q = Math.max(0, 1 - Math.max(0, distance) / halfWidth);
            return q * q;
        }
        function height(x, y, halfWidth, depth) {
            const [u, v] = transform(x, y);
            if (p.mode === 'cells') {
                let d = Infinity;
                for (const plane of cell(nearest(u, v)).planes)
                    d = Math.min(d, (plane[2] - plane[0] * u - plane[1] * v) * plane[3]);
                return -depth * profile(d, halfWidth);
            }
            let value = 0;
            for (let g = 0; g < normals.length; g++) {
                const n = normals[g], across = n.nx * u + n.ny * v, along = -n.ny * u + n.nx * v;
                const first = Math.floor(across);
                let contribution = 0;
                for (let i = first - 1; i <= first + 1; i++) {
                    const d = Math.abs(across - linePosition(i, g)) * step / n.metric;
                    if (d < halfWidth) contribution = Math.max(contribution,
                        profile(d, halfWidth) * lineStrength(i, g, along));
                }
                // The third family is weaker, so a continuous triangle lattice
                // does not dominate the photographic pore pattern.
                value += contribution * (g === 2 ? 0.5 : 1);
            }
            return -depth * value;
        }
        function node(x, y, radius) {
            const [u, v] = transform(x, y);
            let points = [];
            if (p.mode === 'cells') points = vertices(nearest(u, v));
            else {
                for (let a = 0; a < 2; a++) for (let b = a + 1; b < 3; b++) {
                    const na = normals[a], nb = normals[b];
                    const ia = Math.floor(na.nx * u + na.ny * v), ib = Math.floor(nb.nx * u + nb.ny * v);
                    const det = na.nx * nb.ny - na.ny * nb.nx;
                    for (let i = ia - 1; i <= ia + 1; i++) for (let j = ib - 1; j <= ib + 1; j++) {
                        const va = linePosition(i, a), vb = linePosition(j, b);
                        const nu = (va * nb.ny - na.ny * vb) / det, nv = (na.nx * vb - va * nb.nx) / det;
                        if (lineStrength(i, a, -na.ny * nu + na.nx * nv) > 0.2 &&
                            lineStrength(j, b, -nb.ny * nu + nb.nx * nv) > 0.2) points.push([nu, nv]);
                    }
                }
            }
            let best = null, distance = radius * radius;
            for (const q of points) {
                const point = inverse(q[0], q[1]);
                const d = (point[0] - x) ** 2 + (point[1] - y) ** 2;
                if (d < distance) { best = point; distance = d; }
            }
            return best;
        }
        return { height, node, transform, inverse, nearest, cell, vertices, step };
    }

    function populations(p) {
        return [
            { density: p.poreDensity, median: p.poreRadiusMm, min: p.poreRadiusMinMm,
                max: p.poreRadiusMaxMm, depth: p.poreDepthUm, distance: p.minPoreDistanceMm,
                clusterRadius: p.clusterRadiusMm },
            { density: p.smallPoreDensity, median: p.smallPoreRadiusMm, min: p.smallRadiusMinMm,
                max: p.smallRadiusMaxMm, depth: p.smallPoreDepthUm, distance: p.smallMinDistanceMm,
                clusterRadius: p.smallClusterRadiusMm }
        ];
    }
    function placePores(p, geom, bounds, factors) {
        const groups = populations(p), candidates = [];
        const maxSupport = Math.max(...groups.map(g => g.max)) * p.poreAspect * (1 + p.droplet);
        const maxDistance = Math.max(2 * maxSupport,
            ...groups.map(g => g.distance / Math.sqrt(1 - p.densityVariation)));
        const pool = { x: bounds.x - maxDistance, y: bounds.y - maxDistance,
            width: bounds.width + 2 * maxDistance, height: bounds.height + 2 * maxDistance };
        for (let group = 0; group < groups.length; group++) {
            const g = groups[group];
            if (!g.density) continue;
            // A parent has 2, 3 or 4 children. Unclustered parents scatter their
            // children throughout the tile; clustered ones use a compact disk.
            const step = Math.sqrt(3 / (g.density * factors[group] * (1 + p.densityVariation)));
            const reach = step + g.clusterRadius + p.nodeAttractMm;
            const x0 = Math.floor((pool.x - reach) / step), x1 = Math.ceil((pool.x + pool.width + reach) / step);
            const y0 = Math.floor((pool.y - reach) / step), y1 = Math.ceil((pool.y + pool.height + reach) / step);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > 3000000)
                throw new Error('Pore placement is too large; generate a smaller rectangle');
            for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
                const salt = 1000 + group * 1000;
                const count = 2 + Math.floor(random(ix, iy, p.seed, salt) * 3);
                const clustered = random(ix, iy, p.seed, salt + 1) < p.clusterFraction;
                const parentX = (ix + random(ix, iy, p.seed, salt + 2)) * step;
                const parentY = (iy + random(ix, iy, p.seed, salt + 3)) * step;
                for (let child = 0; child < count; child++) {
                    const tag = salt + 10 + 20 * child;
                    const r1 = random(ix, iy, p.seed, tag), r2 = random(ix, iy, p.seed, tag + 1);
                    const angle = 2 * Math.PI * r1, radius = g.clusterRadius * Math.sqrt(r2);
                    let x = clustered ? parentX + radius * Math.cos(angle) : (ix + r1) * step;
                    let y = clustered ? parentY + radius * Math.sin(angle) : (iy + r2) * step;
                    const modulation = 1 + p.densityVariation * noise(x / p.densityLengthMm, y / p.densityLengthMm, p.seed, 155);
                    if (random(ix, iy, p.seed, tag + 2) > modulation / (1 + p.densityVariation)) continue;
                    let snapped = false;
                    if (p.nodeFraction && random(ix, iy, p.seed, tag + 3) < p.nodeFraction) {
                        const node = geom.node(x, y, p.nodeAttractMm);
                        if (node) { x = node[0]; y = node[1]; snapped = true; }
                    }
                    if (!inside(x, y, pool)) continue;
                    const gaussian = Math.sqrt(-2 * Math.log(random(ix, iy, p.seed, tag + 4))) *
                        Math.cos(2 * Math.PI * random(ix, iy, p.seed, tag + 5));
                    const poreRadius = clamp(g.median * Math.exp(p.radiusLogSigma * gaussian), g.min, g.max);
                    candidates.push({ x, y, group, ix, iy, child, snapped, clustered,
                        priority: hash(ix, iy, p.seed, tag + 6), radius: poreRadius,
                        support: poreRadius * p.poreAspect * (1 + p.droplet),
                        separation: g.distance / Math.sqrt(modulation),
                        depth: g.depth * Math.exp(0.22 * gaussian),
                        angle: (p.poreDirectionDeg + 24 * (random(ix, iy, p.seed, tag + 7) - 0.5)) * Math.PI / 180,
                        phase: random(ix, iy, p.seed, tag + 8) * 2 * Math.PI });
                }
            }
        }
        const bins = new Map();
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i], key = Math.floor(c.x / maxDistance) + ',' + Math.floor(c.y / maxDistance);
            if (!bins.has(key)) bins.set(key, []);
            bins.get(key).push(i);
        }
        const accepted = [];
        function older(a, b) {
            return a.priority < b.priority || (a.priority === b.priority &&
                (a.group < b.group || (a.group === b.group && (a.iy < b.iy ||
                (a.iy === b.iy && (a.ix < b.ix || (a.ix === b.ix && a.child < b.child)))))));
        }
        for (const c of candidates) {
            if (!inside(c.x, c.y, bounds)) continue;
            const bx = Math.floor(c.x / maxDistance), by = Math.floor(c.y / maxDistance);
            let keep = true;
            // Matérn-II compares against ALL older candidates, even candidates
            // rejected elsewhere. There is no scan-order dependency or chain.
            for (let dy = -1; dy <= 1 && keep; dy++) for (let dx = -1; dx <= 1 && keep; dx++) {
                const bucket = bins.get((bx + dx) + ',' + (by + dy));
                if (!bucket) continue;
                for (const i of bucket) {
                    const other = candidates[i];
                    if (!older(other, c)) continue;
                    const limit = Math.max(c.separation, other.separation, c.support + other.support);
                    if ((c.x - other.x) ** 2 + (c.y - other.y) ** 2 < limit * limit) { keep = false; break; }
                }
            }
            if (keep) accepted.push(c);
        }
        // Stable global order also makes Float32 crater accumulation independent
        // of the rectangle. Distinct supports do not overlap, but ordering is
        // explicit so later profile changes cannot silently break that contract.
        accepted.sort((a, b) => a.group - b.group || a.iy - b.iy || a.ix - b.ix || a.child - b.child);
        return accepted;
    }
    function calibrate(p) {
        if (!p.pores || (!p.poreDensity && !p.smallPoreDensity)) return { factors: [1, 1], densities: [0, 0] };
        // A fixed physical pilot, independent of the requested document, corrects
        // loss from clustering, snapping and cross-population hard-core thinning.
        // This is numerical intensity calibration, NOT photographic calibration.
        const relevant = Object.assign({}, p);
        for (const key of ['width', 'height', 'rect', 'pxPerMm', 'seed', 'azimuthDeg', 'elevationDeg',
            'relief', 'furrows', 'roughness', 'highPassCells', 'heightPreviewUm']) delete relevant[key];
        const key = JSON.stringify(relevant);
        if (calibrationCache.has(key)) return calibrationCache.get(key);
        const pilot = Object.assign({}, p, { seed: 904713 });
        const geom = geometry(pilot), side = 40, area = side * side;
        const bounds = { x: 17.25, y: 11.75, width: side, height: side };
        const targets = [p.poreDensity, p.smallPoreDensity];
        let factors = [1.8, 1.8], densities = [0, 0], iterations = 0;
        for (; iterations < 9; iterations++) {
            const points = placePores(pilot, geom, bounds, factors), counts = [0, 0];
            for (const point of points) counts[point.group]++;
            densities = counts.map(count => count / area);
            if (targets.every((t, i) => !t || Math.abs(densities[i] / t - 1) < 0.035)) break;
            if (iterations === 8) break;
            factors = factors.map((f, i) => targets[i] ? clamp(f * targets[i] / Math.max(densities[i], 1 / area), 0.05, 32) : 1);
        }
        if (targets.some((t, i) => t && Math.abs(densities[i] / t - 1) > 0.15))
            throw new Error('Requested pore density cannot be calibrated with this spacing/profile; reduce density or radii');
        const result = { factors, densities, pilotSideMm: side, pilotSeed: pilot.seed, iterations: iterations + 1 };
        if (calibrationCache.size >= 12) calibrationCache.clear();
        calibrationCache.set(key, result);
        return result;
    }
    function prepare(input) {
        const p = resolveParams(input);
        const radius = Math.ceil(p.highPassCells * p.spacingMm * p.pxPerMm);
        if (radius > 4096) throw new Error('High-pass radius too large for this prototype');
        const shadeRect = expand(p.rect, radius, p), heightRect = expand(shadeRect, 1, p);
        if (heightRect.width * heightRect.height > 25000000)
            throw new Error('Working area exceeds 25 million pixels; use rectangles/strips');
        const levels = [0, 1].map(level => {
            const spacing = p.spacingMm / (level ? p.secondaryRatio : 1);
            const width = level ? p.secondaryWidthMm : p.primaryWidthMm;
            const depth = level ? p.secondaryDepthUm : p.primaryDepthUm;
            const widened = Math.max(width, 1.5 / p.pxPerMm);
            return { spacing, halfWidth: widened / 2,
                depth: depth * width / widened * fade(spacing * p.pxPerMm),
                attenuation: fade(spacing * p.pxPerMm), widthScale: width / widened };
        });
        const rough = [];
        for (let octave = 0; octave < p.roughnessOctaves; octave++) {
            const wavelength = p.roughnessWavelengthMm / (2 ** octave);
            rough.push({ wavelength, attenuation: fade(wavelength * p.pxPerMm),
                amplitude: p.roughnessAmplitudeUm / (2 ** octave) });
        }
        return { p, radius, shadeRect, heightRect, levels, rough,
            geometry: [geometry(p, 0), geometry(p, 1)], calibration: calibrate(p),
            stats: { nonFiniteReplacements: 0, layers: {},
                suppressed: { primary: levels[0].attenuation, secondary: levels[1].attenuation,
                    roughness: rough.map(o => o.attenuation) } } };
    }
    function safe(value, state, fallback = 0) {
        if (Number.isFinite(value)) return value;
        state.stats.nonFiniteReplacements++;
        return fallback;
    }
    function buildHeights(state) {
        const { p, heightRect: r, geometry: geoms } = state;
        const size = r.width * r.height;
        const base = new Float32Array(size), pores = new Float32Array(size);
        for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
            // Pixel centres are evaluated in global physical coordinates. The
            // document boundary affects derivatives only, not random geometry.
            const wx = (r.x + x + 0.5) / p.pxPerMm, wy = (r.y + y + 0.5) / p.pxPerMm;
            let h = 0;
            if (p.furrows) for (let level = 0; level < 2; level++) {
                const l = state.levels[level];
                if (l.depth) h += geoms[level].height(wx, wy, l.halfWidth, l.depth);
            }
            if (p.roughness) for (let i = 0; i < state.rough.length; i++) {
                const o = state.rough[i];
                if (o.attenuation) h += o.amplitude * o.attenuation * noise(wx / o.wavelength, wy / o.wavelength, p.seed, 300 + i);
            }
            base[y * r.width + x] = safe(h, state);
        }
        const maxSupport = Math.max(p.poreRadiusMaxMm, p.smallRadiusMaxMm) * p.poreAspect * (1 + p.droplet);
        const bounds = { x: r.x / p.pxPerMm - maxSupport, y: r.y / p.pxPerMm - maxSupport,
            width: r.width / p.pxPerMm + 2 * maxSupport, height: r.height / p.pxPerMm + 2 * maxSupport };
        const points = p.pores ? placePores(p, geoms[0], bounds, state.calibration.factors) : [];
        const counts = [0, 0], visible = [0, 0], snapped = [0, 0], clustered = [0, 0];
        const outputBounds = { x: p.rect.x / p.pxPerMm, y: p.rect.y / p.pxPerMm,
            width: p.rect.width / p.pxPerMm, height: p.rect.height / p.pxPerMm };
        for (const c of points) {
            const attenuation = fade(2 * c.radius * p.pxPerMm);
            if (inside(c.x, c.y, outputBounds)) {
                counts[c.group]++; if (attenuation) visible[c.group]++;
                if (c.snapped) snapped[c.group]++; if (c.clustered) clustered[c.group]++;
            }
            if (!attenuation) continue;
            const x0 = Math.max(0, Math.floor((c.x - c.support) * p.pxPerMm - r.x));
            const y0 = Math.max(0, Math.floor((c.y - c.support) * p.pxPerMm - r.y));
            const x1 = Math.min(r.width - 1, Math.ceil((c.x + c.support) * p.pxPerMm - r.x));
            const y1 = Math.min(r.height - 1, Math.ceil((c.y + c.support) * p.pxPerMm - r.y));
            const co = Math.cos(c.angle), si = Math.sin(c.angle);
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const dx = (r.x + x + 0.5) / p.pxPerMm - c.x, dy = (r.y + y + 0.5) / p.pxPerMm - c.y;
                const along = co * dx + si * dy, across = -si * dx + co * dy;
                const a = along / (c.radius * p.poreAspect * (1 + p.droplet * Math.tanh(along / c.radius)));
                const b = across / c.radius;
                // The radial modulation stays <=1, preserving the hard support
                // bound used by the non-overlap test and the ROI candidate halo.
                const radial = Math.sqrt(a * a + b * b) / (0.96 + 0.04 * Math.sin(3 * Math.atan2(b, a) + c.phase));
                if (radial < 1) pores[y * r.width + x] += safe(-c.depth * attenuation * (1 - radial * radial) ** 2, state);
            }
        }
        const area = outputBounds.width * outputBounds.height;
        state.stats.pores = { counts, visible, snapped, clustered, areaMm2: area,
            measuredDensity: counts.map(n => n / area), targetDensity: [p.poreDensity, p.smallPoreDensity],
            calibration: state.calibration };
        state.heights = { base, pores };
        return state;
    }
    function shade(state, layer) {
        if (!['main', 'pores', 'furrows'].includes(layer)) throw new Error('Unknown layer');
        const { p, shadeRect: s, heightRect: h } = state;
        const size = s.width * s.height;
        if (!state.illumination) state.illumination = new Int32Array(size);
        const out = state.illumination, base = state.heights.base, pores = state.heights.pores;
        const az = p.azimuthDeg * Math.PI / 180, el = p.elevationDeg * Math.PI / 180;
        const lx = Math.cos(az) * Math.cos(el), ly = Math.sin(az) * Math.cos(el), lz = Math.sin(el);
        const scale = p.pxPerMm * 0.0005 * p.relief;
        const useBase = layer !== 'pores', usePores = layer !== 'furrows';
        for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
            const hx = s.x + x - h.x, hy = s.y + y - h.y;
            const left = hy * h.width + Math.max(0, hx - 1), right = hy * h.width + Math.min(h.width - 1, hx + 1);
            const up = Math.max(0, hy - 1) * h.width + hx, down = Math.min(h.height - 1, hy + 1) * h.width + hx;
            const gx = safe(((useBase ? base[right] - base[left] : 0) + (usePores ? pores[right] - pores[left] : 0)) * scale, state);
            const gy = safe(((useBase ? base[down] - base[up] : 0) + (usePores ? pores[down] - pores[up] : 0)) * scale, state);
            const lambert = Math.max(0, (-gx * lx - gy * ly + lz) / Math.sqrt(1 + gx * gx + gy * gy));
            out[y * s.width + x] = Math.round(safe(lambert / lz - 1, state) * LIGHT_SCALE);
        }
        return out;
    }
    function finish(state, layer) {
        const { p, shadeRect: s, radius: radius } = state;
        const r = p.rect, values = state.illumination, diameter = 2 * radius + 1;
        const workingSize = s.height * r.width;
        if (!state.horizontal) state.horizontal = new Float64Array(workingSize);
        const horizontal = state.horizontal;
        const originX = r.x - s.x, originY = r.y - s.y;
        // Sums are integers below 2^53 throughout the supported range. They are
        // exactly associative, unlike a floating-point running blur. Clamp at
        // document edges, never at a requested crop's edges.
        for (let y = 0; y < s.height; y++) {
            const row = y * s.width;
            let sum = 0;
            for (let k = -radius; k <= radius; k++) sum += values[row + clamp(originX + k, 0, s.width - 1)];
            for (let x = 0; x < r.width; x++) {
                horizontal[y * r.width + x] = sum;
                sum += values[row + clamp(originX + x + radius + 1, 0, s.width - 1)] -
                    values[row + clamp(originX + x - radius, 0, s.width - 1)];
            }
        }
        const out = new Uint8Array(r.width * r.height);
        let min = 255, max = 0, total = 0, clipped = 0;
        const divisor = diameter * diameter;
        for (let x = 0; x < r.width; x++) {
            let sum = 0;
            for (let k = -radius; k <= radius; k++) sum += horizontal[clamp(originY + k, 0, s.height - 1) * r.width + x];
            for (let y = 0; y < r.height; y++) {
                const value = safe(128 + GAIN * (values[(originY + y) * s.width + originX + x] - sum / divisor) / LIGHT_SCALE, state, 128);
                if (value < 0 || value > 255) clipped++;
                const byte = Math.round(clamp(value, 0, 255));
                out[y * r.width + x] = byte; min = Math.min(min, byte); max = Math.max(max, byte); total += byte;
                sum += horizontal[clamp(originY + y + radius + 1, 0, s.height - 1) * r.width + x] -
                    horizontal[clamp(originY + y - radius, 0, s.height - 1) * r.width + x];
            }
        }
        state.stats.layers[layer] = { min, max, mean: total / out.length, clippedFraction: clipped / out.length };
        return out;
    }
    function heightPreview(state) {
        const { p, heightRect: h } = state, r = p.rect;
        const out = new Uint8Array(r.width * r.height);
        for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
            const i = (r.y + y - h.y) * h.width + r.x + x - h.x;
            // This fixed display scale is deliberately unrelated to the range
            // of the current image. It is a diagnostic, not an overlay layer.
            out[y * r.width + x] = Math.round(clamp(safe(128 + 127 * p.relief *
                (state.heights.base[i] + state.heights.pores[i]) / p.heightPreviewUm, state, 128), 0, 255));
        }
        return out;
    }
    function render(input) {
        const state = buildHeights(prepare(input)), layers = {};
        for (const layer of ['main', 'pores', 'furrows']) { shade(state, layer); layers[layer] = finish(state, layer); }
        layers.height = heightPreview(state);
        return { params: state.p, layers, stats: state.stats };
    }
    return { version: VERSION, gain: GAIN, defaults: Object.freeze(defaults), resolveParams,
        prepare, buildHeights, shade, finish, heightPreview, render,
        // Diagnostic access allows independent geometry, spacing and finite-value
        // tests without making those tests infer scientific facts from pixels.
        diagnostics: { geometry, placePores, calibrate, fade, hash, safe } };
})();
if (typeof module !== 'undefined') module.exports = SkinTexture;
