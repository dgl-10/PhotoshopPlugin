/**
 * Showing the agent what the document actually looks like.
 *
 * Everything here goes through the Imaging API rather than duplicating the document and
 * flattening it: on the stage 2 testbench that route took 18 to 25 seconds for a single
 * preview, which is far too slow for a tool the agent is meant to reach for whenever it
 * wants to check its own work.
 *
 * The picture leaves the plugin as base64 and is handed to the agent through the MCP
 * image content type in Helper. By default it is reduced, because images cost context,
 * and every capture carries a caption saying what was reduced and by how much — the
 * coordinates the agent sends back are always real document pixels.
 */

const { imaging } = require('photoshop');

// Nothing smaller is worth looking at, and a request for one pixel is a mistake.
const MIN_TARGET_SIZE = 32;

/**
 * @param {*} value - Candidate number.
 * @returns {boolean} True when it is a finite number.
 */
function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Normalise a region into left/top/right/bottom, clipped to the document.
 *
 * @param {object|null} bounds - Region asked for, in real document pixels.
 * @param {object} doc - Document.
 * @returns {object|null} Clipped bounds, or null for "everything".
 */
function normalizeBounds(bounds, doc) {
    if (!bounds) return null;

    const left = Math.max(0, Math.round(bounds.left));
    const top = Math.max(0, Math.round(bounds.top));
    const right = Math.min(doc.width, Math.round(bounds.right));
    const bottom = Math.min(doc.height, Math.round(bounds.bottom));

    if (!(right > left && bottom > top)) {
        throw new Error(
            `The region ${JSON.stringify(bounds)} is empty once clipped to the document `
            + `(${doc.width}×${doc.height} px). Give left/top/right/bottom in real document pixels.`
        );
    }

    return { left, top, right, bottom };
}

/**
 * Work out the size to ask the Imaging API for.
 *
 * Only the longer side is passed, so Photoshop scales proportionally.
 *
 * @param {number} width - Source width.
 * @param {number} height - Source height.
 * @param {number} maxSize - Longest side allowed.
 * @param {boolean} fullSize - True when the agent asked for the original.
 * @returns {object|null} A targetSize option, or null when no scaling is needed.
 */
function computeTargetSize(width, height, maxSize, fullSize) {
    const longest = Math.max(width, height);
    if (fullSize || longest <= maxSize) return null;

    const limit = Math.max(MIN_TARGET_SIZE, Math.round(maxSize));
    return width >= height ? { width: limit } : { height: limit };
}

/**
 * Turn a PhotoshopImageData into base64.
 *
 * Grayscale data — masks, selections, single channels — cannot be encoded directly,
 * because the encoder wants RGB, so it is spread across three components first.
 *
 * @param {object} imageData - PhotoshopImageData from the Imaging API.
 * @returns {Promise<{base64: string, mimeType: string, width: number, height: number}>}
 */
async function encodeToBase64(imageData) {
    let encodable = imageData;
    let converted = null;

    if (imageData.components === 1) {
        const raw = new Uint8Array(await imageData.getData());
        const width = imageData.width;
        const height = imageData.height;
        const rowBytes = imageData.rowBytes || width;

        const rgb = new Uint8Array(width * height * 3);
        for (let y = 0; y < height; y++) {
            const sourceRow = y * rowBytes;
            const targetRow = y * width * 3;
            for (let x = 0; x < width; x++) {
                const value = raw[sourceRow + x];
                rgb[targetRow + x * 3] = value;
                rgb[targetRow + x * 3 + 1] = value;
                rgb[targetRow + x * 3 + 2] = value;
            }
        }

        converted = await imaging.createImageDataFromBuffer(rgb, {
            width,
            height,
            components: 3,
            chunky: true,
            colorSpace: 'RGB'
        });
        encodable = converted;
    }

    try {
        const encoded = await imaging.encodeImageData({
            imageData: encodable,
            format: 'image/png',
            base64: true
        });

        // The encoder is asked for PNG, but which format it really produced is visible in
        // the first bytes, and the agent's client needs an honest mime type.
        const mimeType = typeof encoded === 'string' && encoded.startsWith('/9j/')
            ? 'image/jpeg'
            : 'image/png';

        return {
            base64: encoded,
            mimeType,
            width: encodable.width,
            height: encodable.height
        };
    } finally {
        if (converted) {
            try { converted.dispose(); } catch { /* nothing to do about it */ }
        }
    }
}

