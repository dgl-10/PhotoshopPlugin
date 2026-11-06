'use strict';

/**
 * Skin texture jobs: compute a procedural skin micro-relief for a rectangle of the task's
 * Photoshop document in the background, then write it into that document on request.
 *
 * WHERE THE TEXTURE IS COMPUTED AND HOW IT REACHES PHOTOSHOP (method "B")
 *
 * The relief core is computed here, in Helper (Node, in a worker thread), and the finished
 * gray pixels travel to Photoshop as a file in the data folder of the running plugin; a
 * short UXP script then reads the file and writes the layer. The alternative, method "A",
 * was tried for real before this choice: in the task02 experiments of 3-4 November 2026
 * (docs/points_to_future development/skin_texture/task02.01.pixel_delivery-report.md in the
 * PhotoshopDaDHelperPreRelease planning folder) the very same core ran INSIDE Photoshop, in
 * a UXP script sent through ps_execute_script, and its data and the delivered pixels matched
 * Node byte for byte in every case checked. A works.
 *
 * B was chosen because it keeps Photoshop busy only for the short write (at most ~1.6 s on
 * the measured sizes, 4096 x 4096 included), while A keeps Photoshop's plugin thread busy for
 * the whole computation (40.7 s for 4096 x 4096 "lines"), and because long A calls ran into
 * trouble in the MCP session we tested with: one call of about 115 s was cut off by the MCP
 * client at roughly 60 s, the plugin channel dropped, and Photoshop later had to be restarted.
 * The ~60 s was a limit of that particular client/session, not a universal limit of Photoshop
 * (Helper itself waits up to 180 s), and the timeout did not stop the script: the layer was
 * still written afterwards. Eight shorter A calls did assemble a correct layer. So A is not
 * impossible, and B does not make the mathematics itself any faster (Node took 54 s for the
 * same 4096 "lines" case); B only moves the long part out of Photoshop and out of any single
 * MCP call.
 *
 * Because the computation can outlast one MCP call, a job is driven by separate short calls
 * (start, status, apply, cancel); no call waits longer than responseBudgetMs (15 s).
 *
 * LIFE CYCLE
 *
 *   checking_document -> computing -> ready -> preparing_write -> applying -> applied
 *   with the side exits cancelled, failed, invalidated (the document or the plugin runtime
 *   changed, so the result may not be written any more), discarded (the task ended, the result
 *   expired or a newer one replaced it) and apply_unknown (a write was sent, its outcome could
 *   not be established).
 *
 *   preparing_write and applying are two different things (task03.10, finding R2 of the lead's
 *   review): while the exchange files are being written to disk NOTHING has been sent to
 *   Photoshop yet, so a cancel, the end of the task, Helper quitting, a pause of the AI line, a
 *   new plugin runtime or an open interactive dialog still stop the write with no change to
 *   the document. Only applying means the command was handed to the transport.
 *
 * Rules this module keeps:
 * - At most one job per task is checking or computing; a ready result is kept for a limited
 *   time, and only a limited number of results and job records are kept per task.
 * - A request_id is used once per task (finding R1). The record of a used key outlives the job
 *   record: once a job record is dropped to bound memory, its key stays known in a compact
 *   ledger, so repeating it is refused instead of silently computing and writing a second
 *   texture. The ledger is bounded too (maxRequestsPerTask new keys per task); past that,
 *   start refuses and the agent has to begin a new task.
 * - A finished computation never writes by itself; only apply writes.
 * - A job is written at most once. A repeated or concurrent apply returns the first outcome
 *   and never sends a second write: not after a lost answer, not after the person's Undo.
 *   Only a write that provably changed nothing (Photoshop busy, the channel was down before
 *   sending, the command reached Photoshop after its deadline, the write was stopped before
 *   it was sent) may be sent again, and only by a new explicit apply.
 * - Before a write: the task must be running, the plugin runtime must be the one that
 *   reported the document at start, and the script itself re-checks the document. These
 *   checks are made again right before sending, after the files are on disk, and the check
 *   and the mark "sent" happen in one synchronous step with no await in between, so a cancel
 *   cannot slip through. A paused AI line is a pause, not a cancellation: the computation may
 *   finish, but nothing is written until the agent calls apply after the line is back; a
 *   pause while a write is being prepared stops that write, it is never sent on resume.
 * - The owner of a job (this module) cleans up after it: workers, memory and its own files.
 *   A terminated worker owns nothing, so its finally blocks do not matter. Files of a write
 *   whose outcome is unknown stay until its start deadline plus fileGraceMs, also when Helper
 *   quits (finding R3); after a quit the next run's orphan sweep removes them.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const adapter = require('./core-adapter');
const exchangeFiles = require('./exchange-files');
const scripts = require('./uxp-scripts');
const recipeCatalog = require('./recipe-catalog');

const WORKER_FILE = path.join(__dirname, 'worker.js');

const DEFAULT_OPTIONS = {
    // No MCP call of these tools waits longer than this. Clients cut tool calls at their own
    // limits (60 s was observed); 15 s keeps well under any of them.
    responseBudgetMs: 15_000,
    // Transport deadlines for the scripts. They are this module's own and do not change the
    // global timeouts of mcp-tools.js. Network timeouts are never treated as cancellation.
    probeTimeoutMs: 60_000,
    applyTransportTimeoutMs: 120_000,
    // An apply script that has not STARTED within this time after sending refuses to run, so
    // a command re-delivered after a reconnection cannot write late on its own.
    applyStartDeadlineMs: 60_000,
    // After a write with an unknown outcome its files stay this long past the deadline, so a
    // script that started in time can still read them.
    fileGraceMs: 120_000,
    resultTtlMs: 30 * 60_000,
    maxComputeMs: 10 * 60_000,
    // Job records kept per task (each without pixels once it has ended). Older ended records
    // are dropped first; their request_id stays known in the ledger below.
    maxJobsPerTask: 12,
    // Different request_ids one task may use. The ledger of used keys is small (an id, a hash
    // and the final outcome per key), but it must not grow without end; past this limit start
    // refuses and the agent finishes the task and starts a new one.
    maxRequestsPerTask: 100,
    maxReadyResults: 2,
    sweepIntervalMs: 30_000,
    // The next run removes our leftover files only when they are at least this old. It must
    // stay well above applyStartDeadlineMs + fileGraceMs (3 minutes by default), the time a
    // late script may still read the files of a write with an unknown outcome.
    orphanMinAgeMs: 15 * 60_000
};

const COMPUTING_PHASES = new Set(['checking_document', 'computing']);
const TERMINAL_PHASES = new Set(['applied', 'apply_unknown', 'cancelled', 'failed', 'invalidated', 'discarded']);

/**
 * Wait for a promise, but no longer than the given time. The promise itself keeps running.
 *
 * @param {Promise} promise - A promise that never rejects.
 * @param {number} ms - Longest wait.
 * @returns {Promise<void>}
 */
