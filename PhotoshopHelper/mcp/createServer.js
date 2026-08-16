const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');

const { getAvailableProviders } = require('../availableProviders');
const { getProvidersDetails, selectMcpProviders, toProviderSummaries } = require('./compactProvider');
const { createGenerateImageHandler } = require('./generateImage');
const { buildInstructions } = require('./instructions');
const {
    GENERATE_IMAGE_DESCRIPTION,
    GET_PROVIDERS_DETAILS_DESCRIPTION,
    LIST_PROVIDERS_DESCRIPTION,
    generateImageInputSchema,
    getProvidersDetailsInputSchema,
    listProvidersInputSchema
} = require('./toolSchemas');
const { jsonResult, toolError } = require('./toolResults');

/**
 * Create one MCP server instance for a single Streamable HTTP session.
 *
 * @param {object} options - Runtime dependencies.
 * @param {string} options.appVersion - Application version advertised to the client.
 * @param {string} options.guidePath - Absolute path to MCP_GUIDE.md.
 * @param {Function} options.generate - Existing generate() function.
 * @param {string} options.tempDir - Shared generation output directory.
 * @param {Function} [options.onGenerationAccepted] - Usage/accounting hook.
 * @param {Function} [options.getAvailableProviders] - Optional catalog override.
 * @returns {McpServer} Connected later to one transport.
 */
function createPhotoshopHelperMcpServer(options) {
    const loadAvailableProviders = options.getAvailableProviders || getAvailableProviders;
    const server = new McpServer(
        {
            name: 'photoshop-helper',
            version: options.appVersion
        },
        {
            instructions: buildInstructions(options.guidePath)
        }
    );

    server.registerTool(
        'list_providers',
        {
            description: LIST_PROVIDERS_DESCRIPTION,
            inputSchema: listProvidersInputSchema
        },
        async ({ mode } = {}) => {
            const available = selectMcpProviders(loadAvailableProviders());
            return jsonResult(toProviderSummaries(available, mode));
        }
    );

    server.registerTool(
        'get_providers_details',
        {
            description: GET_PROVIDERS_DETAILS_DESCRIPTION,
            inputSchema: getProvidersDetailsInputSchema
        },
        async ({ providerIds } = {}) => {
            const available = selectMcpProviders(loadAvailableProviders());
            const result = getProvidersDetails(available, providerIds);
            if (result.error) {
                return toolError(result.error);
            }
            return jsonResult({
                providers: result.providers,
                notFound: result.notFound
            });
        }
    );

    server.registerTool(
        'generate_image',
        {
            description: GENERATE_IMAGE_DESCRIPTION,
            inputSchema: generateImageInputSchema
        },
        createGenerateImageHandler({
            generate: options.generate,
            tempDir: options.tempDir,
            onGenerationAccepted: options.onGenerationAccepted
        })
    );

    return server;
}

module.exports = { createPhotoshopHelperMcpServer };
