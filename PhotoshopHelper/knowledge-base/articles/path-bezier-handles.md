---
id: path-bezier-handles
title: Build a curved path from Bezier control points — which handle goes where
problem: making a smooth curved path with doc.pathItems.add from Bezier control points (for example from an SVG "C" command) without loops and kinks at the anchors
confidence: agent-written
task: found by an agent in task-38d2a3; moved into the author layer without being reproduced by the author
photoshop: 25.3.1
date: 2026-09-28
helped: 0
failed: 0
---

## The finding

**This contradicts Adobe's reference**, which calls `leftDirection` the "in" handle and
`rightDirection` the "out" handle. With that reading — the curve from point A to point B
using `A.rightDirection = cp1`, `B.leftDirection = cp2` — the agent got loops and kinks at
the anchors. The swap drew the intended curve:

- the handle leaving A towards B: `A.leftDirection = cp1`;
- the handle arriving at B from A: `B.rightDirection = cp2`.

One run, judged by eye. Before relying on it, draw a short test curve both ways and look at
it with `ps_get_image`.

## Code

```js
// SVG "M x0 y0 C cp1x cp1y, cp2x cp2y, x1 y1 C ..." → one open subpath
function svgToSubPath(d) {
    const points = [];
    let prev = null;
    for (const cmd of d.match(/[a-df-z][^a-df-z]*/ig)) {
        const n = cmd.slice(1).trim().split(/[\s,]+/).map(Number);
        if (cmd[0] === 'M') {
            const p = new app.PathPointInfo();
            p.anchor = p.leftDirection = p.rightDirection = [n[0], n[1]];
            p.kind = constants.PointKind.CORNERPOINT;
            points.push(p); prev = p;
        } else if (cmd[0] === 'C') {
            prev.leftDirection = [n[0], n[1]];          // leaves the previous point
            prev.kind = constants.PointKind.SMOOTHPOINT;
            const p = new app.PathPointInfo();
            p.anchor = [n[4], n[5]];
            p.rightDirection = [n[2], n[3]];            // arrives at this point
            p.leftDirection = [n[4], n[5]];             // until the next C sets it
            p.kind = constants.PointKind.SMOOTHPOINT;
            points.push(p); prev = p;
        }
    }
    const spi = new app.SubPathInfo();
    spi.closed = false;
    spi.operation = constants.ShapeOperation.SHAPEXOR;
    spi.entireSubPath = points;
    return spi;
}

await doc.pathItems.add("Smooth Path", [svgToSubPath("M 330 530 C 240 580, 125 670, 125 755")]);
```

To draw along the path with a brush, see `path-stroke-with-brush`.
