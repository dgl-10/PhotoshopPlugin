/**
 * Build the short initialize handshake. The full companion guide is a file
 * path, not inline text: instructions are sent once per session.
 *
 * @param {string} guidePath - Absolute path to MCP_GUIDE.md.
 * @returns {string} MCP initialize instructions.
 */
function buildInstructions(guidePath) {
    return [
        'Photoshop Helper is a local image-generation tool server.',
        'Call list_providers first, pick a provider by id and generation_modes, then call get_providers_details only for the chosen provider ids, then generate_image.',
        'Inputs and outputs are absolute filesystem paths. Generated files are written to the shared temp directory and are not placed into Photoshop.',
        `Optional deep-dive: if you are stuck, read this local file with your filesystem tool: ${guidePath}`
    ].join(' ');
}

module.exports = { buildInstructions };
