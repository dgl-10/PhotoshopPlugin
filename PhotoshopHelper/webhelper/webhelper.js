/**
 * WebHelper for Photoshop - Frontend
 * Using Spectre.css and Vanilla JS Web Components (Light DOM)
 */

// Global list of all supported aspect ratios (ordered from widest to tallest)  See also apiGeneratorPreprocessors.js
const ALL_ASPECT_RATIOS = [
    "21:9", "2:1", "16:9", "3:2", "4:3", "5:4",
    "1:1",
    "4:5", "3:4", "2:3", "9:16", "1:2", "9:21"
];

// Global environment info (defaults to local desktop)
window.envInfo = {
    isLocal: true,
    isMobile: false,
    threadId: null
};



/**
 * Returns the closest allowed aspect ratio to the given one.
 * If the value is already in the allowed list — returns it as-is.
 * Otherwise finds the nearest match by comparing numeric ratios.
 * @param {string} aspectRatio - e.g. "2:3"
 * @param {string[]} allowedList - list of allowed ratio strings
 * @returns {string}
 */
function fixAspectRatio(aspectRatio, allowedList) {
    if (allowedList.includes(aspectRatio)) return aspectRatio;
    try {
        if (aspectRatio.includes(':')) {
            const parts = aspectRatio.split(':');
            if (parts.length === 2) {
                const [w, h] = parts.map(Number);
                const target = w / h;
                let bestMatch = aspectRatio;
                let minDiff = Infinity;
                for (const a of allowedList) {
                    try {
                        const [aw, ah] = a.split(':').map(Number);
                        const diff = Math.abs(target - aw / ah);
                        if (diff < minDiff) { minDiff = diff; bestMatch = a; }
                    } catch { }
                }
                return bestMatch;
            }
        }
    } catch { }
    return aspectRatio;
}

function getPreviewUrl(url) {
    if (!url) return url;
    return url.replace('/api/webhelper/file/', '/api/webhelper/filePreview/');
}


class WebHelperApp {
    constructor() {
        this.appWrapper = document.getElementById('wh-app-wrapper');
        this.tasksContainer = document.getElementById('tasks-container');
        this.taskSelectorContainer = document.getElementById('task-selector-container');
        this.taskSelector = document.getElementById('global-task-selector');
        this.noTasksMsg = document.getElementById('no-tasks-msg');
        this.errorContainer = document.getElementById('error-container');
        this.connectionStatus = document.getElementById('connection-status');

        this.providers = [];
        this.activeTaskIds = new Set();
        this.taskElements = new Map(); // taskId -> element
        this.pollInterval = null;
        this.taskColorIndex = 0;
        this.taskColors = [
            '#ce1aa1ff', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
            '#e67e22', '#1abc9c', '#d35400', '#34495e', '#c0392b'
        ];

        // Alias persistence: map alias -> value
        this.aliasState = {};

        this.init();
        this.setupSelector();
        this.setupExternalImageInput();
    }

    async init() {
        await this.loadEnvironmentInfo();
        try {
            await this.loadProviders();
            this.startPolling();
            console.log('WebHelper initialized');
        } catch (error) {
            console.error('Failed to initialize WebHelper:', error);
            this.showGlobalError('Failed to load configuration. Check server connection.');
        }
    }

    /**
     * Fetch environment status (local/remote and mobile/desktop) from the server
     */
    async loadEnvironmentInfo() {
        try {
            const response = await fetch('/api/is-local');
            const data = await response.json();

            // Update global variable with actual data
            window.envInfo.isLocal = data.isLocal;
            window.envInfo.isMobile = data.isMobile;
            window.envInfo.threadId = data.threadId;

            console.log("Current environment detected:", window.envInfo);

        } catch (error) {
            console.error("Network error while checking environment:", error);
        }
    }

    setupSelector() {
        if (!this.taskSelector) return;
        this.taskSelector.addEventListener('change', (e) => {
            this.activateTask(e.target.value);
        });
    }

    setupExternalImageInput() {
        const fileInput = document.getElementById('external-task-upload');
        const btnNav = document.getElementById('btn-create-external-task');
        const btnEmpty = document.getElementById('btn-empty-create-external-task');

        const triggerInput = () => {
            if (fileInput) fileInput.click();
        };

        if (btnNav) btnNav.addEventListener('click', triggerInput);
        if (btnEmpty) btnEmpty.addEventListener('click', triggerInput);

        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                this.processExternalFiles(e.target.files);
                fileInput.value = ''; // Reset
            });
        }

        // Global drag & drop
        document.body.ondragover = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        document.body.ondrop = (e) => {
            // Check if dropped into a specific drop-zone (like reference images or global stage)
            // If so, let it handle it instead of creating a new task.
            const isRefDropZone = e.target.closest('wh-source-tab') || e.target.closest('wh-global-stage');
            if (isRefDropZone) return;

            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer && e.dataTransfer.files) {
                this.processExternalFiles(e.dataTransfer.files);
            }
        };

        // Global paste
        this._pasteHandler = this.handleGlobalPaste.bind(this);
        document.addEventListener('paste', this._pasteHandler);
    }

    handleGlobalPaste(e) {
        // If a more specific handler (like WhSourceTab) handled this, ignore
        if (e.defaultPrevented) return;

        // UI Refinement: If there are ANY tasks already active/open, 
        // we don't want to accidentally create a NEW task via global paste.
        // The user should use the "+" button or Drag & Drop for that.
        if (this.activeTaskIds.size > 0) return;

        const clipboardData = e.clipboardData || window.clipboardData;
        if (!clipboardData || !clipboardData.items) return;

        const files = [];
        for (let i = 0; i < clipboardData.items.length; i++) {
            if (clipboardData.items[i].type.startsWith('image/')) {
                const file = clipboardData.items[i].getAsFile();
                if (file) files.push(file);
            }
        }

        if (files.length > 0) {
            this.processExternalFiles(files);
        }
    }

    async processExternalFiles(fileList) {
        if (!fileList || fileList.length === 0) return;

        // We only take the first image for a single task as requested
        const file = Array.from(fileList).find(f => f.type.startsWith('image/'));
        if (!file) {
            this.showGlobalError('No image found in the selection or clipboard.');
            return;
        }

        try {
            const base64Image = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = (e) => reject(e);
                reader.readAsDataURL(file);
            });

            // Send to the existing endpoint
            const response = await fetch('/api/webhelper/task', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: base64Image,
                    threadId: window.envInfo.threadId
                })
            });


            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to create task');
            }

            // Immediately poll to show the new task
            this.pollForTasks();

        } catch (err) {
            console.error('Failed to process external image:', err);
            this.showGlobalError('Error creating task: ' + err.message);
        }
    }

    async loadProviders() {
        try {
            const response = await fetch('/api/webhelper/providers');
            if (!response.ok) throw new Error('Failed to load providers');
            const data = await response.json();
            this.providers = data.providers || [];
        } catch (err) {
            console.error(err);
            this.showGlobalError('Could not load provider configurations.');
        }
    }

    startPolling() {
        if (!window.envInfo.isLocal) {
            console.log('Remote host detected. Automatic polling disabled.');
            this.pollForTasks(); // Perform one-off poll to check initial connection and set status
            return;
        }
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.pollInterval = setInterval(() => this.pollForTasks(), 2000);
        this.pollForTasks();
    }

    async pollForTasks() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        try {
            const url = new URL('/api/webhelper/queue', window.location.origin);
            if (window.envInfo.threadId) {
                url.searchParams.append('threadId', window.envInfo.threadId);
            }
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) throw new Error('Polling failed');

            const data = await response.json();
            const newTasks = data.tasks || [];

            if (newTasks.length > 0) {
                this.handleNewTasks(newTasks);
            }

            this.setConnectionStatus(true, window.envInfo.isLocal ? null : 'Remote Access');
        } catch (err) {
            clearTimeout(timeoutId);
            this.setConnectionStatus(false);
            if (err.name === 'AbortError') {
                console.warn('Polling request timed out');
            }
        }
    }

    async handleNewTasks(taskIds) {
        try {
            await fetch('/api/webhelper/mark_opened', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskIds })
            });
        } catch (err) {
            console.error('Failed to mark tasks as opened:', err);
        }

        for (const taskId of taskIds) {
            if (this.activeTaskIds.has(taskId)) continue;

            try {
                const response = await fetch(`/api/webhelper/task/${taskId}`);
                if (!response.ok) continue;

                const taskData = await response.json();
                this.createTaskControl(taskId, taskData);
                this.activeTaskIds.add(taskId);
            } catch (err) {
                console.error(`Failed to load task ${taskId}:`, err);
            }
        }
    }

    createTaskControl(taskId, taskData) {
        if (this.noTasksMsg) this.noTasksMsg.style.display = 'none';
        if (this.taskSelectorContainer) this.taskSelectorContainer.style.display = 'block';

        // Assign color
        const color = this.taskColors[this.taskColorIndex];
        this.taskColorIndex = (this.taskColorIndex + 1) % this.taskColors.length;

        const taskControl = document.createElement('wh-task-control');
        taskControl.taskId = taskId;
        taskControl.taskData = taskData;
        taskControl.providers = this.providers;
        taskControl.app = this;
        taskControl.state.taskColor = color; // Save color to task state
        taskControl.style.display = 'none';

        this.tasksContainer.appendChild(taskControl);
        this.taskElements.set(taskId, taskControl);

        const option = document.createElement('option');
        option.value = taskId;
        const shortId = taskId.replace('task_', '').substring(0, 12);
        const time = new Date().toLocaleTimeString();
        option.textContent = `● [Task ${shortId}] @ ${time}`;
        option.style.color = color; // Apply color to the option text

        this.taskSelector.insertBefore(option, this.taskSelector.firstChild);
        this.taskSelector.value = taskId;
        this.activateTask(taskId);
    }

    activateTask(taskId) {
        this.taskElements.forEach(el => el.style.display = 'none');
        const activeEl = this.taskElements.get(taskId);
        if (activeEl) {
            activeEl.style.display = 'block';
            if (this.appWrapper) {
                this.appWrapper.style.borderColor = activeEl.state.taskColor;
            }
        }
    }

    setConnectionStatus(ok, customText = null) {
        if (!this.connectionStatus) return;
        const text = customText || (ok ? 'Connected' : 'Disconnected (Retrying...)');
        this.connectionStatus.innerHTML = ok
            ? `<span class="label label-success">${text}</span>`
            : `<span class="label label-error">${text}</span>`;
    }

    showGlobalError(msg) {
        const toast = document.createElement('div');
        toast.className = 'toast toast-error mb-2 wh-error-banner';
        toast.innerHTML = `<button class="btn btn-clear float-right" onclick="this.parentElement.remove()"></button>${msg}`;
        this.errorContainer.appendChild(toast);
    }
}

