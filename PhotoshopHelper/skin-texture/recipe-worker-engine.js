'use strict';

/**
 * Recipe worker entry point. The coordinator runs one disposable variant worker at a
 * time and returns the unchanged SKTX0002 transport format with generation-two metadata.
 */
module.exports = require('./three-formula-engine');