/**
 * @param {object} imageData - PhotoshopImageData to release.
 */
function dispose(imageData) {
    try {
        if (imageData && typeof imageData.dispose === 'function') imageData.dispose();
    } catch {
        // Releasing pixels must never be the reason a capture fails.
    }
}

/**
 * Options shared by every composite or layer capture: 8 bits per component and sRGB, so
 * a 16-bit or wide-gamut document does not come back as something the model reads wrong.
 *
 * @param {object} doc - Document.
 * @returns {object} Extra getPixels options.
 */
function colorOptionsFor(doc) {
    const options = { componentSize: 8 };

    const profile = String(doc.colorProfileName || '').toLowerCase();
    const isWideGamut = ['prophoto', 'adobe rgb', 'display p3', 'dci-p3', 'wide gamut']
        .some(name => profile.includes(name));

    if (isWideGamut || doc.bitsPerChannel !== 8) {
        options.colorSpace = 'RGB';
        options.colorProfile = 'sRGB IEC61966-2.1';
    }

    return options;
}

/**
 * Capture the flattened document or one layer's content.
 *
 * @param {object} params - { doc, layerId, bounds, maxSize, fullSize }.
 * @returns {Promise<object>} Capture with its caption data.
 */
async function capturePixels({ doc, layerId, bounds, maxSize, fullSize }) {
    const region = normalizeBounds(bounds, doc);
    const sourceWidth = region ? region.right - region.left : doc.width;
    const sourceHeight = region ? region.bottom - region.top : doc.height;

    const options = {
        documentID: doc.id,
        applyAlpha: true,
        ...colorOptionsFor(doc)
    };
    if (region) options.sourceBounds = region;
    if (isNumber(layerId)) options.layerID = layerId;

    const targetSize = computeTargetSize(sourceWidth, sourceHeight, maxSize, fullSize);
    if (targetSize) options.targetSize = targetSize;

    const captured = await imaging.getPixels(options);
    try {
        const encoded = await encodeToBase64(captured.imageData);
        return { ...encoded, region: captured.sourceBounds || region, sourceWidth, sourceHeight };
    } finally {
        dispose(captured.imageData);
    }
}

/**
 * Capture a layer's mask.
 *
 * @param {object} params - { doc, layerId, maskKind, bounds, maxSize, fullSize }.
 * @returns {Promise<object>} Capture with its caption data.
 */
async function captureLayerMask({ doc, layerId, maskKind, bounds, maxSize, fullSize }) {
    if (!isNumber(layerId)) {
        throw new Error('Capturing a layer mask needs layer_id.');
    }

    const region = normalizeBounds(bounds, doc);
    const sourceWidth = region ? region.right - region.left : doc.width;
    const sourceHeight = region ? region.bottom - region.top : doc.height;

    const options = { documentID: doc.id, layerID: layerId, kind: maskKind || 'user' };
    if (region) options.sourceBounds = region;

    const targetSize = computeTargetSize(sourceWidth, sourceHeight, maxSize, fullSize);
    if (targetSize) options.targetSize = targetSize;

    const captured = await imaging.getLayerMask(options);
    try {
        const encoded = await encodeToBase64(captured.imageData);
        return { ...encoded, region: captured.sourceBounds || region, sourceWidth, sourceHeight };
    } finally {
        dispose(captured.imageData);
    }
}

/**
 * Capture the selection as a grayscale image, the way Quick Mask shows it.
 *
 * @param {object} params - { doc, bounds, maxSize, fullSize }.
 * @returns {Promise<object>} Capture with its caption data.
 */
