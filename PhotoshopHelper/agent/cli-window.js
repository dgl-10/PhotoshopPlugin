'use strict';

/**
 * A console window that shows what a command-line agent is doing while it works.
 *
 * Helper does not hand its own pipes over to a window: the CLI is started exactly as it is
 * for a hidden run, so the answer is collected the same way. The window is only a viewer.
 * Helper writes the readable record (see cli-transcript.js) into a text file, and the
 * window follows that file, like `tail -f`. Closing the window early does not touch the run.
 *
 * Windows only. Elsewhere openCliWindow() returns null and the run stays hidden.
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Last line written to the file. The viewer sees it, says it is finished, and waits for Enter.
const END_MARKER = '[[CLI-WINDOW-END]]';

/**
 * @param {string} value - Text to place inside a single-quoted PowerShell string.
 * @returns {string}
 */
function quotePowerShell(value) {
    return String(value).replace(/'/g, "''");
}

/**
 * Remove record files left by earlier runs. A file cannot be removed while its window is
 * still open, so a run only cleans up what is a day old.
 *
 * @param {string} dir - Folder that holds the record files.
 */
function removeOldRecords(dir) {
    const limit = Date.now() - 24 * 60 * 60 * 1000;
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!/^ps-cli-view-.+\.(log|ps1)$/.test(name)) continue;
            const file = path.join(dir, name);
            try {
                if (fs.statSync(file).mtimeMs < limit) fs.unlinkSync(file);
            } catch { /* it is in use or already gone */ }
        }
    } catch { /* an unreadable temp folder is not worth stopping a run for */ }
}

/**
 * Open the viewer window.
 *
 * @param {object} options
 * @param {string} options.title - Window title.
 * @param {string} [options.dir] - Folder for the record file; defaults to the OS temp folder.
 * @returns {{logPath: string, append: (text: string) => void, close: () => void}|null}
 *   Null when a window cannot be shown here.
 */
function openCliWindow({ title, dir = os.tmpdir() }) {
    if (process.platform !== 'win32') return null;

    removeOldRecords(dir);
    const id = crypto.randomUUID();
    const logPath = path.join(dir, `ps-cli-view-${id}.log`);
    const scriptPath = path.join(dir, `ps-cli-view-${id}.ps1`);

    // The files are written with a byte-order mark so Windows PowerShell 5.1 reads them as UTF-8.
    const bom = '﻿';
    const script = [
        `$Host.UI.RawUI.WindowTitle = '${quotePowerShell(title)}'`,
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        `Get-Content -LiteralPath '${quotePowerShell(logPath)}' -Wait -Encoding UTF8 | ForEach-Object {`,
        `    if ($_ -eq '${END_MARKER}') {`,
        "        Write-Host ''",
        "        Write-Host '--- The agent has finished. Press Enter to close this window. ---'",
        '        [void][Console]::ReadLine()',
        '        exit',
        '    }',
        '    $_',
        '}',
        ''
    ].join('\r\n');

    try {
        fs.writeFileSync(logPath, bom, 'utf8');
        fs.writeFileSync(scriptPath, bom + script, 'utf8');

        // `start` is what gives the viewer a console window of its own; a detached child of a
        // program without a console of its own would have none.
        const command = `/d /c start "${title.replace(/"/g, '')}" powershell.exe -NoProfile `
            + `-ExecutionPolicy Bypass -File "${scriptPath}"`;
        const viewer = spawn('cmd.exe', [command], {
            shell: false,
            windowsVerbatimArguments: true,
            windowsHide: false,
            stdio: 'ignore'
        });
        viewer.on('error', () => { /* the run goes on without the window */ });
        viewer.unref();
    } catch {
        return null;
    }

    return {
        logPath,
        append(text) {
            try { fs.appendFileSync(logPath, text, 'utf8'); } catch { /* the window is optional */ }
        },
        close() {
            try { fs.appendFileSync(logPath, `${END_MARKER}\r\n`, 'utf8'); } catch { /* the window is optional */ }
            // The viewer may still be reading the file for a moment, so the files are removed
            // later. They are small and sit in the OS temp folder either way.
            setTimeout(() => {
                try { fs.unlinkSync(scriptPath); } catch { /* already gone */ }
            }, 10000).unref();
        }
    };
}

module.exports = {
    openCliWindow,
    // Exported for testing only; production code goes through openCliWindow().
    END_MARKER
};
