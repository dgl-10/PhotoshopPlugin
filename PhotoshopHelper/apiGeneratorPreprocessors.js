const { nativeImage } = require('electron');
const { parseImageInput } = require('./imageUtils');

// Global mapping of supported aspect ratios (ordered from widest to tallest). See also webhelper.js
const ASPECT_RATIO_VALUES = {
    "21:9": 21 / 9,   // ~2.333
    "2:1": 2 / 1,     // 2.0
    "16:9": 16 / 9,   // ~1.778
    "3:2": 3 / 2,     // 1.5
    "4:3": 4 / 3,     // ~1.333
    "5:4": 5 / 4,     // 1.25
    "1:1": 1.0,
    "4:5": 4 / 5,     // 0.8
    "3:4": 3 / 4,     // 0.75
    "2:3": 2 / 3,     // ~0.666
    "9:16": 9 / 16,   // ~0.5625
    "1:2": 1 / 2,     // 0.5
    "9:21": 9 / 21    // ~0.4286
};

const ALL_ASPECT_RATIOS = Object.keys(ASPECT_RATIO_VALUES);

/**
 * Returns the list of allowed aspect ratios for the provider.
 * 
 * @param {Object} provider - Provider configuration object
 * @param {Object} [userParams] - Current user parameters for dynamic dependencies
 * @returns {string[]}
 */
function getAlowedAspectRatios(provider, userParams = {}) {
    if (!provider || provider.allowed_aspect_ratios === undefined) return ALL_ASPECT_RATIOS;

    const arConfig = provider.allowed_aspect_ratios;

    // Simple array
    if (Array.isArray(arConfig)) return arConfig;

    // Dynamic: depends on the value of another form field
    if (typeof arConfig === 'object' && arConfig.depends_on) {
        const depVal = userParams[arConfig.depends_on];
        if (depVal && arConfig.values && arConfig.values[depVal] !== undefined) {
            return arConfig.values[depVal];
        }
        return arConfig.default ?? ALL_ASPECT_RATIOS;
    }

    return ALL_ASPECT_RATIOS;
}

/**
 * Returns the closest allowed aspect ratio to the given one.
 * 
 * @param {string} aspectRatio - e.g. "2:3"
 * @param {string[]} allowedList - list of allowed ratio strings
 * @returns {string}
 */
function fixAspectRatio(aspectRatio, allowedList) {
    if (!aspectRatio) return "1:1";
    if (allowedList.includes(aspectRatio)) return aspectRatio;
    try {
        let target;
        if (ASPECT_RATIO_VALUES[aspectRatio] !== undefined) {
            target = ASPECT_RATIO_VALUES[aspectRatio];
        } else if (aspectRatio.includes(':')) {
            const parts = aspectRatio.split(':');
            if (parts.length === 2) {
                const [w, h] = parts.map(Number);
                target = w / h;
            }
        }

        if (target === undefined) return "1:1";

        let bestMatch = "1:1";
        let minDiff = Infinity;
        for (const a of allowedList) {
            const val = ASPECT_RATIO_VALUES[a];
            if (val !== undefined) {
                const diff = Math.abs(target - val);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestMatch = a;
                }
            } else if (a.includes(':')) {
                try {
                    const [aw, ah] = a.split(':').map(Number);
                    const diff = Math.abs(target - aw / ah);
                    if (diff < minDiff) {
                        minDiff = diff;
                        bestMatch = a;
                    }
                } catch { }
            }
        }
        return bestMatch;
    } catch { }
    return "1:1";
}

/**
 * Returns the closest standard aspect ratio from the list: ALL_ASPECT_RATIOS
 * 
 * @param {number} width 
 * @param {number} height 
 * @returns {string}
 */
function getAspectRatio(width, height) {
    if (width <= 0 || height <= 0) {
        return "1:1";
    }

    // Real ratio (width / height)
    const ratio = width / height;

    // Find the option with minimum relative difference from the global list
    let bestLabel = "1:1";
    let bestDiff = Infinity;

    for (const [label, stdRatio] of Object.entries(ASPECT_RATIO_VALUES)) {
        // Use relative difference - better for wide range
        const diff = Math.abs(ratio - stdRatio) / Math.max(ratio, stdRatio);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestLabel = label;
        }
    }

    return bestLabel;
}

