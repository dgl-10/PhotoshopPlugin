---
id: camera-raw-local-masks
title: Masks inside the Camera Raw Filter — gradients, brush strokes and your own black-and-white mask
problem: applying Camera Raw settings to parts of the picture, several parts with different settings in one filter — the `$LCs` key (XMP text) with linear and radial gradients, brush strokes, and your own black-and-white mask packed into `$BigT`; adding, subtracting and intersecting mask parts; the attribute of every mask slider and its scale (÷100, exposure ÷4, hue ÷180); and Camera Raw not computing Subject or Background masks by itself when applied from a script
confidence: author-verified
task: structure and every mask slider from two recordings by the author (Actions → Copy As JavaScript; the second with each slider set to its own value and an intersected radial); behaviour measured on pixels by an agent at the author's request in two runs on 2026-10-30; the `$BigT` code rebuilds the recorded block byte for byte
photoshop: 25.3.1 (Camera Raw 18.7)
date: 2026-10-30
helped: 0
failed: 0
---

## When to use it

Tone and colour on part of the picture go into adjustment layers with masks (see the rules),
not here. Masks inside Camera Raw are for what only a filter can do — texture, clarity,
dehaze, noise reduction, sharpening, grain — on parts of the picture.

When one area is enough, the filter mask of a smart filter is simpler, and the person can
see it and repaint it (`smart-filter-mask`). Masks inside Camera Raw pay off when one filter
needs several areas with different settings, because the filter mask is one per layer. They
stay hidden inside the filter: the person can change them only by opening Camera Raw.

## The shape

All masks go into one key, `$LCs`, as XMP text, next to the usual keys
(`camera-raw-filter`). Gradients and brush strokes need nothing else. A mask made of your
own pixels also needs `$BigT` — see "Your own black-and-white mask".

```js
{
    _obj: "Adobe Camera Raw Filter",
    "$CrVe": "18.7", "$PrVN": 6, "$PrVe": 251920384,   // exactly as recorded on this machine
    "$LCs": lcs([ correction("Sky", { LocalDehaze: 0.3 }, linearMask(0.5, 0.45, 0.5, 0.1)) ])
}
```

The builder below ran in the measured tests:

