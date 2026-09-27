/**
 * Renderer for the AI Assist window.
 *
 * Everything here comes from window.assistBridge (see assist-window-preload.js), which
 * talks straight to Helper's own agent service over IPC — there is no HTTP involved, unlike
 * the plugin's line, which has no other way to reach Helper.
 */

(function () {
    'use strict';

    const POLL_INTERVAL_MS = 1500;

    // Must match ABORTED_BY_PERSON in PhotoshopHelper/agent/index.js.
    const ABORTED_BY_PERSON = 'the person pressed Abort task';

    let lastState = null;
    let userToggledConnect = false;
    let setupChoices = [];
    let setupChoiceIndex = 0;
    let setupChoicesLoading = false;
    let setupTextShown = false;
    let promptTextShown = false;

    const STARTER_PROMPT = [
        'Use the photoshop-helper MCP server to work on the active Photoshop document.',
        '',
        'Architecture & Delegation:',
        '- Primary Agent (Orchestrator): Write ExtendScript/UXP scripts and call MCP tools directly.',
        '- Vision (CV): Delegate every look at the canvas (ps_get_image) to a subagent running your flagship vision model with extra-high effort: [TOP_TIER_VISION_MODEL] (effort: [EXTRA_HIGH_EFFORT]). Use it not only to review results but to locate things: ask it concrete questions — where exactly is this edge or object, in document pixels (the image caption gives the scale) — and let it request a full-size crop of a region when precision matters.',
        '- Exact geometry: when the task depends on an edge or a distance (follow an outline, keep N px away, place along a contour), do not trust visual estimates. Get the edge as data — a selection (Select Subject, Color Range), a mask, or pixel analysis in a script — compute from it, then have the vision subagent confirm on a close-up.',
        '- Knowledge Base (KB): When searching or reading the PhotoshopHelper knowledge base (ps_kb_list, ps_kb_read), delegate the lookup to a subagent running: [MID_TIER_RESEARCH_MODEL] (effort: [HIGH_EFFORT]).',
        '',
        'Final Report Requirements:',
        'When the task is complete, provide a comprehensive report:',
        '1. Subagents Report: Which subagents were spawned and the tasks they handled.',
        '2. Visual Inspection Log: How many times the canvas image was captured (ps_get_image), and what specific decisions/changes were made after each review. For every position or distance you claim, say whether it was measured from pixels or estimated by eye.',
        '3. Knowledge Base Log: Which KB articles were read by the subagent and how they guided your actions.',
        '',
        'Task:',
        '[YOUR_TASK_DESCRIPTION]'
    ].join('\n');

    /**
     * @param {string} id - Element id.
     * @returns {HTMLElement|null}
     */
    function byId(id) {
        return document.getElementById(id);
    }

    /**
     * @param {HTMLElement|null} element - Element to show or hide.
     * @param {boolean} shown - Whether it should be visible.
     */
    function setShown(element, shown) {
        if (!element) return;
        if (shown) element.removeAttribute('hidden');
        else element.setAttribute('hidden', '');
    }

    /**
     * @param {string} id - Element id.
     * @param {string} text - Text content to set.
     */
    function setText(id, text) {
        const element = byId(id);
        if (element) element.textContent = text || '';
    }

    /**
     * @param {number} ms - Time since something happened.
     * @returns {string} "12 s ago", "4 min ago", "2 h ago".
     */
    function formatAge(ms) {
        const seconds = Math.max(0, Math.round(ms / 1000));
        if (seconds < 60) return `${seconds} s ago`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes} min ago`;
        return `${Math.round(minutes / 60)} h ago`;
    }

    /**
     * @param {number} ms - How long a task took.
     * @returns {string} "took 6 min", or "took under a minute".
     */
    function formatDuration(ms) {
        const minutes = Math.round(Math.max(0, ms) / 60000);
        return minutes < 1 ? 'took under a minute' : `took ${minutes} min`;
    }

    /**
     * @param {number} ms - Time since the task started.
     * @returns {string} "3:07".
     */
    function formatClock(ms) {
        const seconds = Math.max(0, Math.floor(ms / 1000));
        const rest = seconds % 60;
        return `${Math.floor(seconds / 60)}:${rest < 10 ? '0' : ''}${rest}`;
    }

    /**
     * @param {string} text - A sentence fragment.
     * @returns {string} The same with a capital first letter.
     */
    function capitalize(text) {
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
    }

    /**
     * @param {object} state - assistBridge.getState() answer.
     * @param {string} taskId - Task whose steps are wanted.
     * @returns {object[]} That task's steps, oldest first.
     */
    function stepsOf(state, taskId) {
        return (state.progress || []).filter(step => step.taskId === taskId);
    }

    /**
     * Fill a scrollable steps container. Unlike the plugin's line, the window has room to
     * show every step at once — no folding, no "N earlier steps".
     *
     * @param {HTMLElement} container - Target element.
     * @param {number} startedAt - When the task started; step times are shown from there.
     * @param {object[]} steps - Steps to draw.
     * @param {boolean} markLast - Whether the last step is the one happening now.
     */
    function renderStepsInto(container, startedAt, steps, markLast) {
        if (!container) return;
        if (steps.length === 0) {
            setShown(container, false);
            return;
        }
        container.textContent = '';
        steps.forEach((step, index) => {
            const row = document.createElement('div');
            row.className = markLast && index === steps.length - 1
                ? 'assist-step-row assist-step-current'
                : 'assist-step-row';

            const time = document.createElement('span');
            time.className = 'assist-step-time';
            time.textContent = formatClock(step.at - startedAt);

            const text = document.createElement('span');
            text.textContent = step.text;

            row.appendChild(time);
            row.appendChild(text);
            container.appendChild(row);
        });
        container.scrollTop = container.scrollHeight;
        setShown(container, true);
    }

    /**
     * @param {boolean} connected - Whether the plugin's line is connected to Helper.
     */
    function renderPill(connected) {
        const pill = byId('assist-pill');
        if (!pill) return;
        pill.textContent = connected ? 'Connected' : 'Not connected';
        pill.style.background = connected ? '#32b643' : '#9aa0a6';
        pill.style.color = '#fff';
    }

    /**
     * @param {object} state - assistBridge.getState() answer.
     * @param {object} task - state.task.
     */
    function renderTask(state, task) {
        const now = Date.now();
        const steps = stepsOf(state, task.id);
        const last = steps[steps.length - 1];
        const lastActivity = task.lastActivityAt || (last && last.at) || task.startedAt;
        const silent = task.state === 'running'
            && !task.waitingForPerson
            && now - lastActivity >= 4 * 60 * 1000;
        const documentName = task.documentName || 'document';

        setText('assist-task-title', task.intent);

        const live = byId('assist-live');
        if (task.state === 'suspended') {
            setText('assist-task-meta', `${documentName} · paused ${formatAge(now - (task.suspendedAt || now))}`);
            setShown(live, false);
            const restarted = task.suspension && task.suspension.requiresRebind;
            setText('assist-task-message', restarted
                ? 'The Photoshop plugin restarted. Ask your agent to continue the same task, or abort it.'
                : 'The connection to Photoshop was interrupted. Ask your agent to continue the same task, or abort it.');
            setShown(byId('assist-task-message'), true);
        } else {
            setText('assist-task-meta', `${documentName} · started ${formatAge(now - task.startedAt)}`);
            if (live) live.className = silent ? 'assist-live assist-silent' : 'assist-live';
            setText('assist-live-text', last ? `${silent ? 'Last: ' : ''}${last.text}` : 'Starting…');
            setText('assist-live-age', formatAge(now - lastActivity));
            setShown(live, true);

            if (silent) {
                setText('assist-task-message', 'If the agent crashed, ran out of limits or was restarted, abort the task so the next one can start.');
                setShown(byId('assist-task-message'), true);
            } else if (task.waitingForPerson) {
                setText('assist-task-message', 'Waiting for you to finish in a Photoshop dialog.');
                setShown(byId('assist-task-message'), true);
            } else {
                setShown(byId('assist-task-message'), false);
            }
        }

        renderStepsInto(byId('assist-steps'), task.startedAt, steps, true);
        setShown(byId('assist-abort'), true);
    }

    /**
     * @param {object} state - assistBridge.getState() answer.
     * @param {object} finished - state.lastFinishedTask.
     */
    function renderFinished(state, finished) {
        const documentName = finished.documentName || 'document';
        setText('assist-finished-title', finished.intent);
        const steps = stepsOf(state, finished.id);

        if (finished.state === 'finished') {
            const took = finished.startedAt && finished.finishedAt
                ? ` · ${formatDuration(finished.finishedAt - finished.startedAt)}`
                : '';
            setText('assist-finished-meta', `${documentName} · finished${took}`);
            setShown(byId('assist-finished-message'), false);

            const report = finished.report || {};
            setText('assist-report-summary', report.summary || '(no summary)');
            setShown(byId('assist-report-issues-wrap'), Boolean(report.issues));
            setText('assist-report-issues', report.issues || '');
            setShown(byId('assist-report-suggestions-wrap'), Boolean(report.suggestions));
            setText('assist-report-suggestions', report.suggestions || '');
            setShown(byId('assist-report'), true);
            renderStepsInto(byId('assist-finished-steps'), finished.startedAt, steps, false);
            return;
        }

        setShown(byId('assist-report'), false);
        setShown(byId('assist-finished-steps'), false);
        const byPerson = finished.abortReason === ABORTED_BY_PERSON;
        setText('assist-finished-meta', `${documentName} · ${byPerson ? 'aborted by you' : 'aborted'}`);
        setText('assist-finished-message', byPerson
            ? 'A new task can start now. If the old agent is still running, Photoshop will refuse its next call.'
            : `${capitalize(finished.abortReason || 'the task ended')}. A new task can start now.`);
        setShown(byId('assist-finished-message'), true);
    }

    /**
     * @param {boolean} agentSeen - Whether an agent has ever started a task.
     */
    function renderConnectHeading(agentSeen) {
        setText('assist-connect-heading', 'How to connect an agent');
        setText('assist-connect-intro', agentSeen
            ? 'Claude Code, Codex or any other agent that supports MCP.'
            : 'No agent has connected yet. Set one up once:');
    }

    /**
     * Draw the whole window from an assistBridge.getState() answer.
     *
     * @param {object|null} state - Current agent service state.
     */
    function render(state) {
        lastState = state;
        if (!state) return;

        setShown(byId('assist-not-connected'), !state.channel.connected);
        renderPill(state.channel.connected);

        const hasTask = Boolean(state.task);
        const finished = state.lastFinishedTask;
        const agentSeen = Boolean(state.agentSeen);

        // Show connection setup by default when there is no active or finished task.
        // Collapse automatically when an active task runs or when a finished report exists.
        const details = byId('assist-connect-details');
        if (details) {
            if (hasTask) {
                details.open = false;
                userToggledConnect = false;
            } else if (!userToggledConnect) {
                if (finished) {
                    details.open = false;
                } else {
                    details.open = true;
                }
            }
        }

        setShown(byId('assist-task'), hasTask);
        if (hasTask) renderTask(state, state.task);

        setShown(byId('assist-finished'), !hasTask && Boolean(finished));
        if (!hasTask && finished) renderFinished(state, finished);

        renderConnectHeading(agentSeen);
        void loadSetupChoices();

        const isConnected = state.channel.connected;
        setShown(byId('assist-idle'), isConnected && !hasTask);
        if (isConnected && !hasTask) {
            setText('assist-idle-text', finished
                ? 'Waiting for a new task.'
                : 'Waiting for an agent.');
        }
    }

    // ── MCP setup ───────────────────────────────────────────────────────────

    /**
     * @param {number} index - Position in setupChoices.
     */
    function showSetupChoice(index) {
        const choice = setupChoices[index];
        if (!choice) return;
        setupChoiceIndex = index;
        setText('assist-setup-hint', choice.hint);
        setText('assist-setup-text', choice.text);
    }

    /**
     * Fill the setup picker once per window opening. The first choice pastes a complete
     * instruction into any compatible agent; CLI-specific terminal commands follow it.
     */
    async function loadSetupChoices() {
        if (setupChoices.length > 0 || setupChoicesLoading) return;
        setupChoicesLoading = true;
        try {
            const setup = await window.assistBridge.getSetup();
            if (setup && setup.tokenSaved) {
                const step1Num = byId('assist-step-1-num');
                if (step1Num) {
                    step1Num.classList.add('is-done');
                    step1Num.innerHTML = '<i class="icon icon-check"></i>';
                }
                setShown(byId('assist-step-1-badge'), true);
                setText('assist-step-1-text', 'Access key is saved in your User Environment.');
            }

            const select = byId('assist-setup-choice');
            if (!setup || !select) return;

            const choices = [];
            if (setup.instructionsForAnAgent) {
                choices.push({
                    label: 'Any agent: paste into its chat',
                    hint: 'Paste it into your agent\'s chat — the agent adds PhotoshopHelper to its settings by itself.',
                    text: setup.instructionsForAnAgent
                });
            }
            for (const entry of setup.commands) {
                choices.push({
                    label: `${entry.label}: terminal command`,
                    hint: 'Run it in a terminal.',
                    text: entry.copyCommand || entry.command
                });
            }

            select.textContent = '';
            choices.forEach((choice, index) => {
                const option = document.createElement('option');
                option.value = String(index);
                option.textContent = choice.label;
                select.appendChild(option);
            });

            setupChoices = choices;
            showSetupChoice(0);
        } finally {
            setupChoicesLoading = false;
        }
    }

    // ── Controls ────────────────────────────────────────────────────────────

    function wireControls() {
        const abort = byId('assist-abort');
        if (abort) {
            abort.addEventListener('click', async () => {
                await window.assistBridge.stop();
                await refresh();
            });
        }

        const choice = byId('assist-setup-choice');
        if (choice) {
            choice.addEventListener('change', event => showSetupChoice(Number(event.target.value)));
        }

        const showText = byId('assist-setup-show');
        if (showText) {
            showText.addEventListener('click', event => {
                event.preventDefault();
                setupTextShown = !setupTextShown;
                setText('assist-setup-show-label', setupTextShown ? 'Hide text' : 'Show text');
                const icon = byId('assist-setup-show-icon');
                if (icon) icon.className = setupTextShown ? 'icon icon-arrow-down mr-1' : 'icon icon-arrow-right mr-1';
                setShown(byId('assist-setup-text'), setupTextShown);
            });
        }

        const copy = byId('assist-setup-copy');
        if (copy) {
            copy.addEventListener('click', async () => {
                const chosen = setupChoices[setupChoiceIndex];
                if (!chosen) return;
                await window.assistBridge.copyText(chosen.text);
                copy.textContent = 'Copied';
                setTimeout(() => { copy.textContent = 'Copy setup text'; }, 1500);
            });
        }

        const promptText = byId('assist-prompt-text');
        if (promptText) {
            promptText.textContent = STARTER_PROMPT;
        }

        const showPrompt = byId('assist-prompt-show');
        if (showPrompt) {
            showPrompt.addEventListener('click', event => {
                event.preventDefault();
                promptTextShown = !promptTextShown;
                setText('assist-prompt-show-label', promptTextShown ? 'Hide prompt' : 'Show prompt');
                const icon = byId('assist-prompt-show-icon');
                if (icon) icon.className = promptTextShown ? 'icon icon-arrow-down mr-1' : 'icon icon-arrow-right mr-1';
                setShown(byId('assist-prompt-text'), promptTextShown);
            });
        }

        const copyPrompt = byId('assist-prompt-copy');
        if (copyPrompt) {
            copyPrompt.addEventListener('click', async () => {
                await window.assistBridge.copyText(STARTER_PROMPT);
                copyPrompt.textContent = 'Copied';
                setTimeout(() => { copyPrompt.textContent = 'Copy starter prompt'; }, 1500);
            });
        }

        const details = byId('assist-connect-details');
        const summary = details ? details.querySelector('summary') : null;
        if (summary) {
            summary.addEventListener('click', () => {
                userToggledConnect = true;
            });
        }
    }

    async function refresh() {
        const state = await window.assistBridge.getState();
        render(state);
    }

    window.assistBridge.onShowSection((section) => {
        if (section === 'connect') {
            const details = byId('assist-connect-details');
            if (details) {
                details.open = true;
                userToggledConnect = true;
            }
        }
    });

    wireControls();
    void refresh();
    setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
})();
