'use strict';

/**
 * Display names of the supported CLIs / agent platforms. This is the one place where
 * they are written down.
 *
 * The module deliberately imports nothing. cli-service.js loads cli-runner.js, which loads
 * mcp-setup.js, so mcp-setup.js cannot take the names from cli-service.js: that would close
 * a circle and hand it a half-loaded module with no names in it yet. Main-process code
 * that needs a name reads it from here. cli-service.js re-exports the map and puts the
 * name into every getCliConfig() entry as `label`, which is what the windows show.
 *
 * The window renderers cannot require this file and keep no copies of it. They receive
 * the name from the main process: as `label` in the state they load, and, for the per-CLI
 * settings window, in the URL it is opened with (see cli-models-window.js).
 */
const CLI_LABELS = {
    claude: 'Anthropic Claude',
    codex:  'OpenAI ChatGPT/Codex',
    grok:   'SpaceX AI Grok Build',
    agy:    'Google Antigravity'
};

module.exports = { CLI_LABELS };
