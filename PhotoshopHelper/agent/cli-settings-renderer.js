/**
 * Renderer for the CLI Settings window (Window A).
 *
 * Draws a table of the four supported CLIs. For each one it shows:
 *   - Install status (detected by the main process via `where`/`which`).
 *   - An "Enabled" checkbox (disabled when the CLI is not installed).
 *   - A "Native Image Gen" checkbox (also disabled when not installed).
 *   - A "Configure" button that opens the Model Config window (Window B)
 *     for that specific CLI.
 *
 * Changes to checkboxes are saved immediately — there is no explicit Save button.
 * Everything comes from window.cliSettingsBridge (see cli-settings-preload.js).
 */

(function () {
    'use strict';

    /** Display names for the four CLI identifiers. */
    const CLI_LABELS = {
        claude: 'Anthropic Claude',
        codex:  'OpenAI Codex',
        grok:   'SpaceX AI Grok Build',
        agy:    'Google Antigravity'
    };

    /** Ordered list that drives the table row order. */
    const CLI_ORDER = ['claude', 'codex', 'grok', 'agy'];

    // ── DOM helpers ──────────────────────────────────────────────────────

    /**
     * @param {string} id
     * @returns {HTMLElement|null}
     */
    function byId(id) {
        return document.getElementById(id);
    }

    /**
     * @param {HTMLElement|null} el
     * @param {boolean} shown
     */
    function setShown(el, shown) {
        if (!el) return;
        if (shown) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
    }

    // ── Row building ─────────────────────────────────────────────────────

    /**
     * Create a <tr> for one CLI.
     *
     * @param {string} cli   - CLI identifier.
     * @param {object} state - { installed, enabled, nativeImageGen, tiers }.
     * @returns {HTMLTableRowElement}
     */
    function buildRow(cli, state) {
        const tr = document.createElement('tr');
        if (!state.installed) tr.classList.add('cs-row-disabled');

        // ── CLI name ──
        const tdName = document.createElement('td');
        tdName.className = 'cs-cli-name';
        tdName.textContent = CLI_LABELS[cli] || cli;
        tr.appendChild(tdName);

        // ── Status badge ──
        const tdStatus = document.createElement('td');
        tdStatus.className = 'cs-status cs-center';
        const badge = document.createElement('span');
        badge.className = state.installed
            ? 'label label-success label-rounded'
            : 'label label-error label-rounded';
        badge.textContent = state.installed ? 'Installed' : 'Not found';
        tdStatus.appendChild(badge);
        tr.appendChild(tdStatus);

        // ── Enabled checkbox ──
        const tdEnabled = document.createElement('td');
        tdEnabled.className = 'cs-checkbox-cell cs-center';
        const labelEnabled = document.createElement('label');
        labelEnabled.className = 'form-checkbox';
        const cbEnabled = document.createElement('input');
        cbEnabled.type     = 'checkbox';
        cbEnabled.checked  = state.enabled;
        cbEnabled.disabled = !state.installed;
        cbEnabled.addEventListener('change', async () => {
            await window.cliSettingsBridge.setEnabled(cli, cbEnabled.checked);
        });
        labelEnabled.appendChild(cbEnabled);
        labelEnabled.appendChild(document.createElement('i')).className = 'form-icon';
        tdEnabled.appendChild(labelEnabled);
        tr.appendChild(tdEnabled);

        // ── Native Image Gen checkbox ──
        const tdNig = document.createElement('td');
        tdNig.className = 'cs-checkbox-cell cs-center';
        const labelNig = document.createElement('label');
        labelNig.className = 'form-checkbox';
        const cbNig = document.createElement('input');
        cbNig.type = 'checkbox';

        if (state.nativeImageGenNotSupported) {
            cbNig.checked = false;
            cbNig.disabled = true;
            labelNig.title = 'Not supported by this CLI';
        } else {
            cbNig.checked = state.nativeImageGen;
            cbNig.disabled = !state.installed;
            if (state.nativeImageGenSupported) {
                labelNig.title = 'Supported by this CLI';
            }
        }

        cbNig.addEventListener('change', async () => {
            await window.cliSettingsBridge.setNativeImageGen(cli, cbNig.checked);
        });
        labelNig.appendChild(cbNig);
        labelNig.appendChild(document.createElement('i')).className = 'form-icon';
        tdNig.appendChild(labelNig);
        tr.appendChild(tdNig);

        // ── Configure button ──
        const tdAction = document.createElement('td');
        tdAction.className = 'cs-action-cell cs-center';
        const btnConfigure = document.createElement('button');
        btnConfigure.className = 'btn btn-sm btn-primary';
        btnConfigure.textContent = 'Configure';
        btnConfigure.disabled = !state.installed;
        btnConfigure.addEventListener('click', async () => {
            await window.cliSettingsBridge.openModelConfig(cli);
        });
        tdAction.appendChild(btnConfigure);
        tr.appendChild(tdAction);

        return tr;
    }

    // ── Rendering ────────────────────────────────────────────────────────

    /**
     * Populate the table from the state returned by cliSettingsBridge.getState().
     *
     * @param {object} state - Keys are CLI names; values are { installed, enabled, nativeImageGen, tiers }.
     */
    function render(state) {
        const tbody = byId('cs-tbody');
        if (!tbody) return;
        tbody.textContent = '';

        for (const cli of CLI_ORDER) {
            const cliState = state[cli];
            if (!cliState) continue;
            tbody.appendChild(buildRow(cli, cliState));
        }

        setShown(byId('cs-loading'),    false);
        setShown(byId('cs-table-wrap'), true);
    }

    /**
     * Show an error message in the toast and hide the table.
     *
     * @param {string} message
     */
    function showError(message) {
        setShown(byId('cs-loading'), false);
        const errEl = byId('cs-error');
        const errText = byId('cs-error-text');
        if (errText) errText.textContent = message;
        setShown(errEl, true);
    }

    // ── Bootstrap ────────────────────────────────────────────────────────

    async function init() {
        try {
            const state = await window.cliSettingsBridge.getState();
            if (!state) {
                showError('Could not load CLI settings. Please restart Helper.');
                return;
            }
            render(state);
        } catch (error) {
            showError(`Error loading CLI settings: ${error.message}`);
        }
    }

    window.addEventListener('focus', () => {
        void init();
    });

    void init();
})();
