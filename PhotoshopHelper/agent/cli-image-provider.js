'use strict';

/**
 * Virtual WebHelper provider backed by an installed command-line agent.
 *
 * The public provider definition is created in memory from the user's CLI settings. The
 * existing API generator then calls the private route from this module exactly as it would
 * call a remote image API. Keeping that boundary means the mature provider pipeline does
 * not need a CLI-specific branch.
 *
 * IMPORTANT: `file_path` and parameter `ui_position` below are private runtime contracts
 * and should not be copied into providers.user.json.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { buildCliImagePrompt } = require('./cli-prompts');

const CLI_IMAGE_PROVIDER_ID = 'native-cli-image-generator';
const INTERNAL_AUTH_HEADER = 'x-photoshop-helper-internal-key';
const CLI_IMAGE_RUN_PREFIX = 'cli-image-';
const CLI_SCRATCH_DIRNAME = '_WH_CliScratch';
const CLI_IMAGE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_REFERENCE_IMAGES = 5;  //All CLIs on the list state that input image size doesn't impact cost or rate limits. However, sending very large images might result in a loss of detail since they are automatically downscaled.
const MAX_RETURNED_IMAGES = 20;
const MAX_OUTPUT_FILE_BYTES = 100 * 1024 * 1024;

// When false, output_directory is omitted from the CLI prompt and images generated anywhere
// on disk are accepted as-is without being copied into outputDir.
const OUTPUT_DIRECTORY_REQUIRED = false;

/**
 * This deliberately short list is UI policy, not a claim about every CLI's limits. It is
 * kept here, next to the virtual provider, so it can be adjusted without editing the shared
 * on-disk provider catalog.
 */
const DEFAULT_ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']; //3:4,4:3 not supported on grok

/**
 * Per-CLI capability profiles and UI labels.
 * Grok does not support 4:3 and 3:4 aspect ratios; Antigravity supports up to 3 references.
 */
const CLI_PROFILES = {
    codex: {
        label: 'OpenAI Codex',
        tag_family: 'gpt-image'
    },
    grok: {
        label: 'xAI Grok',
        allowed_aspect_ratios: ['1:1', '3:2', '2:3', '16:9', '9:16'],
        tag_family: 'grok'
    },
    agy: {
        label: 'Google Antigravity',
        max_reference_images: 3,
        tag_family: 'nana-banana'
    },
    claude: {
        label: 'Claude Code'
    }
};

const CLI_LABELS = Object.fromEntries(
    Object.entries(CLI_PROFILES).map(([cli, profile]) => [cli, profile.label])
);

/**
 * Error type used inside the private endpoint. The machine-readable code is returned in
 * JSON, while the message also contains the code because the existing provider pipeline
 * intentionally reduces remote HTTP errors to readable text.
 */
class CliImageError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'CliImageError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

/**
 * Return CLIs that are usable for image generation right now.
 *
 * A CLI must be installed, enabled, marked as supporting native image generation, and have
 * a Medium model configured. The setting is deliberately respected even if a model cache
 * once reported support, because the checkbox is the user's final choice.
 *
 * @param {object} cliConfig - Result of cli-service.getCliConfig().
 * @returns {Array<{value: string, label: string}>} Dropdown options.
 */
function getEligibleCliOptions(cliConfig) {
    return Object.entries(cliConfig || {})
        .filter(([, config]) => (
            config?.installed === true
            && config?.enabled === true
            && config?.nativeImageGen === true
            && typeof config?.tiers?.medium?.model === 'string'
            && config.tiers.medium.model.trim() !== ''
        ))
        .map(([cli]) => ({
            value: cli,
            label: CLI_LABELS[cli] || cli
        }));
}

/**
 * Build the complete provider used by apiGenerator.generate(). Nothing is written to the
 * provider catalog. Its private fields are implementation details, not additions to the
 * public provider-authoring schema. When no CLI qualifies, null is returned and WebHelper
 * simply does not advertise the provider.
 *
 * @param {object} cliConfig - Merged CLI settings and installation state.
 * @param {object} options - Runtime-only endpoint settings.
 * @param {string} options.endpointUrl - Loopback URL of the private generation endpoint.
 * @param {string} options.internalKey - Per-process secret accepted by that endpoint.
 * @returns {object|null} Virtual provider definition.
 */