/**
 * Вычисляет максимальные размеры на основе соотношения сторон
 * @param {string|number} aspectRatio - Строка вида "16:9" или значение
 * @param {number} maxSize - Максимальный размер стороны
 * @param {number} minSize - Минимальный размер стороны
 * @param {Object|null} inputDict - Объект для записи результата
 * @returns {[number, number]} - Массив [width, height]
 */
function geSizeByAspectRatio(aspectRatio, maxSize = 1440, minSize = 256, step = 1, inputDict = null) {
    //const step = 32;
    let wRatio, hRatio;

    try {
        // Парсим строку вида "16:9"
        const parts = String(aspectRatio).split(":");
        if (parts.length === 2) {
            wRatio = parseInt(parts[0], 10);
            hRatio = parseInt(parts[1], 10);
        } else {
            // Если это не строка с двоеточием, пробуем использовать как число или дефолт
            wRatio = 1;
            hRatio = 1;
        }

        // Проверка на NaN после парсинга
        if (isNaN(wRatio) || isNaN(hRatio)) {
            wRatio = 1;
            hRatio = 1;
        }
    } catch (e) {
        wRatio = 1;
        hRatio = 1;
    }

    let width, height;

    if (wRatio > hRatio) {
        width = maxSize;
        height = Math.floor((maxSize / wRatio) * hRatio);
    } else {
        height = maxSize;
        width = Math.floor((maxSize / hRatio) * wRatio);
    }

    // Применяем шаг (кратно 32) и ограничиваем снизу minSize
    // Аналог Python: max(min_size, (width // step) * step)
    width = Math.max(minSize, Math.floor(width / step) * step);
    height = Math.max(minSize, Math.floor(height / step) * step);

    if (inputDict && typeof inputDict === 'object') {
        inputDict.width = width;
        inputDict.height = height;
    }

    return [width, height];
}

/**
 * Calculates optimized dimensions for the image while maintaining aspect ratio.
 * 
 * @param {Object} img - object result form parseImageInput function calling
 * @param {number} [maxSize=1440] - Maximum allowed dimension for the longest side.
 * @param {number} [minSize=256] - Minimum allowed dimension for any side.
 * @param {number} [step=1] - Ensures width and height are multiples of this value (rounding).
 * @param {boolean} [autoResize2Max=false] - If true, scales the image so its longest side matches maxSize.
 * @param {Object|null} inputDict - Объект для записи результата {width, height}
 * @returns {[number, number, string]} A tuple containing the optimized [width, height, aspectRatio].
 */
function getSizeFromNativeImage(img, maxSize = 1440, minSize = 256, step = 1, autoResize2Max = false, inputDict = null) {
    if (!img) return null;

    let width = img.size.width;
    let height = img.size.height;
    let aspectRatio = getAspectRatio(width, height);

    [width, height] = img.getOptimizedSize(maxSize, minSize, step, autoResize2Max);

    // Если передан объект, записываем данные в него (как в Python dict)
    if (inputDict && typeof inputDict === 'object') {
        inputDict.width = width;
        inputDict.height = height;
    }

    return [width, height, aspectRatio];
}

/**
 * Calculates dimensions for a target Megapixel area while maintaining aspect ratio.
 * Ensures the result never exceeds the target area and never upscales original dimensions unless allowUpscale is true.
 * 
 * @param {Object} img - object result form parseImageInput function calling
 * @param {number} targetMP - Target megapixels
 * @param {number} minSize - Minimum side length
 * @param {number} step - Step/multiple for dimensions
 * @param {boolean} allowUpscale - If true, can return dimensions larger than original
 * @returns {[number, number]}
 */
function getSizeByMegapixels(img, targetMP, minSize = 256, step = 1, allowUpscale = false) {
    if (!img) return null;
    return img.getOptimizedSizeByMegapixels(targetMP, minSize, step, allowUpscale);
}

