/**
 * Command handlers for MCP tools executed inside the Photoshop UXP plugin.
 * Called from the WebSocket bridge command dispatcher in index.js.
 */

const { app, action, core, imaging, constants } = require('photoshop');
const fsModule = require('./fs.js');
const ps = require('./ps.js');

async function getDocumentInfo() {
    const docs = app.documents;
    
    const docInfo = {
        documents: docs.map(d => ({
            name: d.name,
            id: d.id,
            width: d.width,
            height: d.height,
            resolution: d.resolution,
            colorMode: d.mode ? d.mode.toString() : "unknown",
            isActive: app.activeDocument && app.activeDocument.id === d.id
        }))
    };
    
    if (app.activeDocument) {
        const activeDoc = app.activeDocument;
        
        // Helper to process layers recursively
        function processLayer(layer) {
            const layerData = {
                name: layer.name,
                id: layer.id,
                kind: layer.kind ? layer.kind.toString() : 'unknown',
                visible: layer.visible,
                opacity: layer.opacity,
                blendMode: layer.blendMode,
                locked: layer.locked
            };
            if (layer.layers && layer.layers.length > 0) {
                layerData.children = Array.from(layer.layers).map(processLayer);
            }
            return layerData;
        }

        const activeLayers = activeDoc.activeLayers ? Array.from(activeDoc.activeLayers).map(l => ({ name: l.name, id: l.id })) : [];
        let hasSelection = false;
        try {
            hasSelection = await ps.hasActiveSelection();
        } catch (e) {
            hasSelection = false;
        }

        docInfo.activeDocument = {
            name: activeDoc.name,
            id: activeDoc.id,
            width: activeDoc.width,
            height: activeDoc.height,
            layers: Array.from(activeDoc.layers).map(processLayer),
            activeLayers: activeLayers,
            hasSelection: hasSelection
        };
    }
    
    return docInfo;
}

async function executeBatchPlay(payload) {
    let result = null;
    await core.executeAsModal(async () => {
        result = await action.batchPlay(payload.descriptors, payload.options || { synchronousExecution: false });
    }, { commandName: 'MCP: batchPlay' });
    return { results: result };
}

async function executeScript(payload) {
    let scriptOutput = null;
    try {
        await core.executeAsModal(async () => {
            const fn = new Function('app', 'action', 'core', 'imaging', 'constants', 
                `return (async () => {
                    let result;
                    let returnedValue = await (async () => {
                        ${payload.code}
                    })();
                    return returnedValue !== undefined ? returnedValue : result;
                })()`);
            scriptOutput = await fn(app, action, core, imaging, constants);
        }, { commandName: 'MCP: script' });
    } catch (err) {
        const snippet = payload.code.substring(0, 200);
        throw new Error(`Script execution failed: ${err.message}. Code snippet: ${snippet}`);
    }
    
    return { result: scriptOutput !== undefined ? scriptOutput : null };
}

async function getImage(payload) {
    const doc = app.activeDocument;
    if (!doc) throw new Error('No active document');

    const maxDimension = payload.maxDimension || 1024;
    let base64Data = null;
    let outWidth = doc.width;
    let outHeight = doc.height;

    await core.executeAsModal(async () => {
        // Duplicate document for non-destructive export
        const tempDoc = await doc.duplicate();

        try {
            // Flatten so all visible layers merge into one
            tempDoc.flatten();

            // Scale down if the longest side exceeds maxDimension
            const longest = Math.max(tempDoc.width, tempDoc.height);
            if (longest > maxDimension) {
                const scale = maxDimension / longest;
                const newW = Math.round(tempDoc.width * scale);
                const newH = Math.round(tempDoc.height * scale);

                await action.batchPlay([{
                    _obj: 'imageSize',
                    width: { _unit: 'pixelsUnit', _value: newW },
                    height: { _unit: 'pixelsUnit', _value: newH },
                    scaleStyles: true,
                    constrainProportions: true,
                    interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubicSharper' }
                }], { synchronousExecution: false });
            }

            outWidth = tempDoc.width;
            outHeight = tempDoc.height;

            // Save to a temp PNG file in the plugin's temp folder
            const uxp = require('uxp');
            const fsLib = uxp.storage.localFileSystem;
            const tempFolder = await fsLib.getTemporaryFolder();
            const file = await tempFolder.createFile(`mcp_img_${Date.now()}.png`, { overwrite: true });

            await tempDoc.saveAs.png(file, { compression: 6 }, true);

            const buffer = await file.read({ format: uxp.storage.formats.binary });
            base64Data = fsModule.arrayBufferToBase64(buffer);

            // Clean up temp file
            try { await file.delete(); } catch { /* ignore cleanup errors */ }
        } finally {
            // Close the duplicate document without saving and restore active document
            try { await tempDoc.closeWithoutSaving(); } catch { /* ignore */ }
            try { app.activeDocument = doc; } catch { /* ignore */ }
        }
    }, { commandName: 'MCP: getImage' });

    return {
        base64: base64Data,
        format: 'png',
        width: outWidth,
        height: outHeight
    };
}


module.exports = {
    getDocumentInfo,
    executeBatchPlay,
    executeScript,
    getImage
};