function buildCliImageProvider(cliConfig, { endpointUrl, internalKey }) {
    const cliOptions = getEligibleCliOptions(cliConfig);
    if (cliOptions.length === 0) return null;

    const families = [...new Set(
        cliOptions.flatMap(opt => {
            const tf = CLI_PROFILES[opt.value]?.tag_family;
            if (Array.isArray(tf)) return tf;
            return [tf || 'native-image'];
        }).filter(Boolean)
    )];

    return {
        id: CLI_IMAGE_PROVIDER_ID,
        name: 'CLI Native Image Generator',
        nice_name: 'CLI - {{cli}}',
        tags: {
            provider: 'local-cli',
            family: families.length === 1
                ? families[0]
                : (families.length > 1 ? families : 'native-image')
        },
        generation_modes: ['t2i', 'i2i'],
        image_format: 'file_path',
        max_reference_images: {
            depends_on: 'cli',
            default: MAX_REFERENCE_IMAGES,
            values: Object.fromEntries(
                Object.entries(CLI_PROFILES).map(([cliKey, profile]) => [
                    cliKey,
                    profile.max_reference_images ?? MAX_REFERENCE_IMAGES
                ])
            )
        },
        mask_handling: {
            supported: false,
            required: false,
            type: 'none'
        },
        supports_negative_prompt: false,
        //supports_aspect_ratio_auto_in_t2i: true,
        allowed_aspect_ratios: {
            depends_on: 'cli',
            default: DEFAULT_ASPECT_RATIOS.slice(),
            values: Object.fromEntries(
                Object.entries(CLI_PROFILES).map(([cliKey, profile]) => [
                    cliKey,
                    (profile.allowed_aspect_ratios || DEFAULT_ASPECT_RATIOS).slice()
                ])
            )
        },
        parameters: [
            {
                name: 'cli',
                label: 'CLI provider',
                type: 'dropdown',
                default: cliOptions[0].value,
                options: cliOptions
            },
            {
                name: 'prompt',
                alias: 'prompt',
                label: 'Prompt',
                type: 'string',
                default: ''
            },
            {
                name: 'do_not_change_prompt',
                label: 'Use prompt as is',
                type: 'boolean',
                ui_position: 'after_prompt',
                default: false
            },
            {
                name: 'show_cli_window',
                label: 'Show CLI window',
                type: 'boolean',
                default: false
            }
        ],
        remarks: 'Uses the selected CLI\'s Medium tier and its native image-generation allowance.',
        filename_suffix: 'cli_{{cli}}',
        request_config: {
            endpoint_url: endpointUrl,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [INTERNAL_AUTH_HEADER]: internalKey
            },
            single_image_per_request: false,
            body_template: {
                cli: '{{cli}}',
                prompt: '{{prompt}}',
                do_not_change_prompt: '{{do_not_change_prompt}}',
                show_cli_window: '{{show_cli_window}}',
                num_images: '{{num_images}}',
                '{{?aspect_ratio}}aspect_ratio': '{{aspect_ratio}}',
                source_image_path: '{{source_image}}',
                reference_image_paths: '{{resolved_image_array}}'
            }
        },
        response_config: {
            $ref: 'sync',
            params: {
                format: 'file_path',
                extract: [
                    {
                        path: 'images',
                        mode: 'array'
                    }
                ]
            }
        }
    };
}

/**
 * Detect the supported raster format from file bytes. An extension alone is not trusted:
 * the CLI response is model-authored and may point at a non-image file by mistake.
 *
 * @param {Buffer} bytes - First bytes of a file.
 * @returns {{extension: string, mimeType: string}|null} Detected format.
 */
function detectRasterFormat(bytes) {
    if (
        bytes.length >= 8
        && bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
    ) {
        return { extension: 'png', mimeType: 'image/png' };
    }

    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { extension: 'jpg', mimeType: 'image/jpeg' };
    }

    if (
        bytes.length >= 12
        && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return { extension: 'webp', mimeType: 'image/webp' };
    }

    const gifSignature = bytes.subarray(0, 6).toString('ascii');
    if (gifSignature === 'GIF87a' || gifSignature === 'GIF89a') {
        return { extension: 'gif', mimeType: 'image/gif' };
    }

    return null;
}

