/**
 * Successful tool payload. Agents read the text as JSON.
 *
 * @param {object} payload - Structured tool result.
 * @returns {import('@modelcontextprotocol/sdk/types.js').CallToolResult}
 */
function jsonResult(payload) {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload) }]
    };
}

/**
 * Protocol-level tool error (isError: true). Use for malformed input only.
 *
 * @param {string} message - Human-readable validation failure.
 * @returns {import('@modelcontextprotocol/sdk/types.js').CallToolResult}
 */
function toolError(message) {
    return {
        isError: true,
        content: [{ type: 'text', text: message }]
    };
}

module.exports = { jsonResult, toolError };