class WhTaskControl extends HTMLElement {
    constructor() {
        super();
        this._currentTab = 'source';
        this._results = [];
        this.state = {
            selectedProviderId: null,
            formState: { prompt: '', num_images: 1, aspect_ratio: '' },
            references: [],
            useMask: true
        };
    }

    connectedCallback() {
        this.classList.add('wh-task-control', 'card');
        this.render();
    }

    render() {
        const title = this.taskId ? this.taskId.replace('task_', '').substring(0, 12) : 'New Task';
        this.innerHTML = `
            <div class="card-header wh-task-control-header">
                <div class="card-title h5">Task: ${title}</div>
            </div>
            <ul class="tab tab-block wh-task-control-tabs">
                <li class="tab-item active" data-tab="source"><a href="javascript:void(0)">Source</a></li>
            </ul>
            <div class="card-body wh-tab-content"></div>
        `;
        this.setupTabs();
        this.switchTab('source');
    }

    setupTabs() {
        this.querySelector('.wh-task-control-tabs').onclick = (e) => {
            const item = e.target.closest('.tab-item');
            if (item) this.switchTab(item.dataset.tab);
        };
    }

    switchTab(tabName, regenerateParams = null) {
        this._currentTab = tabName;
        this.querySelectorAll('.tab-item').forEach(item => {
            item.classList.toggle('active', item.dataset.tab === tabName);
        });

        const contentArea = this.querySelector('.wh-tab-content');
        contentArea.innerHTML = '';

        if (tabName === 'source') {
            const tab = document.createElement('wh-source-tab');
            tab.taskId = this.taskId;
            tab.taskData = this.taskData;
            tab.providers = this.providers;
            tab.taskControl = this;
            if (regenerateParams) {
                this.state.formState = { ...this.state.formState, ...regenerateParams };
            }
            contentArea.appendChild(tab);
        } else if (tabName.startsWith('result-')) {
            const index = parseInt(tabName.replace('result-', ''));
            const tab = document.createElement('wh-result-tab');
            tab.resultData = this._results[index];
            tab.index = index;
            tab.taskControl = this;
            contentArea.appendChild(tab);
        }
    }

    addGeneratingTab(shouldSwitch = true) {
        const tabList = this.querySelector('.wh-task-control-tabs');
        const index = this._results.length;
        this._results.push({ status: 'generating' });

        const li = document.createElement('li');
        li.className = 'tab-item';
        li.dataset.tab = `result-${index}`;
        li.innerHTML = `<a href="javascript:void(0)">Res ${index + 1} <span class="loading"></span></a>`;
        tabList.appendChild(li);

        if (shouldSwitch) {
            this.switchTab(`result-${index}`);
        }
        return index;
    }

    setGeneratingPayload(payload, index) {
        if (this._results[index] && this._results[index].status === 'generating') {
            this._results[index].params = payload.params;
            this._results[index].providerId = payload.providerId;
        }
    }

    updateResultsFrom(newResults, baseIndex) {
        if (!newResults || newResults.length === 0) {
            this.handleError("No images generated", baseIndex);
            return;
        }

        const uniqueNewResults = [];
        const seenHashes = new Set();

        for (const res of newResults) {
            if (res.status === 'error' && res.error_hash) {
                if (seenHashes.has(res.error_hash)) {
                    continue;
                }
                seenHashes.add(res.error_hash);
            }
            uniqueNewResults.push(res);
        }

        newResults = uniqueNewResults;

        const tabList = this.querySelector('.wh-task-control-tabs');

        if (this._results[baseIndex] && this._results[baseIndex].status === 'generating') {
            if (newResults && newResults.length > 0) {
                const firstRes = newResults[0];
                this._results[baseIndex] = {
                    params: this._results[baseIndex].params,
                    providerId: this._results[baseIndex].providerId,
                    ...firstRes
                };
                if (!this._results[baseIndex].status) this._results[baseIndex].status = 'done';

                const item = this.querySelector(`.tab-item[data-tab="result-${baseIndex}"]`);
                if (item) {
                    if (this._results[baseIndex].status === 'error') {
                        item.innerHTML = `<a href="javascript:void(0)" class="text-error">Res ${baseIndex + 1} (Error)</a>`;
                    } else {
                        item.innerHTML = `<a href="javascript:void(0)">Res ${baseIndex + 1}</a>`;
                    }
                }
            } else {
                this.handleError("No images generated", baseIndex);
                return;
            }
        }

        // Setup new tabs for any additional results dynamically
        for (let i = 1; i < newResults.length; i++) {
            const newIndex = this._results.length;
            const res = newResults[i];

            const resultData = {
                params: this._results[baseIndex].params,
                providerId: this._results[baseIndex].providerId,
                ...res
            };
            if (!resultData.status) resultData.status = 'done';

            this._results.push(resultData);

            const li = document.createElement('li');
            li.className = 'tab-item';
            li.dataset.tab = `result-${newIndex}`;
            if (resultData.status === 'error') {
                li.innerHTML = `<a href="javascript:void(0)" class="text-error">Res ${newIndex + 1} (Error)</a>`;
            } else {
                li.innerHTML = `<a href="javascript:void(0)">Res ${newIndex + 1}</a>`;
            }
            tabList.appendChild(li);
        }

        if (this._currentTab.startsWith('result-')) this.switchTab(this._currentTab);
    }

    handleError(msg, index) {
        if (this._results[index] && this._results[index].status === 'generating') {
            this._results[index].status = 'error';
            this._results[index].error = msg;
            const item = this.querySelector(`.tab-item[data-tab="result-${index}"]`);
            if (item) item.innerHTML = `<a href="javascript:void(0)" class="text-error">Res ${index + 1} (Error)</a>`;
        }
        if (this._currentTab.startsWith('result-')) this.switchTab(this._currentTab);
    }
}

class WhSourceTab extends HTMLElement {
    constructor() {
        super();
        this._viewMode = 'overlay';
    }

    get currentProvider() {
        return this.providers?.find(p => p.id === this.taskControl?.state?.selectedProviderId);
    }

    get maxRefs() {
        const provider = this.currentProvider;
        if (!provider) return 0;

        const maxConfig = provider.max_reference_images;

        // Обратная совместимость для обычных чисел
        if (typeof maxConfig === 'number') {
            return maxConfig;
        }

        // Если это объект, парсим динамические правила
        if (typeof maxConfig === 'object' && maxConfig !== null) {
            const state = this.taskControl?.state;
            const dependField = maxConfig.depends_on;
            const currentSelectedValue = state?.formState?.[dependField];

            if (currentSelectedValue && maxConfig.values && maxConfig.values[currentSelectedValue] !== undefined) {
                return maxConfig.values[currentSelectedValue];
            }
            return maxConfig.default ?? 0;
        }

        return 0;
    }

    // Effective max refs: if mask occupies a referential slot and is active, subtract 1
    get effectiveMaxRefs() {
        const base = this.maxRefs;
        const provider = this.currentProvider;
        const state = this.taskControl?.state;

        // Only referential mask types consume a ref slot
        const maskType = provider?.mask_handling?.type || '';
        const maskUsesRefSlot = maskType.includes('referential');
        if (!maskUsesRefSlot) return base;

        // Determine if mask will actually be sent
        const maskSupported = provider.mask_handling.supported !== false;
        const maskRequired = provider.mask_handling.required === true;
        const hasMask = !!this.taskData?.maskImage;

        let effectivelyUseMask;
        if (!maskSupported) {
            effectivelyUseMask = false;
        } else if (maskRequired) {
            effectivelyUseMask = hasMask;
        } else {
            effectivelyUseMask = hasMask && (state?.useMask ?? true);
        }

        // Mask takes one slot — subtract from available user slots
        return effectivelyUseMask ? base - 1 : base;
    }