```js
const hex32 = () => Array.from({ length: 32 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');
// Every attribute the recording carried on a correction; anything not given is 0.
const LOCAL_KEYS = ['LocalExposure','LocalHue','LocalSaturation','LocalContrast','LocalClarity','LocalSharpness','LocalBrightness','LocalToningHue','LocalToningSaturation','LocalExposure2012','LocalContrast2012','LocalHighlights2012','LocalShadows2012','LocalWhites2012','LocalBlacks2012','LocalClarity2012','LocalDehaze','LocalLuminanceNoise','LocalMoire','LocalDefringe','LocalTemperature','LocalTint','LocalTexture','LocalGrain','LocalCorrectedDepth','LocalGlow'];
function correction(name, values, masksXml) {
    const attrs = LOCAL_KEYS.map(k => `crs:${k}="${values[k] ?? 0}"`).join(' ');
    return `<rdf:li><rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="true" crs:CorrectionName="${name}" crs:CorrectionSyncID="${hex32()}" ${attrs} crs:LocalCurveRefineSaturation="100"><crs:CorrectionMasks><rdf:Seq>${masksXml}</rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li>`;
}
function linearMask(zx, zy, fx, fy, blend = 0) {
    return `<rdf:li crs:What="Mask/Gradient" crs:MaskActive="true" crs:MaskName="Linear" crs:MaskBlendMode="${blend}" crs:MaskInverted="false" crs:MaskSyncID="${hex32()}" crs:MaskValue="1" crs:ZeroX="${zx}" crs:ZeroY="${zy}" crs:FullX="${fx}" crs:FullY="${fy}"/>`;
}
function radialMask(top, left, bottom, right, blend = 0, inverted = false) {
    return `<rdf:li crs:What="Mask/CircularGradient" crs:MaskActive="true" crs:MaskName="Radial" crs:MaskBlendMode="${blend}" crs:MaskInverted="${inverted}" crs:MaskSyncID="${hex32()}" crs:MaskValue="1" crs:Top="${top}" crs:Left="${left}" crs:Bottom="${bottom}" crs:Right="${right}" crs:Angle="0" crs:Midpoint="50" crs:Roundness="0" crs:Feather="0" crs:Flipped="true" crs:Version="2"/>`;
}
// A brush stroke: points is a list of [x, y] dab centres.
function brushMask(points, radius, flow = 1, centerWeight = 0.051306, blend = 0) {
    const dabs = [`<rdf:li>f ${flow}</rdf:li>`, `<rdf:li>h ${centerWeight}</rdf:li>`]
        .concat(points.map(([x, y]) => `<rdf:li>d ${x.toFixed(6)} ${y.toFixed(6)}</rdf:li>`)).join('');
    return `<rdf:li><rdf:Description crs:What="Mask/Aggregate" crs:MaskActive="true" crs:MaskName="Brush" crs:MaskBlendMode="${blend}" crs:MaskInverted="false" crs:MaskSyncID="${hex32()}" crs:MaskValue="1"><crs:Masks><rdf:Seq><rdf:li><rdf:Description crs:What="Mask/Paint" crs:MaskActive="true" crs:MaskBlendMode="0" crs:MaskInverted="false" crs:MaskSyncID="${hex32()}" crs:MaskValue="1" crs:Radius="${radius}" crs:Flow="${flow}" crs:CenterWeight="${centerWeight}"><crs:Dabs><rdf:Seq>${dabs}</rdf:Seq></crs:Dabs></rdf:Description></rdf:li></rdf:Seq></crs:Masks></rdf:Description></rdf:li>`;
}
// A mask made of pixels; attrs are the extra crs: attributes (see "Your own black-and-white mask").
function imageMask(name, attrs, blend = 0) {
    const extra = Object.entries(attrs).map(([k, v]) => `crs:${k}="${v}"`).join(' ');
    return `<rdf:li crs:What="Mask/Image" crs:MaskActive="true" crs:MaskName="${name}" crs:MaskBlendMode="${blend}" crs:MaskInverted="false" crs:MaskSyncID="${hex32()}" crs:MaskValue="1" crs:MaskVersion="1" ${extra}/>`;
}
function lcs(corrections) {
    return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"><crs:MaskGroupBasedCorrections><rdf:Seq>${corrections.join('')}</rdf:Seq></crs:MaskGroupBasedCorrections></rdf:Description></rdf:RDF></x:xmpmeta>`;
}
// The whole picture: a linear gradient lying entirely above it.
const WHOLE = () => linearMask(0.5, -1, 0.5, -0.5);
```

One `correction` is one mask in the Camera Raw panel ("Mask 1", "Mask 2"…): its own settings
and one or more mask parts. Several corrections go into one `lcs([...])`.

## Settings and their scale

Recorded by the author with every slider of a mask set to its own value, in the order the
mask panel shows them (Camera Raw 18.7). The attribute is the slider's value divided by 100,
except where the table says otherwise.

| panel section | slider | attribute | scale |
| --- | --- | --- | --- |
| Light | Exposure | `LocalExposure2012` | **EV divided by 4**: +1.13 EV was `0.2825`; also measured on pixels — `0.25` matched global `$Ex12` +1 EV |
| Light | Contrast, Highlights, Shadows, Whites, Blacks | `LocalContrast2012`, `LocalHighlights2012`, `LocalShadows2012`, `LocalWhites2012`, `LocalBlacks2012` | ÷ 100 |
| Color | Temperature, Tint | `LocalTemperature`, `LocalTint` | ÷ 100 |
| Color | Hue | `LocalHue` | **÷ 180**: +18.0 was `0.1` |
| Color | Saturation | `LocalSaturation` | ÷ 100 |
| Effects | Texture, Clarity, Dehaze | `LocalTexture`, `LocalClarity2012`, `LocalDehaze` | ÷ 100 |
| Effects | Grain, Glow | `LocalGrain`, `LocalGlow` | ÷ 100 |
| Detail | Sharpness | `LocalSharpness` | ÷ 100 |
| Detail | Noise Reduction, Moire Reduction, Defringe | `LocalLuminanceNoise`, `LocalMoire`, `LocalDefringe` | ÷ 100 |
| mask header | Amount | `CorrectionAmount` | ÷ 100 (100 was `1`) |

The same value does not mean the same strength as the global slider: `LocalDehaze: 0.5`
darkened mid-grey more than global `$Dhze: 50` (83 against 93). Look at the result with
`ps_get_image`.

Some attributes have no `2012` in the name and are still in use: `LocalHue`,
`LocalSaturation`, `LocalSharpness`. The ones that stayed `0` with every slider moved —
`LocalExposure`, `LocalContrast`, `LocalClarity`, `LocalBrightness`, `LocalCorrectedDepth`,
`LocalToningHue`, `LocalToningSaturation` — leave at `0`. The Color swatch was not set in the
recording; `LocalToningHue` and `LocalToningSaturation` are probably it — not proven. The
Point Color and Color Grading sections of the mask were not recorded.

## Mask parts

Coordinates are fractions of the picture: `0` is the left or top edge, `1` the right or
bottom edge.

- **Linear gradient**, `Mask/Gradient`: `ZeroX, ZeroY` is where the effect is zero,
  `FullX, FullY` where it is full; past the full point it stays full. `WHOLE()` lies entirely
  above the picture and covers all of it (measured: top, centre and bottom changed equally).
  A transition inside the picture is how the author's recording used it; its exact shape was
  not measured.
- **Radial gradient**, `Mask/CircularGradient`: the ellipse's box `Top, Left, Bottom, Right`,
  and `Feather` (`0` gave a hard edge; the recording had `68`). The effect is **inside** the
  ellipse; with `inverted` (`MaskInverted="true"`) it is **outside** (both measured).
  `Flipped` changes nothing by itself: `"false"` gave the same result as `"true"`.
- **Brush stroke**, `brushMask`: dabs, not pixels — a `Mask/Paint` inside a
  `Mask/Aggregate`, as in the author's recording. Measured on a 896 × 1200 picture: dabs
  0.01 apart from x = 0.2 to 0.8 at y = 0.5 with radius `0.05` gave one continuous stroke,
  full within about 15 px of the line and fading to nothing at 60 px. 60 px is 0.05 × 1200,
  the picture's height — which there was also its long side; which of the two the radius is
  measured against was not separated. In the dabs list `f` and `h` repeat `Flow` and
  `CenterWeight`.
- **Your own pixels**, `imageMask` plus `$BigT` — next section.

## Your own black-and-white mask

**Camera Raw does not compute Subject or Background masks by itself from a script.** A
`Mask/Image` part for Subject (`MaskSubType: 1`) or Background (`MaskSubType: 0`,
`MaskSubCategoryID: 22`) without `$BigT` changed nothing, with or without `ModelVersion`, and
raised no error. The smart filter read back afterwards held no `$BigT`. Those masks are
computed in the Camera Raw window.

**What works is giving it the mask yourself.** Measured on an 896 × 1200 photo: a mask white
on the left half and black on the right darkened exactly the left half, cut along the
middle. White (255) is where the correction applies. It worked without `InputDigest` and with
a deliberately wrong one: Camera Raw did not check that the mask belongs to the picture.

```js
// px: Uint8Array of W * H bytes, rows top to bottom, 255 where the correction applies.
const block = acrBlock(greyTiff(px, W, H));        // uncompressed TIFF
const big = buildBigT([block]);
const mask = imageMask("My mask", {
    MaskSubType: 1, MaskDigest: toHex(md5(block)), Origin: "0,0",
    FullMaskSize: `${W},${H}`, WholeImageArea: `0/1,0/1,${H}/1,${W}/1`, ModelVersion: 318769633
});
await action.batchPlay([{
    _obj: "Adobe Camera Raw Filter", "$CrVe": "18.7", "$PrVN": 6, "$PrVe": 251920384,
    "$LCs": lcs([ correction("Subject texture", { LocalTexture: 0.3 }, mask) ]),
    "$BigT": { _data: big.base64, _rawData: "base64" }
}], {});
```

`MaskDigest` is how Camera Raw finds the mask's pixels in the block: it must be the MD5 of
that mask's piece, `toHex(md5(block))`. For several masks, make one `acrBlock` per mask, give
each mask its own block's digest, and pack them all with one `buildBigT([...])`. The pixels
can come from anything the size of the picture: a selection from Select Subject or Color
Range, a mask an image generator drew (`select-with-ai-inpaint-mask`), your own analysis of
the pixels. Your mask combines with the other parts as usual — for example, your mask minus a
brush stroke.

The code for the block. It rebuilds a block that Camera Raw itself recorded byte for byte;
the only difference is that it writes the TIFF uncompressed, where Camera Raw writes JPEG XL
(compression `52546`) — and Camera Raw accepted the uncompressed one.

```js
// $BigT layout, read from a Camera Raw 18.7 recording:
//   "ACR\0", u32 1, u32 0, u32 count, u32 0, then count entries of
//   { 16-byte digest, u64 size, u64 offset }, then the blocks, each padded to 4 bytes.
//   A block is a 16-byte header (u32 2, u32 1, 8 zero bytes) followed by a grey TIFF.
//   The digest is the MD5 of the whole block and equals the mask's crs:MaskDigest.
function md5(bytes) {
    const K = new Uint32Array(64);
    const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const len = bytes.length;
    const total = (((len + 8) >>> 6) + 1) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, (len * 8) >>> 0, true);
    dv.setUint32(total - 4, Math.floor(len / 536870912) >>> 0, true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Uint32Array(16);
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F, g;
            if (i < 16) { F = (B & C) | (~B & D); g = i; }
            else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
            else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
            else { F = C ^ (B | ~D); g = (7 * i) % 16; }
            F = (F + A + K[i] + M[g]) >>> 0;
            A = D; D = C; C = B;
            B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
        }
        a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    [a0, b0, c0, d0].forEach((v, i) => odv.setUint32(i * 4, v, true));
    return out;
}