/**
 * Validate one absolute input path supplied by apiGenerator's private file-path formatter.
 * WebHelper inputs normally live in its temp directory, while the public Local Generation
 * API deliberately accepts readable absolute input paths from elsewhere on disk. The
 * internal endpoint is protected by a per-process secret, so both established workflows
 * can pass their already-authorized paths without copying large inputs first.
 *
 * @param {unknown} value - Candidate local image path.
 * @param {string} fieldName - Name used in validation errors.
 * @param {boolean} [optional=false] - Whether an empty value means no image.
 * @returns {string|null} Canonical absolute file path.
 */
function validateInputImagePath(value, fieldName, optional = false) {
    if (optional && (value === null || value === undefined || value === '')) return null;
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
        throw new CliImageError('invalid_image', `${fieldName} must be an absolute image path.`, 400);
    }

    try {
        const realFilePath = fs.realpathSync(value);
        if (!inspectImageFile(realFilePath)) {
            throw new Error('Path is not a supported image.');
        }
        return realFilePath;
    } catch {
        throw new CliImageError(
            'invalid_image',
            `${fieldName} does not point to a readable PNG, JPEG, WebP, or GIF image.`,
            400
        );
    }
}



/**
 * Find the first complete JSON object in possibly noisy CLI output. Braces inside quoted
 * strings are ignored, unlike a simple first-"{"/first-"}" slice.
 *
 * @param {string} text - CLI response text.
 * @returns {object|null} Parsed object, or null when none is valid.
 */
function extractFirstJsonObject(text) {
    const source = String(text || '');

    for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = start; index < source.length; index += 1) {
            const character = source[index];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (character === '\\') {
                    escaped = true;
                } else if (character === '"') {
                    inString = false;
                }
                continue;
            }

            if (character === '"') {
                inString = true;
                continue;
            }
            if (character === '{') depth += 1;
            if (character === '}') depth -= 1;

            if (depth === 0) {
                try {
                    const value = JSON.parse(source.slice(start, index + 1));
                    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
                } catch {
                    // This brace range was not JSON. Continue searching at the next opening brace.
                }
                break;
            }
        }
    }

    return null;
}

/**
 * Recursively list files created in the requested output directory. The depth is naturally
 * bounded by the finite directory tree; only the first MAX_RETURNED_IMAGES valid images are
 * returned to the existing generator pipeline.
 *
 * @param {string} directory - Directory to scan.
 * @returns {string[]} Absolute file paths.
 */
function listOutputFiles(directory) {
    if (!fs.existsSync(directory)) return [];

    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...listOutputFiles(entryPath));
        else if (entry.isFile()) files.push(entryPath);
    }
    return files;
}

/**
 * Read enough bytes to verify that a path is a supported raster image.
 *
 * @param {string} filePath - Candidate output file.
 * @returns {{path: string, extension: string}|null} Validated file descriptor.
 */
function inspectImageFile(filePath) {
    try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile() || stats.size === 0 || stats.size > MAX_OUTPUT_FILE_BYTES) return null;

        const descriptor = fs.openSync(filePath, 'r');
        try {
            const header = Buffer.alloc(16);
            const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
            const format = detectRasterFormat(header.subarray(0, bytesRead));
            return format
                ? { path: fs.realpathSync(filePath), extension: format.extension }
                : null;
        } finally {
            fs.closeSync(descriptor);
        }
    } catch {
        return null;
    }
}

/**
 * Convert a structured CLI error (or ordinary text) into the stable codes shown by the
 * private endpoint. This makes moderation, aspect-ratio, quota, and timeout failures easy
 * to distinguish without coupling the application to one vendor's exact wording.
 *
 * @param {string} message - Error text.
 * @param {string|null} suggestedCode - Code supplied by the CLI's JSON response.
 * @returns {string} Normalized error code.
 */
