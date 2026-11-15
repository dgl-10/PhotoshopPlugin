'use strict';

/**
 * Stable entry point for skin request validation.
 * Generation-two validation lives in a separate module so callers retain their existing
 * dependency while obsolete kernel-specific blur geometry and presets are removed.
 */
module.exports = require('./recipe-request');