const toHex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

function toBase64(bytes) {
    const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const parts = [];
    for (let i = 0; i < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
        parts.push(T[(n >> 18) & 63] + T[(n >> 12) & 63]
            + (i + 1 < bytes.length ? T[(n >> 6) & 63] : '=')
            + (i + 2 < bytes.length ? T[n & 63] : '='));
    }
    return parts.join('');
}

// One-tile 8-bit grey TIFF with the same tags, in the same order, as Camera Raw writes.
// compression 1 = none.
function greyTiff(data, width, height, compression = 1) {
    const tags = [[254, 4, 0], [256, 4, width], [257, 4, height], [258, 3, 8], [259, 3, compression],
        [262, 3, 1], [277, 3, 1], [284, 3, 1], [322, 4, width], [323, 4, height], [324, 4, 0], [325, 4, data.length]];
    const dataOffset = 8 + 2 + tags.length * 12 + 4;
    tags[10][2] = dataOffset;
    // Camera Raw pads the TIFF to an even length with one zero byte.
    const out = new Uint8Array((dataOffset + data.length + 1) & ~1);
    const dv = new DataView(out.buffer);
    out.set([0x49, 0x49, 0x2a, 0x00]);
    dv.setUint32(4, 8, true);
    dv.setUint16(8, tags.length, true);
    tags.forEach(([tag, type, value], i) => {
        const p = 10 + i * 12;
        dv.setUint16(p, tag, true);
        dv.setUint16(p + 2, type, true);
        dv.setUint32(p + 4, 1, true);
        if (type === 3) dv.setUint16(p + 8, value, true); else dv.setUint32(p + 8, value, true);
    });
    dv.setUint32(10 + tags.length * 12, 0, true);
    out.set(data, dataOffset);
    return out;
}