function classifyCliError(message, suggestedCode = null) {
    const allowedCodes = new Set([
        'moderation',
        'invalid_aspect_ratio',
        'quota_exhausted',
        'timeout',
        'generation_failed',
        'invalid_response',
        'no_images'
    ]);
    if (allowedCodes.has(suggestedCode)) return suggestedCode;

    const normalized = String(message || '').toLowerCase();
    if (/moderation|safety|content policy|blocked prompt/.test(normalized)) return 'moderation';
    if (/aspect|ratio|dimension|image size|invalid size/.test(normalized)) return 'invalid_aspect_ratio';
    if (/quota|rate limit|usage limit|credit|allowance|capacity/.test(normalized)) return 'quota_exhausted';
    if (/timed? out|timeout|deadline/.test(normalized)) return 'timeout';
    return 'generation_failed';
}

/**
 * Read paths reported by the CLI and supplement them with files actually present in the
 * requested output directory. The scan is an intentional recovery path for CLIs that make
 * the image correctly but surround or omit the requested JSON response.
 *
 * @param {object} runResult - Result of cli-service.runWithSelectedCli().
 * @param {string} outputDir - Directory requested in the CLI prompt.
 * @param {object|null} [parsedResponse=null] - Pre-parsed CLI JSON response, if already extracted.
 * @returns {string[]} Canonical absolute paths inside outputDir.
 */
function collectCliImageOutputs(runResult, outputDir, parsedResponse = null) {
    const response = parsedResponse || extractFirstJsonObject(runResult?.text || '');
    const reported = [];

    if (Array.isArray(response?.images)) {
        for (const image of response.images) {
            const candidate = typeof image === 'string'
                ? image
                : (image?.path || image?.file_path || image?.file || null);
            if (typeof candidate !== 'string' || candidate.trim() === '') continue;
            const resolvedCandidate = path.isAbsolute(candidate)
                ? path.resolve(candidate)
                : path.resolve(outputDir || process.cwd(), candidate);
            if (OUTPUT_DIRECTORY_REQUIRED) {
                if (outputDir && isPathInside(outputDir, resolvedCandidate)) reported.push(resolvedCandidate);
            } else {
                reported.push(resolvedCandidate);
            }
        }
    }

    const fallbackFiles = outputDir && fs.existsSync(outputDir)
        ? listOutputFiles(outputDir)
        : [];
    const candidates = [...reported, ...fallbackFiles];
    const validImages = [];
    const seen = new Set();
    const realOutputDir = (outputDir && fs.existsSync(outputDir))
        ? fs.realpathSync(outputDir)
        : null;

    for (const candidate of candidates) {
        const inspected = inspectImageFile(candidate);
        if (!inspected) continue;
        if (OUTPUT_DIRECTORY_REQUIRED && (!realOutputDir || !isPathInside(realOutputDir, inspected.path))) continue;

        const identity = process.platform === 'win32'
            ? inspected.path.toLowerCase()
            : inspected.path;
        if (seen.has(identity)) continue;
        seen.add(identity);

        // Accept the candidate as-is without copying into task outputDir
        validImages.push(inspected);

        if (validImages.length >= MAX_RETURNED_IMAGES) break;
    }

    if (validImages.length === 0) {
        const responseError = response?.error;
        const responseMessage = typeof responseError === 'string'
            ? responseError
            : responseError?.message;
        const message = responseMessage
            || runResult?.error
            || (response ? 'The CLI reported success but no readable image files were found.' : 'The CLI response was not valid JSON and no image files were found.');
        const suggestedCode = typeof responseError === 'object' ? responseError?.code : null;
        const code = response
            ? classifyCliError(message, suggestedCode)
            : (runResult?.ok === false ? classifyCliError(message) : 'invalid_response');
        const status = code === 'quota_exhausted' ? 429 : (code === 'timeout' ? 504 : 422);
        throw new CliImageError(code, message, status);
    }

    return validImages.map(image => image.path);
}

/**
 * Confirm that a path resolved from route parameters remains within its expected parent.
 *
 * @param {string} parent - Allowed directory.
 * @param {string} candidate - Candidate path.
 * @returns {boolean} True when candidate is inside parent.
 */
