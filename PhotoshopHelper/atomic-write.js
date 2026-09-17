const fs = require('node:fs');

/**
 * Replace a text file so that readers see either the old or the new content, never a
 * half-written file.
 *
 * The content goes to a temporary file next to the target and is then renamed over it.
 * A rename within one folder is atomic on the file systems this app runs on, and on
 * Windows Node's rename replaces an existing target. An existing file's permission bits
 * are carried over, so a private file such as .env stays private after the rewrite.
 *
 * @param {string} filePath - File to create or replace.
 * @param {string} text - New file content.
 */
function writeFileAtomic(filePath, text) {
    const tempPath = `${filePath}.tmp-${process.pid}`;
    const options = { encoding: 'utf8' };

    if (fs.existsSync(filePath)) {
        options.mode = fs.statSync(filePath).mode;
    }

    try {
        fs.writeFileSync(tempPath, text, options);
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
}

module.exports = { writeFileAtomic };