    get isPromptEmpty() {
        const state = this.taskControl?.state;
        if (!state || !state.selectedProviderId) return false;
        const prompt = state.formState?.prompt;
        return !prompt || !prompt.trim();
    }

    get isRefLimitExceeded() {
        const state = this.taskControl?.state;
        if (!state || !state.selectedProviderId) return false;
        const count = state.references?.length ?? 0;
        const max = this.effectiveMaxRefs;
        return (max > 0 && count > max) || (max === 0 && count > 0);
    }

    get isMaskMissing() {
        const state = this.taskControl?.state;
        const p = this.currentProvider;
        if (!state || !state.selectedProviderId || !p) return false;
        return !!(p.mask_handling?.required && !this.taskData?.maskImage);
    }

    // Returns the list of allowed aspect ratios for the current provider.
    // Supports: plain array, dynamic object with depends_on, or absent (= all allowed).
    get allowedAspectRatios() {
        const provider = this.currentProvider;
        if (!provider || provider.allowed_aspect_ratios === undefined) return ALL_ASPECT_RATIOS;

        const arConfig = provider.allowed_aspect_ratios;

        // Simple array
        if (Array.isArray(arConfig)) return arConfig;

        // Dynamic: depends on the value of another form field
        if (typeof arConfig === 'object' && arConfig.depends_on) {
            const state = this.taskControl?.state;
            const depVal = state?.formState?.[arConfig.depends_on];
            if (depVal && arConfig.values && arConfig.values[depVal] !== undefined) {
                return arConfig.values[depVal];
            }
            return arConfig.default ?? ALL_ASPECT_RATIOS;
        }

        return ALL_ASPECT_RATIOS;
    }


    connectedCallback() {
        this.classList.add('wh-source-tab');
        this._pasteHandler = this.handlePaste.bind(this);
        // Use capture phase (true) so this handler runs BEFORE the global document handler
        document.addEventListener('paste', this._pasteHandler, true);
        if (this.taskData) this.render();
    }

    disconnectedCallback() {
        if (this._touchCleanup) {
            this._touchCleanup();
            this._touchCleanup = null;
        }
        if (this._pasteHandler) {
            document.removeEventListener('paste', this._pasteHandler);
        }
    }

    handlePaste(e) {
        console.log("Paste event triggered!", e);
        if (!this.taskControl || !this.taskControl.state) {
            console.log("Missing taskControl or state");
            return;
        }

        // Важно: если контент вкладки скрыт (display: none), мы игнорируем вставку!
        if (this.taskControl.style.display === 'none') {
            console.log("Task control is hidden (display: none), ignoring paste");
            return;
        }

        const state = this.taskControl.state;

        // REMOVED: Restriction to allow pasting before provider selection
        /*
        if (!state.selectedProviderId) {
            console.log("No provider selected, cannot paste references");
            return;
        }
        */

        const clipboardData = e.clipboardData || window.clipboardData;
        if (!clipboardData || !clipboardData.items) {
            console.log("No clipboard data or items found");
            return;
        }

        console.log(`Found ${clipboardData.items.length} items in clipboard`);

        const items = clipboardData.items;
        const files = [];
        let hasImage = false;

        for (let i = 0; i < items.length; i++) {
            console.log(`Item [${i}] type:`, items[i].type);
            if (items[i].type.startsWith('image/')) {
                const file = items[i].getAsFile();
                if (file) {
                    files.push(file);
                    hasImage = true;
                    console.log("Successfully extracted image file:", file.name, file.size);
                } else {
                    console.log("Failed to get file from image item");
                }
            }
        }

        if (!hasImage) {
            console.log("No images found in clipboard items");
            return;
        }

        console.log("Preventing default paste (handling as reference) and passing to processFiles", files);
        e.preventDefault();
        e.stopPropagation(); // Stop propagation to prevent global handler from seeing it
        this.processFiles(files);
    }

