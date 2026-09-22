'use strict';

/**
 * Connecting a CLI agent to this MCP server, once.
 *
 * The server is registered on the person's machine one time and then simply exists; it is
 * not handed to the CLI on every launch. Other MCP servers the person has are left alone —
 * Context7 is one we want ourselves, and the rest do no harm. No strict mode.
 *
 * The registration carries a reference to an environment variable rather than the token
 * itself, so the secret does not end up written into a configuration file.
 */

const { spawn } = require('node:child_process');

// The name the server is registered under. It decides what the tools are called on the
// agent's side (mcp__photoshop-helper__ps_start_task), so changing it is not cosmetic.
const SERVER_NAME = 'photoshop-helper';

// The variable Helper can write into the user's environment from its tray menu.
const TOKEN_ENV_VAR = 'PHOTOSHOP_HELPER_LOCAL_API_TOKEN';

/**
 * The one-line command for each CLI, plus anything the person has to know about it.
 *
 * @param {object} options
 * @param {number} options.port - Helper's HTTP port.
 * @returns {object[]} One entry per CLI.
 */
function buildInstallCommands({ port }) {
    const url = `http://127.0.0.1:${port}/mcp`;
    const grokHeader = `Authorization: Bearer \${${TOKEN_ENV_VAR}}`;
    const grokAdd = `grok mcp add --transport http ${SERVER_NAME} ${url}`;
    const grokForCmd = `${grokAdd} --header "${grokHeader}"`;
    const grokForShell = `${grokAdd} --header '${grokHeader}'`;

    return [
        {
            cli: 'claude',
            label: 'Claude Code',
            command: `claude mcp add --transport http ${SERVER_NAME} ${url} `
                + `--header "Authorization: Bearer \${${TOKEN_ENV_VAR}}"`,
            note: 'Claude Code expands ${VAR} from the environment when it connects, so the '
                + 'token itself is never written into ~/.claude.json.',
            canInstallFromHelper: true
        },
        {
            cli: 'codex',
            label: 'OpenAI Codex',
            command: `codex mcp add ${SERVER_NAME} --url ${url} --bearer-token-env-var ${TOKEN_ENV_VAR}`,
            note: 'Codex reads the token from the environment variable by name.',
            canInstallFromHelper: true
        },
        {
            cli: 'grok',
            label: 'xAI Grok',
            // cmd.exe (the shell Helper uses on Windows) leaves ${VAR} alone inside double
            // quotes. PowerShell and sh expand it, so a pasted command must use single quotes
            // or the reference never reaches ~/.grok/config.toml.
            command: process.platform === 'win32' ? grokForCmd : grokForShell,
            copyCommand: grokForShell,
            note: 'Grok stores ${VAR} unchanged in ~/.grok/config.toml and expands it when it '
                + 'loads the file. Do not paste the token into that file. The copied command '
                + 'quotes the header so PowerShell and bash do not expand the reference first.',
            canInstallFromHelper: true
        },
        {
            cli: 'agy',
            label: 'Google Antigravity',
            // Antigravity does not support environment variable interpolation in HTTP headers at runtime
            // (${env:VAR} or ${VAR} are treated as literal strings). The command expands the variable
            // via the shell at install time so that the real token is written into ~/.gemini/config/mcp_config.json.
            // cmd.exe (used by runInstall) expands %VAR%, while PowerShell and sh expand $env:VAR / $VAR.
            command: process.platform === 'win32'
                ? `agy mcp add --header "Authorization: Bearer %${TOKEN_ENV_VAR}%" ${SERVER_NAME} ${url}`
                : `agy mcp add --header "Authorization: Bearer $${TOKEN_ENV_VAR}" ${SERVER_NAME} ${url}`,
            copyCommand: process.platform === 'win32'
                ? `agy mcp add --header "Authorization: Bearer $env:${TOKEN_ENV_VAR}" ${SERVER_NAME} ${url}`
                : `agy mcp add --header "Authorization: Bearer $${TOKEN_ENV_VAR}" ${SERVER_NAME} ${url}`,
            note: 'Antigravity does not evaluate environment variables in headers at runtime. '
                + 'The command expands the environment variable via the shell at install time '
                + 'so the actual token is stored in ~/.gemini/config/mcp_config.json.',
            canInstallFromHelper: true
        }
    ];
}

/**
 * What to tell an agent that is being asked to set this up for the person.
 *
 * @param {object} options
 * @param {number} options.port - Helper's HTTP port.
 * @returns {string} A paragraph the person can paste to their own agent.
 */
function buildAgentInstructions({ port }) {
    return [
        'Please register this MCP server, then tell me to restart you so the tools load:',
        '',
        `  name:      ${SERVER_NAME}`,
        '  transport: http',
        `  url:       http://127.0.0.1:${port}/mcp`,
        `  header:    Authorization: Bearer \${${TOKEN_ENV_VAR}}`,
        '',
        `The token is in the ${TOKEN_ENV_VAR} environment variable — write the reference to the`,
        'variable into the configuration, not the token itself (Note: if you are Google Antigravity,',
        'read the variable and write the actual token value, since Antigravity does not expand env vars in headers).',
        'If the variable is empty, ask me to save the token first: PhotoshopHelper tray menu > Access Tokens >',
        'Save Token to User Environment, and restart you afterwards. Do not turn off my other MCP servers.'//,,
        //'After restarting, the tools are named ps_*; call ps_start_task first.'
    ].join('\n');
}

/**
 * Run a registration command.
 *
 * This only ever happens because the person pressed something: the hard rule of this
 * project is that Helper does not edit another program's global settings on its own.
 *
 * @param {object} options
 * @param {string} options.cli - Which CLI to register with.
 * @param {number} options.port - Helper's HTTP port.
 * @param {number} [options.timeoutMs] - How long to wait.
 * @returns {Promise<{ok: boolean, output: string}>}
 */
function runInstall({ cli, port, timeoutMs = 60_000 }) {
    const entry = buildInstallCommands({ port }).find(item => item.cli === cli);
    if (!entry) {
        return Promise.resolve({ ok: false, output: `Unknown CLI: ${cli}` });
    }

    // The command is built here, not taken from the caller, and is run through the shell
    // because the CLIs are batch shims on Windows.
    return new Promise((resolve) => {
        let output = '';
        let finished = false;

        const child = spawn(entry.command, {
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        const timer = setTimeout(() => {
            finished = true;
            try { child.kill(); } catch { /* already gone */ }
            resolve({ ok: false, output: `${output}\n${entry.cli} did not finish in time.` });
        }, timeoutMs);

        child.stdout.on('data', chunk => { output += chunk.toString('utf-8'); });
        child.stderr.on('data', chunk => { output += chunk.toString('utf-8'); });

        child.on('error', (error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve({ ok: false, output: `Could not run "${entry.cli}": ${error.message}` });
        });

        child.on('close', (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve({ ok: code === 0, output: output.trim() });
        });
    });
}

module.exports = {
    SERVER_NAME,
    TOKEN_ENV_VAR,
    buildInstallCommands,
    buildAgentInstructions,
    runInstall
};