function isPathInside(parent, candidate) {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The only directory under the WebHelper temp root where this provider may write.
 *
 * Nothing is created until a run actually needs disk space:
 * - `OUTPUT_DIRECTORY_REQUIRED` — the CLI is told to save rasters in a per-run folder
 *   inside this directory, so a later scan cannot mix images from older runs.
 * - additional reference images — browser Data URIs are stored by SHA-256 under
 *   `references/`, and the CLI's working directory becomes this scratch root so its
 *   own extra files stay in one place. References that are already files are not copied.
 *
 * A text-to-image or source-only request with the output directory disabled does not
 * create this directory at all.
 */
class CliScratchSpace {
    /**
     * @param {string} tempRoot - Existing WebHelper temp root (`ps_webhelper_tasks`).
     */
    constructor(tempRoot) {
        this.tempRoot = tempRoot;
        this.root = path.join(tempRoot, CLI_SCRATCH_DIRNAME);
        this.referencesDir = path.join(this.root, 'references');
    }

    /**
     * Decide whether this run may touch the scratch directory, and create only what it needs.
     *
     * @param {object} options - Run placement inputs.
     * @param {string} options.runId - Unique id used for the output folder when one is required.
     * @param {boolean} options.outputDirectoryRequired - Current `OUTPUT_DIRECTORY_REQUIRED` value.
     * @param {boolean} options.hasAdditionalReferences - True when the request has reference images.
     * @returns {{ cwd: string, outputDir: string|null, usesScratch: boolean }} Placement.
     */
    placeRun({ runId, outputDirectoryRequired, hasAdditionalReferences }) {
        if (!outputDirectoryRequired && !hasAdditionalReferences) {
            return { cwd: this.tempRoot, outputDir: null, usesScratch: false };
        }

        fs.mkdirSync(this.root, { recursive: true });
        if (!outputDirectoryRequired) {
            return { cwd: this.root, outputDir: null, usesScratch: true };
        }

        const outputDir = path.join(this.root, 'runs', `${CLI_IMAGE_RUN_PREFIX}${runId}`);
        fs.mkdirSync(outputDir, { recursive: true });
        return { cwd: this.root, outputDir, usesScratch: true };
    }

    /**
     * Store reference bytes once per SHA-256. A later request with the same bytes
     * reuses the file already on disk, including when the extension differs.
     *
     * @param {Buffer} buffer - Decoded reference image.
     * @param {string} extension - Extension used when the hash is not already stored.
     * @returns {string} Absolute path of the stored image.
     */
    storeReferenceBytes(buffer, extension) {
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            throw new Error('Reference image contains no image bytes.');
        }

        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        fs.mkdirSync(this.referencesDir, { recursive: true });

        for (const knownExtension of ['png', 'jpg', 'webp', 'gif']) {
            const existing = path.join(this.referencesDir, `${hash}.${knownExtension}`);
            if (fs.existsSync(existing)) return path.resolve(existing);
        }

        const filePath = path.join(this.referencesDir, `${hash}.${extension}`);
        const tempPath = path.join(
            this.referencesDir,
            `.${hash}.${process.pid}.${Date.now()}.tmp`
        );
        fs.writeFileSync(tempPath, buffer);
        try {
            fs.renameSync(tempPath, filePath);
        } catch (error) {
            fs.rmSync(tempPath, { force: true });
            if (fs.existsSync(filePath)) return path.resolve(filePath);
            throw error;
        }
        return path.resolve(filePath);
    }
}

/**
 * Persist browser reference Data URIs for the file-path CLI provider.
 *
 * Absolute-path references are not passed through this saver, so files that already
 * live on disk are never copied. Identical Data URI bytes share one hashed file.
 *
 * @param {string} tempRoot - Existing WebHelper temp root.
 * @returns {(base64: string, mime: string, index: number) => string} Reference saver.
 */