    render() {
        const state = this.taskControl.state;
        const provider = this.currentProvider;
        const maxRefs = this.effectiveMaxRefs;

        // Compute effective aspect ratio for the current provider.
        // Raw user intent is stored in aliasState and is never modified here,
        // so switching back to a provider that supports the original value restores it.
        const rawAspectRatio = this.taskControl.app?.aliasState?.['aspect_ratio'] ?? '';
        const allowedRatios = this.allowedAspectRatios;
        let effectiveAspectRatio;
        // Empty allowedRatios = provider does not support ratio changes, force Match Input
        if (allowedRatios.length === 0 || rawAspectRatio === '') {
            effectiveAspectRatio = '';
        } else {
            effectiveAspectRatio = fixAspectRatio(rawAspectRatio, allowedRatios);
        }
        state.formState.aspect_ratio = effectiveAspectRatio;

        if (state.formState.force_separate_requests === undefined) {
            state.formState.force_separate_requests = this.taskControl.app?.aliasState?.['force_separate_requests'] || false;
        }

        this.innerHTML = `
            <div class="columns">
                <div class="column col-6 col-sm-12">
                    <div class="wh-view-controls d-flex ai-center mb-2" style="justify-content: space-between; align-items: center; min-height: 36px;">
                        ${(() => {
                let maskSupported = true;
                let maskRequired = false;

                if (provider && provider.mask_handling) {
                    maskSupported = provider.mask_handling.supported !== false;
                    maskRequired = provider.mask_handling.required === true;
                } else if (provider && !provider.mask_handling) {
                    maskSupported = false;
                }

                const showCb = provider && this.taskData.maskImage;

                let cbDisabled = '';
                let cbChecked = '';

                if (!maskSupported) {
                    cbDisabled = 'disabled';
                    cbChecked = '';
                } else if (maskRequired) {
                    cbDisabled = 'disabled';
                    cbChecked = 'checked';
                } else {
                    cbDisabled = '';
                    cbChecked = state.useMask ? 'checked' : '';
                }

                return `
                                <div class="wh-mask-toggle" style="visibility: ${showCb ? 'visible' : 'hidden'}">
                                    <label class="form-checkbox m-0" style="cursor: pointer; display: flex; align-items: center;">
                                        <input type="checkbox" id="use-mask-checkbox" ${cbChecked} ${cbDisabled}>
                                        <i class="form-icon"></i> <span class="text-tiny text-bold ml-1">Use Mask</span>
                                    </label>
                                </div>
                            `;
            })()}

                        ${(() => {
                let effectivelyUseMask = true;
                if (provider) {
                    const maskSupported = provider.mask_handling && provider.mask_handling.supported !== false;
                    const maskRequired = provider.mask_handling && provider.mask_handling.required === true;
                    if (!maskSupported) effectivelyUseMask = false;
                    else if (maskRequired) effectivelyUseMask = true;
                    else effectivelyUseMask = state.useMask;
                } else {
                    effectivelyUseMask = false;
                }

                // If mask is not used, hide the toggle buttons entirely or just the redundant ones.
                // User wants to remove Image and Mask buttons when checkbox is not checked.
                const hideToggles = !effectivelyUseMask || !this.taskData.maskImage;

                return `
                                <div class="btn-group" style="visibility: ${hideToggles ? 'hidden' : 'visible'}">
                                    <button class="btn btn-sm ${this._viewMode === 'source' ? 'active' : ''}" data-view="source">Image</button>
                                    <button class="btn btn-sm ${this._viewMode === 'mask' ? 'active' : ''}" data-view="mask" ${!this.taskData.maskImage ? 'disabled' : ''}>Mask</button>
                                    <button class="btn btn-sm ${this._viewMode === 'overlay' ? 'active' : ''}" data-view="overlay" ${!this.taskData.maskImage ? 'disabled' : ''}>Overlay</button>
                                </div>
                            `;
            })()}
                    </div>
                    <div class="wh-source-tab-preview rounded shadow-sm mb-4">
                        <div class="wh-image-container">
                            ${(() => {
                let maskSupported = true;
                let maskRequired = false;
                if (provider && provider.mask_handling) {
                    maskSupported = provider.mask_handling.supported !== false;
                    maskRequired = provider.mask_handling.required === true;
                } else if (provider && !provider.mask_handling) {
                    maskSupported = false;
                }

                const effectivelyUseMask = maskSupported && (maskRequired || state.useMask);
                const hideOverlay = (this._viewMode === 'source') || !effectivelyUseMask;

                return `
                                    <img src="${getPreviewUrl(this.taskData.sourceImage)}" class="wh-source-img" style="visibility: ${this._viewMode === 'mask' ? 'hidden' : 'visible'}; display: block; max-width: 100%;">
                                    ${this.taskData.maskImage ? `<img src="${this.taskData.maskImage}" class="wh-source-tab-overlay ${this._viewMode === 'overlay' ? 'overlay-mode' : 'mask-only'}" style="display: ${hideOverlay ? 'none' : 'block'};">` : ''}
                                `;
            })()}
                        </div>
                    </div>
                    <div class="wh-source-tab-references" id="drop-zone">
                        <div class="text-bold text-tiny mb-1 ${(state.selectedProviderId && ((maxRefs > 0 && state.references.length > maxRefs) || (maxRefs === 0 && state.references.length > 0))) ? 'text-error' : ''}">
                            Reference Images ${maxRefs > 0 ? `(${state.references.length}/${maxRefs})` : `(${state.references.length})`}
                        </div>
                        <div class="d-flex" style="gap: 0.5rem; flex-wrap: wrap;">
                            ${state.references.map((ref, i) => `<div class="wh-reference-item" draggable="true" data-ref-index="${i}"><div class="ref-index-label">@image${i + 1}</div><img src="${ref}" draggable="false"><button class="btn btn-clear btn-sm btn-remove" data-remove-ref="${i}"></button></div>`).join('')}
                            <label class="wh-reference-add-btn">
                                <i class="icon icon-plus"></i>
                                <input type="file" accept="image/*" multiple style="display: none;" id="ref-upload">
                            </label>
                            ${state.references.length === 0 ? `<div class="text-gray text-tiny mt-2" style="pointer-events: none;">Drag images here or click "+"</div>` : ''}
                        </div>
                    </div>
                </div>
                <div class="column col-6 col-sm-12">
                    <div class="form-group">
                        <label class="form-label">Model / Provider</label>
                        <select class="form-select wh-source-tab-provider" id="provider-select">
                            <option value="">Select a provider...</option>
                            ${this.providers.map(p => `<option value="${p.id}" ${state.selectedProviderId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
                        </select>
                    </div>
                    <div id="dynamic-params-container" class="wh-source-tab-settings border rounded bg-gray p-2 mb-2" style="max-height: 300px; overflow-y: auto; display: none;"></div>
                    <div class="form-group">
                        <label class="form-label">Prompt</label>
                        <textarea class="form-input wh-source-tab-prompt" id="prompt-input" rows="3" placeholder="Describe what you want...">${state.formState.prompt || ''}</textarea>
                    </div>
                    <div id="negative-prompt-container" class="form-group" style="display: none;">
                        <label class="form-label">Negative Prompt</label>
                        <textarea class="form-input" id="neg-prompt-input" rows="2" placeholder="Avoid...">${state.formState.negative_prompt || ''}</textarea>
                    </div>
                    <div id="tab-notification-container" style="min-height: 5px;">
                        <div id="persistent-prompt-warning" class="wh-source-toast-notification toast toast-warning p-1 mb-2 text-tiny" style="display: ${this.isPromptEmpty ? 'block' : 'none'}; ">
                            <i class="icon icon-message mr-1"></i>Prompt is empty.
                        </div>
                        <div id="persistent-ref-warning" class="wh-source-toast-notification toast toast-warning p-1 mb-2 text-tiny" style="display: ${this.isRefLimitExceeded ? 'block' : 'none'}; ">
                            <i class="icon icon-message mr-1"></i>Too many references (${state.references.length}/${maxRefs}). Server will only receive the first ${maxRefs}.
                        </div>
                        <div id="persistent-mask-error" class="wh-source-toast-notification toast toast-error p-1 mb-2 text-tiny" style="display: ${this.isMaskMissing ? 'block' : 'none'}; ">
                            <i class="icon icon-cross mr-1"></i>Provider requires a mask.
                        </div>
                    </div>
                    ${provider?.remarks ? `<div class="wh-provider-remarks p-2 mb-2 rounded bg-gray text-tiny">${provider.remarks}</div>` : ''}
                    <div class="columns" style="align-items: flex-end;">
                        <div class="column col-3">
                            <div class="form-group m-0">
                                <label class="form-label">Images</label>
                                <input type="number" class="form-input input-lg" id="num-images-input" value="${state.formState.num_images || 1}" min="1" max="10">
                            </div>
                        </div>
                        <div class="column col-5">
                            <div class="form-group m-0">
                                <label class="form-label">Aspect Ratio</label>
                                <select class="form-select input-lg" id="aspect-ratio-select" ${allowedRatios.length === 0 ? 'disabled' : ''}>
                                    <option value="" ${effectiveAspectRatio === '' ? 'selected' : ''}>Match Input</option>
                                    ${allowedRatios.map(r => `<option value="${r}" ${effectiveAspectRatio === r ? 'selected' : ''}>${r}</option>`).join('')}
                                </select>
                            </div>
                        </div>
                        <div class="column col-4">
                            <button class="btn btn-primary btn-lg btn-block wh-source-tab-generate" id="btn-generate" ${(!state.selectedProviderId || this.isMaskMissing) ? 'disabled' : ''}>
                                <i class="icon icon-check"></i> Generate
                            </button>
                        </div>
                    </div>
                    <div class="mt-2" id="separate-requests-container" style="display: ${(state.formState.num_images || 1) > 1 ? 'block' : 'none'}">
                        ${(() => {
                const provForceSingle = provider ? (provider.single_image_per_request === true) : false;
                const isChecked = provForceSingle || !!state.formState.force_separate_requests;
                const isDisabled = provForceSingle ? 'disabled' : '';

                return `
                                <label class="form-checkbox m-0 tooltip tooltip-top" data-tooltip="Generate single image per request" style="display:inline-flex; align-items:center;">
                                    <input type="checkbox" id="force-separate-req-cb" ${isChecked ? 'checked' : ''} ${isDisabled}>
                                    <i class="form-icon"></i> <span class="text-tiny ml-1">Each image in separate request</span>
                                </label>
                            `;
            })()}
                    </div>
                </div>
            </div>
        `;
        this.setupEventListeners();
        if (state.selectedProviderId) this.renderDynamicParams();
    }

    setupEventListeners() {
        if (this._touchCleanup) { this._touchCleanup(); this._touchCleanup = null; }
        const state = this.taskControl.state;
        this.querySelector('#provider-select').onchange = (e) => { state.selectedProviderId = e.target.value; this.render(); };
        this.querySelectorAll('[data-view]').forEach(btn => btn.onclick = () => { this._viewMode = btn.dataset.view; this.render(); });
        this.querySelector('#btn-generate').onclick = () => this.handleGenerate();

        const useMaskCb = this.querySelector('#use-mask-checkbox');
        if (useMaskCb) {
            useMaskCb.onchange = (e) => {
                state.useMask = e.target.checked;
                this.render();
            };
        }

        const forceReqCb = this.querySelector('#force-separate-req-cb');
        if (forceReqCb) {
            forceReqCb.onchange = (e) => {
                state.formState.force_separate_requests = e.target.checked;
                if (this.taskControl.app) {
                    this.taskControl.app.aliasState['force_separate_requests'] = e.target.checked;
                }
            };
        }

        // Aspect Ratio select: persist raw user intent to aliasState (survives provider switch)
        const arSelect = this.querySelector('#aspect-ratio-select');
        if (arSelect) {
            arSelect.onchange = (e) => {
                const val = e.target.value;
                state.formState.aspect_ratio = val;
                // Store raw intent — not fixed, so switching back restores the original choice
                if (this.taskControl.app) this.taskControl.app.aliasState['aspect_ratio'] = val;
            };
        }

        const dropZone = this.querySelector('#drop-zone');
        if (dropZone) {
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(n => dropZone.addEventListener(n, (e) => { e.preventDefault(); e.stopPropagation(); }));
            dropZone.ondragenter = dropZone.ondragover = () => dropZone.classList.add('drag-over');
            dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
            dropZone.ondrop = (e) => {
                dropZone.classList.remove('drag-over');
                // Skip internal reference reorder drags — those are handled by item-level drop handlers
                const internalData = e.dataTransfer.getData('text/plain');
                if (internalData && internalData.startsWith('ref:')) return;
                this.processFiles(e.dataTransfer.files);
            };
        }

        // --- Drag-to-sort reference items ---
        const refsContainer = this.querySelector('.wh-source-tab-references .d-flex');
        let dropInsertIdx = null; // Tracks the current computed insertion index

        const removeSeparator = () => {
            const sep = refsContainer && refsContainer.querySelector('.wh-ref-drop-separator');
            if (sep) sep.remove();
        };

        const showSeparator = (insertIdx) => {
            // Skip DOM update if index hasn't changed — prevents layout-reflow flicker
            if (insertIdx === dropInsertIdx) return;
            removeSeparator();
            const sep = document.createElement('div');
            sep.className = 'wh-ref-drop-separator';
            const items = [...refsContainer.querySelectorAll('.wh-reference-item')];
            const addBtn = refsContainer.querySelector('.wh-reference-add-btn');
            // Insert before the item at insertIdx, or before the add-btn if at the end
            if (insertIdx < items.length) {
                refsContainer.insertBefore(sep, items[insertIdx]);
            } else {
                refsContainer.insertBefore(sep, addBtn || null);
            }
            dropInsertIdx = insertIdx;
        };

        // Row-aware insertion index: find the item whose centroid is closest to the mouse,
        // then decide "before" or "after" by comparing mouseX to that item's horizontal center.
        const calcInsertionIdx = (mouseX, mouseY) => {
            const items = [...refsContainer.querySelectorAll('.wh-reference-item')];
            if (items.length === 0) return 0;
            let bestIdx = items.length;
            let bestDist = Infinity;
            for (let i = 0; i < items.length; i++) {
                const rect = items[i].getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const dist = Math.hypot(mouseX - cx, mouseY - cy);
                if (dist < bestDist) {
                    bestDist = dist;
                    // Insert before this item if cursor is left of its center, otherwise after
                    bestIdx = mouseX < cx ? i : i + 1;
                }
            }
            return bestIdx;
        };

        let touchDragFromIdx = null;  // Index of item being touch-dragged
        let nativeDragActive = false;  // True when browser's native drag is running (some Android browsers)
        let touchStartX = 0;           // Touch origin for movement threshold
        let touchStartY = 0;
        const TOUCH_MOVE_THRESHOLD = 8; // px — minimum movement to arm the sort

        this.querySelectorAll('.wh-reference-item').forEach(item => {
            const idx = parseInt(item.dataset.refIndex);

            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', `ref:${idx}`);
                e.dataTransfer.effectAllowed = 'move';
                e.stopPropagation(); // Prevent drop-zone from acting as file receiver
                nativeDragActive = true;
                item.classList.add('dragging');
            });

            item.addEventListener('dragend', () => {
                nativeDragActive = false;
                item.classList.remove('dragging');
                removeSeparator();
                dropInsertIdx = null;
            });

            // --- Touch support (mobile) ---
            item.addEventListener('touchstart', (e) => {
                // Allow touch on delete buttons to proceed normally
                if (e.target.closest('.btn-remove')) return;

                e.preventDefault();
                const touch = e.touches[0];
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
                touchDragFromIdx = idx;
            }, { passive: false });

            // Block the context menu that appears on long-press (image save dialog etc.)
            item.addEventListener('contextmenu', (e) => e.preventDefault());
        });

        // touchmove/touchend on document so they keep firing even as finger moves off the item
        const onTouchMove = (e) => {
            if (touchDragFromIdx === null || !refsContainer) return;
            const touch = e.touches[0];
            const moved = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY);
            if (moved < TOUCH_MOVE_THRESHOLD) return;
            e.preventDefault();

            // Mobile Highlighting and Auto-Open for Global Stage
            const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
            const globalStage = dropTarget && dropTarget.closest('wh-global-stage');
            // Reset all global stages highlights
            document.querySelectorAll('wh-global-stage .wh-global-stage-accordion').forEach(dz => dz.classList.remove('drag-over'));
            if (globalStage) {
                const accordion = globalStage.querySelector('.wh-global-stage-accordion');
                if (accordion) accordion.classList.add('drag-over');

                // Auto-open if hovering over header
                if (dropTarget.closest('.wh-global-stage-header') && !globalStage._open) {
                    globalStage._open = true;
                    globalStage.render();
                }
            }

            const containerRect = refsContainer.getBoundingClientRect();
            if (
                touch.clientX >= containerRect.left && touch.clientX <= containerRect.right &&
                touch.clientY >= containerRect.top && touch.clientY <= containerRect.bottom
            ) {
                const draggingEl = refsContainer.querySelector(`.wh-reference-item[data-ref-index="${touchDragFromIdx}"]`);
                if (draggingEl) draggingEl.classList.add('dragging');
                showSeparator(calcInsertionIdx(touch.clientX, touch.clientY));
            } else {
                removeSeparator();
                dropInsertIdx = null;
            }
        };

        const onTouchEnd = (e) => {
            if (touchDragFromIdx === null) return;
            const fromIdx = touchDragFromIdx;
            touchDragFromIdx = null;
            this.querySelectorAll('.wh-reference-item.dragging').forEach(el => el.classList.remove('dragging'));
            removeSeparator();

            // Clear global stage highlight
            document.querySelectorAll('wh-global-stage .wh-global-stage-accordion').forEach(dz => dz.classList.remove('drag-over'));

            if (nativeDragActive) { dropInsertIdx = null; return; }

            const touch = e.changedTouches[0];
            const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
            const globalStage = dropTarget && dropTarget.closest('wh-global-stage');
            if (globalStage) {
                const base64 = state.references[fromIdx];
                globalStage._images.push(base64);
                globalStage.render();
                dropInsertIdx = null;
                return;
            }

            let toIdx = dropInsertIdx;
            dropInsertIdx = null;
            if (toIdx === null || isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;
            if (toIdx > fromIdx) toIdx -= 1;
            const refs = state.references;
            const [moved] = refs.splice(fromIdx, 1);
            refs.splice(toIdx, 0, moved);
            this.render();
        };

        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
        this._touchCleanup = () => {
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onTouchEnd);
        };




        // Container handles dragover/drop so we can show a gap-style separator
        if (refsContainer) {
            refsContainer.ondragover = (e) => {
                const isDraggingRef = e.dataTransfer.types.includes('text/plain') || e.dataTransfer.types.includes('wh/ref-image');
                if (!isDraggingRef) return;
                e.preventDefault();
                e.stopPropagation();
                showSeparator(calcInsertionIdx(e.clientX, e.clientY));
            };

            refsContainer.ondragleave = (e) => {
                // Only remove separator if cursor truly left the container
                if (!refsContainer.contains(e.relatedTarget)) {
                    removeSeparator();
                    dropInsertIdx = null;
                }
            };

            refsContainer.ondrop = (e) => {
                e.preventDefault();
                // Always stop propagation: we handle both external files and internal reorder here.
                // Without this, external drops bubble to #drop-zone.ondrop and processFiles is called twice.
                e.stopPropagation();
                removeSeparator();
                const data = e.dataTransfer.getData('text/plain');
                // Check for wh/ref-image data (from Global Stage)
                const refImageData = e.dataTransfer.getData('wh/ref-image');
                if (refImageData) {
                    state.references.push(refImageData);
                    this.render();
                    return;
                }
                // External file drop — process files directly
                if (!data || !data.startsWith('ref:')) {
                    this.processFiles(e.dataTransfer.files);
                    return;
                }
                // Internal reference reorder
                const fromIdx = parseInt(data.replace('ref:', ''));

                let toIdx = dropInsertIdx !== null ? dropInsertIdx : calcInsertionIdx(e.clientX, e.clientY);
                dropInsertIdx = null;
                if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;
                // Account for the fact that removing fromIdx shifts subsequent indices
                if (toIdx > fromIdx) toIdx -= 1;
                const refs = state.references;
                const [moved] = refs.splice(fromIdx, 1);
                refs.splice(toIdx, 0, moved);
                this.render();
            };
        }



        // --- Drop reference item onto prompt textarea to insert @imageN ---
        const promptEl = this.querySelector('#prompt-input');
        if (promptEl) {
            promptEl.ondragover = (e) => {
                // Allow drop only for internal reference items
                if (e.dataTransfer.types.includes('text/plain')) e.preventDefault();
            };

            promptEl.ondrop = (e) => {
                const raw = e.dataTransfer.getData('text/plain');
                if (!raw || !raw.startsWith('ref:')) return;
                e.preventDefault();
                const idx = parseInt(raw.replace('ref:', ''));
                const tag = `@image${idx + 1}`;
                // Insert at current cursor position without overwriting any text
                const start = promptEl.selectionStart;
                const end = promptEl.selectionEnd;
                const current = promptEl.value;
                promptEl.value = current.substring(0, start) + tag + current.substring(end);
                // Restore cursor right after the inserted tag
                promptEl.selectionStart = promptEl.selectionEnd = start + tag.length;
                // Sync to state
                state.formState.prompt = promptEl.value;
            };
        }

        const refUpload = this.querySelector('#ref-upload');
        if (refUpload) refUpload.onchange = (e) => this.processFiles(e.target.files);
        this.querySelectorAll('[data-remove-ref]').forEach(btn => btn.onclick = () => { state.references.splice(parseInt(btn.dataset.removeRef), 1); this.render(); });

        this.ondragover = (e) => {
            const types = e.dataTransfer.types;
            const isFile = types && Array.from(types).includes('Files');
            const isRef = types && Array.from(types).includes('wh/ref-image');

            if (isFile || isRef) {
                e.preventDefault();
                e.stopPropagation();
                const dz = this.querySelector('#drop-zone');
                if (dz) dz.classList.add('drag-over');
            }
        };
        this.ondragleave = (e) => {
            if (!this.contains(e.relatedTarget)) {
                const dz = this.querySelector('#drop-zone');
                if (dz) dz.classList.remove('drag-over');
            }
        };
        this.ondrop = (e) => {
            const types = e.dataTransfer.types;
            const isFile = types && Array.from(types).includes('Files');
            const refData = e.dataTransfer.getData('wh/ref-image');

            if (isFile || refData) {
                e.preventDefault();
                e.stopPropagation();
                const dz = this.querySelector('#drop-zone');
                if (dz) dz.classList.remove('drag-over');

                if (isFile) {
                    this.processFiles(e.dataTransfer.files);
                } else if (refData) {
                    state.references.push(refData);
                    this.render();
                }
            }
        };

        this.oninput = (e) => {
            if (e.target.id === 'prompt-input') {
                state.formState.prompt = e.target.value;
                const warning = this.querySelector('#persistent-prompt-warning');
                if (warning) {
                    warning.style.display = this.isPromptEmpty ? 'block' : 'none';
                }
            }
            if (e.target.id === 'neg-prompt-input') state.formState.negative_prompt = e.target.value;
            if (e.target.id === 'num-images-input') {
                const val = parseInt(e.target.value) || 1;
                state.formState.num_images = val;
                const container = this.querySelector('#separate-requests-container');
                if (container) container.style.display = val > 1 ? 'block' : 'none';
            }
            if (e.target.dataset.paramName) {
                const name = e.target.dataset.paramName;
                const alias = e.target.dataset.alias;
                let val = e.target.type === 'checkbox' ? e.target.checked : (e.target.type === 'number' || e.target.type === 'range' ? parseFloat(e.target.value) : e.target.value);

                const stateKey = alias || name;
                state.formState[stateKey] = val;

                if (alias && this.taskControl.app) this.taskControl.app.aliasState[alias] = val;
                if (e.target.type === 'range') {
                    const d = this.querySelector(`#val-${name}`);
                    if (d) d.textContent = val;
                }

                // If the updated field controls the dynamic max reference limit, rebuild UI to update limits visually
                const provider = this.currentProvider;
                if (provider && typeof provider.max_reference_images === 'object' && provider.max_reference_images !== null) {
                    if (provider.max_reference_images.depends_on === stateKey || provider.max_reference_images.depends_on === name) {
                        this.render();
                    }
                }
            }
        };
    }

    async processFiles(fileList) {
        const files = Array.from(fileList);
        const state = this.taskControl.state;
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            const reader = new FileReader();
            reader.onload = (e) => {
                state.references.push(e.target.result);
                this.render();
            };
            reader.readAsDataURL(file);
        }
    }

    renderDynamicParams() {
        const container = this.querySelector('#dynamic-params-container');
        const state = this.taskControl.state;
        const provider = this.providers.find(p => p.id === state.selectedProviderId);
        if (!provider) return;
        this.querySelector('#negative-prompt-container').style.display = provider.supports_negative_prompt ? 'block' : 'none';
        let html = '';
        (provider.parameters || []).forEach(p => {
            if (['prompt', 'num_images'].includes(p.alias)) return;
            const stateKey = p.alias || p.name;
            let val = state.formState[stateKey];
            if (val === undefined && p.alias) {
                val = this.taskControl.app.aliasState[p.alias];
            }
            if (val === undefined) {
                let defVal = p.default;
                if (p.type === 'dropdown' && p.options) {
                    const opt = p.options.find(o => (typeof o === 'object' ? o.value : o) == defVal);
                    if (opt && typeof opt === 'object' && opt.alias) defVal = opt.alias;
                }
                val = defVal;
            }
            state.formState[stateKey] = val;

            if (p.alias === 'negative_prompt') {
                // Sync to existing DOM element if it exists and is empty
                const el = this.querySelector('#neg-prompt-input');
                if (el && !el.value && val) el.value = val;
                return;
            }
            html += `<div class="form-group">`;
            if (p.type !== 'boolean') {
                html += `<label class="form-label text-tiny text-bold">${p.label || p.name}</label>`;
            }
            const attrs = `data-param-name="${p.name}" data-alias="${p.alias || ''}"`;
            if (p.type === 'dropdown') {
                html += `<select class="form-select select-sm" ${attrs}>`;
                let selectedIndex = -1;
                let selectdValuedHidden = null;
                let genefatedOptions = [];
                p.options.forEach(opt => {
                    const optAlias = typeof opt === 'object' ? (opt.alias || opt.value) : opt;
                    const label = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                    const hidden = typeof opt === 'object' ? (opt.hidden || false) : false;

                    const isSelected = (val === optAlias);
                    if (isSelected && selectedIndex === -1) {
                        if (hidden)
                            selectdValuedHidden = (typeof opt === 'object' ? opt.value : opt);
                        else
                            selectedIndex = genefatedOptions.length;
                    }

                    if (!hidden) {
                        genefatedOptions.push({
                            value: optAlias,
                            label: label
                        });
                    }

                    if (isSelected) {
                        state.formState[stateKey] = optAlias;
                        if (p.alias && this.taskControl.app) {
                            this.taskControl.app.aliasState[p.alias] = optAlias;
                        }
                    }
                });
                if (selectedIndex === -1 && selectdValuedHidden) {
                    // Fallback: If the selected alias is hidden in the current provider, 
                    // find a visible option that shares the same underlying API value (e.g. "ultra" -> "2k" -> "high").
                    p.options.forEach(opt => {
                        if (selectedIndex !== -1) return;
                        const hidden = typeof opt === 'object' ? (opt.hidden || false) : false;
                        if (!hidden) {
                            const optVal = typeof opt === 'object' ? opt.value : opt;
                            if (optVal === selectdValuedHidden) {
                                const optAlias = typeof opt === 'object' ? (opt.alias || opt.value) : opt;
                                selectedIndex = genefatedOptions.findIndex(go => go.value === optAlias);
                            }
                        }
                    });
                }
                if (selectedIndex === -1) {
                    //covers possible erros in configeurtaion
                    p.options.forEach((opt, index) => {
                        const optVal = typeof opt === 'object' ? opt.value : opt;

                        const isSelected = (val === optVal);
                        if (isSelected && selectedIndex === -1) {
                            selectedIndex = index;
                        }
                    });
                }
                genefatedOptions.forEach((opt, index) => {
                    const isSelected = (index === selectedIndex);
                    html += `<option value="${opt.value}" ${isSelected ? 'selected' : ''}>${opt.label}</option>`;
                });
                html += `</select>`;
            } else if (p.type === 'slider') {
                html += `<div class="columns"><div class="column col-9"><input class="slider" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${val}" ${attrs}></div><div class="column col-3 text-right"><span id="val-${p.name}" class="text-tiny">${val}</span></div></div>`;
            } else if (p.type === 'boolean') {
                html += `<label class="form-checkbox" style="display: flex; align-items: center; cursor: pointer; padding-top: 0.2rem;"><input type="checkbox" ${val ? 'checked' : ''} ${attrs}><i class="form-icon"></i> <span class="text-tiny text-bold">${p.label || p.name}</span></label>`;
            } else {
                html += `<input type="${p.type === 'integer' || p.type === 'number' ? 'number' : 'text'}" class="form-input input-sm" value="${val}" ${attrs}>`;
            }
            html += `</div>`;
        });
        container.innerHTML = html;
        container.style.display = html ? 'block' : 'none';
    }

    showNotification(msg, type = 'primary') {
        return; // no needs currently

        const container = this.querySelector('#tab-notification-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `wh-source-toast-notification toast toast-${type} p-1 mb-2 text-tiny`;
        toast.innerHTML = `<button class="btn btn-clear float-right" onclick="this.parentElement.remove()"></button>${msg}`;
        container.appendChild(toast);
        setTimeout(() => { if (toast.parentElement) toast.remove(); }, 5000);
    }

    async handleGenerate() {
        const state = this.taskControl.state;
        if (!state.selectedProviderId) return; // Button should be disabled anyway

        const provider = this.currentProvider;

        // WARNING: Empty Prompt (Allow generation)
        if (this.isPromptEmpty) {
            this.showNotification('Prompt is empty. Generating anyway...', 'warning');
        }

        // WARNING: Too many reference images (Allow generation)
        if (this.isRefLimitExceeded) {
            this.showNotification(`Too many references (${state.references.length}/${this.effectiveMaxRefs}). Server will only receive the first ${this.effectiveMaxRefs}.`, 'warning');
        }

        let effectivelyUseMask = true;
        if (provider) {
            const maskSupported = provider.mask_handling && provider.mask_handling.supported !== false;
            const maskRequired = provider.mask_handling && provider.mask_handling.required === true;

            if (!maskSupported) {
                effectivelyUseMask = false;
            } else if (maskRequired) {
                effectivelyUseMask = true;
            } else {
                if (!this.taskData.maskImage) {
                    effectivelyUseMask = false;
                } else {
                    const maskCb = this.querySelector('#use-mask-checkbox');
                    effectivelyUseMask = maskCb ? maskCb.checked : state.useMask;
                }
            }

            // BLOCKING ERROR: Missing required mask
            if (this.isMaskMissing) {
                this.showNotification('Error: This provider strictly requires a mask, but this task has no mask.', 'error');
                return;
            }
        }

        const numImagesEl = this.querySelector('#num-images-input');
        const numImagesVal = numImagesEl ? parseInt(numImagesEl.value) : (state.formState.num_images || 1);

        const generatingIndex = this.taskControl.addGeneratingTab(false);
        try {
            const finalParams = {};
            provider.parameters.forEach(p => {
                let val;

                // Try to get value directly from the DOM
                const domElement = this.querySelector(`[data-param-name="${p.name}"]`);
                if (domElement) {
                    if (domElement.type === 'checkbox') {
                        val = domElement.checked;
                    } else if (domElement.type === 'number' || domElement.type === 'range') {
                        val = parseFloat(domElement.value);
                    } else {
                        val = domElement.value;
                    }
                } else {
                    // Fallback to specific standard inputs or state
                    if (p.alias === 'prompt') {
                        let el = this.querySelector('#prompt-input');
                        val = el ? el.value : state.formState.prompt;
                    } else if (p.alias === 'negative_prompt') {
                        let el = this.querySelector('#neg-prompt-input');
                        val = el ? el.value : state.formState.negative_prompt;
                    } else if (p.alias === 'num_images') {
                        val = numImagesVal;
                    } else {
                        const stateKey = p.alias || p.name;
                        val = state.formState[stateKey] !== undefined ? state.formState[stateKey] : p.default;
                    }
                }

                if (p.type === 'dropdown') {
                    const opt = p.options.find(o => (typeof o === 'object' ? (o.alias || o.value) : o) == val);
                    if (opt) val = typeof opt === 'object' ? opt.value : opt;
                }
                finalParams[p.name] = val;
            });

            const payload = {
                taskId: this.taskId,
                providerId: state.selectedProviderId,
                num_images: numImagesVal,
                aspect_ratio: state.formState.aspect_ratio,
                use_mask: effectivelyUseMask,
                params: finalParams,
                referenceImages: state.references.slice(0, this.effectiveMaxRefs),
                force_separate_requests: state.formState.force_separate_requests || false
            };

            this.taskControl.setGeneratingPayload(payload, generatingIndex);

            console.log('--- GENERATION DEBUG ---');
            console.log('Provider:', state.selectedProviderId);
            console.log('Final Payload:', payload);
            console.log('------------------------');

            // Skip actual generation for debug
            // this.showNotification('Debug: check console.', 'info');
            // return;

            const res = await fetch('/api/webhelper/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                const errorData = await res.json();
                throw new Error(errorData.error || 'Request failed');
            }
            this.taskControl.updateResultsFrom((await res.json()).results, generatingIndex);

        } catch (err) { this.taskControl.handleError(err.message, generatingIndex); }
    }
}