const preprocessors = {
    async image_get_size(provider, payload) {
        const { aspect_ratio, source_image, mask_image, reference_images, user_params, args } = payload;

        let maxSize = args.max_size || 1440;
        const minSize = args.min_size || 256;
        const step = args.step || 1;
        const autoResize2Max = args.auto_resize_2_max || false;

        if (typeof maxSize === 'string') {
            const k = parseInt(maxSize.toUpperCase().replace('K', ''), 10);
            if (!isNaN(k)) {
                maxSize = 1024 * k;
            }
        }

        if (aspect_ratio) {
            const aspectRatios = getAlowedAspectRatios(provider, user_params);
            const fixedAspectRatio = fixAspectRatio(aspect_ratio, aspectRatios);
            [width, height] = geSizeByAspectRatio(fixedAspectRatio, maxSize, minSize, step);
            user_params.calculated_output_size_width = width;
            user_params.calculated_output_size_height = height;
            user_params.calculated_output_size = { width: width, height: height };

            if (aspect_ratio == fixedAspectRatio) {
                user_params.calculated_output_aspect_ratio = aspect_ratio;
            } else {
                user_params.calculated_output_aspect_ratio = fixedAspectRatio;
                user_params.calculated_output_aspect_ratio_changed = true;
            }
        } else {
            const sourceParsed = parseImageInput(source_image);
            if (sourceParsed) {
                //console.log(`[Preprocessor] Source Image: ${sourceParsed.size.width}x${sourceParsed.size.height}, type: ${sourceParsed.mimeType}`);
                [width, height, aspectRatio] = getSizeFromNativeImage(sourceParsed, maxSize, minSize, step, autoResize2Max);

                const aspectRatios = getAlowedAspectRatios(provider, user_params);
                let fixedAspectRatio = fixAspectRatio(aspectRatio, aspectRatios);

                user_params.calculated_output_size_width = width;
                user_params.calculated_output_size_height = height;
                user_params.calculated_output_size = { width: width, height: height };

                if (aspectRatio == fixedAspectRatio) {
                    user_params.calculated_output_aspect_ratio = aspectRatio;
                } else {
                    user_params.calculated_output_aspect_ratio = fixedAspectRatio;
                    user_params.calculated_output_aspect_ratio_changed = true;
                }
            }
        }
        return null;
    },
    async image_get_size_mp(provider, payload) {
        const { aspect_ratio, source_image, mask_image, reference_images, user_params, args } = payload;

        // Resolve optimization parameters from args
        const resolutionRaw = String(args.output_resolution_mp || '1').trim();
        const resolutionMatch = resolutionRaw.match(/^(\d+(?:[.,]\d+)?)(-)?/);
        const resolutionMp = resolutionMatch ? Number(resolutionMatch[1].replace(',', '.')) : 1;
        let allowUpscale;
        // Check if auto_resize_2_max key is NOT in args object, and if modifier exists
        if (!('auto_resize_2_max' in args)) {
            if (resolutionMatch) {
                if (resolutionMatch[2]) {
                    allowUpscale = false; // up to
                } else {
                    allowUpscale = true;  // exact
                }
            } else {
                allowUpscale = true;      // no modifier - exact
            }
        } else {
            allowUpscale = args.auto_resize_2_max || false;
        }
        const alwaysOutput = args.always_output ?? true; // if false - don't output if no needs to change image dimensions

        const minSize = Number(args.min_size) || 256;
        const minAreaRaw = args.min_area || 0;
        const step = Number(args.step) || 1;

        let minArea = 0;
        if (typeof minAreaRaw === 'string' && minAreaRaw.includes('*')) {
            const parts = minAreaRaw.split('*').map(p => parseInt(p.trim(), 10));
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                minArea = parts[0] * parts[1];
            }
        } else {
            minArea = Number(minAreaRaw) || 0;
        }

        let width, height;
        let originalWidth = 0, originalHeight = 0;

        const sourceParsed = source_image ? parseImageInput(source_image) : null;
        if (sourceParsed) {
            originalWidth = sourceParsed.size.width;
            originalHeight = sourceParsed.size.height;
        }

        if (aspect_ratio) {
            const aspectRatios = getAlowedAspectRatios(provider, user_params);
            const fixedAspectRatio = fixAspectRatio(aspect_ratio, aspectRatios);
            const [arW, arH] = fixedAspectRatio.split(':').map(Number);
            const ar = arW / arH;

            let targetArea = resolutionMp * 1024 * 1024;
            if (!allowUpscale && originalWidth && originalHeight) {
                targetArea = Math.min(targetArea, originalWidth * originalHeight);
            }
            if (minArea > 0) {
                targetArea = Math.max(targetArea, minArea);
            }

            // Ideal dimensions
            width = Math.floor(Math.sqrt(targetArea * ar));
            height = Math.floor(width / ar);

            // Apply step and minSize
            width = Math.max(minSize, Math.floor(width / step) * step);
            height = Math.max(minSize, Math.floor(height / step) * step);

            // Final overshoot check
            if (width * height > targetArea && (width > minSize || height > minSize)) {
                if (width >= height) width = Math.max(minSize, width - step);
                else height = Math.max(minSize, height - step);
            }
        } else if (sourceParsed) {
            [width, height] = getSizeByMegapixels(sourceParsed, resolutionMp, minSize, step, allowUpscale);
        } else {
            return null; // Nothing to work with
        }

        // Ensure calculated area satisfies minArea if specified
        if (minArea > 0 && width > 0 && height > 0 && (width * height) < minArea) {
            const scale = Math.sqrt(minArea / (width * height));
            width = Math.max(minSize, Math.ceil((width * scale) / step) * step);
            height = Math.max(minSize, Math.ceil((height * scale) / step) * step);
        }

        const isChanged = width !== originalWidth || height !== originalHeight;
        if (alwaysOutput || isChanged) {
            user_params.calculated_output_size_width = width;
            user_params.calculated_output_size_height = height;
            user_params.calculated_output_size = { width: width, height: height };
            console.log(`[Preprocessor] Set output size: ${width}x${height} (${(width * height / 1024 / 1024).toFixed(3)} MP) | changed: ${isChanged}`);
        }

        return null;
    },
    async image_optimizer_by_min_size(provider, payload) {
        const { aspect_ratio, source_image, mask_image, reference_images, user_params, args } = payload;

        const allowUpscale = args.uscale_2_min || false;
        if (!allowUpscale) return null;

        const minSize = Number(args.min_size) || 256;
        const minAreaRaw = args.min_area || 0;
        const step = Number(args.step) || 1;

        let targetArea = 0;
        if (typeof minAreaRaw === 'string' && minAreaRaw.includes('*')) {
            const parts = minAreaRaw.split('*').map(p => parseInt(p.trim(), 10));
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                targetArea = parts[0] * parts[1];
            }
        } else {
            targetArea = Number(minAreaRaw) || 0;
        }

        const sourceParsed = parseImageInput(source_image);
        if (!sourceParsed) return null;

        const { width: w, height: h } = sourceParsed.size;

        // Calculate scale needed for minSize (both sides must be >= minSize)
        const scaleS = Math.max(minSize / w, minSize / h);

        // Calculate scale needed for minArea
        const scaleA = targetArea > 0 ? Math.sqrt(targetArea / (w * h)) : 0;

        // Use the most "pessimistic" scale (must be at least 1, as we only upscale)
        const finalScale = Math.max(1, scaleS, scaleA);

        if (finalScale > 1) {
            // Apply scale and step (rounding UP to ensure we stay above minimums)
            const nw = Math.ceil((w * finalScale) / step) * step;
            const nh = Math.ceil((h * finalScale) / step) * step;

            console.log(`[Preprocessor] image_optimizer_by_min_size: Resizing ${w}x${h} -> ${nw}x${nh} (scale: ${finalScale.toFixed(3)})`);

            const resizedImg = sourceParsed.image.resize({ width: nw, height: nh });
            const out_source = sourceParsed.pack(resizedImg);
            let out_mask = mask_image;

            if (mask_image) {
                const maskParsed = parseImageInput(mask_image);
                if (maskParsed) {
                    const resizedMask = maskParsed.image.resize({ width: nw, height: nh });
                    out_mask = maskParsed.pack(resizedMask);
                }
            }

            return {
                source_image: out_source,
                mask_image: out_mask,
                reference_images: reference_images
            };
        }

        return null;
    },
    async image_optimizer_mp(provider, payload) {
        const { aspect_ratio, source_image, mask_image, reference_images, user_params, args } = payload;

        // Resolve optimization parameters from args
        const mode = args.optimization_mode;   // "auto", "auto_plus", "refs_2_1mp", "all_1mp"
        const resRaw = String(args.output_resolution_mp || '1').trim();
        const resMatch = resRaw.match(/^(\d+(?:[.,]\d+)?)(-)?/);
        const resolution_mp = resMatch ? Number(resMatch[1].replace(',', '.')) : 1;
        //const modifier_mp = (resMatch && resMatch[2]) || ''; // Extracted modifier, e.g. "-"

        const minSize = Number(args.min_size) || 256;
        const step = Number(args.step) || 1;

        console.log(`[Preprocessor] Run image_optimizer_mp | mode: ${mode} | resolution: ${resolution_mp}MP | step: ${step}`);

        // Decide target MP for source and references based on selected mode
        let sourceTargetMP = null;
        let refsTargetMP = null;

        switch (mode) {
            case 'auto':
                sourceTargetMP = resolution_mp;
                refsTargetMP = resolution_mp;
                break;
            case 'auto_plus':
                sourceTargetMP = resolution_mp;
                refsTargetMP = 1;
                break;
            case 'refs_2_1mp':
                sourceTargetMP = null;
                refsTargetMP = 1;
                break;
            case 'all_1mp':
                sourceTargetMP = 1;
                refsTargetMP = 1;
                break;
            default:
                // If mode is unknown, do nothing
                return null;
        }

        let out_source = source_image;
        let out_mask = mask_image;
        let out_refs = reference_images || [];

        // 1. Process Source Image and Mask
        const sourceParsed = parseImageInput(source_image);
        if (sourceParsed && sourceTargetMP) {
            const [nw, nh] = getSizeByMegapixels(sourceParsed, sourceTargetMP, minSize, step);

            if (nw !== sourceParsed.size.width || nh !== sourceParsed.size.height) {
                console.log(`[Preprocessor] Resizing source: ${sourceParsed.size.width}x${sourceParsed.size.height} -> ${nw}x${nh} (~${(nw * nh / (1024 * 1024)).toFixed(3)} MP)`);
                const resizedImg = sourceParsed.image.resize({ width: nw, height: nh });
                out_source = sourceParsed.pack(resizedImg);

                // Synchronize mask if it exists
                if (mask_image) {
                    const maskParsed = parseImageInput(mask_image);
                    if (maskParsed) {
                        console.log(`[Preprocessor] Synchronizing mask to ${nw}x${nh}`);
                        const resizedMask = maskParsed.image.resize({ width: nw, height: nh });
                        out_mask = maskParsed.pack(resizedMask);
                    }
                }
            }
        }

        // 2. Process Reference Images
        if (out_refs.length > 0 && refsTargetMP) {
            out_refs = out_refs.map((ref, idx) => {
                const refParsed = parseImageInput(ref);
                if (!refParsed) return ref;

                const [rw, rh] = getSizeByMegapixels(refParsed, refsTargetMP, minSize, step);
                if (rw !== refParsed.size.width || rh !== refParsed.size.height) {
                    console.log(`[Preprocessor] Resizing ref #${idx + 1}: ${refParsed.size.width}x${refParsed.size.height} -> ${rw}x${rh} (~${(rw * rh / (1024 * 1024)).toFixed(3)} MP)`);
                    return refParsed.pack(refParsed.image.resize({ width: rw, height: rh }));
                }
                return ref;
            });
        }

        return {
            source_image: out_source,
            mask_image: out_mask,
            reference_images: out_refs
        };
    },
    async convert_mask_to_alpha(provider, payload) {
        const { source_image, mask_image, reference_images, args } = payload;
        if (!mask_image) return null;

        const maskParsed = parseImageInput(mask_image);
        if (!maskParsed) return null;

        const { width, height } = maskParsed.size;
        const threshold = Number(args.threshold ?? 128);
        const mode = args.mode || 'white_to_transparent';
        const isBlackToTransparent = mode === 'black_to_transparent' || args.invert === true;

        const bitmap = maskParsed.image.toBitmap();
        const newBuffer = Buffer.from(bitmap);

        for (let i = 0; i < newBuffer.length; i += 4) {
            const b = newBuffer[i];
            const g = newBuffer[i + 1];
            const r = newBuffer[i + 2];

            const lum = 0.299 * r + 0.587 * g + 0.114 * b;

            let alpha = 255;
            if (isBlackToTransparent) {
                alpha = lum <= threshold ? 0 : 255;
            } else {
                alpha = lum > threshold ? 0 : 255;
            }

            newBuffer[i + 3] = alpha;
        }

        const modifiedImg = nativeImage.createFromBitmap(newBuffer, { width, height });
        const out_mask = maskParsed.pack(modifiedImg, 'image/png');

        return {
            source_image: source_image,
            mask_image: out_mask,
            reference_images: reference_images
        };
    }
};

