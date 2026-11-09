'use strict';

/**
 * Decide whether this Helper run computes skin textures or only refuses them.
 *
 * The ps_skin_texture_ tools are always published with the same descriptions and schemas.
 * What answers them is either the real job manager (job-manager.js) or a stand-in that
 * refuses every call:
 * - in the installed Helper the feature is still in development and formulas.wasm is not
 *   shipped, so the tools answer that the feature is not available yet;
 * - in a development run without a usable formulas.wasm (missing, or not the pinned build)
 *   Helper still starts, writes the reason to its log, and the tools answer with it.
 *
 * The stand-in computes nothing, writes no files and never touches the document.
 */

const { createSkinTextureJobs, DEFAULT_OPTIONS } = require('./job-manager');
const { SkinRequestError } = require('./core-adapter');
const wasmLoader = require('./wasm-loader.js');

const IN_DEVELOPMENT_CODE = 'FEATURE_IN_DEVELOPMENT';
const IN_DEVELOPMENT_MESSAGE =
    'Skin texture is still in development and is not available in this version of PhotoshopHelper. '
    + 'Nothing was computed and the document was not changed. Tell the person that this feature '
    + 'will come in a later version. Do not call the ps_skin_texture_ tools again in this task, '
    + 'and do not substitute the texture by other means unless the person asks for that.';
const CORE_UNAVAILABLE_CODE = 'CORE_UNAVAILABLE';

/**
 * A job manager that refuses every call. It carries the real manager's options, so the
 * tool descriptions built from them stay exactly the same.
 *
 * @param {object} options
 * @param {string} options.code - Refusal code for the agent.
 * @param {string} options.message - Refusal text for the agent.
 * @param {object} [options.limits] - The same limits the real manager would get.
 * @returns {object} An object with the job manager's surface used by the tool layer.
 */
function createRefusingJobs({ code, message, limits = {} }) {
    const refuse = () => {
        throw new SkinRequestError(code, message);
    };
    return {
        options: { ...DEFAULT_OPTIONS, ...limits },
        start: async () => refuse(),
        status: () => refuse(),
        apply: async () => refuse(),
        cancel: async () => refuse(),
        dispose: () => Promise.resolve()
    };
}

/**
 * Create the job manager for this Helper run.
 *
 * @param {object} options - Everything createSkinTextureJobs takes, plus:
 * @param {boolean} [options.inDevelopment] - true in the installed Helper: the tools refuse
 *   with "in development" and formulas.wasm is never looked for.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {object} The real job manager, or a refusing stand-in.
 */
function createSkinTextureJobsForHelper({ inDevelopment = false, logger = console, ...options }) {
    if (inDevelopment) {
        logger.info('[skin-texture] Installed build: the skin texture tools answer that the feature is in development.');
        return createRefusingJobs({ code: IN_DEVELOPMENT_CODE, message: IN_DEVELOPMENT_MESSAGE, limits: options.limits });
    }

    const problem = wasmLoader.checkWasmCore();
    if (problem) {
        logger.error(`[skin-texture] ${problem} The skin texture tools refuse until it is fixed.`);
        return createRefusingJobs({ code: CORE_UNAVAILABLE_CODE, message: problem, limits: options.limits });
    }

    return createSkinTextureJobs({ logger, ...options });
}

module.exports = {
    IN_DEVELOPMENT_CODE,
    CORE_UNAVAILABLE_CODE,
    createSkinTextureJobsForHelper
};