class WhResultTab extends HTMLElement {
    constructor() { super(); }
    connectedCallback() { this.classList.add('wh-result-tab'); this.render(); }
    render() {
        if (!this.resultData) return;
        if (this.resultData.status === 'generating') { this.innerHTML = `<div class="wh-loading"><div class="loading loading-lg"></div><p>Generating...</p></div>`; return; }
        const providerLabel = this.resultData.nice_name || this.resultData.providerId || 'Unknown';
        const headerTitle = this.resultData.params ? `${providerLabel} | Aspect: ${this.resultData.aspect_ratio || 'Match Input'}` : 'Generation Options';
        const paramsJson = this.resultData.params ? JSON.stringify(this.resultData.params, null, 2) : '';

        if (this.resultData.status === 'error') {
            this.innerHTML = `
                <div class="toast toast-error mb-2">
                    <h5>Error</h5>
                    <p>${this.resultData.error}</p>
                    ${this.resultData.fallback_url ? `
                        <div class="mt-2">
                            <a href="${this.resultData.fallback_url}" target="_blank" class="btn btn-sm btn-primary">
                                <i class="icon icon-download"></i> Download Manually
                            </a>
                        </div>
                    ` : ''}
                </div>
                ` + (this.resultData.params ? `
                <div class="wh-result-tab-params card p-2 mb-2 bg-secondary">
                    <div class="text-tiny text-uppercase text-bold mb-1">${headerTitle}</div>
                    <pre class="m-0 mb-2" style="font-size: 0.6rem; max-height: 100px; overflow: auto;">${paramsJson}</pre>
                </div>
                ` : '');
            return;
        }
        const imageUrl = this.resultData.image || '';
        const ext = imageUrl.split('.').pop() || 'png';
        const servePreviewUrl = !window.envInfo.isLocal;

        this.innerHTML = `
            <div class="wh-result-tab-content">
                <div class="wh-result-tab-params-wrapper mb-2" style="position: relative; z-index: 10;">
                    <div class="wh-result-tab-params card bg-secondary" id="params-dropdown-container" style="border-bottom-left-radius: 0; border-bottom-right-radius: 0;">
                        <!-- Header -->
                        <div class="text-tiny text-uppercase text-bold" id="params-header" style="cursor: pointer;">
                            ${headerTitle}
                        </div>
                        <!-- Dropdown Body -->
                        <div class="wh-params-dropdown card p-2 bg-secondary shadow" id="params-body" style="display: none; position: absolute; top: 100%; left: 0; right: 0; border-bottom-left-radius: 4px; border-bottom-right-radius: 4px; border-top: none; margin-top: -1px; z-index: 11;">
                            ${this.resultData.params ? `<pre class="m-0 mb-2" style="font-size: 0.6rem; max-height: 100px; overflow: auto;">${paramsJson}</pre>` : ''}
                            <div class="wh-result-tab-actions">
                                ${window.envInfo.isLocal ? `<button class="btn btn-primary" id="btn-copy"><i class="icon icon-copy"></i>${servePreviewUrl ? 'Copy Full Res' : 'Copy'}</button>` : ''}
                                <a href="${this.resultData.image}" download class="btn"><i class="icon icon-download"></i>${servePreviewUrl ? 'Download Full Res' : 'Download'}</a>
                                <button class="btn btn-link" id="btn-regenerate"><i class="icon icon-refresh"></i> Re-generate</button>
                                <button class="btn" id="btn-new-task"><i class="icon icon-share"></i> New Task</button>
                            </div>
                        </div>
                    </div>
                </div>
                <img src="${servePreviewUrl ? getPreviewUrl(this.resultData.image) : this.resultData.image}" class="wh-result-tab-image rounded shadow mb-2">
            </div>
        `;

        const container = this.querySelector('#params-dropdown-container');
        const header = this.querySelector('#params-header');
        const body = this.querySelector('#params-body');

        if (container && header && body) {
            let closeTimeout = null;
            let openTimeout = null;

            const openMenuDelayed = () => {
                if (closeTimeout) clearTimeout(closeTimeout);
                if (openTimeout) clearTimeout(openTimeout);

                openTimeout = setTimeout(() => {
                    body.style.display = 'block';
                }, 1000); // 1-second delay
            };

            const closeMenuDelayed = () => {
                if (openTimeout) clearTimeout(openTimeout); // Cancel opening if mouse left too early
                if (closeTimeout) clearTimeout(closeTimeout);

                closeTimeout = setTimeout(() => {
                    body.style.display = 'none';
                }, 1500);
            };

            const toggleMenuImmediate = () => {
                if (openTimeout) clearTimeout(openTimeout);
                if (closeTimeout) clearTimeout(closeTimeout);

                if (body.style.display === 'none') {
                    body.style.display = 'block';
                } else {
                    body.style.display = 'none';
                }
            };

            header.addEventListener('click', toggleMenuImmediate);
            container.addEventListener('mouseenter', openMenuDelayed);
            container.addEventListener('mouseleave', closeMenuDelayed);
        }

        const btnCopy = this.querySelector('#btn-copy');
        if (btnCopy) btnCopy.onclick = () => this.handleCopy();
        this.querySelector('#btn-regenerate').onclick = () => this.handleRegenerate();
        this.querySelector('#btn-new-task').onclick = () => this.handleNewTaskFromResult();
    }
    async handleCopy() {
        const btn = this.querySelector('#btn-copy');
        try {
            // Extract filename from the URL (e.g., "/api/webhelper/file/task_..._res_0.png")
            const imageUrl = this.resultData.image;
            const filename = imageUrl.split('/').pop();

            const res = await fetch('/api/webhelper/file/copy2clipboard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
            });

            if (res.ok) {
                btn.classList.add('btn-success');
                setTimeout(() => btn.classList.remove('btn-success'), 1000);
            } else {
                const err = await res.json();
                console.error('Copy failed:', err.error);
            }
        } catch (err) {
            console.error('Copy error:', err);
        }
    }
    handleRegenerate() {
        if (this.taskControl) {
            if (this.resultData.providerId) {
                this.taskControl.state.selectedProviderId = this.resultData.providerId;
            }
            const regenParams = { ...(this.resultData.params || {}) };
            if (this.resultData.num_images !== undefined) {
                regenParams.num_images = this.resultData.num_images;
            }
            if (this.resultData.aspect_ratio !== undefined) {
                regenParams.aspect_ratio = this.resultData.aspect_ratio;
            }
            this.taskControl.switchTab('source', regenParams);
        }
    }
    async handleNewTaskFromResult() {
        const btn = this.querySelector('#btn-new-task');
        btn.disabled = true;
        try {
            // Extract filename from the image URL (e.g. /api/webhelper/file/task_..._res_0.png)
            const filename = this.resultData.image.split('/').pop();
            const sourceTaskId = this.taskControl ? this.taskControl.taskId : null;

            const res = await fetch('/api/webhelper/task/from-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename,
                    sourceTaskId,
                    threadId: window.envInfo.threadId
                })
            });


            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to create task');
            }

            // Immediately poll to show the new task
            if (window.app) window.app.pollForTasks();

            btn.innerHTML = '<i class="icon icon-check"></i> Created!';

            btn.classList.add('btn-success');
            setTimeout(() => {
                btn.innerHTML = originalText;
                btn.classList.remove('btn-success');
                btn.disabled = false;
            }, 2000);
        } catch (err) {
            console.error('New task from result error:', err);
            btn.disabled = false;
            this.taskControl.handleError(err.message);
        }
    }
}

