/**
 * WebHelper v2 — compact SPA. Talks to the existing Helper API.
 * Classic UI remains at /webhelper.
 */

import * as api from './api.js';
import { bindStrip, tryElectronDrag } from './dnd.js';
import * as P from './providers.js';
import {
    COOKIE_COMBO,
    COOKIE_FAVS,
    TASK_COLORS,
    clipboardImageFiles,
    escapeHtml,
    filenameFromUrl,
    filesToDataUrls,
    fileToDataUrl,
    getPreviewUrl,
    readJsonCookie,
    resultImageUrl,
    shortTaskId,
    stageBgIndexFromColor,
    urlToDataUrl,
    writeJsonCookie
} from './util.js';

/** Viewer display options for error/pending generation slots. */
export const VIEWER_CONFIG = {
    includeErrors: false,
    includeGenerating: false
};

function isViewableResult(res, config = VIEWER_CONFIG) {
    if (!res) return false;
    if (res.status === 'error') return Boolean(config.includeErrors);
    if (res.status === 'generating') return Boolean(config.includeGenerating);
    return Boolean(res.image);
}

class App {
    constructor() {
        this.env = window.envInfo;
        this.providers = [];
        this.tasks = new Map();
        this.taskOrder = [];
        this.activeId = null;
        this.globalImages = [];
        this.aliasState = {};
        this.colorIndex = 0;
        this.favs = new Set(readJsonCookie(COOKIE_FAVS, []));
        this.combo = {
            query: '',
            tags: [],
            favOnly: false,
            sort: 'name',
            providerId: '',
            ...readJsonCookie(COOKIE_COMBO, {})
        };
        this.comboOpen = false;
        this.pollTimer = null;
        this.stripCleanups = [];
        this.appEl = document.getElementById('app');
        this.paneSource = document.getElementById('pane-source');
        this.paneResults = document.getElementById('pane-results');
        this.stageEl = document.getElementById('global-stage');
        this.stageStrip = document.getElementById('stage-strip');
        this.statusEl = document.getElementById('connection-status');
        this.taskSelect = document.getElementById('task-select');
        this.taskPick = document.getElementById('task-pick');
        this.taskDot = document.getElementById('task-dot');
        this.toastsEl = document.getElementById('toasts');
        this.fileTask = document.getElementById('file-task');
        this.fileRefs = document.getElementById('file-refs');
        this.fileStage = document.getElementById('file-stage');
        this.viewerState = {
            open: false,
            index: 0,
            scale: 'fit',
            isDragging: false,
            panX: 0,
            panY: 0,
            startX: 0,
            startY: 0,
            touchStartX: 0,
            touchStartY: 0,
            lastTap: 0,
            token: 0
        };
    }

    task() {
        return this.tasks.get(this.activeId) || null;
    }

    provider(task = this.task()) {
        if (!task) return null;
        return this.providers.find((p) => p.id === task.state.selectedProviderId) || null;
    }

    persistCombo() {
        writeJsonCookie(COOKIE_COMBO, this.combo);
    }

    persistFavs() {
        writeJsonCookie(COOKIE_FAVS, [...this.favs]);
    }

    toast(msg, type = 'error') {
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = msg;
        this.toastsEl.appendChild(el);
        setTimeout(() => el.remove(), 5000);
    }

    setConnection(ok, custom) {
        const text = custom || (ok ? 'Connected' : 'Disconnected');
        this.statusEl.textContent = text;
        this.statusEl.title = text;
        this.statusEl.classList.toggle('ok', ok);
        this.statusEl.classList.toggle('bad', !ok);
    }

    async init() {
        this.bindShell();
        try {
            const env = await api.loadEnvironmentInfo();
            this.env.isLocal = env.isLocal;
            this.env.isMobile = env.isMobile;
            this.env.threadId = env.threadId;
            window.envInfo = this.env;
        } catch (err) {
            console.error('Environment check failed', err);
        }
        try {
            const data = await api.loadProviders();
            this.providers = data.providers || [];
        } catch (err) {
            console.error(err);
            this.toast('Failed to load configuration. Check server connection.');
        }
        this.startPolling();
        this.render();
    }

