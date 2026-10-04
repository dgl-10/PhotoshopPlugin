'use strict';

/**
 * Publish several tool layers through the one MCP server.
 *
 * MCP has a single flat tool list, so the Photoshop document tools (`ps_`) and the
 * generation tools (`gen_`) are merged here. Each layer keeps its own handlers and its own
 * rules; this only decides whose call a name belongs to.
 */

/**
 * Merge tool layers into one { list, call, setClient } object for createMcpRouter.
 *
 * @param {object[]} layers - Tool layers, each with list() and call(name, args), and
 *   optionally setClient(clientInfo). The first layer answers calls for unknown names.
 * @returns {{list: Function, call: Function, setClient: Function}} The merged tool layer.
 */
function combineTools(layers) {
    const owners = new Map();
    for (const layer of layers) {
        for (const tool of layer.list()) {
            if (owners.has(tool.name)) {
                throw new Error(`Two tool layers publish a tool named "${tool.name}".`);
            }
            owners.set(tool.name, layer);
        }
    }

    return {
        /**
         * @returns {object[]} Every layer's tool definitions, in layer order.
         */
        list() {
            return layers.flatMap(layer => layer.list());
        },

        /**
         * @param {string} name - Tool name.
         * @param {object} [args] - Tool arguments.
         * @returns {Promise<object>} The owning layer's result. An unknown name goes to the
         *   first layer, whose refusal already lists what exists in that layer.
         */
        call(name, args = {}) {
            const layer = owners.get(name) || layers[0];
            return layer.call(name, args);
        },

        /**
         * @param {object|null} clientInfo - The clientInfo block from initialize.
         */
        setClient(clientInfo) {
            for (const layer of layers) {
                if (typeof layer.setClient === 'function') layer.setClient(clientInfo);
            }
        }
    };
}

module.exports = { combineTools };
