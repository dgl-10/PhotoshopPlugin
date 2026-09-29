/**
 * Renderer for the CLI Model Config window (Window B).
 *
 * Responsible for:
 *   - Reading the CLI name from the URL hash (e.g. #claude).
 *   - Loading stored tier settings + cached model list on startup.
 *   - Populating datalist options for every model and effort combobox.
 *   - Validating each field: if the value is not in the cached list,
 *     the field gets a red border (Spectre's `has-error` class).
 *   - "Refresh Models" button: calls the main process, updates datalists,
 *     fills only EMPTY tier fields with recommended values, re-validates.
 *   - "Save" button: writes all three tiers at once.
 *
 * Talks exclusively to window.cliModelsBridge (see cli-models-preload.js).
 */

(function () {
    'use strict';

    /** CLI identifier extracted from the window URL hash. */
    const CLI = (window.location.hash || '').replace('#', '').trim() || 'unknown';

    /** Display names for the four CLI identifiers. */
    const CLI_LABELS = {
        claude: 'Anthropic Claude',
        codex:  'OpenAI Codex',
        grok:   'SpaceX AI Grok Build',
        agy:    'Google Antigravity'
    };

    /** The three tiers in display order. */
    const TIERS = ['light', 'medium', 'high'];

    /**
     * All available models from the last successful cache load or refresh.
     * Used for validation.
     * Shape: { modelName: string[] }  — model → array of available efforts.
     *
     * @type {Map<string, string[]>}
     */
    let availableModels = new Map();

    /**
     * Whether a cache was loaded at startup.
     * Used to decide whether to show "No cached data".
     */
    let cacheLoaded = false;

    // ── DOM helpers ──────────────────────────────────────────────────────

    function byId(id) { return document.getElementById(id); }

    function setShown(el, shown) {
        if (!el) return;
        if (shown) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
    }

    function setText(id, text) {
        const el = byId(id);
        if (el) el.textContent = text || '';
    }

    // ── Field accessors ──────────────────────────────────────────────────

    /**
     * @param {'light'|'medium'|'high'} tier
     * @param {'model'|'effort'}        field
     * @returns {HTMLInputElement|null}
     */
    function getInput(tier, field) {
        return byId(`cm-${tier}-${field}`);
    }

    /**
     * @param {'light'|'medium'|'high'} tier
     * @param {'model'|'effort'}        field
     * @returns {HTMLButtonElement|null}
     */
    function getButton(tier, field) {
        return byId(`cm-${tier}-${field}-btn`);
    }

    /**
     * @param {'light'|'medium'|'high'} tier
     * @param {'model'|'effort'}        field
     * @returns {HTMLUListElement|null}
     */
    function getMenu(tier, field) {
        return byId(`cm-${tier}-${field}-menu`);
    }

    // ── Combobox population & management ─────────────────────────────────

    /**
     * Close all open combobox dropdown menus.
     */
    function closeAllMenus() {
        document.querySelectorAll('.cm-combo-menu').forEach(menu => {
            menu.setAttribute('hidden', '');
        });
    }

    /**
     * Flatten all models from the all_available_models response into a
     * Map<modelName, availableEfforts[]> for validation and combobox population.
     * Preserves exact ordering from the CLI response without sorting.
     *
     * @param {object} allModels - all_available_models from the CLI response.
     * @returns {Map<string, string[]>}
     */
    function buildModelMap(allModels) {
        const map = new Map();
        if (!allModels || typeof allModels !== 'object') return map;
        for (const group of Object.values(allModels)) {
            if (!Array.isArray(group)) continue;
            for (const entry of group) {
                if (entry && entry.model) {
                    map.set(entry.model, Array.isArray(entry.available_efforts) ? entry.available_efforts : []);
                }
            }
        }
        return map;
    }

    /**
     * Populate a combobox dropdown menu with items.
     * Crucial: items are NEVER filtered or sorted — all items are shown.
     *
     * @param {'light'|'medium'|'high'} tier
     * @param {'model'|'effort'}        field
     * @param {string[]}                items - All available items.
     * @param {string}                  emptyText - Text when no items are available.
     */
    function populateComboboxMenu(tier, field, items, emptyText = 'No items available') {
        const menu = getMenu(tier, field);
        const input = getInput(tier, field);
        if (!menu) return;

        menu.textContent = '';

        if (!items || items.length === 0) {
            const emptyLi = document.createElement('li');
            emptyLi.className = 'cm-combo-empty';
            emptyLi.textContent = emptyText;
            menu.appendChild(emptyLi);
            return;
        }

        const currentValue = input ? input.value.trim() : '';

        for (const itemValue of items) {
            const li = document.createElement('li');
            li.className = 'menu-item' + (itemValue === currentValue ? ' is-selected' : '');

            const a = document.createElement('a');
            a.href = '#';
            a.textContent = itemValue;
            a.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                if (input) {
                    input.value = itemValue;
                }
                menu.setAttribute('hidden', '');

                if (field === 'model') {
                    // Selected a model: reload efforts for this tier immediately
                    updateEffortsForTier(tier);
                    validateModel(tier);
                    validateEffort(tier);
                } else {
                    validateEffort(tier);
                }
            });

            li.appendChild(a);
            menu.appendChild(li);
        }
    }

    /**
     * Populate model combobox menus for all tiers.
     * Shows ALL models for this CLI without any filtering or sorting.
     */
    function updateAllModelMenus() {
        const allModelNames = Array.from(availableModels.keys());
        for (const tier of TIERS) {
            populateComboboxMenu(tier, 'model', allModelNames, 'No models in cache');
        }
    }

    /**
     * Populate effort combobox menu for a specific tier based on its selected model.
     * Shows ALL available effort settings for that model without any filtering or sorting.
     *
     * @param {'light'|'medium'|'high'} tier
     */
    function updateEffortsForTier(tier) {
        const modelInput = getInput(tier, 'model');
        const modelVal = modelInput ? modelInput.value.trim() : '';

        if (!modelVal) {
            populateComboboxMenu(tier, 'effort', [], 'Select a model first');
            return;
        }

        if (!availableModels.has(modelVal)) {
            // Model is not recognized in cache -> no efforts available
            populateComboboxMenu(tier, 'effort', [], 'No efforts for unknown model');
            return;
        }

        const efforts = availableModels.get(modelVal) || [];
        populateComboboxMenu(tier, 'effort', efforts, 'No effort settings available');
    }

    // ── Validation ───────────────────────────────────────────────────────

    /**
     * Validate a model input field.
     * Red border if: value is non-empty AND cache exists AND value not in cache.
     *
     * @param {'light'|'medium'|'high'} tier
     */
    function validateModel(tier) {
        const input = getInput(tier, 'model');
        if (!input) return;
        const value = input.value.trim();
        const isError = cacheLoaded && value !== '' && !availableModels.has(value);
        input.closest('.form-group')?.classList.toggle('has-error', isError);
    }

    /**
     * Validate an effort input field.
     *
     * Rules:
     * - If model is unknown (not in cache and cache loaded):
     *   Since model does not exist, there are no valid efforts for it -> error if non-empty!
     * - If model is known:
     *   Effort must be in model's available efforts (if non-empty).
     *
     * @param {'light'|'medium'|'high'} tier
     */
    function validateEffort(tier) {
        const modelInput  = getInput(tier, 'model');
        const effortInput = getInput(tier, 'effort');
        if (!modelInput || !effortInput) return;

        const modelValue  = modelInput.value.trim();
        const effortValue = effortInput.value.trim();

        if (!cacheLoaded || effortValue === '') {
            // Empty effort means CLI default -> valid
            effortInput.closest('.form-group')?.classList.remove('has-error');
            return;
        }

        // If a model is typed and does NOT exist in availableModels:
        if (modelValue !== '' && !availableModels.has(modelValue)) {
            // Unknown model has no valid efforts -> error!
            effortInput.closest('.form-group')?.classList.add('has-error');
            return;
        }

        // Known model in availableModels:
        const efforts = availableModels.get(modelValue);
        const isError = efforts !== undefined && !efforts.includes(effortValue);
        effortInput.closest('.form-group')?.classList.toggle('has-error', isError);
    }

    /** Validate all tier fields. */
    function validateAll() {
        for (const tier of TIERS) {
            validateModel(tier);
            validateEffort(tier);
        }
    }

    // ── Cache age formatting ─────────────────────────────────────────────

    /**
     * @param {number} ageMs
     * @returns {string} Human-readable age string.
     */
    function formatAge(ageMs) {
        const minutes = Math.floor(ageMs / 60000);
        if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} min ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} h ago`;
        const days = Math.floor(hours / 24);
        return `${days} day${days === 1 ? '' : 's'} ago`;
    }

    // ── Rendering ────────────────────────────────────────────────────────

    /**
     * Fill tier input values from stored settings.
     *
     * @param {{ light, medium, high }} tiers
     */
    function fillTierInputs(tiers) {
        for (const tier of TIERS) {
            const cfg = tiers[tier] || {};
            const modelIn  = getInput(tier, 'model');
            const effortIn = getInput(tier, 'effort');
            if (modelIn)  modelIn.value  = cfg.model  || '';
            if (effortIn) effortIn.value = cfg.effort || '';
        }
    }

    /**
     * Apply recommended tier values, but ONLY to fields that are currently empty.
     *
     * @param {{ Light, Medium, High }} recommended - recommended_tiers from the prompt response.
     */
    function applyRecommendedToEmpty(recommended) {
        const tierMap = { light: 'Light', medium: 'Medium', high: 'High' };
        for (const tier of TIERS) {
            const key = tierMap[tier];
            const rec = recommended && recommended[key];
            if (!rec) continue;

            const modelIn  = getInput(tier, 'model');
            const effortIn = getInput(tier, 'effort');

            if (modelIn  && modelIn.value.trim()  === '' && rec.model)  modelIn.value  = rec.model;
            if (effortIn && effortIn.value.trim() === '' && rec.effort) effortIn.value = rec.effort;
        }
    }

    /**
     * Update the cache age label.
     *
     * @param {number|null} ageMs
     */
    function renderCacheAge(ageMs) {
        const el = byId('cm-cache-age');
        if (!el) return;
        if (ageMs === null || ageMs === undefined) {
            el.textContent = 'No cached data';
        } else {
            el.textContent = `Last refreshed: ${formatAge(ageMs)}`;
        }
    }

    /**
     * Whether the CLI binary is installed on this machine.
     */
    let isInstalled = true;

    // ── Checkbox state & validation ──────────────────────────────────────

    /**
     * Update the Native Image Gen checkbox according to known support from config/cache.
     *
     * Rules:
     * - Known to support (true): checkbox is enabled (interactable), keep checked state.
     * - Known to NOT support (false): checkbox is disabled, value forced to false.
     * - Unknown (null/undefined): checkbox is interactable, keep user's setting as is.
     *
     * @param {boolean|null|undefined} nativeSupport - Known support flag from cache/prompt.
     * @param {boolean}               currentChecked - Current or stored checked state.
     */
    function updateNativeImageGenState(nativeSupport, currentChecked) {
        const cb = byId('cm-native-image-gen');
        const hint = byId('cm-native-image-gen-hint');
        if (!cb) return;

        if (nativeSupport === false) {
            cb.checked = false;
            cb.disabled = true;
            if (hint) hint.textContent = '(not supported by CLI)';
            // If it was checked before, persist the false state to avoid inconsistency.
            if (currentChecked) {
                void window.cliModelsBridge.setNativeImageGen(CLI, false);
            }
        } else if (nativeSupport === true) {
            cb.checked = Boolean(currentChecked);
            cb.disabled = !isInstalled;
            if (hint) hint.textContent = '(supported)';
        } else {
            // Unknown — leave control enabled (if CLI installed) and preserve user choice.
            cb.checked = Boolean(currentChecked);
            cb.disabled = !isInstalled;
            if (hint) hint.textContent = '';
        }
    }

    /**
     * Update the Enabled checkbox.
     *
     * @param {boolean} enabled - Stored enabled state.
     */
    function updateEnabledState(enabled) {
        const cb = byId('cm-enabled');
        if (!cb) return;
        cb.checked = Boolean(enabled);
        cb.disabled = !isInstalled;
    }

    // ── State loading ────────────────────────────────────────────────────

    /**
     * Load state from the bridge and initialise the form.
     *
     * @param {object} state - { settings, cache } from cliModelsBridge.getState().
     */
    function applyState(state) {
        isInstalled = state.settings ? Boolean(state.settings.installed) : true;

        // Apply checkboxes state
        if (state.settings) {
            updateEnabledState(state.settings.enabled);
            const nativeSupport = state.cache?.data?.supports_native_image_generation;
            updateNativeImageGenState(nativeSupport, state.settings.nativeImageGen);
        }

        // Fill stored tier values.
        if (state.settings && state.settings.tiers) {
            fillTierInputs(state.settings.tiers);
        }

        // Populate combobox menus and update validation from cache.
        if (state.cache && state.cache.data) {
            cacheLoaded     = true;
            availableModels = buildModelMap(state.cache.data.all_available_models);
            updateAllModelMenus();
            for (const tier of TIERS) updateEffortsForTier(tier);
            renderCacheAge(state.cache.ageMs);
        } else {
            updateAllModelMenus();
            for (const tier of TIERS) updateEffortsForTier(tier);
            renderCacheAge(null);
        }

        validateAll();

        setShown(byId('cm-loading'),  false);
        setShown(byId('cm-content'),  true);
        setShown(byId('cm-save-btn'), true);
    }

    // ── Controls ─────────────────────────────────────────────────────────

    function wireControls() {
        // Enabled checkbox change event.
        const enabledCb = byId('cm-enabled');
        if (enabledCb) {
            enabledCb.addEventListener('change', async () => {
                await window.cliModelsBridge.setEnabled(CLI, enabledCb.checked);
            });
        }

        // Native Image Gen checkbox change event.
        const nigCb = byId('cm-native-image-gen');
        if (nigCb) {
            nigCb.addEventListener('change', async () => {
                await window.cliModelsBridge.setNativeImageGen(CLI, nigCb.checked);
            });
        }

        // Combobox buttons and text inputs for all tiers
        for (const tier of TIERS) {
            for (const field of ['model', 'effort']) {
                const btn   = getButton(tier, field);
                const menu  = getMenu(tier, field);
                const input = getInput(tier, field);

                if (btn && menu) {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const isHidden = menu.hasAttribute('hidden');

                        closeAllMenus();

                        if (isHidden) {
                            // Update items before showing to ensure .is-selected matches current input
                            if (field === 'model') {
                                const allModelNames = Array.from(availableModels.keys());
                                populateComboboxMenu(tier, 'model', allModelNames, 'No models in cache');
                            } else {
                                updateEffortsForTier(tier);
                            }
                            menu.removeAttribute('hidden');

                            const selectedLi = menu.querySelector('.is-selected');
                            if (selectedLi) {
                                selectedLi.scrollIntoView({ block: 'nearest' });
                            }
                        }
                    });
                }

                if (input) {
                    input.addEventListener('input', () => {
                        if (field === 'model') {
                            updateEffortsForTier(tier);
                            validateModel(tier);
                            validateEffort(tier);
                        } else {
                            validateEffort(tier);
                        }
                    });
                }
            }
        }

        // Close dropdowns on outside click or Escape
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.cm-combobox')) {
                closeAllMenus();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeAllMenus();
            }
        });

        // Refresh Models button.
        const refreshBtn = byId('cm-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.disabled = true;
                setShown(byId('cm-cache-age'), false);
                setShown(byId('cm-refresh-error'), false);
                setShown(byId('cm-refresh-status'), true);

                const label = CLI_LABELS[CLI] || CLI;
                setText('cm-refresh-status-text', `Querying ${label} CLI...`);
                setText('cm-refresh-timer', '0s');
                setShown(byId('cm-refresh-hint'), false);

                let elapsedSeconds = 0;
                const timerInterval = setInterval(() => {
                    elapsedSeconds++;
                    const mins = Math.floor(elapsedSeconds / 60);
                    const secs = elapsedSeconds % 60;
                    const formatted = mins > 0 ? `${mins}m ${secs < 10 ? '0' : ''}${secs}s` : `${secs}s`;
                    setText('cm-refresh-timer', formatted);

                    if (elapsedSeconds >= 15) {
                        setShown(byId('cm-refresh-hint'), true);
                    }
                }, 1000);

                try {
                    const result = await window.cliModelsBridge.refreshModels(CLI);

                    if (result.error) {
                        setText('cm-refresh-error-text', result.error);
                        setShown(byId('cm-refresh-error'), true);
                        return;
                    }

                    if (result.data) {
                        cacheLoaded     = true;
                        availableModels = buildModelMap(result.data.all_available_models);
                        updateAllModelMenus();
                        for (const tier of TIERS) updateEffortsForTier(tier);

                        // Update Native Image Gen checkbox from refreshed prompt data.
                        const nigSupport = result.data.supports_native_image_generation;
                        const nigCurrent = byId('cm-native-image-gen')?.checked ?? false;
                        const shouldCheck = nigSupport === true ? true : (nigSupport === false ? false : nigCurrent);
                        updateNativeImageGenState(nigSupport, shouldCheck);

                        // Fill only EMPTY fields with recommended values.
                        applyRecommendedToEmpty(result.data.recommended_tiers);

                        // Refresh effort options for all tiers after applying recommended values
                        for (const tier of TIERS) updateEffortsForTier(tier);

                        renderCacheAge(0); // just refreshed
                        validateAll();
                    }
                } catch (err) {
                    setText('cm-refresh-error-text', `Refresh failed: ${err.message}`);
                    setShown(byId('cm-refresh-error'), true);
                } finally {
                    clearInterval(timerInterval);
                    setShown(byId('cm-refresh-status'), false);
                    setShown(byId('cm-cache-age'), true);
                    refreshBtn.disabled = false;
                }
            });
        }

        // Refresh error close button.
        const errClose = byId('cm-refresh-error-close');
        if (errClose) {
            errClose.addEventListener('click', () => setShown(byId('cm-refresh-error'), false));
        }

        // Save button.
        const saveBtn = byId('cm-save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                saveBtn.classList.add('loading');
                saveBtn.disabled = true;

                const tiers = {};
                for (const tier of TIERS) {
                    tiers[tier] = {
                        model:  (getInput(tier, 'model')?.value  || '').trim(),
                        effort: (getInput(tier, 'effort')?.value || '').trim()
                    };
                }

                try {
                    await window.cliModelsBridge.save(CLI, {
                        enabled: byId('cm-enabled')?.checked ?? false,
                        nativeImageGen: byId('cm-native-image-gen')?.checked ?? false,
                        tiers
                    });
                    // Brief visual feedback on the button.
                    saveBtn.textContent = 'Saved';
                    setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
                } catch (err) {
                    setText('cm-error-text', `Save failed: ${err.message}`);
                    setShown(byId('cm-error'), true);
                } finally {
                    saveBtn.classList.remove('loading');
                    saveBtn.disabled = false;
                }
            });
        }
    }

    // ── Bootstrap ────────────────────────────────────────────────────────

    async function init() {
        // Update window title and refresh button with the CLI display name.
        const label = CLI_LABELS[CLI] || CLI;
        const titleEl = byId('cm-title');
        if (titleEl) titleEl.textContent = `Model Configuration — ${label}`;

        const refreshBtn = byId('cm-refresh-btn');
        const refreshBtnText = byId('cm-refresh-btn-text');
        if (refreshBtnText) refreshBtnText.textContent = `Refresh via ${label} CLI`;
        if (refreshBtn) refreshBtn.title = `Query local ${label} CLI to discover available models and capabilities`;

        wireControls();

        try {
            const state = await window.cliModelsBridge.getState(CLI);
            if (!state) {
                setText('cm-error-text', 'Could not load settings. Please restart Helper.');
                setShown(byId('cm-loading'), false);
                setShown(byId('cm-error'),   true);
                return;
            }
            applyState(state);
        } catch (err) {
            setText('cm-error-text', `Error loading settings: ${err.message}`);
            setShown(byId('cm-loading'), false);
            setShown(byId('cm-error'),   true);
        }
    }

    void init();
})();
