'use strict';

/**
 * Identity and availability of the two private areola binaries (task20).
 *
 * The check is separate from availability.js on purpose: the skin recipe keeps working when an
 * areola binary is missing, and only a request with areolas is refused, naming the variant and
 * its file. A wrong file is refused by its SHA-256; another variant is never substituted.
 */
const runtime = require('./variant-runtime');
const { AREOLA_DEFINITIONS } = require('./areola-definitions');

/**
 * Verify one binary on disk and describe it in the same shape as the skin formula identities.
 *
 * @param {string} id - Areola variant key, e.g. "areola_fable".
 * @returns {object}
 * @throws {Error} Missing file or SHA-256 mismatch, with the file name.
 */
function areolaCoreIdentity(id) {
    const definition = AREOLA_DEFINITIONS[id];
    if (!definition) throw new Error(`Unknown areola variant: ${id}`);
    runtime.readVerified(id);
    return {
        formulaId: id, name: definition.variant, fileName: definition.fileName,
        version: definition.variantVersion, sha256: definition.sha256, rawSha256: definition.sha256,
        matchesPinned: true, label: definition.label
    };
}

/**
 * Check both binaries without compiling or running them.
 *
 * @returns {string|null} null when all are usable, otherwise one sentence per unusable variant.
 */
function checkAreolaCores() {
    const problems = [];
    for (const definition of Object.values(AREOLA_DEFINITIONS)) {
        try {
            areolaCoreIdentity(definition.id);
        } catch (error) {
            problems.push(`Areola variant ${definition.label} (${definition.variant} ${definition.variantVersion}): ${error.message}`);
        }
    }
    return problems.length ? problems.join(' ') : null;
}

module.exports = { areolaCoreIdentity, checkAreolaCores };