class WhGlobalStage extends HTMLElement {
    constructor() {
        super();
        this._images = []; // Array of base64 strings
        this._open = false; // Collapsed by default
    }

    connectedCallback() {
        this.classList.add('wh-global-stage');
        this.render();
    }

    render() {
        const imagesHtml = this._images.map((img, i) => `
            <div class="wh-glb-item" draggable="true" data-glb-index="${i}">
                <div class="wh-glb-index-label">@glb${i + 1}</div>
                <img src="${img}" draggable="false">
                <button class="btn btn-clear btn-sm wh-glb-remove" data-remove-glb="${i}"></button>
            </div>
        `).join('');

        this.innerHTML = `
            <div class="wh-global-stage-accordion">
                <div class="wh-global-stage-header">
                    <i class="icon ${this._open ? 'icon-arrow-down' : 'icon-arrow-right'} mr-1"></i>
                    <span class="text-bold text-tiny">Global Stage (${this._images.length})</span>
                </div>
                <div class="wh-global-stage-body" style="display: ${this._open ? 'block' : 'none'};">
                    <div class="d-flex wh-global-stage-grid" style="gap: 0.5rem; flex-wrap: wrap;">
                        ${imagesHtml}
                        <label class="wh-reference-add-btn">
                            <i class="icon icon-plus"></i>
                            <input type="file" accept="image/*" multiple style="display: none;" id="glb-ref-upload">
                        </label>
                        ${this._images.length === 0
                ? '<div class="text-gray text-tiny mt-2" style="pointer-events: none;">Drag images here or click "+"</div>'
                : `<div class="text-gray text-tiny mt-0" style="pointer-events: none; width: 100%;">Drag to use in WebHelper${window.envInfo.isLocal ? ', Alt+Drag to use externally' : ''}</div>`}
                    </div>
                </div>
            </div>
        `;
        this.setupEventListeners();
    }

