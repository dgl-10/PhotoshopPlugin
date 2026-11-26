'use strict';

/**
 * Compatibility entry point for the skin texture subsystem's Wasm host.
 * The implementation handles separately pinned private variants; no formula
 * mathematics or obsolete single-core binary is bundled in this file.
 */
module.exports = require('./variant-runtime');