async function runPreprocessor(preprocessorConfig, provider, payload, contextResolver) {
    if (!preprocessorConfig || !preprocessorConfig.name) return payload;

    const processor = preprocessors[preprocessorConfig.name];
    if (!processor) {
        throw new Error(`Preprocessor '${preprocessorConfig.name}' не найден.`);
    }

    // Resolve templates in arguments (convert {{input_optimization}} to real value)
    const resolvedArgs = contextResolver(preprocessorConfig.args || {}, payload.user_params);

    // Filter processor
    if (resolvedArgs.filter_type) {
        const filterBy = resolvedArgs.filter_by;
        const filterType = resolvedArgs.filter_type;

        // Ensure values is treated as an array for consistent processing
        const values = resolvedArgs.values ? (Array.isArray(resolvedArgs.values) ? resolvedArgs.values : [resolvedArgs.values]) : [];

        switch (filterType) {
            case "contains":
                // Check if at least one element in the array contains the substring
                {
                    let isMatch = false;
                    for (let i = 0; i < values.length; i++) {
                        if (values[i].includes(filterBy)) {
                            isMatch = true; break;
                        }
                    }
                    if (!isMatch) {
                        for (let i = 0; i < values.length; i++) {
                            if (filterBy.includes(values[i])) {
                                isMatch = true; break;
                            }
                        }
                    }
                    if (!isMatch) return null;
                }
                break;

            case "not_contains":
                // Check if at least one element in the array NOT contains the substring
                {
                    let isMatch = false;
                    for (let i = 0; i < values.length; i++) {
                        if (!values[i].includes(filterBy)) {
                            isMatch = true; break;
                        }
                    }
                    if (!isMatch) {
                        for (let i = 0; i < values.length; i++) {
                            if (!filterBy.includes(values[i])) {
                                isMatch = true; break;
                            }
                        }
                    }
                    if (!isMatch) return null;
                }
                break;

            case "equals":
                // Check if at least one element is an exact match
                {
                    let isMatch = false;
                    for (let i = 0; i < values.length; i++) {
                        if (values[i] == filterBy) {
                            isMatch = true; break;
                        }
                    }
                    if (!isMatch) return null;
                }
                break;

            case "not_equals":
                //  Check if at least one element is NOT an exact match
                {
                    let isMatch = false;
                    for (let i = 0; i < values.length; i++) {
                        if (values[i] != filterBy) {
                            isMatch = true; break;
                        }
                    }
                    if (!isMatch) return null;
                }
                break;

            case "not_empty":
                // Check if at least one element in the array is not empty
                {
                    let isMatch = filterBy && filterBy != "";
                    if (!isMatch) return null;
                }
                break;

            case "empty":
                // Check if at least one element in the array is not empty
                {
                    let isMatch = !filterBy || filterBy == "";
                    if (!isMatch) return null;
                }
                break;

            default:
                throw new Error(`Unknown filter type: ${filterType}`);
        }
    }

    return await processor(provider, {
        ...payload,
        args: resolvedArgs
    });
}

module.exports = {
    //getAlowedAspectRatios,
    //fixAspectRatio,
    runPreprocessor
};