    setupEventListeners() {
        if (this._touchCleanup) { this._touchCleanup(); this._touchCleanup = null; }

        // Header click — manual open/close toggle only (not affected by drag events)
        const header = this.querySelector('.wh-global-stage-header');
        if (header) {
            header.onclick = () => {
                this._open = !this._open;
                this.render();
            };

            // Auto-open on drag over
            header.ondragover = (e) => {
                const types = e.dataTransfer.types;
                const isFile = types && Array.from(types).includes('Files');
                const isRef = types && Array.from(types).includes('wh/ref-image');
                const isTaskRef = types && Array.from(types).includes('text/plain');

                if (isFile || isRef || isTaskRef) {
                    if (!this._open) {
                        this._open = true;
                        this.render();
                    }
                }
            };
        }

        // Entire component handles dragover/drop for highlighting and receiving images
        this.ondragover = (e) => {
            const types = e.dataTransfer.types;
            const isFile = types && Array.from(types).includes('Files');
            const isRef = types && Array.from(types).includes('wh/ref-image');
            const isTaskRef = types && Array.from(types).includes('text/plain');

            if (isFile || isRef || isTaskRef) {
                e.preventDefault();
                e.stopPropagation();
                const acc = this.querySelector('.wh-global-stage-accordion');
                if (acc) acc.classList.add('drag-over');
            }
        };

        this.ondragleave = (e) => {
            if (!this.contains(e.relatedTarget)) {
                const acc = this.querySelector('.wh-global-stage-accordion');
                if (acc) acc.classList.remove('drag-over');
            }
        };

        this.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const acc = this.querySelector('.wh-global-stage-accordion');
            if (acc) acc.classList.remove('drag-over');
            this.handleDrop(e);
        };