    bindShell() {
        this.mountViewer();
        this.paneResults.addEventListener('click', (e) => this.onResultsClick(e));
        this.paneResults.addEventListener('dblclick', (e) => {
            const card = e.target.closest('[data-card]');
            if (card && e.target.closest('.card-stage')) {
                this.openViewer(parseInt(card.dataset.card, 10));
            }
        });
        document.addEventListener('keydown', (e) => this.onResultsKey(e));
        document.getElementById('btn-t2i').addEventListener('click', () => this.createTextTask());
        document.getElementById('btn-image').addEventListener('click', () => this.fileTask.click());
        this.fileTask.addEventListener('change', async (e) => {
            await this.processExternalFiles(e.target.files);
            this.fileTask.value = '';
        });
        this.fileRefs.addEventListener('change', async (e) => {
            await this.addRefsFromFiles(e.target.files);
            this.fileRefs.value = '';
        });
        this.fileStage.addEventListener('change', async (e) => {
            const urls = await filesToDataUrls(e.target.files);
            this.globalImages.push(...urls);
            this.fileStage.value = '';
            this.renderStage();
            this.bindDnd();
        });
        this.taskSelect.addEventListener('change', (e) => this.activate(e.target.value));

        document.body.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
        document.body.addEventListener('drop', (e) => {
            if (e.target.closest('#global-stage') || e.target.closest('#prompt-input')) return;
            // An open source pane owns the drop (refs). Empty source should create a task,
            // same as dropping on the results pane.
            if (e.target.closest('#pane-source') && this.task()) return;
            e.preventDefault();
            if (e.dataTransfer?.files?.length) this.processExternalFiles(e.dataTransfer.files);
        });

        document.addEventListener('paste', (e) => {
            const files = clipboardImageFiles(e.clipboardData);
            if (!files.length) return;
            if (this.tasks.size > 0) {
                e.preventDefault();
                e.stopPropagation();
                this.addRefsFromFiles(files);
            } else {
                this.processExternalFiles(files);
            }
        }, true);

        document.addEventListener('click', (e) => {
            if (this.comboOpen && !e.target.closest('.combo')) {
                this.comboOpen = false;
                this.renderSource();
                this.bindDnd();
            }
        });

        this.stageEl.addEventListener('dragover', (e) => {
            const types = [...(e.dataTransfer?.types || [])];
            if (types.includes('Files') || types.includes('wh/ref-image') || types.includes('text/plain')) {
                e.preventDefault();
                this.stageEl.classList.add('drag-over');
            }
        });
        this.stageEl.addEventListener('dragleave', (e) => {
            if (!this.stageEl.contains(e.relatedTarget)) this.stageEl.classList.remove('drag-over');
        });
        this.stageEl.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.stageEl.classList.remove('drag-over');
            this.handleStageDrop(e);
        });
    }

    startPolling() {
        if (!this.env.isLocal) {
            this.pollOnce();
            return;
        }
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => this.pollOnce(), 2000);
        this.pollOnce();
    }

    async pollOnce() {
        try {
            const data = await api.pollQueue(this.env.threadId);
            const ids = data.tasks || [];
            if (ids.length) await this.handleNewTasks(ids);
            this.setConnection(true, this.env.isLocal ? null : 'Remote Access');
        } catch (err) {
            this.setConnection(false);
            if (err.name !== 'AbortError') console.warn('Polling failed', err);
        }
    }

    async handleNewTasks(taskIds) {
        try {
            await api.markOpened(taskIds);
        } catch (err) {
            console.error('mark_opened failed', err);
        }
        for (const id of taskIds) {
            if (this.tasks.has(id)) continue;
            try {
                const data = await api.getTask(id);
                this.mountTask(id, data);
            } catch (err) {
                console.error(`Failed to load task ${id}`, err);
            }
        }
    }

    mountTask(id, data, activate = true) {
        const color = TASK_COLORS[this.colorIndex % TASK_COLORS.length];
        this.colorIndex += 1;
        const task = {
            id,
            data,
            color,
            createdAt: new Date(),
            state: {
                selectedProviderId: null,
                formState: { prompt: '', num_images: 1, aspect_ratio: '' },
                references: [],
                useMask: true,
                viewMode: 'overlay'
            },
            results: [],
            selectedResult: 0
        };
        const preferred = this.providers.find((p) => p.id === this.combo.providerId);
        if (preferred && P.providerSupportsMode(preferred, P.effectiveGenerationMode(task))) {
            task.state.selectedProviderId = preferred.id;
        }
        this.tasks.set(id, task);
        this.taskOrder.unshift(id);
        if (activate) this.activate(id);
        else this.render();
    }

    activate(id) {
        this.activeId = id;
        this.comboOpen = false;
        this.closeViewer();
        this.render();
    }

    async createTextTask() {
        try {
            await api.createTask({ threadId: this.env.threadId });
            await this.pollOnce();
        } catch (err) {
            this.toast('Error creating task: ' + err.message);
        }
    }

    async processExternalFiles(fileList) {
        const file = Array.from(fileList || []).find((f) => f.type && f.type.startsWith('image/'));
        if (!file) {
            this.toast('No image found in the selection or clipboard.');
            return;
        }
        try {
            const image = await fileToDataUrl(file);
            await api.createTask({ image, threadId: this.env.threadId });
            await this.pollOnce();
        } catch (err) {
            this.toast('Error creating task: ' + err.message);
        }
    }

    async addRefsFromFiles(fileList) {
        const task = this.task();
        if (!task) {
            await this.processExternalFiles(fileList);
            return;
        }
        const urls = await filesToDataUrls(fileList);
        if (!urls.length) return;
        task.state.references.push(...urls);
        this.renderSource();
        this.bindDnd();
    }

    async ensureSourceData(task) {
        if (!task?.data?.sourceImage) return null;
        if (task._sourceDataUrl) return task._sourceDataUrl;
        task._sourceDataUrl = await urlToDataUrl(task.data.sourceImage);
        return task._sourceDataUrl;
    }

    async handleStageDrop(e) {
        const plain = e.dataTransfer.getData('text/plain');
        const refImage = e.dataTransfer.getData('wh/ref-image');
        if (plain && plain.startsWith('ref:')) {
            const idx = parseInt(plain.slice(4), 10);
            const task = this.task();
            if (task?.state.references[idx]) {
                this.globalImages.push(task.state.references[idx]);
                this.renderStage();
                this.bindDnd();
            }
            return;
        }
        if (plain && plain.startsWith('src:')) {
            const task = this.tasks.get(plain.slice(4)) || this.task();
            try {
                const data = await this.ensureSourceData(task);
                if (data) {
                    this.globalImages.push(data);
                    this.renderStage();
                    this.bindDnd();
                }
            } catch (err) {
                this.toast('Could not add source to Stage');
            }
            return;
        }
        if (refImage) {
            this.globalImages.push(refImage);
            this.renderStage();
            this.bindDnd();
            return;
        }
        if (e.dataTransfer.files?.length) {
            const urls = await filesToDataUrls(e.dataTransfer.files);
            this.globalImages.push(...urls);
            this.renderStage();
            this.bindDnd();
        }
    }

    render() {
        const task = this.task();
        const hasResults = Boolean(task && task.results.length);
        this.appEl.classList.toggle('no-results', !hasResults);
        this.renderTopbar();
        this.renderStage();
        this.renderSource();
        this.renderResults();
        this.bindDnd();
    }

    renderTopbar() {
        if (!this.taskOrder.length) {
            this.taskPick.classList.add('hidden');
            this.taskSelect.innerHTML = '';
            return;
        }
        this.taskPick.classList.remove('hidden');
        this.taskSelect.innerHTML = this.taskOrder.map((id) => {
            const t = this.tasks.get(id);
            const t2i = t?.data?.sourceImage ? '' : '[T2I] ';
            const time = t?.createdAt ? t.createdAt.toLocaleTimeString() : '';
            return `<option value="${escapeHtml(id)}" ${id === this.activeId ? 'selected' : ''} style="color:${t.color}">${t2i}[Task ${escapeHtml(shortTaskId(id))}] @ ${escapeHtml(time)}</option>`;
        }).join('');
        const color = this.task()?.color || '#333';
        this.taskDot.style.background = color;
        this.taskSelect.style.color = color;
        this.appEl.style.borderTop = `3px solid ${color}`;
    }

    renderStage() {
        const localHint = this.env.isLocal ? ', Alt+Drag out' : '';
        const items = this.globalImages.map((img, i) => `
            <div class="thumb" draggable="true" data-index="${i}">
                <div class="thumb-badge">@glb${i + 1}</div>
                <img src="${img}" alt="" draggable="false">
                <button class="thumb-remove" type="button" data-remove-glb="${i}" aria-label="Remove">×</button>
            </div>
        `).join('');
        this.stageStrip.innerHTML = `
            ${items}
            <label class="thumb-add" title="Add to dump">+
                <input type="file" accept="image/*" multiple data-stage-upload>
            </label>
            ${this.globalImages.length === 0
                ? `<span class="stage-hint">Drop images here</span>`
                : `<span class="stage-hint">Drag into a task${escapeHtml(localHint)}</span>`}
        `;
        this.stageStrip.querySelectorAll('[data-remove-glb]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.globalImages.splice(parseInt(btn.dataset.removeGlb, 10), 1);
                this.renderStage();
                this.bindDnd();
            });
        });
        const upload = this.stageStrip.querySelector('[data-stage-upload]');
        if (upload) {
            upload.addEventListener('change', async (e) => {
                const urls = await filesToDataUrls(e.target.files);
                this.globalImages.push(...urls);
                this.renderStage();
                this.bindDnd();
            });
        }
    }

    filteredProviders(task) {
        const mode = task ? P.effectiveGenerationMode(task) : 't2i';
        let list = this.providers.slice();
        const q = String(this.combo.query || '').trim().toLowerCase();
        const tags = this.combo.tags || [];
        if (this.combo.favOnly) list = list.filter((p) => this.favs.has(p.id));
        if (q) {
            list = list.filter((p) => (`${p.name} ${p.id} ${P.providerTags(p).join(' ')}`).toLowerCase().includes(q));
        }
        if (tags.length) {
            list = list.filter((p) => tags.every((t) => P.providerTags(p).includes(t)));
        }
        const favRank = (p) => (this.favs.has(p.id) ? 0 : 1);
        if (this.combo.sort === 'tag') {
            list.sort((a, b) => favRank(a) - favRank(b)
                || (P.providerTags(a)[0] || '').localeCompare(P.providerTags(b)[0] || '')
                || a.name.localeCompare(b.name));
        } else {
            list.sort((a, b) => favRank(a) - favRank(b) || a.name.localeCompare(b.name));
        }
        return list.map((p) => ({ p, available: !task || P.providerSupportsMode(p, mode) }));
    }

    renderCombo(task, provider) {
        const selected = provider;
        const label = selected ? selected.name : 'Select a provider…';
        const starred = selected && this.favs.has(selected.id);
        const tags = P.allProviderTags(this.providers);
        const rows = this.filteredProviders(task);
        const tagChips = tags.map((t) => {
            const on = (this.combo.tags || []).includes(t);
            return `<button type="button" class="tag ${on ? 'on' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
        }).join('');
        const items = rows.map(({ p, available }) => {
            const isOn = task.state.selectedProviderId === p.id;
            const fav = this.favs.has(p.id);
            const pTags = P.providerTags(p).join(' · ');
            const suffix = available ? '' : ` · unavailable for ${P.effectiveGenerationMode(task).toUpperCase()}`;
            return `<li class="combo-item ${isOn ? 'is-on' : ''} ${available ? '' : 'is-off'}" data-provider="${escapeHtml(p.id)}" data-available="${available ? '1' : '0'}">
                <button type="button" class="star-btn ${fav ? 'on' : ''}" data-star="${escapeHtml(p.id)}" aria-label="Favorite">★</button>
                <div class="meta">
                    <div class="title">${escapeHtml(p.name)}</div>
                    <div class="sub">${escapeHtml(pTags)}${escapeHtml(suffix)}</div>
                </div>
            </li>`;
        }).join('') || `<li class="combo-item"><div class="meta"><div class="sub">No models match.</div></div></li>`;

        return `
            <div class="combo ${this.comboOpen ? 'open' : ''}" id="provider-combo">
                <button type="button" class="combo-trigger" id="combo-trigger">
                    <span class="name">${escapeHtml(label)}</span>
                    ${starred ? '<span class="star">★</span>' : ''}
                </button>
                <div class="combo-panel">
                    <div class="combo-tools">
                        <input type="search" id="combo-query" placeholder="Filter…" value="${escapeHtml(this.combo.query || '')}">
                        <label class="check"><input type="checkbox" id="combo-favs" ${this.combo.favOnly ? 'checked' : ''}> Fav</label>
                        <select id="combo-sort" class="select" style="height:28px;padding:0 4px;">
                            <option value="name" ${this.combo.sort === 'name' ? 'selected' : ''}>Name</option>
                            <option value="tag" ${this.combo.sort === 'tag' ? 'selected' : ''}>Tag</option>
                        </select>
                    </div>
                    <div class="combo-tags">${tagChips}</div>
                    <ul class="combo-list">${items}</ul>
                </div>
            </div>
        `;
    }

    renderDynamicParams(task, provider) {
        if (!provider) return '';
        let html = '';
        for (const p of provider.parameters || []) {
            if (p.alias === 'prompt' || p.alias === 'num_images') continue;
            const val = P.resolveParamDefault(p, this.aliasState, task.state.formState);
            task.state.formState[P.paramStateKey(p)] = val;
            if (p.alias === 'negative_prompt') continue;
            const attrs = `data-param-name="${escapeHtml(p.name)}" data-alias="${escapeHtml(p.alias || '')}"`;
            html += `<div class="field">`;
            if (p.type !== 'boolean') {
                html += `<label>${escapeHtml(p.label || p.name)}</label>`;
            }
            if (p.type === 'dropdown') {
                const vis = P.visibleDropdownOptions(p, val);
                html += `<select ${attrs}>`;
                vis.options.forEach((opt, i) => {
                    html += `<option value="${escapeHtml(opt.value)}" ${i === vis.selectedIndex ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`;
                });
                html += `</select>`;
            } else if (p.type === 'slider') {
                html += `<div class="slider-row"><input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${val}" ${attrs}><span data-val="${escapeHtml(p.name)}">${escapeHtml(val)}</span></div>`;
            } else if (p.type === 'boolean') {
                html += `<label class="check"><input type="checkbox" ${val ? 'checked' : ''} ${attrs}> ${escapeHtml(p.label || p.name)}</label>`;
            } else {
                const type = (p.type === 'integer' || p.type === 'number') ? 'number' : 'text';
                html += `<input type="${type}" value="${escapeHtml(val ?? '')}" ${attrs}>`;
            }
            html += `</div>`;
        }
        return html;
    }

    renderSource() {
        const task = this.task();
        if (!task) {
            this.paneSource.innerHTML = `
                <div class="empty-board">
                    <h2>No task yet</h2>
                    <p>Waiting for Photoshop, or drop an image here.</p>
                    <div class="empty-actions">
                        <button class="btn btn-primary" type="button" data-act="t2i">New T2I</button>
                        <button class="btn" type="button" data-act="image">Select image</button>
                    </div>
                </div>`;
            this.paneSource.querySelector('[data-act="t2i"]').onclick = () => this.createTextTask();
            this.paneSource.querySelector('[data-act="image"]').onclick = () => this.fileTask.click();
            this.paneSource.ondragover = (e) => {
                if ([...(e.dataTransfer?.types || [])].includes('Files')) {
                    e.preventDefault();
                    this.paneSource.classList.add('drag-over');
                }
            };
            this.paneSource.ondragleave = (e) => {
                if (!this.paneSource.contains(e.relatedTarget)) this.paneSource.classList.remove('drag-over');
            };
            this.paneSource.ondrop = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.paneSource.classList.remove('drag-over');
                if (e.dataTransfer?.files?.length) this.processExternalFiles(e.dataTransfer.files);
            };
            return;
        }

        const provider = this.provider(task);
        P.seedForceSeparate(task, this.aliasState);
        const mode = P.effectiveGenerationMode(task);
        const ar = P.resolveAspectRatio(task, provider, this.aliasState);
        const mask = P.maskCheckboxState(provider, task);
        const maxRefs = P.effectiveMaxRefs(provider, task);
        const refs = task.state.references || [];
        const overRefs = P.isRefLimitExceeded(provider, task);
        const hasSource = Boolean(task.data?.sourceImage);
        const hideToggles = !mask.use || !task.data?.maskImage;
        const hideOverlay = task.state.viewMode === 'source' || !mask.use;

        const preview = hasSource ? `
            <div class="preview-wrap ${this.sourceBgClass(task)}" id="source-preview">
                <div class="preview-inner">
                    <img class="source" id="source-img" draggable="true"
                        src="${getPreviewUrl(task.data.sourceImage)}"
                        style="visibility:${task.state.viewMode === 'mask' ? 'hidden' : 'visible'}">
                    ${task.data.maskImage ? `<img class="mask ${task.state.viewMode === 'overlay' ? 'overlay-mode' : ''}" src="${task.data.maskImage}" style="display:${hideOverlay ? 'none' : 'block'}">` : ''}
                </div>
            </div>` : '';

        const modeUnsupported = Boolean(provider) && !P.providerSupportsMode(provider, mode);
        const notes = [
            { id: 'note-prompt-empty', t: 'Prompt is empty.', error: false, hide: !P.isPromptEmpty(task) },
            { id: 'note-ref-limit', t: `Too many references (${refs.length}/${maxRefs}). Server will only receive the first ${maxRefs}.`, error: false, hide: !overRefs },
            { id: 'note-mask', t: 'Provider requires a mask.', error: true, hide: !P.isMaskMissing(provider, task) },
            { id: 'note-mode', t: `Provider does not support ${mode.toUpperCase()} generation.`, error: true, hide: !modeUnsupported },
            { id: 'note-ar', t: 'Aspect ratio is required for Text-to-Image generation.', error: true, hide: !P.isAspectRatioMissing(task) }
        ];

        const forceSingle = provider ? provider.single_image_per_request === true : false;
        const separateOn = forceSingle || !!task.state.formState.force_separate_requests;
        const numImages = task.state.formState.num_images || 1;
        const blocked = P.isGenerateBlocked(provider, task);
        const paramsHtml = this.renderDynamicParams(task, provider);

        this.paneSource.innerHTML = `
            <div class="source-scroll">
                <div class="row-tools" style="${hasSource ? '' : 'display:none'}">
                    <label class="check" style="visibility:${mask.show ? 'visible' : 'hidden'}">
                        <input type="checkbox" id="use-mask" ${mask.checked ? 'checked' : ''} ${mask.disabled ? 'disabled' : ''}> Use mask
                    </label>
                    <div class="seg" style="visibility:${hideToggles ? 'hidden' : 'visible'}">
                        <button type="button" data-view="source" class="${task.state.viewMode === 'source' ? 'active' : ''}">Image</button>
                        <button type="button" data-view="mask" class="${task.state.viewMode === 'mask' ? 'active' : ''}" ${task.data.maskImage ? '' : 'disabled'}>Mask</button>
                        <button type="button" data-view="overlay" class="${task.state.viewMode === 'overlay' ? 'active' : ''}" ${task.data.maskImage ? '' : 'disabled'}>Overlay</button>
                    </div>
                </div>
                ${preview}
                <div class="thumbs-box" id="ref-box" data-drop-target="refs">
                    <div class="thumbs-head ${overRefs ? 'is-over' : ''}">
                        <span id="refs-head">Refs ${maxRefs > 0 ? `(${refs.length}/${maxRefs})` : `(${refs.length})`}</span>
                        <span class="mode-chip" id="refs-mode">${mode === 'i2i' ? 'I2I' : 'T2I'}</span>
                    </div>
                    <p class="refs-hint" id="refs-hint"${hasSource ? ' hidden' : ''}>${escapeHtml(this.refsHintText(task))}</p>
                    <div class="thumb-strip" id="ref-strip">
                        ${refs.map((ref, i) => `
                            <div class="thumb" draggable="true" data-index="${i}">
                                <div class="thumb-badge">@image${i + 1}</div>
                                <img src="${ref}" alt="">
                                <button class="thumb-remove" type="button" data-remove-ref="${i}">×</button>
                            </div>`).join('')}
                        <label class="thumb-add">+<input type="file" accept="image/*" multiple id="ref-upload"></label>
                    </div>
                </div>
                <div class="field">
                    <label>Model</label>
                    ${this.renderCombo(task, provider)}
                </div>
                <div class="params ${paramsHtml ? '' : 'is-empty'}" id="dynamic-params">${paramsHtml}</div>
                <div class="field">
                    <label>Prompt</label>
                    <textarea id="prompt-input" rows="3" placeholder="Describe what you want…">${escapeHtml(task.state.formState.prompt || '')}</textarea>
                </div>
                <div class="field" id="neg-wrap" style="display:${provider?.supports_negative_prompt ? 'block' : 'none'}">
                    <label>Negative prompt</label>
                    <textarea id="neg-prompt-input" rows="2" placeholder="Avoid…">${escapeHtml(task.state.formState.negative_prompt || '')}</textarea>
                </div>
                <div class="notes" id="notes">${notes.map((n) => `<div class="note ${n.error ? 'error' : ''}"${n.id ? ` id="${n.id}"` : ''}${n.hide ? ' hidden' : ''}>${escapeHtml(n.t)}</div>`).join('')}</div>
                ${provider?.remarks ? `<div class="remarks">${provider.remarks}</div>` : ''}
            </div>
            <div class="generate-bar">
                <div class="field">
                    <!-- <label>Aspect</label> -->
                    <select id="aspect-ratio-select" ${ar.allowed.length === 0 ? 'disabled' : ''}>
                        ${ar.isT2I ? '' : `<option value="" ${ar.effective === '' ? 'selected' : ''}>Match Input</option>`}
                        ${ar.allowed.map((r) => `<option value="${escapeHtml(r)}" ${ar.effective === r ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
                    </select>
                </div>
                <div class="gen-cluster ${numImages > 1 ? 'is-multi' : ''}" id="gen-cluster">
                    <div class="gen-run">
                        <input type="number" id="num-images-input" class="gen-count" min="1" max="10"
                            value="${escapeHtml(numImages)}" title="Images to generate" aria-label="Number of images">
                        <button class="btn btn-primary" id="btn-generate" ${blocked ? 'disabled' : ''}>${numImages > 1 ? `Generate ×${escapeHtml(numImages)}` : 'Generate'}</button>
                    </div>
                    <label class="check gen-split" id="force-separate-row" ${numImages > 1 ? '' : 'hidden'}>
                        <input type="checkbox" id="force-separate" ${separateOn ? 'checked' : ''} ${forceSingle ? 'disabled' : ''}>
                        Each image in a separate request
                    </label>
                </div>
            </div>
        `;
        this.bindSourceEvents(task);
    }

    syncSourceWarnings(task) {
        const provider = this.provider(task);
        const mode = P.effectiveGenerationMode(task);
        const maxRefs = P.effectiveMaxRefs(provider, task);
        const count = task.state.references?.length ?? 0;
        const overRefs = P.isRefLimitExceeded(provider, task);
        const modeUnsupported = Boolean(provider) && !P.providerSupportsMode(provider, mode);

        const setNote = (id, hide, text) => {
            const el = this.paneSource.querySelector(`#${id}`);
            if (!el) return;
            el.hidden = hide;
            if (text != null) el.textContent = text;
        };
        setNote('note-prompt-empty', !P.isPromptEmpty(task));
        setNote(
            'note-ref-limit',
            !overRefs,
            `Too many references (${count}/${maxRefs}). Server will only receive the first ${maxRefs}.`
        );
        setNote('note-mask', !P.isMaskMissing(provider, task));
        setNote(
            'note-mode',
            !modeUnsupported,
            `Provider does not support ${mode.toUpperCase()} generation.`
        );
        setNote('note-ar', !P.isAspectRatioMissing(task));

        const gen = this.paneSource.querySelector('#btn-generate');
        if (gen) gen.disabled = P.isGenerateBlocked(provider, task);
        this.syncGenerateCluster(task);

        const head = this.paneSource.querySelector('#refs-head');
        const headWrap = this.paneSource.querySelector('.thumbs-head');
        if (head) {
            if (headWrap) headWrap.classList.toggle('is-over', overRefs);
            head.textContent = maxRefs > 0 ? `Refs (${count}/${maxRefs})` : `Refs (${count})`;
        }
        const chip = this.paneSource.querySelector('#refs-mode');
        if (chip) chip.textContent = mode === 'i2i' ? 'I2I' : 'T2I';
        const hint = this.paneSource.querySelector('#refs-hint');
        if (hint) {
            const text = this.refsHintText(task);
            hint.hidden = !text;
            if (text) hint.textContent = text;
        }
    }

    refsHintText(task) {
        if (task.data?.sourceImage) return '';
        const n = task.state.references?.length ?? 0;
        if (n === 0) return 'Add one ref to switch this task to image-to-image.';
        return 'Image-to-image — the first ref is the source.';
    }

    syncGenerateCluster(task) {
        const n = Math.min(10, Math.max(1, task.state.formState.num_images || 1));
        const cluster = this.paneSource.querySelector('#gen-cluster');
        if (cluster) cluster.classList.toggle('is-multi', n > 1);
        const btn = this.paneSource.querySelector('#btn-generate');
        if (btn) {
            const blocked = btn.disabled;
            btn.textContent = n > 1 ? `Generate ×${n}` : 'Generate';
            btn.disabled = blocked;
        }
        const splitRow = this.paneSource.querySelector('#force-separate-row');
        if (splitRow) splitRow.hidden = n <= 1;
        const num = this.paneSource.querySelector('#num-images-input');
        if (num && Number(num.value) !== n) num.value = n;
    }

    bindSourceEvents(task) {
        this.paneSource.querySelectorAll('[data-view]').forEach((btn) => {
            btn.onclick = () => {
                task.state.viewMode = btn.dataset.view;
                this.renderSource();
                this.bindDnd();
            };
        });
        const maskCb = this.paneSource.querySelector('#use-mask');
        if (maskCb) {
            maskCb.onchange = () => {
                task.state.useMask = maskCb.checked;
                this.renderSource();
                this.bindDnd();
            };
        }
        const prompt = this.paneSource.querySelector('#prompt-input');
        if (prompt) {
            prompt.oninput = () => {
                task.state.formState.prompt = prompt.value;
                this.syncSourceWarnings(task);
            };
        }
        const neg = this.paneSource.querySelector('#neg-prompt-input');
        if (neg) {
            neg.oninput = () => { task.state.formState.negative_prompt = neg.value; };
        }
        const num = this.paneSource.querySelector('#num-images-input');
        if (num) {
            num.oninput = () => {
                let n = parseInt(num.value, 10) || 1;
                if (n < 1) n = 1;
                if (n > 10) n = 10;
                task.state.formState.num_images = n;
                this.syncGenerateCluster(task);
            };
        }
        const arSel = this.paneSource.querySelector('#aspect-ratio-select');
        if (arSel) {
            arSel.onchange = () => {
                task.state.formState.aspect_ratio = arSel.value;
                this.aliasState.aspect_ratio = arSel.value;
                this.syncSourceWarnings(task);
            };
        }
        const sep = this.paneSource.querySelector('#force-separate');
        if (sep) {
            sep.onchange = () => {
                task.state.formState.force_separate_requests = sep.checked;
                this.aliasState.force_separate_requests = sep.checked;
            };
        }
        const gen = this.paneSource.querySelector('#btn-generate');
        if (gen) gen.onclick = () => this.handleGenerate();

        this.paneSource.querySelectorAll('[data-remove-ref]').forEach((btn) => {
            btn.onclick = () => {
                task.state.references.splice(parseInt(btn.dataset.removeRef, 10), 1);
                this.renderSource();
                this.bindDnd();
            };
        });
        const refUpload = this.paneSource.querySelector('#ref-upload');
        if (refUpload) {
            refUpload.onchange = (e) => this.addRefsFromFiles(e.target.files);
        }

        this.paneSource.oninput = (e) => {
            const t = e.target;
            if (!t.dataset?.paramName) return;
            const alias = t.dataset.alias;
            let val = t.type === 'checkbox' ? t.checked : (t.type === 'number' || t.type === 'range' ? parseFloat(t.value) : t.value);
            P.applyParamValue(task, this.aliasState, t.dataset.paramName, alias || '', val);
            if (t.type === 'range') {
                const lab = this.paneSource.querySelector(`[data-val="${t.dataset.paramName}"]`);
                if (lab) lab.textContent = val;
            }
            const provider = this.provider(task);
            const hitsDepends = (config) => config && typeof config === 'object'
                && (config.depends_on === alias || config.depends_on === t.dataset.paramName);
            if (hitsDepends(provider?.max_reference_images) || hitsDepends(provider?.allowed_aspect_ratios)) {
                this.renderSource();
                this.bindDnd();
                return;
            }
            this.syncSourceWarnings(task);
        };

        const srcImg = this.paneSource.querySelector('#source-img');
        if (srcImg) {
            srcImg.addEventListener('mousedown', () => { this.ensureSourceData(task).catch(() => { }); });
            srcImg.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', `src:${task.id}`);
                e.dataTransfer.effectAllowed = 'copy';
                if (this.env.isLocal && e.altKey && task._sourceDataUrl) {
                    if (tryElectronDrag(e, task._sourceDataUrl)) {
                        e.preventDefault();
                    }
                }
            });
        }

        this.bindCombo(task);

        this.paneSource.classList.remove('drag-over');
        this.paneSource.ondragleave = null;
        this.paneSource.ondragover = (e) => {
            const types = [...(e.dataTransfer?.types || [])];
            if (types.includes('Files') || types.includes('wh/ref-image')) {
                e.preventDefault();
            }
        };
        this.paneSource.ondrop = (e) => {
            if (e.target.closest('#ref-strip') || e.target.closest('#prompt-input')) return;
            const types = [...(e.dataTransfer?.types || [])];
            const refImage = e.dataTransfer.getData('wh/ref-image');
            if (types.includes('Files') || refImage) {
                e.preventDefault();
                e.stopPropagation();
                if (refImage) {
                    task.state.references.push(refImage);
                    this.renderSource();
                    this.bindDnd();
                } else if (e.dataTransfer.files?.length) {
                    this.addRefsFromFiles(e.dataTransfer.files);
                }
            }
        };

        const refBox = this.paneSource.querySelector('#ref-box');
        if (refBox) {
            ['dragenter', 'dragover'].forEach((n) => {
                refBox.addEventListener(n, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    refBox.classList.add('drag-over');
                });
            });
            refBox.addEventListener('dragleave', (e) => {
                if (!refBox.contains(e.relatedTarget)) refBox.classList.remove('drag-over');
            });
            refBox.addEventListener('drop', (e) => {
                const internal = e.dataTransfer.getData('text/plain');
                if (internal && internal.startsWith('ref:')) return;
                e.preventDefault();
                e.stopPropagation();
                refBox.classList.remove('drag-over');
                const refImage = e.dataTransfer.getData('wh/ref-image');
                if (refImage) {
                    task.state.references.push(refImage);
                    this.renderSource();
                    this.bindDnd();
                    return;
                }
                if (e.dataTransfer.files?.length) this.addRefsFromFiles(e.dataTransfer.files);
            });
        }
    }

    bindCombo(task) {
        const combo = this.paneSource.querySelector('#provider-combo');
        if (!combo) return;
        const trigger = combo.querySelector('#combo-trigger');
        trigger.onclick = (e) => {
            e.stopPropagation();
            this.comboOpen = !this.comboOpen;
            this.renderSource();
            this.bindDnd();
        };
        const query = combo.querySelector('#combo-query');
        if (query) {
            query.addEventListener('input', () => {
                this.combo.query = query.value;
                this.persistCombo();
                this.comboOpen = true;
                this.renderSource();
                this.bindDnd();
                const again = this.paneSource.querySelector('#combo-query');
                if (again) {
                    again.focus();
                    again.setSelectionRange(again.value.length, again.value.length);
                }
            });
        }
        const favOnly = combo.querySelector('#combo-favs');
        if (favOnly) {
            favOnly.onchange = () => {
                this.combo.favOnly = favOnly.checked;
                this.persistCombo();
                this.comboOpen = true;
                this.renderSource();
                this.bindDnd();
            };
        }
        const sort = combo.querySelector('#combo-sort');
        if (sort) {
            sort.onchange = () => {
                this.combo.sort = sort.value;
                this.persistCombo();
                this.comboOpen = true;
                this.renderSource();
                this.bindDnd();
            };
        }
        combo.querySelectorAll('[data-tag]').forEach((chip) => {
            chip.onclick = (e) => {
                e.stopPropagation();
                const t = chip.dataset.tag;
                const set = new Set(this.combo.tags || []);
                if (set.has(t)) set.delete(t);
                else set.add(t);
                this.combo.tags = [...set];
                this.persistCombo();
                this.comboOpen = true;
                this.renderSource();
                this.bindDnd();
            };
        });
        combo.querySelectorAll('[data-star]').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const id = btn.dataset.star;
                if (this.favs.has(id)) this.favs.delete(id);
                else this.favs.add(id);
                this.persistFavs();
                this.comboOpen = true;
                this.renderSource();
                this.bindDnd();
            };
        });
        combo.querySelectorAll('.combo-item[data-provider]').forEach((row) => {
            row.onclick = (e) => {
                if (e.target.closest('[data-star]')) return;
                if (row.dataset.available !== '1') return;
                task.state.selectedProviderId = row.dataset.provider;
                this.combo.providerId = row.dataset.provider;
                this.persistCombo();
                this.comboOpen = false;
                this.renderSource();
                this.bindDnd();
            };
        });
    }

    onResultsClick(e) {
        const task = this.task();
        if (!task) return;
        const zoom = e.target.closest('[data-zoom]');
        if (zoom) {
            this.openViewer(parseInt(zoom.dataset.zoom, 10));
            return;
        }
        const go = e.target.closest('[data-go]');
        if (go) {
            this.selectResult(parseInt(go.dataset.go, 10));
            return;
        }
        const copy = e.target.closest('[data-copy]');
        if (copy) {
            this.handleCopy(task.results[parseInt(copy.dataset.copy, 10)], copy);
            return;
        }
        const regen = e.target.closest('[data-regen]');
        if (regen) {
            this.handleRegen(task.results[parseInt(regen.dataset.regen, 10)]);
            return;
        }
        const neu = e.target.closest('[data-newtask]');
        if (neu) {
            this.handleNewTaskFromResult(task.results[parseInt(neu.dataset.newtask, 10)], neu);
            return;
        }
        const paramsToggle = e.target.closest('[data-params-toggle]');
        if (paramsToggle) {
            const card = paramsToggle.closest('[data-card]');
            if (card) card.classList.toggle('params-open');
            return;
        }
        const card = e.target.closest('[data-card]');
        if (card && !e.target.closest('a, button')) {
            this.selectResult(parseInt(card.dataset.card, 10));
        }
    }

    onResultsKey(e) {
        if (this.viewerState?.open) {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.closeViewer();
                return;
            }
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.viewerNav(-1);
                return;
            }
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.viewerNav(1);
                return;
            }
            if (e.key.toLowerCase() === 'f' || e.key === '1') {
                e.preventDefault();
                this.toggleViewerScale();
                return;
            }
            return;
        }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (this.comboOpen) return;
        const task = this.task();
        if (!task?.results.length) return;
        e.preventDefault();
        const current = Number.isInteger(task.selectedResult) ? task.selectedResult : 0;
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const next = Math.max(0, Math.min(task.results.length - 1, current + delta));
        this.selectResult(next);
    }

    renderResults() {
        const task = this.task();
        if (!task || !task.results.length) {
            this.paneResults.innerHTML = `
                <div class="empty-board">
                    <h2>Results</h2>
                    <p>Generate to fill this pane. The image stays on screen — no page scroll.</p>
                </div>`;
            return;
        }
        const isLocal = this.env.isLocal;
        const cards = task.results.map((res, i) => this.resultCard(res, i, i === task.selectedResult, isLocal)).join('');
        const thumbs = task.results.map((res, i) => this.filmThumb(res, i, i === task.selectedResult, isLocal)).join('');
        this.paneResults.innerHTML = `
            <div class="carousel" id="carousel">${cards}</div>
            <div class="film" id="film">${thumbs}</div>
        `;
        this.scrollCarouselTo(task.selectedResult, 'auto');
    }

    ensureCarousel() {
        if (this.paneResults.querySelector('#carousel')) return;
        this.paneResults.innerHTML = `<div class="carousel" id="carousel"></div><div class="film" id="film"></div>`;
    }

    htmlToElement(html) {
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        return template.content.firstElementChild;
    }

    filmThumb(res, index, active, isLocal) {
        const on = active ? 'on' : '';
        if (res.status === 'generating') {
            return `<button type="button" class="${on}" data-go="${index}"><span class="ph">…</span></button>`;
        }
        if (res.status === 'error') {
            return `<button type="button" class="${on}" data-go="${index}"><span class="ph">!</span></button>`;
        }
        const src = resultImageUrl(res.image, isLocal);
        return `<button type="button" class="${on}" data-go="${index}"><img src="${src}" alt=""></button>`;
    }

    appendResultSlot(task, index, { reveal = true } = {}) {
        if (this.activeId !== task.id) return;
        this.ensureCarousel();
        const carousel = document.getElementById('carousel');
        const film = document.getElementById('film');
        const isLocal = this.env.isLocal;
        const active = index === task.selectedResult;
        const card = this.htmlToElement(this.resultCard(task.results[index], index, active, isLocal));
        const thumb = this.htmlToElement(this.filmThumb(task.results[index], index, active, isLocal));
        if (reveal) card.classList.add('is-enter');
        carousel.appendChild(card);
        film.appendChild(thumb);
        if (this.viewerState?.open && this.activeId === task.id) {
            this.updateViewerUI();
        }
    }

    patchResultSlot(task, index) {
        if (this.activeId !== task.id) return;
        this.ensureCarousel();
        const carousel = document.getElementById('carousel');
        const film = document.getElementById('film');
        let card = carousel.querySelector(`[data-card="${index}"]`);
        if (!card) {
            this.appendResultSlot(task, index, { reveal: false });
            return;
        }
        const isLocal = this.env.isLocal;
        const res = task.results[index];
        const active = index === task.selectedResult;
        const next = this.htmlToElement(this.resultCard(res, index, active, isLocal));
        card.className = next.className;
        card.innerHTML = next.innerHTML;
        const img = card.querySelector('.card-stage img');
        if (img) img.classList.add('is-reveal');
        const thumb = film.querySelector(`[data-go="${index}"]`);
        const nextThumb = this.htmlToElement(this.filmThumb(res, index, active, isLocal));
        if (thumb) {
            thumb.className = nextThumb.className;
            thumb.innerHTML = nextThumb.innerHTML;
        } else {
            film.appendChild(nextThumb);
        }
        if (this.viewerState?.open && this.activeId === task.id) {
            this.updateViewerUI();
        }
    }

    highlightResult(index) {
        this.paneResults.querySelectorAll('[data-card]').forEach((el) => {
            el.classList.toggle('is-active', Number(el.dataset.card) === index);
        });
        this.paneResults.querySelectorAll('[data-go]').forEach((el) => {
            el.classList.toggle('on', Number(el.dataset.go) === index);
        });
    }

    stageBgClass(index) {
        return `stage-bg-${Math.abs(Number(index) || 0) % 6}`;
    }

    sourceBgClass(task) {
        const bg = stageBgIndexFromColor(task.color);
        const pos = Math.abs(String(task.id || '').length + bg) % 6;
        return `stage-bg-${bg} stage-pos-${pos}`;
    }

    resultTitle(res) {
        const providerLabel = res.nice_name || res.providerId || 'Unknown';
        const aspect = res.aspect_ratio || (res.params ? 'Match Input' : '');
        const dims = (res.width && res.height) ? `${res.width}×${res.height}` : '';

        let aspectPart = '';
        if (aspect && dims) {
            aspectPart = `Aspect: ${aspect} (${dims})`;
        } else if (aspect) {
            aspectPart = `Aspect: ${aspect}`;
        } else if (dims) {
            aspectPart = `${dims}`;
        }

        return aspectPart ? `${providerLabel} | ${aspectPart}` : providerLabel;
    }

    ensureResultDimensions(res) {
        if (!res || !res.image || (res.width && res.height)) return;
        const img = new Image();
        img.onload = () => {
            if (img.naturalWidth && img.naturalHeight) {
                res.width = img.naturalWidth;
                res.height = img.naturalHeight;
                this.syncResultTitleUI(res);
            }
        };
        img.src = res.image;
    }

    syncResultTitleUI(res) {
        const task = this.task();
        if (!task) return;
        const index = task.results.indexOf(res);
        if (index !== -1) {
            const title = this.resultTitle(res);
            const card = this.paneResults?.querySelector(`[data-card="${index}"]`);
            const btn = card?.querySelector('.params-hit');
            if (btn) {
                btn.textContent = title;
                btn.title = title;
            }
            if (this.viewerState?.open && this.viewerState.index === index && this.viewerInfo) {
                this.viewerInfo.textContent = title;
                this.viewerInfo.title = title;
            }
        }
    }

    resultParamsPre(res) {
        if (!res.params) return '';
        return `<pre class="card-params-json">${escapeHtml(JSON.stringify(res.params, null, 2))}</pre>`;
    }

    resultCard(res, index, active, isLocal) {
        if (res.status === 'generating') {
            return `<article class="card ${active ? 'is-active' : ''}" data-card="${index}"><div class="card-stage ${this.stageBgClass(index)}"><div class="spinner"></div></div><div class="card-meta"><div class="info">Generating…</div></div></article>`;
        }
        this.ensureResultDimensions(res);
        const title = this.resultTitle(res);
        const paramsBlock = this.resultParamsPre(res);
        if (res.status === 'error') {
            return `<article class="card ${active ? 'is-active' : ''}" data-card="${index}">
                <div class="card-error">
                    <strong>Error</strong>
                    <p>${escapeHtml(res.error || 'Unknown error')}</p>
                    ${res.fallback_url ? `<p><a href="${escapeHtml(res.fallback_url)}" target="_blank" rel="noopener">Download manually</a></p>` : ''}
                    ${paramsBlock ? `<button type="button" class="info params-hit" data-params-toggle="${index}">${escapeHtml(title)}</button>${paramsBlock}` : ''}
                    <div class="card-error-bar">
                        <button class="btn btn-ghost" type="button" data-regen="${index}">Again</button>
                    </div>
                </div>
            </article>`;
        }
        const src = resultImageUrl(res.image, isLocal);
        const dlLabel = isLocal ? 'Download' : 'Download full res';
        return `<article class="card ${active ? 'is-active' : ''}" data-card="${index}">
            <div class="card-stage ${this.stageBgClass(index)}"><img src="${src}" alt=""></div>
            ${paramsBlock ? `<div class="card-params-pop">${paramsBlock}</div>` : ''}
            <div class="card-meta">
                <button type="button" class="info params-hit" data-params-toggle="${index}" title="${escapeHtml(title)}">${escapeHtml(title)}</button>
                <div class="card-actions">
                    <div class="card-btn-grp">
                        <button class="btn btn-fullsize" type="button" data-zoom="${index}" title="Open full size">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <polyline points="15 3 21 3 21 9"></polyline>
                                <polyline points="9 21 3 21 3 15"></polyline>
                                <line x1="21" y1="3" x2="14" y2="10"></line>
                                <line x1="3" y1="21" x2="10" y2="14"></line>
                            </svg>
                            <span>Full Size</span>
                        </button>
                    </div>
                    <span class="card-btn-sep" aria-hidden="true"></span>
                    <div class="card-btn-grp">
                        ${isLocal ? `<button class="btn" type="button" data-copy="${index}">Copy</button>` : ''}
                        <a class="btn btn-download" href="${escapeHtml(res.image)}" download>${dlLabel}</a>
                    </div>
                    <span class="card-btn-sep" aria-hidden="true"></span>
                    <div class="card-btn-grp">
                        <button class="btn btn-ghost" type="button" data-regen="${index}">Again</button>
                        <button class="btn" type="button" data-newtask="${index}">New task</button>
                    </div>
                </div>
            </div>
        </article>`;
    }

    selectResult(index) {
        const task = this.task();
        if (!task || index < 0 || index >= task.results.length) return;
        task.selectedResult = index;
        this.highlightResult(index);
        if (!this.isCardCentered(index)) this.scrollCarouselTo(index, 'smooth');
    }

    carouselTargetLeft(index) {
        const carousel = document.getElementById('carousel');
        const card = carousel && carousel.querySelector(`[data-card="${index}"]`);
        if (!carousel || !card) return null;
        const cardRect = card.getBoundingClientRect();
        const carouselRect = carousel.getBoundingClientRect();
        const cardLeft = cardRect.left - carouselRect.left + carousel.scrollLeft;
        return Math.max(0, cardLeft - (carousel.clientWidth - card.clientWidth) / 2);
    }

    isCardCentered(index) {
        const carousel = document.getElementById('carousel');
        const target = this.carouselTargetLeft(index);
        if (!carousel || target == null) return false;
        return Math.abs(carousel.scrollLeft - target) < 12;
    }

    scrollCarouselTo(index, behavior = 'auto') {
        const carousel = document.getElementById('carousel');
        const left = this.carouselTargetLeft(index);
        if (!carousel || left == null) return;
        carousel.scrollTo({ left, behavior: behavior === 'smooth' ? 'smooth' : 'auto' });
    }

    bindDnd() {
        this.stripCleanups.forEach((fn) => fn());
        this.stripCleanups = [];
        const task = this.task();
        const refStrip = this.paneSource.querySelector('#ref-strip');
        if (task && refStrip) {
            this.stripCleanups.push(bindStrip(refStrip, {
                itemSelector: '.thumb[data-index]',
                payloadPrefix: 'ref',
                getItems: () => task.state.references,
                setItems: (arr) => {
                    task.state.references = arr;
                    this.renderSource();
                    this.bindDnd();
                },
                onExternalFiles: (files) => this.addRefsFromFiles(files),
                onWhRefImage: (data) => {
                    task.state.references.push(data);
                    this.renderSource();
                    this.bindDnd();
                },
                onPromptTag: (promptEl, idx) => {
                    const tag = `@image${idx + 1}`;
                    const start = promptEl.selectionStart;
                    const end = promptEl.selectionEnd;
                    const current = promptEl.value;
                    promptEl.value = current.slice(0, start) + tag + current.slice(end);
                    promptEl.selectionStart = promptEl.selectionEnd = start + tag.length;
                    task.state.formState.prompt = promptEl.value;
                },
                onCrossPoolDrop: (token, other) => {
                    if (other?.dataset.dropTarget === 'stage' && token.startsWith('ref:')) {
                        const idx = parseInt(token.slice(4), 10);
                        if (task.state.references[idx]) {
                            this.globalImages.push(task.state.references[idx]);
                            this.renderStage();
                            this.bindDnd();
                        }
                    }
                },
                highlightSelector: '[data-drop-target]'
            }));
        }
        this.stripCleanups.push(bindStrip(this.stageStrip, {
            itemSelector: '.thumb[data-index]',
            payloadPrefix: 'glb',
            skipSelfWhRef: true,
            getItems: () => this.globalImages,
            setItems: (arr) => {
                this.globalImages = arr;
                this.renderStage();
                this.bindDnd();
            },
            onExternalFiles: async (files) => {
                const urls = await filesToDataUrls(files);
                this.globalImages.push(...urls);
                this.renderStage();
                this.bindDnd();
            },
            onWhRefImage: (data) => {
                this.globalImages.push(data);
                this.renderStage();
                this.bindDnd();
            },
            onCrossPoolDrop: (token) => {
                if (token.startsWith('ref:')) {
                    const idx = parseInt(token.slice(4), 10);
                    const t = this.task();
                    if (t?.state.references[idx]) {
                        this.globalImages.push(t.state.references[idx]);
                        this.renderStage();
                        this.bindDnd();
                    }
                } else if (token.startsWith('src:')) {
                    this.handleStageDrop({ dataTransfer: { getData: (k) => (k === 'text/plain' ? token : ''), files: null } });
                } else if (token.startsWith('glb:')) {
                    const t = this.task();
                    const idx = parseInt(token.slice(4), 10);
                    if (t && this.globalImages[idx]) {
                        t.state.references.push(this.globalImages[idx]);
                        this.renderSource();
                        this.bindDnd();
                    }
                }
            },
            highlightSelector: '[data-drop-target]'
        }));
    }

    async handleGenerate() {
        const task = this.task();
        const provider = this.provider(task);
        if (!task || !provider) return;
        const mode = P.effectiveGenerationMode(task);
        if (!P.providerSupportsMode(provider, mode)) {
            this.toast(`Provider does not support ${mode.toUpperCase()} generation.`);
            return;
        }
        if (P.isAspectRatioMissing(task)) {
            this.toast('Aspect ratio is required for Text-to-Image generation.');
            return;
        }
        if (P.isPromptEmpty(task)) this.toast('Prompt is empty. Generating anyway…', 'info');
        if (P.isRefLimitExceeded(provider, task)) {
            this.toast(`Too many references. Server will only receive the first ${P.effectiveMaxRefs(provider, task)}.`, 'info');
        }
        if (P.isMaskMissing(provider, task)) {
            this.toast('Error: This provider strictly requires a mask, but this task has no mask.');
            return;
        }

        const mask = P.maskCheckboxState(provider, task);
        const numEl = this.paneSource.querySelector('#num-images-input');
        const numImages = numEl ? parseInt(numEl.value, 10) : (task.state.formState.num_images || 1);
        task.state.formState.num_images = numImages;
        const finalParams = P.collectGenerateParams(provider, task.state.formState, this.paneSource);
        const payload = {
            taskId: task.id,
            providerId: task.state.selectedProviderId,
            num_images: numImages,
            aspect_ratio: task.state.formState.aspect_ratio,
            use_mask: mask.use,
            params: finalParams,
            referenceImages: task.state.references.slice(0, P.effectiveMaxRefs(provider, task)),
            force_separate_requests: task.state.formState.force_separate_requests || false
        };

        const index = task.results.length;
        task.results.push({
            status: 'generating',
            providerId: payload.providerId,
            params: payload.params,
            num_images: payload.num_images,
            aspect_ratio: payload.aspect_ratio
        });
        task.selectedResult = index;
        this.appEl.classList.remove('no-results');
        this.appendResultSlot(task, index);
        this.highlightResult(index);
        this.scrollCarouselTo(index, 'smooth');

        try {
            const data = await api.generate(payload);
            this.applyResults(task, data.results || [], index);
        } catch (err) {
            task.results[index].status = 'error';
            task.results[index].error = err.message;
            this.patchResultSlot(task, index);
        }
    }

    applyResults(task, newResults, baseIndex) {
        if (!newResults.length) {
            task.results[baseIndex] = { ...task.results[baseIndex], status: 'error', error: 'No images generated' };
            this.patchResultSlot(task, baseIndex);
            return;
        }
        const unique = [];
        const seen = new Set();
        for (const res of newResults) {
            if (res.status === 'error' && res.error_hash) {
                if (seen.has(res.error_hash)) continue;
                seen.add(res.error_hash);
            }
            unique.push(res);
        }
        const first = unique[0];
        task.results[baseIndex] = {
            params: task.results[baseIndex].params,
            providerId: task.results[baseIndex].providerId,
            ...first,
            status: first.status || 'done'
        };
        const extraStart = task.results.length;
        for (let i = 1; i < unique.length; i++) {
            const res = unique[i];
            task.results.push({
                params: task.results[baseIndex].params,
                providerId: task.results[baseIndex].providerId,
                ...res,
                status: res.status || 'done'
            });
        }
        this.patchResultSlot(task, baseIndex);
        for (let i = extraStart; i < task.results.length; i++) {
            this.appendResultSlot(task, i);
        }
    }

    async handleCopy(result, btn) {
        try {
            await api.copyToClipboard(filenameFromUrl(result.image));
            btn.classList.add('flash');
            setTimeout(() => btn.classList.remove('flash'), 1000);
        } catch (err) {
            this.toast('Copy failed: ' + err.message);
        }
    }

    handleRegen(result) {
        const task = this.task();
        if (!task || !result) return;
        if (result.providerId) task.state.selectedProviderId = result.providerId;
        const params = { ...(result.params || {}) };
        if (result.num_images !== undefined) params.num_images = result.num_images;
        if (result.aspect_ratio !== undefined) params.aspect_ratio = result.aspect_ratio;
        Object.assign(task.state.formState, params);
        if (params.aspect_ratio !== undefined) this.aliasState.aspect_ratio = params.aspect_ratio;
        this.renderSource();
        this.bindDnd();
        this.paneSource.querySelector('#prompt-input')?.focus();
    }

    async handleNewTaskFromResult(result, btn) {
        const task = this.task();
        const original = btn.innerHTML;
        btn.disabled = true;
        try {
            await api.createTaskFromFile({
                filename: filenameFromUrl(result.image),
                sourceTaskId: task ? task.id : null,
                threadId: this.env.threadId
            });
            await this.pollOnce();
            btn.textContent = 'Created';
            btn.classList.add('flash');
            setTimeout(() => {
                btn.innerHTML = original;
                btn.classList.remove('flash');
                btn.disabled = false;
            }, 1600);
        } catch (err) {
            btn.disabled = false;
            this.toast(err.message);
        }
    }

    mountViewer() {
        if (document.getElementById('viewer-modal')) return;
        const html = `
            <div class="viewer-modal" id="viewer-modal" aria-hidden="true" data-scale="fit">
                <div class="viewer-toolbar">
                    <div class="viewer-toolbar-left">
                        <span class="viewer-counter" id="viewer-counter"></span>
                        <span class="viewer-info" id="viewer-info"></span>
                    </div>
                    <div class="viewer-toolbar-right">
                        <div class="viewer-zoom-grp">
                            <button class="viewer-zoom-btn is-active" id="viewer-btn-fit" type="button" title="Fit to screen (F)">Fit</button>
                            <button class="viewer-zoom-btn" id="viewer-btn-100" type="button" title="Original 100% size (1)">100%</button>
                        </div>
                        <button class="btn btn-sm" id="viewer-btn-copy" type="button">Copy</button>
                        <a class="btn btn-sm btn-download" id="viewer-btn-download" href="#" download>Download</a>
                        <button class="viewer-close-btn" id="viewer-btn-close" type="button" title="Close (Esc)">✕</button>
                    </div>
                </div>
                <button class="viewer-nav-btn viewer-prev" id="viewer-btn-prev" type="button" title="Previous (Left Arrow)" aria-label="Previous image">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
                </button>
                <button class="viewer-nav-btn viewer-next" id="viewer-btn-next" type="button" title="Next (Right Arrow)" aria-label="Next image">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </button>
                <div class="viewer-body" id="viewer-body">
                    <div class="viewer-stage" id="viewer-stage">
                        <img class="viewer-img" id="viewer-img" src="" alt="">
                        <div class="viewer-spinner" id="viewer-spinner"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', html);

        this.viewerModal = document.getElementById('viewer-modal');
        this.viewerImg = document.getElementById('viewer-img');
        this.viewerSpinner = document.getElementById('viewer-spinner');
        this.viewerCounter = document.getElementById('viewer-counter');
        this.viewerInfo = document.getElementById('viewer-info');
        this.viewerBtnFit = document.getElementById('viewer-btn-fit');
        this.viewerBtn100 = document.getElementById('viewer-btn-100');
        this.viewerBtnCopy = document.getElementById('viewer-btn-copy');
        this.viewerBtnDownload = document.getElementById('viewer-btn-download');
        this.viewerBtnPrev = document.getElementById('viewer-btn-prev');
        this.viewerBtnNext = document.getElementById('viewer-btn-next');
        this.viewerBtnClose = document.getElementById('viewer-btn-close');
        this.viewerStage = document.getElementById('viewer-stage');
        this.viewerBody = document.getElementById('viewer-body');

        this.bindViewerEvents();
    }

    bindViewerEvents() {
        this.viewerBtnFit.onclick = () => this.setViewerScale('fit');
        this.viewerBtn100.onclick = () => this.setViewerScale('100');
        this.viewerBtnClose.onclick = () => this.closeViewer();
        this.viewerBtnPrev.onclick = () => this.viewerNav(-1);
        this.viewerBtnNext.onclick = () => this.viewerNav(1);
        this.viewerBtnCopy.onclick = (e) => {
            const task = this.task();
            if (task?.results[this.viewerState.index]) {
                this.handleCopy(task.results[this.viewerState.index], e.currentTarget);
            }
        };

        this.viewerStage.onclick = (e) => {
            if (e.target === this.viewerStage || e.target === this.viewerBody) {
                this.closeViewer();
            }
        };

        this.viewerImg.onclick = (e) => {
            e.stopPropagation();
            if (this.viewerState.scale === 'fit') {
                this.setViewerScale('100');
            }
        };

        this.viewerBody.onmousedown = (e) => {
            if (this.viewerState.scale !== '100') return;
            if (e.button !== 0) return;
            e.preventDefault();
            this.viewerState.isDragging = true;
            this.viewerState.startX = e.clientX - this.viewerState.panX;
            this.viewerState.startY = e.clientY - this.viewerState.panY;
            this.viewerModal.classList.add('is-panning');
        };

        window.addEventListener('mousemove', (e) => {
            if (!this.viewerState.open || !this.viewerState.isDragging) return;
            this.viewerState.panX = e.clientX - this.viewerState.startX;
            this.viewerState.panY = e.clientY - this.viewerState.startY;
            this.applyViewerTransform();
        });

        window.addEventListener('mouseup', () => {
            if (!this.viewerState.open || !this.viewerState.isDragging) return;
            this.viewerState.isDragging = false;
            this.viewerModal.classList.remove('is-panning');
        });

        this.viewerBody.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const touch = e.touches[0];
            this.viewerState.touchStartX = touch.clientX;
            this.viewerState.touchStartY = touch.clientY;

            const now = Date.now();
            if (now - this.viewerState.lastTap < 300) {
                this.toggleViewerScale();
                this.viewerState.lastTap = 0;
                e.preventDefault();
                return;
            }
            this.viewerState.lastTap = now;

            if (this.viewerState.scale === '100') {
                this.viewerState.isDragging = true;
                this.viewerState.startX = touch.clientX - this.viewerState.panX;
                this.viewerState.startY = touch.clientY - this.viewerState.panY;
                this.viewerModal.classList.add('is-panning');
            }
        }, { passive: false });

        this.viewerBody.addEventListener('touchmove', (e) => {
            if (!this.viewerState.open || e.touches.length !== 1) return;
            const touch = e.touches[0];
            if (this.viewerState.scale === '100' && this.viewerState.isDragging) {
                this.viewerState.panX = touch.clientX - this.viewerState.startX;
                this.viewerState.panY = touch.clientY - this.viewerState.startY;
                this.applyViewerTransform();
                e.preventDefault();
            }
        }, { passive: false });

        this.viewerBody.addEventListener('touchend', (e) => {
            if (!this.viewerState.open) return;
            if (this.viewerState.isDragging) {
                this.viewerState.isDragging = false;
                this.viewerModal.classList.remove('is-panning');
            }
            if (this.viewerState.scale === 'fit' && e.changedTouches.length === 1) {
                const touch = e.changedTouches[0];
                const dx = touch.clientX - this.viewerState.touchStartX;
                const dy = touch.clientY - this.viewerState.touchStartY;
                if (Math.abs(dx) > 40 && Math.abs(dy) < 60) {
                    if (dx < 0) this.viewerNav(1);
                    else this.viewerNav(-1);
                } else if (dy > 70 && Math.abs(dx) < 50) {
                    this.closeViewer();
                }
            }
        }, { passive: true });
    }

    getNextViewableIndex(currentIndex, delta) {
        const task = this.task();
        if (!task || !task.results.length) return -1;
        let idx = currentIndex + delta;
        while (idx >= 0 && idx < task.results.length) {
            if (isViewableResult(task.results[idx])) {
                return idx;
            }
            idx += delta;
        }
        return -1;
    }

    openViewer(index) {
        const task = this.task();
        if (!task || !task.results.length) return;
        let targetIndex = index;
        if (!isViewableResult(task.results[targetIndex])) {
            targetIndex = this.getNextViewableIndex(index, 1);
            if (targetIndex === -1) targetIndex = this.getNextViewableIndex(index, -1);
        }
        if (targetIndex === -1 || !task.results[targetIndex]) return;
        this.viewerState.open = true;
        this.viewerState.index = targetIndex;
        this.viewerState.scale = 'fit';
        this.viewerState.panX = 0;
        this.viewerState.panY = 0;
        this.viewerModal.classList.add('is-open');
        this.viewerModal.setAttribute('aria-hidden', 'false');
        this.viewerModal.dataset.scale = 'fit';
        this.updateViewerUI();
    }

    closeViewer() {
        if (!this.viewerState.open) return;
        this.viewerState.open = false;
        this.viewerModal.classList.remove('is-open');
        this.viewerModal.setAttribute('aria-hidden', 'true');
        this.viewerImg.src = '';
        this.viewerImg.style.transform = '';
    }

    updateViewerUI() {
        const task = this.task();
        if (!task || !this.viewerState.open) return;
        let idx = this.viewerState.index;
        if (!isViewableResult(task.results[idx])) {
            const nextValid = this.getNextViewableIndex(idx, 1);
            const prevValid = nextValid !== -1 ? nextValid : this.getNextViewableIndex(idx, -1);
            if (prevValid === -1) {
                this.closeViewer();
                return;
            }
            idx = prevValid;
            this.viewerState.index = idx;
        }
        const res = task.results[idx];
        if (!res) { this.closeViewer(); return; }

        const viewableList = task.results.map((r, i) => ({ r, i })).filter(({ r }) => isViewableResult(r));
        const total = viewableList.length;
        const currentPos = viewableList.findIndex(({ i }) => i === idx) + 1;

        this.viewerCounter.textContent = `${currentPos || 1} / ${total || 1}`;
        this.viewerInfo.textContent = this.resultTitle(res);
        this.viewerInfo.title = this.viewerInfo.textContent;

        const hasPrev = this.getNextViewableIndex(idx, -1) !== -1;
        const hasNext = this.getNextViewableIndex(idx, 1) !== -1;

        this.viewerBtnPrev.disabled = !hasPrev;
        this.viewerBtnNext.disabled = !hasNext;
        this.viewerBtnPrev.style.display = total > 1 ? '' : 'none';
        this.viewerBtnNext.style.display = total > 1 ? '' : 'none';

        const isLocal = this.env.isLocal;
        this.viewerBtnCopy.style.display = isLocal && res.image ? '' : 'none';
        this.viewerBtnDownload.href = res.image || '#';
        this.viewerBtnDownload.download = filenameFromUrl(res.image);

        this.viewerBtnFit.classList.toggle('is-active', this.viewerState.scale === 'fit');
        this.viewerBtn100.classList.toggle('is-active', this.viewerState.scale === '100');
        this.viewerModal.dataset.scale = this.viewerState.scale;
        this.applyViewerTransform();

        const token = ++this.viewerState.token;
        const previewSrc = getPreviewUrl(res.image);
        const fullSrc = res.image;

        this.viewerImg.src = previewSrc || fullSrc;

        if (!isLocal && fullSrc && fullSrc !== previewSrc) {
            this.viewerSpinner.classList.add('loading');
            const preload = new Image();
            preload.onload = () => {
                if (preload.naturalWidth && preload.naturalHeight) {
                    res.width = preload.naturalWidth;
                    res.height = preload.naturalHeight;
                    this.syncResultTitleUI(res);
                }
                if (this.viewerState.token === token && this.viewerState.open) {
                    this.viewerImg.src = fullSrc;
                    this.viewerSpinner.classList.remove('loading');
                }
            };
            preload.onerror = () => {
                if (this.viewerState.token === token) {
                    this.viewerSpinner.classList.remove('loading');
                }
            };
            preload.src = fullSrc;
        } else {
            this.viewerSpinner.classList.remove('loading');
            this.ensureResultDimensions(res);
        }

        this.selectResult(idx);
    }

    setViewerScale(scale) {
        this.viewerState.scale = scale;
        this.viewerState.panX = 0;
        this.viewerState.panY = 0;
        this.viewerModal.dataset.scale = scale;
        this.viewerBtnFit.classList.toggle('is-active', scale === 'fit');
        this.viewerBtn100.classList.toggle('is-active', scale === '100');
        this.applyViewerTransform();
    }

    toggleViewerScale() {
        this.setViewerScale(this.viewerState.scale === 'fit' ? '100' : 'fit');
    }

    applyViewerTransform() {
        if (this.viewerState.scale === '100') {
            this.viewerImg.style.transform = `translate3d(${this.viewerState.panX}px, ${this.viewerState.panY}px, 0)`;
        } else {
            this.viewerImg.style.transform = '';
        }
    }

    viewerNav(delta) {
        const next = this.getNextViewableIndex(this.viewerState.index, delta);
        if (next !== -1) {
            this.viewerState.index = next;
            this.viewerState.panX = 0;
            this.viewerState.panY = 0;
            this.updateViewerUI();
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    window.app = app;
    app.init();
});