async function waitAtMost(promise, ms) {
    if (!promise || ms <= 0) return;
    let timer = null;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, ms); });
    try {
        await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @param {number|null} ms - Epoch milliseconds.
 * @returns {string|null} ISO time.
 */
function iso(ms) {
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Create the job manager.
 *
 * @param {object} options
 * @param {object} options.tasks - Task registry (task-session.js).
 * @param {() => object|null} options.getBridge - The plugin channel; used for its runtime id.
 * @param {object} [options.logger] - Diagnostics.
 * @param {(workerData: object) => object} [options.createWorker] - Worker factory; tests
 *   replace it. The object must emit 'message', 'error' and 'exit' and have terminate().
 * @param {() => number} [options.now] - Clock; tests replace it.
 * @param {object} [options.limits] - Overrides of DEFAULT_OPTIONS (tests, development).
 * @returns {object} { start, status, apply, cancel, dispose, describe, options }
 */
function createSkinTextureJobs({
    tasks,
    getBridge,
    logger = console,
    createWorker = workerData => new Worker(WORKER_FILE, { workerData }),
    now = () => Date.now(),
    limits = {}
}) {
    const options = { ...DEFAULT_OPTIONS, ...limits };
    const core = adapter.getCoreIdentity();
    const formulasCore = recipeCatalog.getFormulasCoreIdentity();

    // taskId -> { taskId, jobs: Map<jobId, job>, requests: Map<requestId, ledgerEntry>, closed, closedReason }
    // A ledger entry is { jobId, keyHash, retired }: retired is null while the job record is
    // kept, and a short summary of how the job ended once the record has been dropped.
    const stores = new Map();
    // Exchange files of writes with an unknown outcome: removed once their grace has passed.
    const pendingRemovals = [];
    // Data folders already swept for orphans in this Helper run.
    const sweptFolders = new Set();
    let disposed = false;
    // The promise dispose() returned; repeated calls get the same one.
    let disposing = null;

    const sweepTimer = setInterval(sweep, options.sweepIntervalMs);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

    const unsubscribe = tasks.subscribe((type, payload) => {
        if (!payload) return;
        if (type === 'finished' || type === 'aborted' || type === 'expired') {
            closeTask(payload.id, type === 'finished'
                ? 'the task was finished'
                : `the task ended (${payload.abortReason || type})`);
        } else if (type === 'suspended') {
            const suspension = payload.suspension || {};
            // A write that is still being prepared must not go out when the line comes back:
            // the pause is remembered on the attempt and checked right before sending.
            markPreparingInterrupted(payload.id, suspension);
            if (suspension.requiresRebind) {
                // A new UXP runtime has lost the document binding the result was computed for.
                invalidateTask(payload.id, 'RUNTIME_CHANGED',
                    'The Photoshop plugin runtime restarted, so this result can no longer be written.');
            }
        }
    });

    // ── Small helpers ──────────────────────────────────────────────────────────

    function newJobId() {
        return `skt-${crypto.randomBytes(6).toString('hex')}`;
    }

    function storeFor(taskId, create = false) {
        let store = stores.get(taskId);
        if (!store && create) {
            store = { taskId, jobs: new Map(), requests: new Map(), closed: false, closedReason: null };
            stores.set(taskId, store);
        }
        return store || null;
    }

    /**
     * A short fingerprint of a request's normalised arguments. The ledger keeps this instead
     * of the arguments themselves, which is enough to tell "the same request again" from "the
     * same key with other arguments".
     *
     * @param {string} key - request.key from the adapter (normalised JSON of the arguments).
     * @returns {string} 32 hex digits.
     */
    function keyHashOf(key) {
        return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
    }

    /**
     * A refusal with a few machine-readable facts next to the message (the original job of
     * a used request_id, for example). The tool layer puts them into the answer.
     *
     * @param {string} code - Refusal code.
     * @param {string} message - Text for the agent.
     * @param {object} [details] - Extra facts.
     * @returns {adapter.SkinRequestError}
     */
    function refusalError(code, message, details) {
        const error = new adapter.SkinRequestError(code, message);
        if (details) error.details = details;
        return error;
    }

    /**
     * Before a job record is dropped, keep in its ledger entry what the agent may still need
     * to know about it: how it ended and, after a write, the ids of its layers. No pixels, no
     * parameters, no files.
     *
     * @param {object} store - The task's store.
     * @param {object} job - The job whose record is being dropped.
     */
    function retireRecord(store, job) {
        const entry = store.requests.get(job.requestId);
        if (!entry || entry.jobId !== job.id) return;
        const attempt = job.apply;
        entry.retired = {
            phase: job.phase,
            code: (job.error && job.error.code) || (attempt && attempt.code) || null,
            layers: attempt && Array.isArray(attempt.layers)
                ? attempt.layers.map(layer => ({ output: layer.output, id: layer.id }))
                : null
        };
    }

    /**
     * @param {object} entry - A ledger entry whose job record was dropped.
     * @returns {string} How that job ended, in words.
     */
    function retiredOutcomeText(entry) {
        const r = entry.retired;
        let text = `job ${entry.jobId} ended as "${r.phase}"`;
        if (r.code && r.code !== 'APPLIED') text += ` (${r.code})`;
        if (r.layers && r.layers.length) {
            text += `; it wrote the layer${r.layers.length === 1 ? '' : 's'} `
                + r.layers.map(layer => `${layer.id} (${layer.output})`).join(', ');
        }
        return text;
    }

    /**
     * @param {object} entry - A ledger entry whose job record was dropped.
     * @returns {object} The same facts for the answer's details.
     */
    function retiredDetails(entry) {
        return {
            job_id: entry.jobId,
            phase: entry.retired.phase,
            code: entry.retired.code,
            layer_ids: entry.retired.layers ? entry.retired.layers.map(layer => layer.id) : null,
            record_kept: false
        };
    }

    function activeRuntimeId() {
        const bridge = getBridge();
        if (!bridge || typeof bridge.getActiveRuntimeId !== 'function') return null;
        return bridge.getActiveRuntimeId() || null;
    }

    function markerOf(job) {
        return `[${job.id}]`;
    }

    function layerNameOf(job, output) {
        return `Skin texture ${output} ${markerOf(job)}`;
    }

    function historyNameOf(job) {
        if (job.request && job.request.recipe) {
            return `skin texture ${job.id}: recipe ${job.request.recipe}`;
        }
        return `skin texture ${job.id}: ${job.request.outputs.join(', ')}`;
    }

    function dropResult(job) {
        if (job.result) job.result.files = null;
    }

    function stopWorker(job) {
        const worker = job.worker;
        job.worker = null;
        if (job.computeTimer) {
            clearTimeout(job.computeTimer);
            job.computeTimer = null;
        }
        if (worker) {
            try {
                Promise.resolve(worker.terminate()).catch(() => {});
            } catch {
                // Already gone.
            }
        }
    }

    /**
     * End a job that has not been written, unless it already reached a final phase.
     */
    function endUnwritten(job, phase, code, message, retryable = false) {
        if (!COMPUTING_PHASES.has(job.phase) && job.phase !== 'ready') return false;
        stopWorker(job);
        dropResult(job);
        job.phase = phase;
        job.error = code ? { code, message, retryable } : null;
        job.times.endedAt = now();
        return true;
    }

    function failJob(job, code, message, retryable = false) {
        return endUnwritten(job, 'failed', code, message, retryable);
    }

    function invalidate(job, code, message) {
        return endUnwritten(job, 'invalidated', code, message);
    }

    /**
     * Turn a transport failure into a code, and say whether it provably changed nothing.
     *
     * @param {Error} error - What callPlugin threw.
     * @param {object} transport - The caller's transport, with the plugin's markers.
     * @returns {{code: string, message: string, definite: boolean, retryable: boolean, documentClosed: boolean}}
     */
    function classifyTransportError(error, transport) {
        const markers = transport.markers || {};
        let message = String((error && error.message) || error || 'unknown error');
        if (error && error.code === 'PANEL_CLOSED') {
            return { code: 'PHOTOSHOP_UNAVAILABLE', message, definite: true, retryable: true, documentClosed: false };
        }
        if (markers.photoshopBusy && message.includes(markers.photoshopBusy)) {
            message = message.replace(markers.photoshopBusy, '').trim();
            return { code: 'PHOTOSHOP_BUSY', message, definite: true, retryable: true, documentClosed: false };
        }
        if (markers.documentClosed && message.includes(markers.documentClosed)) {
            message = message.replace(markers.documentClosed, '').trim();
            return { code: 'DOCUMENT_CLOSED', message, definite: true, retryable: false, documentClosed: true };
        }
        if (/not bound to a document/i.test(message)) {
            return { code: 'TASK_NOT_BOUND', message, definite: true, retryable: false, documentClosed: false };
        }
        return { code: 'NO_ANSWER', message, definite: false, retryable: true, documentClosed: false };
    }

    // ── Start ──────────────────────────────────────────────────────────────────

    /**
     * Start (or repeat) a request. Registration happens synchronously, before the first
     * await, so two calls with the same request_id that arrive together share one job.
     *
     * @param {object} task - The running task (already checked by the caller).
     * @param {object} args - Tool arguments.
     * @param {object} transport - { run(code, historyName, timeoutMs), markers, onDocumentClosed }.
     * @returns {Promise<{job: object, repeated: boolean}>}
     * @throws {adapter.SkinRequestError} For a refused request; nothing was started.
     */
    async function start(task, args, transport) {
        const startedAt = now();
        if (disposed) throw new adapter.SkinRequestError('SHUTTING_DOWN', 'Helper is quitting.');
        const requestId = checkRequestId(args.request_id);
        const request = adapter.checkRequestShape(args);
        const store = storeFor(task.id, true);
        const keyHash = keyHashOf(request.key);

        let job = null;
        const entry = store.requests.get(requestId);
        if (entry) {
            // A used key stays used for the whole task, whether or not its job record is
            // still kept (finding R1): it never starts a second computation.
            if (entry.keyHash !== keyHash) {
                throw refusalError(
                    'REQUEST_ID_CONFLICT',
                    `request_id "${requestId}" was already used in this task for different arguments `
                    + `(job ${entry.jobId}). Use a new request_id for a new request.`,
                    { request_id: requestId, job_id: entry.jobId }
                );
            }
            const existing = store.jobs.get(entry.jobId);
            if (!existing) {
                throw refusalError(
                    'REQUEST_ALREADY_USED',
                    `request_id "${requestId}" was already used in this task: ${retiredOutcomeText(entry)}. `
                    + `Its record is no longer kept (a task keeps the last ${options.maxJobsPerTask} job records), `
                    + 'so this request is not computed or written again. If another texture is wanted, start '
                    + 'it with a new request_id; look at the document first if you are unsure what is there.',
                    { request_id: requestId, ...retiredDetails(entry) }
                );
            }
            const retry = existing.phase === 'failed' && existing.error && existing.error.retryable;
            if (!retry) {
                if (existing.probePromise && existing.phase === 'checking_document') {
                    await waitAtMost(existing.probePromise, options.responseBudgetMs - (now() - startedAt));
                }
                return { job: existing, repeated: true };
            }
            job = existing;
        }

        if (!job && store.requests.size >= options.maxRequestsPerTask) {
            throw refusalError(
                'REQUEST_LIMIT_REACHED',
                `This task has already used ${store.requests.size} different request_ids, the most one task `
                + 'keeps track of. Repeating an earlier request_id still answers, but a new one is refused: '
                + 'finish this task with ps_finish_task and start a new task for more textures.',
                { limit: options.maxRequestsPerTask }
            );
        }

        const busy = Array.from(store.jobs.values()).find(other => COMPUTING_PHASES.has(other.phase) && other !== job);
        if (busy) {
            throw new adapter.SkinRequestError(
                'SLOT_BUSY',
                `Job ${busy.id} of this task is still ${busy.phase === 'computing' ? 'computing' : 'starting'}. `
                + 'Only one texture is computed at a time: wait for it (ps_skin_texture_status) or '
                + 'cancel it (ps_skin_texture_cancel), then start again.'
            );
        }

        if (!job) {
            evictIfNeeded(store);
            job = {
                id: newJobId(),
                taskId: task.id,
                requestId,
                request,
                phase: 'checking_document',
                error: null,
                document: null,
                dataFolder: null,
                dataFolderNative: null,
                runtimeId: null,
                versions: null,
                coreParams: null,
                work: null,
                worker: null,
                computeTimer: null,
                progress: null,
                result: null,
                stats: null,
                diagnostics: null,
                workerTimings: null,
                apply: null,
                pastAttempts: [],
                cancelRequestedAt: null,
                probePromise: null,
                times: { createdAt: now() }
            };
            store.jobs.set(job.id, job);
            store.requests.set(requestId, { jobId: job.id, keyHash, retired: null });
        }

        beginProbe(job, task, transport);
        await waitAtMost(job.probePromise, options.responseBudgetMs - (now() - startedAt));
        return { job, repeated: false };
    }

    function checkRequestId(value) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(value)) {
            throw new adapter.SkinRequestError(
                'INVALID_REQUEST_ID',
                'request_id is required: your own key for this request, 1-80 characters of letters, '
                + 'digits and . _ : -, unique within the task.'
            );
        }
        return value;
    }

    function evictIfNeeded(store) {
        if (store.jobs.size < options.maxJobsPerTask) return;
        const removable = Array.from(store.jobs.values())
            .filter(job => TERMINAL_PHASES.has(job.phase) && !attemptInFlight(job.apply))
            .sort((a, b) => a.times.createdAt - b.times.createdAt);
        while (store.jobs.size >= options.maxJobsPerTask && removable.length) {
            const job = removable.shift();
            // The record goes, the knowledge that its request_id was used stays.
            retireRecord(store, job);
            store.jobs.delete(job.id);
        }
        if (store.jobs.size >= options.maxJobsPerTask) {
            throw new adapter.SkinRequestError(
                'TOO_MANY_JOBS',
                `This task already keeps ${store.jobs.size} skin texture jobs. Cancel the ones you do not need.`
            );
        }
    }

    function beginProbe(job, task, transport) {
        job.phase = 'checking_document';
        job.error = null;
        job.times.probeSentAt = now();
        job.probePromise = runProbe(job, task, transport).catch(error => {
            failJob(job, 'INTERNAL', `Helper failed while starting the job: ${error.message}`, false);
        });
    }

    async function runProbe(job, task, transport) {
        const runtimeBefore = activeRuntimeId();
        if (!runtimeBefore) {
            failJob(job, 'RUNTIME_UNKNOWN',
                'The Photoshop plugin did not identify its runtime, so a later write could not be '
                + 'checked against it. Ask the person to turn the "FromPS / ToPS AI" line off and on, then start again.', true);
            return;
        }

        let answer;
        try {
            answer = await transport.run(scripts.buildProbeScript(), 'skin texture: read document', options.probeTimeoutMs);
        } catch (error) {
            const failure = classifyTransportError(error, transport);
            if (failure.documentClosed && typeof transport.onDocumentClosed === 'function') transport.onDocumentClosed();
            failJob(job, failure.code, failure.message, failure.code !== 'DOCUMENT_CLOSED' && failure.code !== 'TASK_NOT_BOUND');
            return;
        }
        if (job.phase !== 'checking_document') return;
        job.times.probeMs = now() - job.times.probeSentAt;

        if (activeRuntimeId() !== runtimeBefore) {
            failJob(job, 'RUNTIME_CHANGED', 'The Photoshop plugin runtime changed while the document was being read. Start again.', true);
            return;
        }

        const result = answer && answer.result;
        if (!result || result.probe !== 'skin-texture-probe-1' || !result.document) {
            failJob(job, 'PROBE_INVALID', 'Photoshop answered the document check with something unexpected.', true);
            return;
        }
        const d = result.document;
        if (task.documentId !== null && task.documentId !== undefined && d.id !== task.documentId) {
            failJob(job, 'DOCUMENT_MISMATCH', `The plugin read document ${d.id}, but the task is bound to ${task.documentId}.`);
            return;
        }
        if (!d.rgb) {
            failJob(job, 'UNSUPPORTED_MODE', `The document "${d.name}" is ${d.mode}; the skin texture supports RGB documents only (8 or 16 bit).`);
            return;
        }
        if (d.bitsPerChannel !== 8 && d.bitsPerChannel !== 16) {
            failJob(job, 'UNSUPPORTED_DEPTH', `The document "${d.name}" is ${d.bitsText}; the skin texture supports 8 and 16 bits per channel only.`);
            return;
        }
        if (d.profileType === 'unknown') {
            failJob(job, 'UNSUPPORTED_PROFILE', 'The document\'s colour profile type could not be read.');
            return;
        }
        if (d.bitsPerChannel === 16 && d.profileType === 'none') {
            // Photoshop refused untagged 16-bit data in task02 ("A color profile must be
            // specified for the source data") and tagging it with a made-up profile would
            // shift the numbers. Not supported until it is proven on a real document.
            failJob(job, 'UNSUPPORTED_PROFILE',
                `The document "${d.name}" is RGB 16-bit without a colour profile. That combination is not `
                + 'supported: Photoshop needs a profile for 16-bit data and the tool does not invent one. '
                + 'The person can assign a profile or use an 8-bit copy.');
            return;
        }

        let folder;
        try {
            folder = exchangeFiles.checkDataFolder(result.dataFolder);
        } catch (error) {
            failJob(job, 'DATA_FOLDER_UNAVAILABLE', error.message, true);
            return;
        }

        let normalized;
        try {
            normalized = adapter.normalizeForDocument(job.request, { width: d.width, height: d.height });
        } catch (error) {
            failJob(job, error.code || 'INVALID_REQUEST', error.message, false);
            return;
        }

        job.document = {
            id: d.id,
            name: d.name,
            width: d.width,
            height: d.height,
            rgb: true,
            mode: d.mode,
            bitsPerChannel: d.bitsPerChannel,
            bitsText: d.bitsText,
            profileType: d.profileType,
            profileName: d.profileName
        };
        job.dataFolder = folder;
        job.dataFolderNative = result.dataFolder;
        job.runtimeId = runtimeBefore;
        job.versions = result.versions || null;
        job.coreParams = normalized.coreParams;
        job.work = normalized.work;
        maybeSweepOrphans(folder);
        startCompute(job);
    }

    // ── Compute ────────────────────────────────────────────────────────────────

    function startCompute(job) {
        job.phase = 'computing';
        job.times.computeStartedAt = now();
        job.progress = { stage: 'starting', at: now() };
        const isRecipeJob = Boolean(job.request && job.request.recipe);
        const meta = {
            jobId: job.id,
            taskId: job.taskId,
            document: { id: job.document.id, width: job.document.width, height: job.document.height },
            rect: job.request.rect,
            recipe_id: (job.request && job.request.recipe) || null,
            core: isRecipeJob
                ? { version: formulasCore.version, sha256: formulasCore.sha256 }
                : { version: core.version, sha256: core.sha256 }
        };

        let worker;
        try {
            if (isRecipeJob) {
                worker = createWorker({
                    recipe: job.request.recipe,
                    formulaParams: job.coreParams,
                    params: job.coreParams,
                    outputs: job.request.outputs,
                    meta
                });
            } else {
                worker = createWorker({ params: job.coreParams, outputs: job.request.outputs, meta });
            }
        } catch (error) {
            failJob(job, 'WORKER_FAILED', `The computation could not be started: ${error.message}`);
            return;
        }
        job.worker = worker;
        job.computeTimer = setTimeout(() => {
            if (job.worker !== worker) return;
            failJob(job, 'COMPUTE_TIMEOUT', `The computation took longer than ${Math.round(options.maxComputeMs / 60000)} minutes and was stopped.`);
        }, options.maxComputeMs);
        if (typeof job.computeTimer.unref === 'function') job.computeTimer.unref();

        worker.on('message', message => {
            if (job.worker !== worker || !message) return;
            if (message.type === 'progress') {
                job.progress = { stage: message.stage, at: message.at || now() };
            } else if (message.type === 'result') {
                clearTimeout(job.computeTimer);
                job.computeTimer = null;
                job.worker = null;
                onComputed(job, message);
            } else if (message.type === 'error') {
                failJob(job, 'COMPUTE_FAILED', `The texture core failed: ${message.message}`);
            }
        });
        worker.on('error', error => {
            if (job.worker !== worker) return;
            failJob(job, 'COMPUTE_FAILED', `The computation failed: ${error && error.message}`);
        });
        worker.on('exit', code => {
            if (job.worker !== worker) return;
            failJob(job, 'COMPUTE_FAILED', `The computation stopped (exit code ${code}) without a result.`);
        });
    }

    function onComputed(job, message) {
        if (job.phase !== 'computing') return;
        const outputs = job.request.outputs;
        const filesByOutput = message.files || {};
        if (outputs.some(output => !(filesByOutput[output] instanceof Uint8Array))) {
            failJob(job, 'COMPUTE_FAILED', 'The computation returned an incomplete result.');
            return;
        }
        const bytes = outputs.reduce((sum, output) => sum + filesByOutput[output].length, 0);
        job.result = { files: filesByOutput, checksums: message.checksums || {}, bytes };
        job.stats = message.stats || null;
        job.workerTimings = message.timings || null;
        job.times.readyAt = now();
        job.times.computeMs = job.times.readyAt - job.times.computeStartedAt;
        job.times.expiresAt = job.times.readyAt + options.resultTtlMs;
        job.progress = null;
        job.diagnostics = buildDiagnostics(job);
        job.phase = 'ready';
        if (job.cancelRequestedAt) {
            endUnwritten(job, 'cancelled', null, null);
            return;
        }
        enforceReadyLimit(storeFor(job.taskId), job);
    }

    function enforceReadyLimit(store, keep) {
        if (!store) return;
        const ready = Array.from(store.jobs.values())
            .filter(job => job.phase === 'ready' && job !== keep)
            .sort((a, b) => a.times.readyAt - b.times.readyAt);
        while (ready.length + 1 > options.maxReadyResults && ready.length) {
            const oldest = ready.shift();
            endUnwritten(oldest, 'discarded', 'RESULT_REPLACED',
                `Only ${options.maxReadyResults} unwritten results are kept per task; this one was the oldest.`);
        }
    }

    function buildDiagnostics(job) {
        if (job.request && job.request.recipe === 'skin_pair_v1') {
            const stats = job.stats || {};
            const stats1 = stats.formula_1 || {};
            const stats2 = stats.formula_2 || {};
            const layers = {};
            if (stats1.layers) {
                for (const [k, v] of Object.entries(stats1.layers)) {
                    layers[`formula_1_${k}`] = {
                        min: v.min,
                        max: v.max,
                        mean: Math.round(v.mean * 1000) / 1000,
                        clippedFraction: v.clippedFraction
                    };
                }
            }
            if (stats2.layers) {
                for (const [k, v] of Object.entries(stats2.layers)) {
                    layers[`formula_2_${k}`] = {
                        min: v.min,
                        max: v.max,
                        mean: Math.round(v.mean * 1000) / 1000,
                        clippedFraction: v.clippedFraction
                    };
                }
            }
            const f1Notes = (job.coreParams && job.coreParams.formula_1)
                ? adapter.visibilityNotes(job.coreParams.formula_1, stats1, ['pores', 'furrows'])
                : [];
            const f2Notes = (job.coreParams && job.coreParams.formula_2)
                ? adapter.visibilityNotes(job.coreParams.formula_2, stats2, ['pores', 'furrows'])
                : [];
            return {
                layers,
                formulas: {
                    formula_1: {
                        suppressed: stats1.suppressed || null,
                        pores: stats1.pores ? { counts: stats1.pores.counts, visible: stats1.pores.visible } : null,
                        notes: f1Notes
                    },
                    formula_2: {
                        suppressed: stats2.suppressed || null,
                        pores: stats2.pores ? { counts: stats2.pores.counts, visible: stats2.pores.visible } : null,
                        notes: f2Notes
                    }
                },
                notes: [...new Set([...f1Notes, ...f2Notes])]
            };
        }

        const stats = job.stats || {};
        const layers = {};
        for (const output of job.request.outputs) {
            const s = stats.layers && stats.layers[output];
            if (s) {
                layers[output] = {
                    min: s.min,
                    max: s.max,
                    mean: Math.round(s.mean * 1000) / 1000,
                    clippedFraction: s.clippedFraction
                };
            }
        }
        const suppressed = stats.suppressed || null;
        const pores = stats.pores
            ? { counts: stats.pores.counts, visible: stats.pores.visible, measuredDensity: stats.pores.measuredDensity, targetDensity: stats.pores.targetDensity }
            : null;
        return {
            layers,
            suppressed,
            pores,
            nonFiniteReplacements: stats.nonFiniteReplacements || 0,
            notes: adapter.visibilityNotes(job.coreParams, stats, job.request.outputs)
        };
    }

    // ── Apply ──────────────────────────────────────────────────────────────────

    /**
     * Write a ready job, or report the outcome of the write already made.
     *
     * @param {object} task - The running task.
     * @param {string} jobId - Job id.
     * @param {object} transport - See start().
     * @returns {Promise<{job: object, refusal?: object}>}
     */
    async function apply(task, jobId, transport, maskSource) {
        const startedAt = now();
        const job = findJob(task.id, jobId);

        // If a write is in flight or already finished (applied or terminal/unknown), calling apply again
        // returns what happened the first time without re-validating arguments.
        if (attemptInFlight(job.apply)) {
            await waitAtMost(job.apply.promise, options.responseBudgetMs - (now() - startedAt));
            return { job };
        }
        if (job.apply && job.apply.state !== 'not_applied') return { job };

        if (job.request && job.request.recipe === 'skin_pair_v1') {
            if (!maskSource || typeof maskSource !== 'object') {
                throw new adapter.SkinRequestError(
                    'MASK_SOURCE_REQUIRED',
                    'mask_source is required for recipe skin_pair_v1: { kind: "selection" } or { kind: "layer_mask", layer_id: <integer> }.'
                );
            }
            if (maskSource.kind !== 'selection' && maskSource.kind !== 'layer_mask') {
                throw new adapter.SkinRequestError('INVALID_MASK_SOURCE', 'mask_source.kind must be "selection" or "layer_mask".');
            }
            if (maskSource.kind === 'layer_mask' && !Number.isInteger(maskSource.layer_id)) {
                throw new adapter.SkinRequestError('INVALID_MASK_SOURCE', 'mask_source.layer_id must be an integer layer ID.');
            }
        } else {
            if (maskSource !== undefined) {
                throw new adapter.SkinRequestError('INVALID_ARGUMENT', 'mask_source is only valid for recipe jobs (e.g. skin_pair_v1).');
            }
        }

        if (job.phase !== 'ready') {
            return { job, refusal: refusalForPhase(job) };
        }
        if (now() > job.times.expiresAt) {
            endUnwritten(job, 'discarded', 'RESULT_EXPIRED', 'The result was kept for its full time without being written.');
            return { job, refusal: refusalForPhase(job) };
        }
        const runtime = activeRuntimeId();
        if (!runtime || runtime !== job.runtimeId) {
            invalidate(job, 'RUNTIME_CHANGED',
                'The Photoshop plugin runtime is not the one that reported the document when this job started, '
                + 'so the result is not written. Start a new request.');
            return { job, refusal: refusalForPhase(job) };
        }
        if (task.documentId !== job.document.id) {
            invalidate(job, 'DOCUMENT_CHANGED', 'The task is bound to another document now. Start a new request.');
            return { job, refusal: refusalForPhase(job) };
        }

        if (job.apply) job.pastAttempts.push(summarizeAttempt(job.apply));
        const attempt = {
            number: job.pastAttempts.length + 1,
            // 'preparing' while the exchange files are written (nothing sent yet), then
            // 'sending' once the command is handed to the transport, see runApply.
            state: 'preparing',
            startedAt: now(),
            files: [],
            maskSource: maskSource || null,
            historyName: historyNameOf(job),
            // Set when the task is paused while this attempt is still being prepared.
            interruption: null,
            promise: null
        };
        job.apply = attempt;
        job.phase = 'preparing_write';
        attempt.promise = runApply(job, attempt, transport).catch(error => {
            settleApply(job, attempt, attempt.state === 'preparing'
                ? { state: 'not_applied', retryable: true, code: 'INTERNAL',
                    message: `Helper failed while preparing the write: ${error.message}. Nothing was sent to Photoshop.` }
                : { state: 'unknown', code: 'INTERNAL', message: `Helper failed during the write: ${error.message}` });
        });
        await waitAtMost(attempt.promise, options.responseBudgetMs - (now() - startedAt));
        return { job };
    }

    /**
     * @param {object|null} attempt - An apply attempt.
     * @returns {boolean} Whether it is still being prepared or waiting for Photoshop's answer.
     */
    function attemptInFlight(attempt) {
        return Boolean(attempt) && (attempt.state === 'preparing' || attempt.state === 'sending');
    }

    /**
     * Remember on the attempts still being prepared for this task that the task was paused.
     * A paused write is never sent later by itself, even if the line is back by the time its
     * files are on disk: the agent has to call apply again, which checks everything again.
     *
     * @param {string} taskId - The suspended task.
     * @param {object} suspension - The registry's suspension record.
     */
    function markPreparingInterrupted(taskId, suspension) {
        const store = storeFor(taskId);
        if (!store) return;
        for (const job of store.jobs.values()) {
            const attempt = job.apply;
            if (!attempt || attempt.state !== 'preparing') continue;
            const before = attempt.interruption;
            attempt.interruption = {
                reason: suspension.reason || 'the connection to Photoshop was lost',
                requiresRebind: Boolean((before && before.requiresRebind) || suspension.requiresRebind)
            };
        }
    }

    /**
     * Why a prepared write must not be sent now, or null when it may be sent. Everything is
     * read from the live state at this very moment: this manager's own flags, the task
     * registry, the plugin channel, and the caller's own checks (its AI line and an open
     * interactive dialog, transport.checkBeforeSend).
     *
     * @param {object} job - The job.
     * @param {object} attempt - Its attempt, still 'preparing'.
     * @param {object} transport - See start(); checkBeforeSend() is optional.
     * @returns {object|null} An outcome for settleApply in which nothing was sent.
     */
    function reasonNotToSend(job, attempt, transport) {
        const unsent = (code, message, extra = {}) => ({
            state: 'not_applied',
            retryable: true,
            code,
            message: `${message} Nothing was sent to Photoshop and nothing was changed.`,
            ...extra
        });
        if (disposed) return unsent('HELPER_QUIT', 'Helper is quitting.');
        // Reading the registry also expires a task that went silent; the subscription then
        // closes its store at once.
        const current = tasks.getCurrent();
        const store = storeFor(job.taskId);
        if (!store || store.closed || !current || current.id !== job.taskId) {
            return unsent('TASK_ENDED', `The task ended before the write was sent${store && store.closedReason ? ` (${store.closedReason})` : ''}.`);
        }
        if (job.cancelRequestedAt) return unsent('CANCELLED', 'Cancelled before the write was sent.');
        const runtime = activeRuntimeId();
        const interruption = attempt.interruption;
        if ((interruption && interruption.requiresRebind) || (runtime && runtime !== job.runtimeId)) {
            return unsent('RUNTIME_CHANGED',
                'The Photoshop plugin runtime changed while the write was being prepared, so this result may no '
                + 'longer be written. Start a new request.', { invalidate: true });
        }
        if (current.documentId !== job.document.id) {
            return unsent('DOCUMENT_CHANGED', 'The task is bound to another document now. Start a new request.', { invalidate: true });
        }
        if (interruption || current.state !== 'running') {
            return unsent('PAUSED_BEFORE_SEND',
                'The task was paused while the write was being prepared '
                + `(${(interruption && interruption.reason) || 'the Photoshop connection is paused'}), so the write was `
                + 'stopped; it is never sent by itself when the line comes back. Once the line is back, call '
                + 'ps_skin_texture_apply again: it checks the document and the plugin again before writing.');
        }
        if (!runtime) return unsent('PHOTOSHOP_UNAVAILABLE', 'The Photoshop plugin is not connected.');
        const blocked = transport && typeof transport.checkBeforeSend === 'function' ? transport.checkBeforeSend() : null;
        if (blocked) return unsent(blocked.code || 'NOT_SENT', blocked.message || 'The write cannot be sent right now.');
        return null;
    }

    /**
     * End an attempt that was stopped before sending. Its own publish has finished (or never
     * started) at this point, so no file of ours is open any more; its files are removed
     * before the outcome is reported, and nothing is left on disk after a cancel.
     */
    async function stopBeforeSending(job, attempt, outcome) {
        await exchangeFiles.removeOwn(job.dataFolder, attempt.files);
        settleApply(job, attempt, outcome);
    }

    async function runApply(job, attempt, transport) {
        if (job.request && job.request.recipe === 'skin_pair_v1') {
            const components = recipeCatalog.getRecipeComponents(job.request.recipe);
            const names = components.map(c => exchangeFiles.fileNameFor(job.id, attempt.number, c.componentKey));
            attempt.files = names;
            let t = now();
            for (let i = 0; i < components.length; i++) {
                // Stop early between files; the decisive check is the one right before sending.
                const early = reasonNotToSend(job, attempt, transport);
                if (early) {
                    await stopBeforeSending(job, attempt, early);
                    return;
                }
                try {
                    await exchangeFiles.publish(job.dataFolder, names[i], job.result.files[components[i].componentKey]);
                } catch (error) {
                    await exchangeFiles.removeOwn(job.dataFolder, names);
                    settleApply(job, attempt, {
                        state: 'not_applied',
                        retryable: true,
                        code: 'PUBLISH_FAILED',
                        message: `The texture could not be handed to Photoshop: ${error.message}. Nothing was changed.`
                    });
                    return;
                }
            }
            attempt.publishMs = now() - t;

            const stopped = reasonNotToSend(job, attempt, transport);
            if (stopped) {
                await stopBeforeSending(job, attempt, stopped);
                return;
            }
            attempt.deadlineEpochMs = now() + options.applyStartDeadlineMs;
            const code = scripts.buildRecipeApplyScript({
                jobId: job.id,
                taskId: job.taskId,
                recipe: job.request.recipe,
                marker: markerOf(job),
                document: {
                    id: job.document.id,
                    width: job.document.width,
                    height: job.document.height,
                    bitsPerChannel: job.document.bitsPerChannel,
                    profileType: job.document.profileType,
                    profileName: job.document.profileName
                },
                rect: job.request.rect,
                maskSource: attempt.maskSource,
                components: components.map((c, i) => ({
                    ...c,
                    file: names[i],
                    recipeId: job.request.recipe,
                    coreVersion: formulasCore.version,
                    coreSha256: formulasCore.sha256
                })),
                dataFolder: job.dataFolderNative,
                deadlineEpochMs: attempt.deadlineEpochMs
            });
            attempt.state = 'sending';
            attempt.sentAt = now();
            job.phase = 'applying';

            let answer;
            t = now();
            try {
                answer = await transport.run(code, attempt.historyName, options.applyTransportTimeoutMs);
            } catch (error) {
                attempt.waitMs = now() - t;
                const failure = classifyTransportError(error, transport);
                if (failure.documentClosed && typeof transport.onDocumentClosed === 'function') transport.onDocumentClosed();
                if (failure.definite) {
                    settleApply(job, attempt, {
                        state: 'not_applied',
                        retryable: failure.retryable,
                        code: failure.code,
                        message: `${failure.message} Nothing was changed by this write.`
                    });
                } else {
                    settleApply(job, attempt, { state: 'unknown', code: failure.code, message: failure.message });
                }
                return;
            }
            attempt.waitMs = now() - t;
            settleApply(job, attempt, interpretApplyAnswer(job, answer));
            return;
        }

        const outputs = job.request.outputs;
        const names = outputs.map(output => exchangeFiles.fileNameFor(job.id, attempt.number, output));
        attempt.files = names;
        let t = now();
        for (let i = 0; i < outputs.length; i++) {
            // Stop early between files; the decisive check is the one right before sending.
            const early = reasonNotToSend(job, attempt, transport);
            if (early) {
                await stopBeforeSending(job, attempt, early);
                return;
            }
            try {
                await exchangeFiles.publish(job.dataFolder, names[i], job.result.files[outputs[i]]);
            } catch (error) {
                await exchangeFiles.removeOwn(job.dataFolder, names);
                settleApply(job, attempt, { state: 'not_applied', retryable: true, code: 'PUBLISH_FAILED',
                    message: `The texture could not be handed to Photoshop: ${error.message}. Nothing was changed.` });
                return;
            }
        }
        attempt.publishMs = now() - t;

        // From this check to transport.run() nothing awaits. The last check and the mark
        // "sent" are one synchronous step, so whatever arrived while the files were being
        // written (a cancel, a pause, a new runtime, the end of the task, an open dialog,
        // Helper quitting) is seen here, and a cancel that comes after this step is told the
        // truth: the write was sent. transport.run() reaches the bridge's send synchronously
        // as well (callPlugin -> sendCommandAndWait -> sendCommand).
        const stopped = reasonNotToSend(job, attempt, transport);
        if (stopped) {
            await stopBeforeSending(job, attempt, stopped);
            return;
        }
        attempt.deadlineEpochMs = now() + options.applyStartDeadlineMs;
        const code = scripts.buildApplyScript({
            jobId: job.id,
            taskId: job.taskId,
            marker: markerOf(job),
            document: {
                id: job.document.id,
                width: job.document.width,
                height: job.document.height,
                bitsPerChannel: job.document.bitsPerChannel,
                profileType: job.document.profileType,
                profileName: job.document.profileName
            },
            rect: job.request.rect,
            outputs: outputs.map((output, i) => ({ output, file: names[i], layerName: layerNameOf(job, output) })),
            dataFolder: job.dataFolderNative,
            deadlineEpochMs: attempt.deadlineEpochMs
        });
        attempt.state = 'sending';
        attempt.sentAt = now();
        job.phase = 'applying';

        let answer;
        t = now();
        try {
            answer = await transport.run(code, attempt.historyName, options.applyTransportTimeoutMs);
        } catch (error) {
            attempt.waitMs = now() - t;
            const failure = classifyTransportError(error, transport);
            if (failure.documentClosed && typeof transport.onDocumentClosed === 'function') transport.onDocumentClosed();
            if (failure.definite) {
                settleApply(job, attempt, { state: 'not_applied', retryable: failure.retryable, code: failure.code,
                    message: `${failure.message} Nothing was changed by this write.` });
            } else {
                settleApply(job, attempt, { state: 'unknown', code: failure.code, message: failure.message });
            }
            return;
        }
        attempt.waitMs = now() - t;
        settleApply(job, attempt, interpretApplyAnswer(job, answer));
    }

    /**
     * Read the apply script's answer. Success is reported only when the script itself says
     * the layers were written and their ids and bounds are consistent with the request; a
     * transport that merely did not throw is not success.
     */
    function interpretApplyAnswer(job, answer) {
        const r = answer && answer.result;
        const historyStep = answer && answer.status ? answer.status.historyStep || null : null;
        if (!r || typeof r !== 'object' || r.jobId !== job.id) {
            return { state: 'unknown', code: 'ANSWER_INVALID', message: 'Photoshop answered, but not with the result of this write.' };
        }
        const rect = job.request.rect;
        if (r.ok === true) {
            if (job.request && job.request.recipe) {
                const structure = r.structure;
                const layers = Array.isArray(r.layers) ? r.layers : [];
                const consistent = structure && structure.mainGroup && structure.mainGroup.hasUserMask
                    && Array.isArray(structure.subgroups) && structure.subgroups.length === 2
                    && layers.length === 4
                    && layers.every(layer => Number.isInteger(layer.id) && layer.bounds
                        && layer.bounds.left === rect.x && layer.bounds.top === rect.y
                        && layer.bounds.right === rect.x + rect.width && layer.bounds.bottom === rect.y + rect.height);
                if (!consistent) {
                    return { state: 'unknown', code: 'ANSWER_INCONSISTENT', message: 'Photoshop reported a recipe write whose structure does not match the request.', structure, layers };
                }
                return { state: 'applied', code: 'APPLIED', layers, structure, scriptTimings: r.timings || null, historyStep };
            }
            const layers = Array.isArray(r.layers) ? r.layers : [];
            const consistent = layers.length === job.request.outputs.length
                && layers.every((layer, i) => layer && layer.output === job.request.outputs[i] && Number.isInteger(layer.id)
                    && layer.bounds && layer.bounds.left === rect.x && layer.bounds.top === rect.y
                    && layer.bounds.right === rect.x + rect.width && layer.bounds.bottom === rect.y + rect.height);
            if (!consistent) {
                return { state: 'unknown', code: 'ANSWER_INCONSISTENT', message: 'Photoshop reported a write whose layers do not match the request.', layers };
            }
            return { state: 'applied', code: 'APPLIED', layers, scriptTimings: r.timings || null, historyStep };
        }
        const message = String(r.message || r.code || 'the write failed');
        if (r.changed === false) {
            if (r.code === 'STALE_DOCUMENT' || r.code === 'DATA_FOLDER_CHANGED') {
                return { state: 'not_applied', retryable: false, invalidate: true, code: r.code, message };
            }
            if (r.code === 'ALREADY_PRESENT') {
                return { state: 'unknown', code: r.code, message, existingLayers: r.existingLayers || [] };
            }
            if (r.code === 'APPLY_EXPIRED') {
                return { state: 'not_applied', retryable: true, code: r.code, message };
            }
            const retryable = [
                'NO_SELECTION',
                'SELECTION_READ_FAILED',
                'LAYER_NOT_FOUND',
                'NO_LAYER_MASK',
                'LAYER_MASK_READ_FAILED',
                'INVALID_MASK_SOURCE',
                'MASK_NOT_FOUND',
                'UNSUPPORTED_MASK',
                'UNSUPPORTED_MASK_PROPERTIES'
            ].includes(r.code);
            return { state: 'not_applied', retryable, code: r.code || 'WRITE_REFUSED', message };
        }
        if (r.changed === 'rolled_back') {
            return { state: 'not_applied', retryable: false, code: r.code || 'WRITE_FAILED',
                message: `${message}. The layers this write had created were deleted again, so the document `
                    + `content is as before; the History panel may still show an empty step "Agent: ${job.apply.historyName}".`,
                rolledBack: r.rolledBack || [] };
        }
        return { state: 'unknown', code: r.code || 'WRITE_FAILED',
            message: `${message}. Some layers of this write may remain: ${JSON.stringify(r.leftover || [])}.`,
            leftover: r.leftover || [] };
    }

    function settleApply(job, attempt, outcome) {
        if (!attemptInFlight(attempt)) return;
        Object.assign(attempt, outcome);
        attempt.settledAt = now();
        const store = storeFor(job.taskId);
        const taskClosed = !store || store.closed;

        if (attempt.state === 'applied') {
            job.phase = 'applied';
            dropResult(job);
            removeFiles(job.dataFolder, attempt.files);
        } else if (attempt.state === 'not_applied') {
            removeFiles(job.dataFolder, attempt.files);
            job.phase = 'ready';
            if (disposed) {
                endUnwritten(job, 'discarded', 'HELPER_QUIT', 'Not written: Helper was quitting.');
            } else if (outcome.invalidate) {
                invalidate(job, outcome.code, outcome.message);
            } else if (taskClosed || outcome.code === 'TASK_ENDED') {
                endUnwritten(job, 'discarded', 'TASK_ENDED', store && store.closedReason ? `Not written: ${store.closedReason}.` : 'Not written: the task ended.');
            } else if (job.cancelRequestedAt) {
                endUnwritten(job, 'cancelled', null, null);
            } else if (!outcome.retryable) {
                failJob(job, outcome.code, outcome.message, false);
            }
        } else {
            attempt.state = 'unknown';
            job.phase = 'apply_unknown';
            dropResult(job);
            const after = (attempt.deadlineEpochMs || now()) + options.fileGraceMs;
            if (attempt.files.length) pendingRemovals.push({ folder: job.dataFolder, names: attempt.files, after });
        }
        if (logger && typeof logger.info === 'function') {
            logger.info(`[skin-texture] ${job.id} write ${attempt.state}${attempt.code ? ` (${attempt.code})` : ''}`);
        }
    }

    function summarizeAttempt(attempt) {
        return {
            number: attempt.number,
            state: attempt.state,
            sent: Boolean(attempt.sentAt),
            code: attempt.code || null,
            message: attempt.message || null
        };
    }

    function removeFiles(folder, names) {
        if (!folder || !names || !names.length) return;
        exchangeFiles.removeOwn(folder, names).then(failed => {
            if (failed.length && logger && typeof logger.warn === 'function') {
                logger.warn(`[skin-texture] Could not remove ${failed.join(', ')}`);
            }
        }).catch(() => {});
    }

    // ── Status and cancel ──────────────────────────────────────────────────────

    function findJob(taskId, jobId) {
        const store = storeFor(taskId);
        const job = store && typeof jobId === 'string' ? store.jobs.get(jobId) : null;
        if (!job && store) {
            // A job whose record was dropped: say how it ended, so an apply after the
            // person's Undo is not mistaken for "never written". Nothing is sent for it.
            for (const [requestId, entry] of store.requests) {
                if (entry.jobId !== jobId || !entry.retired) continue;
                throw refusalError(
                    'JOB_UNKNOWN',
                    `Job ${jobId} (request_id "${requestId}") is no longer kept: a task keeps the last `
                    + `${options.maxJobsPerTask} job records. ${retiredOutcomeText(entry).replace(/^job \S+ /, 'It ')}. `
                    + 'A dropped job is never computed or written again; for another texture start a new '
                    + 'request with a new request_id.',
                    { request_id: requestId, ...retiredDetails(entry) }
                );
            }
        }
        if (!job) {
            throw new adapter.SkinRequestError(
                'JOB_UNKNOWN',
                `There is no skin texture job "${jobId}" in task ${taskId}. Jobs belong to the task that `
                + 'started them; an old job may also have been dropped after its retention.'
            );
        }
        return job;
    }

    /**
     * @param {string} taskId - The job's task (running, paused, or the last closed one).
     * @param {string} jobId - Job id.
     * @returns {{job: object}}
     */
    function status(taskId, jobId) {
        const job = findJob(taskId, jobId);
        if (job.phase === 'ready' && now() > job.times.expiresAt) {
            endUnwritten(job, 'discarded', 'RESULT_EXPIRED', 'The result was kept for its full time without being written.');
        }
        return { job };
    }

    /**
     * @param {string} taskId - The job's task (running, paused, or the last closed one).
     * @param {string} jobId - Job id.
     * @returns {Promise<{job: object, note: string}>}
     */
    async function cancel(taskId, jobId) {
        const job = findJob(taskId, jobId);
        if (COMPUTING_PHASES.has(job.phase) || job.phase === 'ready') {
            job.cancelRequestedAt = now();
            endUnwritten(job, 'cancelled', null, null);
            return { job, note: 'Cancelled before anything was written; the computation and its result are gone.' };
        }
        if (job.phase === 'preparing_write') {
            // Nothing was sent: the attempt sees this flag in its check right before sending.
            // Wait (within the budget) until its file hand-over has stopped and its files are gone.
            job.cancelRequestedAt = job.cancelRequestedAt || now();
            await waitAtMost(job.apply.promise, options.responseBudgetMs);
            if (job.phase === 'cancelled') {
                return { job, note: 'Cancelled before the write was sent to Photoshop: nothing was sent and nothing '
                    + 'was changed; the result and its files are gone.' };
            }
            if (job.phase === 'preparing_write') {
                return { job, note: 'Cancelled before the write was sent to Photoshop: it will not be sent and nothing '
                    + 'was changed. Helper is still finishing the file hand-over and then removes its files; '
                    + 'ps_skin_texture_status shows "cancelled" in a moment.' };
            }
            // It ended in another way at the same moment (the task ended, say); described below.
        }
        if (job.phase === 'applying') {
            job.cancelRequestedAt = job.cancelRequestedAt || now();
            return {
                job,
                note: 'The write was already sent to Photoshop, so cancel cannot take it back and does not '
                    + 'promise that nothing changed. Call ps_skin_texture_status for its outcome; written layers '
                    + 'are removed with Undo or by deleting them.'
            };
        }
        if (job.phase === 'applied') {
            return { job, note: 'Already written; cancel does not remove layers. Undo (one History step) or deleting the layers does.' };
        }
        if (job.phase === 'apply_unknown') {
            return { job, note: 'The outcome of the write is unknown; cancel changes nothing. Look at the document first.' };
        }
        return { job, note: `Nothing to cancel: the job is already ${job.phase}.` };
    }

    // ── Task life cycle and housekeeping ───────────────────────────────────────

    function closeTask(taskId, reason) {
        const store = storeFor(taskId);
        if (!store) return;
        store.closed = true;
        store.closedReason = reason;
        // Unwritten jobs end here. A write still being prepared ends in its own check before
        // sending (it sees the closed store), so it is never sent for a closed task.
        for (const job of store.jobs.values()) {
            endUnwritten(job, 'discarded', 'TASK_ENDED', `Not written: ${reason}.`);
        }
        // Keep the closed task's records for status (they hold no pixels any more), and drop
        // older closed tasks unless a write of theirs is still being prepared or waiting for
        // its answer.
        for (const [id, other] of stores) {
            if (id === taskId || !other.closed) continue;
            const pending = Array.from(other.jobs.values()).some(job => attemptInFlight(job.apply));
            if (!pending) stores.delete(id);
        }
    }

    function invalidateTask(taskId, code, message) {
        const store = storeFor(taskId);
        if (!store) return;
        for (const job of store.jobs.values()) invalidate(job, code, message);
    }

    function sweep() {
        if (disposed) return;
        try {
            // The task registry expires an abandoned task lazily, on its next read. Reading it
            // here lets its results go even when nobody calls a tool any more.
            tasks.getCurrent();
        } catch {
            // Never let housekeeping throw.
        }
        const t = now();
        for (const store of stores.values()) {
            for (const job of store.jobs.values()) {
                if (job.phase === 'ready' && t > job.times.expiresAt) {
                    endUnwritten(job, 'discarded', 'RESULT_EXPIRED', 'The result was kept for its full time without being written.');
                }
            }
        }
        for (let i = pendingRemovals.length - 1; i >= 0; i--) {
            const entry = pendingRemovals[i];
            if (t >= entry.after) {
                pendingRemovals.splice(i, 1);
                removeFiles(entry.folder, entry.names);
            }
        }
    }

    function liveFileNames() {
        const names = new Set();
        for (const store of stores.values()) {
            for (const job of store.jobs.values()) {
                if (job.apply) for (const name of job.apply.files || []) names.add(name);
            }
        }
        for (const entry of pendingRemovals) for (const name of entry.names) names.add(name);
        return names;
    }

    function maybeSweepOrphans(folder) {
        if (sweptFolders.has(folder)) return;
        sweptFolders.add(folder);
        exchangeFiles.sweepOrphans(folder, { liveNames: liveFileNames(), minAgeMs: options.orphanMinAgeMs, now })
            .then(report => {
                if (report.removed.length && logger && typeof logger.info === 'function') {
                    logger.info(`[skin-texture] Removed ${report.removed.length} orphaned exchange file(s) from an earlier run.`);
                }
            })
            .catch(() => {});
    }

    /**
     * Stop everything. Workers are terminated and unwritten results dropped. Files are removed
     * only where that is safe:
     * - a write that is known to have finished or known not to have changed anything: now;
     * - a write still being prepared: it is never sent (its check before sending sees
     *   `disposed`), and it removes its own files once its file hand-over has finished, so a
     *   file it still holds open is not deleted blindly;
     * - a write whose outcome is unknown: its files stay until its start deadline plus
     *   fileGraceMs (finding R3), because a script that started in time may still be reading
     *   them. Past that time they are removed now; before it they are left to the next run's
     *   orphan sweep, which removes only provably own files older than orphanMinAgeMs;
     * - a write that was sent and has no answer yet: its files stay as well (its transport
     *   timeout is shorter than its deadline plus grace, so it is always inside that time).
     * Nothing is ever resumed from a file left behind.
     * Called from Helper's quit path, which does not wait for the returned promise; it settles
     * once the writes that were being prepared have stopped (bounded by responseBudgetMs).
     *
     * @returns {Promise<void>}
     */
    function dispose() {
        if (disposing) return disposing;
        disposed = true;
        clearInterval(sweepTimer);
        unsubscribe();
        const t = now();
        const preparing = [];
        for (const store of stores.values()) {
            for (const job of store.jobs.values()) {
                const attempt = job.apply;
                if (attempt && attempt.state === 'preparing') {
                    preparing.push(attempt.promise);
                } else if (attempt && (attempt.state === 'applied' || attempt.state === 'not_applied') && job.dataFolder) {
                    exchangeFiles.removeOwn(job.dataFolder, attempt.files || [], { sync: true });
                }
                // 'sending' and 'unknown' keep their files; 'unknown' ones are in pendingRemovals.
                endUnwritten(job, 'discarded', 'HELPER_QUIT', 'Not written: Helper was quitting.');
            }
        }
        let kept = 0;
        for (let i = pendingRemovals.length - 1; i >= 0; i--) {
            const entry = pendingRemovals[i];
            if (t >= entry.after) {
                pendingRemovals.splice(i, 1);
                exchangeFiles.removeOwn(entry.folder, entry.names, { sync: true });
            } else {
                kept += entry.names.length;
            }
        }
        if (kept && logger && typeof logger.info === 'function') {
            logger.info(`[skin-texture] Kept ${kept} exchange file(s) of writes with an unknown outcome until their `
                + 'safe time; the next run removes them as orphans.');
        }
        disposing = Promise.all(preparing.map(promise => waitAtMost(promise, options.responseBudgetMs))).then(() => {});
        return disposing;
    }

    // ── What the agent sees ────────────────────────────────────────────────────

    function refusalForPhase(job) {
        const reasons = {
            checking_document: 'The job is still starting; it is not ready to write.',
            computing: 'The texture is still being computed; it is not ready to write. Call ps_skin_texture_status.',
            cancelled: 'The job was cancelled; there is nothing to write.',
            failed: 'The job failed; there is nothing to write.',
            invalidated: 'The result may no longer be written (see error).',
            discarded: 'The result is gone (see error).'
        };
        return { code: `NOT_READY_${job.phase.toUpperCase()}`, message: reasons[job.phase] || `The job is ${job.phase}.` };
    }

    function nextStep(job) {
        switch (job.phase) {
            case 'checking_document':
                return 'Helper is reading the document facts from Photoshop. Call ps_skin_texture_status in a few seconds.';
            case 'computing':
                return 'Computing. Call ps_skin_texture_status again in 5-10 seconds; large areas can take a minute or more. Nothing is written until you call ps_skin_texture_apply.';
            case 'ready':
                if (job.request && job.request.recipe) {
                    return `Call ps_skin_texture_apply with job_id "${job.id}" and mask_source ({ kind: "selection" } or { kind: "layer_mask", layer_id: <id> }) to write the Skin group. The result is kept until ${iso(job.times.expiresAt)}.`;
                }
                return `Call ps_skin_texture_apply with job_id "${job.id}" to write the layers. The result is kept until ${iso(job.times.expiresAt)}.`;
            case 'preparing_write':
                return 'Helper is handing the texture file over; the write has NOT been sent to Photoshop yet. '
                    + 'ps_skin_texture_cancel now still stops it with no change to the document. Call '
                    + 'ps_skin_texture_status in a moment. Calling apply again does not start a second write.';
            case 'applying':
                return 'The write was sent to Photoshop. Call ps_skin_texture_status in a few seconds. Calling apply again does not write a second time.';
            case 'applied':
                if (job.request && job.request.recipe) {
                    return 'Skin texture recipe applied. The Skin group has been assembled with Formula 2 (active) and Formula 1 (hidden), 50% Linear Light component layers, and a common user mask on the Skin group. Written to the document as a single Photoshop History step; undo removes it completely. Calling ps_skin_texture_apply again will not write a second time. Adjust visibility, layer opacities, or mask as needed using the returned layer IDs.';
                }
                return 'Written. Set the blend mode (usually Linear Light or Soft Light), the strength (Fill or Opacity), '
                    + 'the mask and Blend If yourself with ps_execute_script; there are no defaults for them. One Undo '
                    + 'removes the whole write; calling apply again never writes it again.';
            case 'apply_unknown':
                return `The outcome of the write is unknown. Before anything else look at the document (ps_get_document) `
                    + `for layers whose names contain "${markerOf(job)}". Do not repeat the write: apply will not send it `
                    + 'again. If the layers are missing and the texture is still wanted, start a new request.';
            case 'cancelled':
                return 'Cancelled; this job wrote nothing.';
            case 'failed':
                return job.error && job.error.retryable
                    ? 'Fix the cause, then call ps_skin_texture_start again: the same request_id with the same arguments retries a failure that happened before computing.'
                    : 'Fix the cause and start a new request with a new request_id.';
            case 'invalidated':
                return 'The document or the plugin changed since start, so this result is not written. Start a new request.';
            case 'discarded':
                return 'The result is gone; start a new request if the texture is still wanted.';
            default:
                return '';
        }
    }

    /**
     * The job as the agent sees it: compact, plain JSON, no pixels.
     *
     * @param {object} job - Job.
     * @param {object} [view]
     * @param {boolean} [view.withParams] - Include the normalised core parameters.
     * @returns {object}
     */
    function describe(job, { withParams = true } = {}) {
        const out = {
            job_id: job.id,
            task_id: job.taskId,
            request_id: job.requestId,
            phase: job.phase,
            // Whether ps_skin_texture_cancel can still stop this job with the document
            // guaranteed unchanged: true up to and including preparing_write, false once the
            // write has been sent (applying and later) or the job has ended.
            can_cancel_without_change: COMPUTING_PHASES.has(job.phase) || job.phase === 'ready' || job.phase === 'preparing_write',
            next_step: nextStep(job)
        };
        if (job.error) out.error = { code: job.error.code, message: job.error.message, retryable: Boolean(job.error.retryable) };
        if (job.document) {
            out.document = {
                id: job.document.id,
                name: job.document.name,
                width: job.document.width,
                height: job.document.height,
                mode: 'RGB',
                bits_per_channel: job.document.bitsPerChannel,
                color_profile: job.document.profileType === 'none' ? 'none (not colour managed)' : job.document.profileName
            };
        }
        out.rect = job.request.rect;
        out.px_per_mm = job.request.pxPerMm;
        out.outputs = job.request.outputs;

        if (job.request && job.request.recipe) {
            out.recipe_id = job.request.recipe;
            out.core = {
                version: formulasCore.version,
                sha256: formulasCore.sha256,
                matches_pinned: formulasCore.matchesPinned
            };
            out.formulas = {
                formula_1: {
                    formula_id: 'formula_1',
                    formula_version: 1,
                    name: 'Formula 1',
                    visible: false,
                    outputs: ['pores', 'furrows'],
                    params: withParams && job.coreParams && job.coreParams.formula_1 ? adapter.publicParams(job.coreParams.formula_1) : undefined
                },
                formula_2: {
                    formula_id: 'formula_2',
                    formula_version: 1,
                    name: 'Formula 2',
                    visible: true,
                    outputs: ['pores', 'furrows'],
                    params: withParams && job.coreParams && job.coreParams.formula_2 ? adapter.publicParams(job.coreParams.formula_2) : undefined
                }
            };
            if (job.request.params) out.recipe_params = job.request.params;
        } else {
            out.layer_names = job.request.outputs.map(output => layerNameOf(job, output));
            if (withParams && job.coreParams) out.params = adapter.publicParams(job.coreParams);
            out.core = { version: core.version, sha256: core.sha256, matches_pinned: core.matchesPinned };
        }

        if (job.phase === 'computing' && job.progress) {
            out.progress = { stage: job.progress.stage, elapsed_ms: now() - job.times.computeStartedAt };
        }
        const times = { created_at: iso(job.times.createdAt) };
        if (Number.isFinite(job.times.probeMs)) times.document_check_ms = job.times.probeMs;
        if (Number.isFinite(job.times.computeMs)) times.compute_ms = job.times.computeMs;
        if (job.workerTimings) times.compute_stages_ms = job.workerTimings;
        if (job.times.readyAt) times.ready_at = iso(job.times.readyAt);
        if (job.phase === 'ready') times.result_expires_at = iso(job.times.expiresAt);
        out.times = times;
        if (job.work) {
            out.work = { blur_radius_px: job.work.radius, working_pixels: job.work.heightPixels, estimated_memory_mb: Math.round(job.work.estimatedBytes / 1048576) };
        }
        if (job.result && job.result.checksums) {
            out.result = { checksums: job.result.checksums, bytes: job.result.bytes, held_in_memory: Boolean(job.result.files) };
        }
        if (job.diagnostics) out.diagnostics = job.diagnostics;
        if (job.apply) {
            const a = job.apply;
            const applyView = {
                state: a.state,
                attempt: a.number,
                // Whether this attempt's command was handed to Photoshop. 'preparing' never was.
                sent: Boolean(a.sentAt),
                history_name: `Agent: ${a.historyName}`
            };
            if (a.code) applyView.code = a.code;
            if (a.message) applyView.message = a.message;
            if (typeof a.retryable === 'boolean') applyView.retryable = a.retryable;
            if (a.structure) applyView.structure = a.structure;
            if (a.maskSource) applyView.mask_source = a.maskSource;
            if (a.layers) applyView.layers = a.layers.map(layer => ({ output: layer.output, id: layer.id, name: layer.name, bounds: layer.bounds, parent: layer.parent || null }));
            if (a.existingLayers) applyView.existing_layers = a.existingLayers;
            if (a.leftover) applyView.leftover_layer_ids = a.leftover;
            if (a.historyStep) applyView.history_step = a.historyStep;
            const applyTimes = {};
            if (Number.isFinite(a.publishMs)) applyTimes.file_ms = a.publishMs;
            if (Number.isFinite(a.waitMs)) applyTimes.photoshop_round_trip_ms = a.waitMs;
            if (a.scriptTimings) applyTimes.photoshop_script_ms = a.scriptTimings.totalMs;
            if (a.state === 'sending') applyTimes.sent_ms_ago = a.sentAt ? now() - a.sentAt : 0;
            applyView.times = applyTimes;
            if (job.cancelRequestedAt && attemptInFlight(a)) applyView.cancel_requested = true;
            out.apply = applyView;
            if (job.pastAttempts.length) out.apply.earlier_attempts = job.pastAttempts;
        }
        return out;
    }

    return {
        start,
        status,
        apply,
        cancel,
        dispose,
        describe,
        options,
        core,
        // Exported for testing only; lets tests run the periodic housekeeping at once.
        _sweep: sweep
    };
}

module.exports = {
    createSkinTextureJobs,
    DEFAULT_OPTIONS,
    WORKER_FILE,
    // Exported for testing only; the same helper the job manager uses to bound its waits.
    waitAtMost
};