function createFilePathReferenceSaver(tempRoot) {
    const scratch = new CliScratchSpace(tempRoot);
    const extensions = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif'
    };

    return (base64, mime, index) => {
        const extension = extensions[String(mime || '').toLowerCase()];
        if (!extension) {
            throw new Error(`Reference image ${index + 1} has an unsupported MIME type: ${mime}.`);
        }

        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length === 0) {
            throw new Error(`Reference image ${index + 1} contains no image bytes.`);
        }
        return scratch.storeReferenceBytes(buffer, extension);
    };
}

/**
 * Create the private endpoint called by the virtual provider.
 *
 * The POST route requires a per-process secret that is never returned to WebHelper.
 * Reported image paths are copied later into `_WH_Generated`. This route itself writes
 * under the temp root only through `CliScratchSpace`.
 *
 * @param {object} options - Runtime dependencies.
 * @param {string} options.tempDir - Existing WebHelper temp directory.
 * @param {string} options.internalKey - Per-process shared secret.
 * @param {Function} options.getCliConfig - CLI configuration loader.
 * @param {Function} options.runWithSelectedCli - Explicit CLI runner.
 * @returns {import('express').Router} Express router.
 */
function createCliImageRouter({
    tempDir,
    internalKey,
    getCliConfig,
    runWithSelectedCli
}) {
    const router = express.Router();
    const scratch = new CliScratchSpace(tempDir);

    router.post('/generate', async (req, res) => {
        // Declared outside the try block so the error response can still report what the
        // agent did before the failure.
        let runResult = null;
        let cliResponse = null;
        try {
            if (!internalKey || req.get(INTERNAL_AUTH_HEADER) !== internalKey) {
                return res.status(401).json({
                    error: { code: 'unauthorized', message: '[unauthorized] Invalid internal key.' }
                });
            }

            const body = req.body || {};
            const cli = typeof body.cli === 'string' ? body.cli.trim() : '';
            const prompt = typeof body.prompt === 'string' ? body.prompt : '';
            const aspectRatio = typeof body.aspect_ratio === 'string' ? body.aspect_ratio.trim() : '';
            const numImages = Number(body.num_images);

            if (!cli) throw new CliImageError('invalid_cli', 'A CLI provider must be selected.', 400);
            if (!Number.isSafeInteger(numImages) || numImages < 1 || numImages > 10) {
                throw new CliImageError('invalid_count', 'num_images must be an integer from 1 to 10.', 400);
            }

            // Re-check live settings instead of trusting an older provider list in the browser.
            const cliConfig = await getCliConfig();
            const eligible = new Set(getEligibleCliOptions(cliConfig).map(option => option.value));
            if (!eligible.has(cli)) {
                throw new CliImageError(
                    'cli_unavailable',
                    `CLI "${cli}" is not installed, enabled, configured for native image generation, and assigned a Medium model.`,
                    400
                );
            }

            const sourcePath = validateInputImagePath(
                body.source_image_path,
                'source_image_path',
                true
            );
            const rawReferencePaths = body.reference_image_paths ?? [];
            if (!Array.isArray(rawReferencePaths)) {
                throw new CliImageError(
                    'invalid_references',
                    'reference_image_paths must be an array.',
                    400
                );
            }
            const allowedRatiosForCli = CLI_PROFILES[cli]?.allowed_aspect_ratios ?? DEFAULT_ASPECT_RATIOS;
            if (aspectRatio && aspectRatio.toLowerCase() !== 'auto' && !allowedRatiosForCli.includes(aspectRatio)) {
                throw new CliImageError(
                    'invalid_aspect_ratio',
                    `Aspect ratio "${aspectRatio}" is not supported for ${CLI_PROFILES[cli]?.label || cli}.`,
                    400
                );
            }

            const maxRefsForCli = CLI_PROFILES[cli]?.max_reference_images ?? MAX_REFERENCE_IMAGES;
            if (rawReferencePaths.length > maxRefsForCli) {
                throw new CliImageError(
                    'too_many_references',
                    `At most ${maxRefsForCli} reference images are supported for ${CLI_PROFILES[cli]?.label || cli}.`,
                    400
                );
            }
            const referencePaths = rawReferencePaths.map((referencePath, index) => (
                validateInputImagePath(
                    referencePath,
                    `reference_image_paths[${index}]`
                )
            ));
            const placement = scratch.placeRun({
                runId: crypto.randomUUID(),
                outputDirectoryRequired: OUTPUT_DIRECTORY_REQUIRED,
                hasAdditionalReferences: referencePaths.length > 0
            });
            const cliPrompt = buildCliImagePrompt({
                prompt,
                doNotChangePrompt: body.do_not_change_prompt === true,
                numImages,
                aspectRatio,
                sourcePath,
                referencePaths,
                outputDir: placement.outputDir,
                outputDirectoryRequired: OUTPUT_DIRECTORY_REQUIRED
            });

            // The tier is intentionally fixed at Medium for this first implementation.
            const tier = 'medium';
            runResult = await runWithSelectedCli(cli, cliPrompt, tier, {
                cwd: placement.cwd,
                timeoutMs: CLI_IMAGE_TIMEOUT_MS,
                showWindow: body.show_cli_window === true,
                // Codex only reports its thinking when asked; the other CLIs do not need it.
                reasoningSummary: 'detailed'
            });
            cliResponse = extractFirstJsonObject(runResult?.text || '');
            const images = collectCliImageOutputs(runResult, placement.outputDir, cliResponse);
            // const reportedFinalPrompt = typeof cliResponse?.final_prompt === 'string' && cliResponse.final_prompt.trim()
            //     ? cliResponse.final_prompt.trim()
            //     : (typeof cliResponse?.prompt === 'string' && cliResponse.prompt.trim()
            //         ? cliResponse.prompt.trim()
            //         : null);

            const tierConfig = cliConfig[cli]?.tiers?.[tier] || {};
            const model = typeof tierConfig.model === 'string' ? tierConfig.model.trim() : '';
            const effort = tierConfig.effort || null;

            return res.json({
                status: 'done',
                images,
                cli,
                tier,
                model,
                effort,
                cli_prompt: cliPrompt,
                //final_prompt: reportedFinalPrompt,
                cli_response: cliResponse || runResult?.text || null,
                // Everything the agent showed while it worked: thoughts, remarks between
                // steps, tool calls and their output. Empty when the CLI showed nothing.
                cli_transcript: runResult?.transcript || ''
            });
        } catch (error) {
            const normalized = error instanceof CliImageError
                ? error
                : new CliImageError(
                    classifyCliError(error?.message),
                    error?.message || 'CLI image generation failed.',
                    500
                );
            let finalErrorMessage = String(normalized.message || 'CLI image generation failed.').slice(0, 1200);
            if (typeof runResult?.text === 'string' && runResult.text.trim()) {
                finalErrorMessage = runResult.text;
            }
            // Clients read only the message, so what the agent showed while it worked
            // travels inside it.
            if (typeof runResult?.transcript === 'string' && runResult.transcript.trim()) {
                finalErrorMessage += `\n\n--- CLI transcript ---\n${runResult.transcript.trim()}`;
            }
            return res.status(normalized.httpStatus || 500).json({
                error: {
                    code: normalized.code,
                    message: `[${normalized.code}] ${finalErrorMessage}`
                }
            });
        }
    });

    return router;
}

module.exports = {
    // Production API imported by main.js and apiGenerator.js.
    CLI_IMAGE_PROVIDER_ID,
    buildCliImageProvider,
    createCliImageRouter,
    createFilePathReferenceSaver,

    // TEST-ONLY EXPORTS: Production code uses these helpers only through the provider
    // builder, the router, and the reference saver above. They are exported solely for
    // focused unit tests of CLI eligibility, prompt construction, response parsing,
    // output containment, and scratch-directory placement.
    // Keep future internal helpers private unless a test imports them directly.
    INTERNAL_AUTH_HEADER,
    OUTPUT_DIRECTORY_REQUIRED, // Exported solely for test verification and toggle inspection
    CLI_PROFILES, // Exported solely for tests and profile inspection
    CLI_SCRATCH_DIRNAME, // Exported solely for tests that assert the scratch location
    CliScratchSpace, // Exported for testing only
    getEligibleCliOptions,
    buildCliImagePrompt,
    extractFirstJsonObject,
    classifyCliError,
    collectCliImageOutputs
};