async function captureSelection({ doc, bounds, maxSize, fullSize }) {
    const region = normalizeBounds(bounds, doc);
    const sourceWidth = region ? region.right - region.left : doc.width;
    const sourceHeight = region ? region.bottom - region.top : doc.height;

    const options = { documentID: doc.id };
    if (region) options.sourceBounds = region;

    const targetSize = computeTargetSize(sourceWidth, sourceHeight, maxSize, fullSize);
    if (targetSize) options.targetSize = targetSize;

    const captured = await imaging.getSelection(options);
    try {
        const encoded = await encodeToBase64(captured.imageData);
        return { ...encoded, region: captured.sourceBounds || region, sourceWidth, sourceHeight };
    } finally {
        dispose(captured.imageData);
    }
}

/**
 * Pull one colour component out of the composite as a grayscale image.
 *
 * @param {object} params - { doc, componentIndex, bounds, maxSize, fullSize }.
 * @returns {Promise<object>} Capture with its caption data.
 */
async function captureComponentChannel({ doc, componentIndex, bounds, maxSize, fullSize }) {
    const region = normalizeBounds(bounds, doc);
    const sourceWidth = region ? region.right - region.left : doc.width;
    const sourceHeight = region ? region.bottom - region.top : doc.height;

    const options = {
        documentID: doc.id,
        applyAlpha: true,
        ...colorOptionsFor(doc)
    };
    if (region) options.sourceBounds = region;

    const targetSize = computeTargetSize(sourceWidth, sourceHeight, maxSize, fullSize);
    if (targetSize) options.targetSize = targetSize;

    const captured = await imaging.getPixels(options);
    try {
        const source = captured.imageData;
        const raw = new Uint8Array(await source.getData());
        const width = source.width;
        const height = source.height;
        const components = source.components;
        const rowBytes = source.rowBytes || width * components;

        if (componentIndex >= components) {
            throw new Error(
                `This document's pixels have ${components} components, so there is no channel `
                + `number ${componentIndex + 1} to show.`
            );
        }

        const gray = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            const sourceRow = y * rowBytes;
            const targetRow = y * width;
            for (let x = 0; x < width; x++) {
                gray[targetRow + x] = raw[sourceRow + x * components + componentIndex];
            }
        }

        const grayData = await imaging.createImageDataFromBuffer(gray, {
            width,
            height,
            components: 1,
            chunky: true,
            colorSpace: 'Grayscale'
        });

        try {
            const encoded = await encodeToBase64(grayData);
            return { ...encoded, region: captured.sourceBounds || region, sourceWidth, sourceHeight };
        } finally {
            dispose(grayData);
        }
    } finally {
        dispose(captured.imageData);
    }
}

/**
 * Capture an alpha channel by loading it as a selection and reading that.
 *
 * There is no Imaging API call for an arbitrary channel, so the selection is used as the
 * way in. The change is undone by suspending history around it and resuming without
 * committing, which puts the document — including the person's own selection — back where
 * it was.
 *
 * @param {object} params - { doc, channelName, bounds, maxSize, fullSize, executionContext }.
 * @returns {Promise<object>} Capture with its caption data.
 */
async function captureAlphaChannel({ doc, channelName, bounds, maxSize, fullSize, executionContext }) {
    let channel = null;
    for (const candidate of doc.channels) {
        if (candidate.name === channelName) channel = candidate;
    }

    if (!channel) {
        const names = Array.from(doc.channels).map(item => item.name).join(', ');
        throw new Error(`There is no channel "${channelName}". The document has: ${names}.`);
    }

    const hostControl = executionContext && executionContext.hostControl;
    if (!hostControl) {
        throw new Error('Capturing a channel needs a modal scope; this is a bug in the plugin.');
    }

    const suspensionId = await hostControl.suspendHistory({
        documentID: doc.id,
        name: 'Agent: read a channel'
    });

    try {
        await doc.selection.load(channel);
        return await captureSelection({ doc, bounds, maxSize, fullSize });
    } finally {
        // commit = false: the document goes back to where it was, so the person's own
        // selection survives being borrowed.
        await hostControl.resumeHistory(suspensionId, false);
    }
}