        // File input "+" button
        const fileInput = this.querySelector('#glb-ref-upload');
        if (fileInput) {
            fileInput.onchange = (e) => {
                this.processFiles(e.target.files);
                fileInput.value = '';
            };
        }

        // Delete buttons
        this.querySelectorAll('[data-remove-glb]').forEach(btn => {
            btn.onclick = () => {
                this._images.splice(parseInt(btn.dataset.removeGlb), 1);
                this.render();
            };
        });

        // Drag start on each stage item
        let touchDragFromIdx = null;
        let nativeDragActive = false;
        let touchStartX = 0;
        let touchStartY = 0;
        const TOUCH_MOVE_THRESHOLD = 8;

        this.querySelectorAll('.wh-glb-item').forEach(item => {
            const idx = parseInt(item.dataset.glbIndex);

            item.addEventListener('dragstart', (e) => {
                const base64 = this._images[idx];

                try {
                    if (window.WHConfig?.tryElectronDrag?.(e, base64)) {
                        e.preventDefault();
                        return;
                    }
                } catch (_) { }

                e.dataTransfer.setData('wh/ref-image', base64);
                e.dataTransfer.effectAllowed = 'copy';
                e.stopPropagation();
                nativeDragActive = true;
                item.classList.add('dragging');
                this._dragSourceIdx = idx;
            });

            item.addEventListener('dragend', () => {
                nativeDragActive = false;
                item.classList.remove('dragging');
                this._dragSourceIdx = null;
            });

            item.addEventListener('touchstart', (e) => {
                // Allow touch on delete buttons to proceed normally
                if (e.target.closest('.wh-glb-remove')) return;

                e.preventDefault();
                const touch = e.touches[0];
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
                touchDragFromIdx = idx;
            }, { passive: false });

            item.addEventListener('contextmenu', (e) => e.preventDefault());
        });

        const onTouchMove = (e) => {
            if (touchDragFromIdx === null) return;
            const touch = e.touches[0];
            const moved = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY);
            if (moved < TOUCH_MOVE_THRESHOLD) return;
            e.preventDefault();

            // Mobile Highlighting for Source Tab (Reference Images)
            const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
            const sourceTab = dropTarget && dropTarget.closest('wh-source-tab');
            // Reset all source tabs highlights
            document.querySelectorAll('wh-source-tab #drop-zone').forEach(dz => dz.classList.remove('drag-over'));
            if (sourceTab) {
                const dz = sourceTab.querySelector('#drop-zone');
                if (dz) dz.classList.add('drag-over');
            }

            const draggingEl = this.querySelector(`.wh-glb-item[data-glb-index="${touchDragFromIdx}"]`);
            if (draggingEl) draggingEl.classList.add('dragging');
        };

        const onTouchEnd = (e) => {
            if (touchDragFromIdx === null) return;
            const fromIdx = touchDragFromIdx;
            touchDragFromIdx = null;
            this.querySelectorAll('.wh-glb-item.dragging').forEach(el => el.classList.remove('dragging'));

            // Clear source tab highlight
            document.querySelectorAll('wh-source-tab #drop-zone').forEach(dz => dz.classList.remove('drag-over'));

            if (nativeDragActive) return;

            const touch = e.changedTouches[0];
            const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
            if (!dropTarget) return;

            const sourceTab = dropTarget.closest('wh-source-tab');
            if (sourceTab && sourceTab.taskControl) {
                const state = sourceTab.taskControl.state;
                const base64 = this._images[fromIdx];
                state.references.push(base64);
                sourceTab.render();
            }
        };

        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
        this._touchCleanup = () => {
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onTouchEnd);
        };
    }

    handleDrop(e) {
        // 1. Check for internal task reference (text/plain = "ref:N")
        const plainData = e.dataTransfer.getData('text/plain');
        if (plainData && plainData.startsWith('ref:')) {
            const idx = parseInt(plainData.replace('ref:', ''));
            // Look up the active task and grab its reference by index
            const app = window.app;
            if (app) {
                const activeTaskId = app.taskSelector?.value;
                const activeTaskEl = activeTaskId && app.taskElements.get(activeTaskId);
                if (activeTaskEl && activeTaskEl.state?.references?.[idx]) {
                    this._images.push(activeTaskEl.state.references[idx]);
                    this.render();
                }
            }
            return;
        }

        // 2. Check for wh/ref-image data — but ignore if drag came from this same Stage (self-drop)
        const refImageData = e.dataTransfer.getData('wh/ref-image');
        if (refImageData) {
            if (this._dragSourceIdx !== null) return; // Self-drop: ignore
            this._images.push(refImageData);
            this.render();
            return;
        }

        // 3. OS file drop
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            this.processFiles(e.dataTransfer.files);
        }
    }

    async processFiles(fileList) {
        const files = Array.from(fileList);
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            const reader = new FileReader();
            reader.onload = (ev) => {
                this._images.push(ev.target.result);
                this.render();
            };
            reader.readAsDataURL(file);
        }
    }
}

customElements.define('wh-task-control', WhTaskControl);
customElements.define('wh-source-tab', WhSourceTab);
customElements.define('wh-result-tab', WhResultTab);
customElements.define('wh-global-stage', WhGlobalStage);

document.addEventListener('DOMContentLoaded', () => { window.app = new WebHelperApp(); });