function acrBlock(tiff) {
    const block = new Uint8Array(16 + tiff.length);
    const dv = new DataView(block.buffer);
    dv.setUint32(0, 2, true);
    dv.setUint32(4, 1, true);
    block.set(tiff, 16);
    return block;
}

// blocks: Uint8Arrays from acrBlock(). Returns { bytes, base64, digests } (digests in block order as stored).
function buildBigT(blocks) {
    const items = blocks.map(b => ({ block: b, hex: toHex(md5(b)) }))
        .sort((x, y) => (x.hex < y.hex ? -1 : 1));
    const pad4 = (n) => (n + 3) & ~3;
    let offset = 20 + 32 * items.length;
    const placed = items.map(it => { const o = offset; offset = pad4(o + it.block.length); return o; });
    const bytes = new Uint8Array(offset);
    const dv = new DataView(bytes.buffer);
    bytes.set([0x41, 0x43, 0x52, 0x00]);
    dv.setUint32(4, 1, true);
    dv.setUint32(12, items.length, true);
    items.forEach((it, i) => {
        const p = 20 + i * 32;
        bytes.set(md5(it.block), p);
        dv.setUint32(p + 16, it.block.length, true);
        dv.setUint32(p + 24, placed[i], true);
        bytes.set(it.block, placed[i]);
    });
    return { bytes, base64: toBase64(bytes), digests: items.map(it => it.hex) };
}
```

Not tried yet:

- **Large pictures.** Measured at 896 × 1200. The mask goes uncompressed — W × H bytes, and
  its base64 a third more — so on a large picture the call carries tens of megabytes.
- **A mask smaller than the picture.** Camera Raw stores its own Subject mask cropped to the
  subject (`Origin`, a smaller TIFF); the same for your mask was not tried.
- **On a smart filter.** Whether the mask is still there when the filter's settings are read
  back, and what happens when the person opens Camera Raw on it later.
- **`MaskSubType`.** Only `1` was tried for your own mask.
- **A recorded AI mask on another picture.** Camera Raw did not check the picture for your
  own mask, but replaying a mask it computed itself on another picture was not tried.

## Adding and subtracting parts

The parts of one correction apply in order. `MaskBlendMode="0"` adds a part, `"1"` subtracts
it. Measured: `WHOLE()`, then a radial with `1` — the inside of the ellipse stayed exactly as
it was, everything else changed.

```js
correction("Except centre", { LocalExposure2012: -0.5 },
    WHOLE() + radialMask(0.3, 0.3, 0.7, 0.7, 1))
```

In the author's recording a brush stroke was subtracted from a Subject mask the same way:
the brush's `Mask/Aggregate` had `MaskBlendMode="1"` (and `MaskValue="0"`).

**Intersecting** is written as subtracting the inverted part. "Intersect Mask With" in the
Camera Raw window recorded the second part with `MaskBlendMode="1"`, `MaskInverted="true"`
(and `MaskValue="0"`): keep only where the part is, by taking away everything where it is
not. Subtracting and inverting were each measured on pixels; the two together were recorded
from Camera Raw, not measured. A radial intersection with the builder:

```js
correction("Inside both", { LocalTexture: 0.3 },
    linearMask(0.5, 0.6, 0.5, 0.0) + radialMask(0.2, 0.2, 0.8, 0.8, 1, true))
```

`"2"` is not intersecting: `WHOLE()` plus a radial with `2` changed the whole picture, as
adding would.

## Check the result

Look at the picture with `ps_get_image` after applying. Mistakes do not announce themselves:
a mask part Camera Raw cannot use (an AI mask without its pixels) changed nothing without an
error, and XMP with a closing tag removed raised no error either — that correction still
applied.