/**
 * Write the caption that travels with the picture.
 *
 * @param {object} params - Everything the caption mentions.
 * @returns {string}
 */
function buildCaption({ doc, target, detail, region, sourceWidth, sourceHeight, width, height }) {
    const scale = sourceWidth > 0 ? width / sourceWidth : 1;
    const reduced = Math.abs(scale - 1) > 0.001;

    const regionText = region
        ? `region ${Math.round(region.left)},${Math.round(region.top)} to `
            + `${Math.round(region.right)},${Math.round(region.bottom)}`
        : 'the whole document';

    const lines = [
        `${target}${detail ? ` (${detail})` : ''} of "${doc.name}", ${regionText}.`,
        `Original ${sourceWidth}×${sourceHeight} px.`,
        reduced
            ? `Reduced to ${width}×${height} px, scale ${scale.toFixed(3)}.`
            : `Not reduced: ${width}×${height} px.`,
        'Coordinates you send back must be in real document pixels, not in the pixels of this picture.'
    ];

    return lines.join(' ');
}

/**
 * Capture whatever the agent asked for.
 *
 * @param {object} params
 * @param {object} params.doc - The task's working document.
 * @param {string} params.target - 'document', 'layer', 'layer_mask', 'selection' or 'channel'.
 * @param {number} [params.layerId] - Layer for 'layer' and 'layer_mask'.
 * @param {string} [params.maskKind] - 'user' or 'vector'.
 * @param {string} [params.channel] - Channel name for 'channel'.
 * @param {object} [params.bounds] - Region in real document pixels.
 * @param {number} params.maxSize - Longest side allowed.
 * @param {boolean} params.fullSize - True when the original size was asked for.
 * @param {object} params.executionContext - The modal scope the caller opened.
 * @returns {Promise<{base64: string, mimeType: string, caption: string}>}
 */
async function capture({
    doc, target, layerId, maskKind, channel, bounds, maxSize, fullSize, executionContext
}) {
    let shot;
    let detail = '';
    let label = target;

    switch (target) {
        case 'layer': {
            if (!isNumber(layerId)) throw new Error('Capturing a layer needs layer_id.');
            shot = await capturePixels({ doc, layerId, bounds, maxSize, fullSize });
            label = 'layer content';
            detail = `layer id ${layerId}`;
            break;
        }

        case 'layer_mask': {
            shot = await captureLayerMask({ doc, layerId, maskKind, bounds, maxSize, fullSize });
            label = 'layer mask';
            detail = `layer id ${layerId}, ${maskKind || 'user'} mask, white is selected`;
            break;
        }

        case 'selection': {
            shot = await captureSelection({ doc, bounds, maxSize, fullSize });
            label = 'selection';
            detail = 'white is selected, black is not, grey is partly selected';
            break;
        }

        case 'channel': {
            const name = String(channel || '').toLowerCase();
            const componentIndex = { red: 0, green: 1, blue: 2 }[name];

            if (componentIndex !== undefined) {
                shot = await captureComponentChannel({
                    doc, componentIndex, bounds, maxSize, fullSize
                });
                label = 'channel';
                detail = `${name}, as grey`;
            } else {
                shot = await captureAlphaChannel({
                    doc, channelName: channel, bounds, maxSize, fullSize, executionContext
                });
                label = 'channel';
                detail = `${channel}, as grey`;
            }
            break;
        }

        case 'document':
        default: {
            shot = await capturePixels({ doc, bounds, maxSize, fullSize });
            label = 'flattened document';
            detail = '';
            break;
        }
    }

    return {
        base64: shot.base64,
        mimeType: shot.mimeType,
        width: shot.width,
        height: shot.height,
        caption: buildCaption({
            doc,
            target: label,
            detail,
            region: shot.region,
            sourceWidth: shot.sourceWidth,
            sourceHeight: shot.sourceHeight,
            width: shot.width,
            height: shot.height
        })
    };
}

module.exports = {
    capture,
    // Exported for testing only; production code goes through capture().
    computeTargetSize,
    normalizeBounds,
    buildCaption
};
