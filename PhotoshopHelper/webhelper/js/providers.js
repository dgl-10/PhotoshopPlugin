/**
 * Client-side provider rules. Must stay aligned with the current WebHelper
 * and with Providers_Configuration_Guide.md — the server is still the authority.
 */

import {
    ALL_ASPECT_RATIOS,
    IMPLEMENTED_GENERATION_MODES,
    fixAspectRatio
} from './util.js';

export function effectiveGenerationMode(task) {
    const hasExplicitSource = Boolean(task?.data?.sourceImage);
    const hasPromotableReference = (task?.state?.references?.length ?? 0) > 0;
    return hasExplicitSource || hasPromotableReference ? 'i2i' : 't2i';
}

export function providerSupportsMode(provider, mode) {
    if (!provider || !Array.isArray(provider.generation_modes)) return false;
    if (provider.generation_modes.length === 0) return false;
    if (new Set(provider.generation_modes).size !== provider.generation_modes.length) return false;
    if (provider.generation_modes.some((m) => !IMPLEMENTED_GENERATION_MODES.includes(m))) return false;
    if (!IMPLEMENTED_GENERATION_MODES.includes(mode)) return false;
    return provider.generation_modes.includes(mode);
}

export function maxReferenceImages(provider, formState) {
    if (!provider) return 0;
    const maxConfig = provider.max_reference_images;
    if (typeof maxConfig === 'number') return maxConfig;
    if (typeof maxConfig === 'object' && maxConfig !== null) {
        const dependField = maxConfig.depends_on;
        const current = formState?.[dependField];
        if (current && maxConfig.values && maxConfig.values[current] !== undefined) {
            return maxConfig.values[current];
        }
        return maxConfig.default ?? 0;
    }
    return 0;
}

export function effectivelyUseMask(provider, task) {
    const hasMask = Boolean(task?.data?.maskImage);
    if (!provider) return false;
    const handling = provider.mask_handling;
    const supported = handling ? handling.supported !== false : false;
    const required = handling ? handling.required === true : false;
    if (!supported) return false;
    if (required) return hasMask;
    return hasMask && (task?.state?.useMask ?? true);
}

export function effectiveMaxRefs(provider, task) {
    const base = maxReferenceImages(provider, task?.state?.formState);
    const maskType = provider?.mask_handling?.type || '';
    if (!maskType.includes('referential')) return base;
    return effectivelyUseMask(provider, task) ? base - 1 : base;
}

export function maskCheckboxState(provider, task) {
    const hasMask = Boolean(task?.data?.maskImage);
    const show = Boolean(provider) && hasMask;
    if (!provider || !provider.mask_handling) {
        return { show, checked: false, disabled: true, use: false };
    }
    const supported = provider.mask_handling.supported !== false;
    const required = provider.mask_handling.required === true;
    if (!supported) return { show, checked: false, disabled: true, use: false };
    if (required) return { show, checked: true, disabled: true, use: hasMask };
    const checked = task?.state?.useMask ?? true;
    return { show, checked, disabled: false, use: hasMask && checked };
}

export function allowedAspectRatios(provider, formState) {
    if (!provider || provider.allowed_aspect_ratios === undefined) return ALL_ASPECT_RATIOS.slice();
    const arConfig = provider.allowed_aspect_ratios;
    if (Array.isArray(arConfig)) return arConfig;
    if (typeof arConfig === 'object' && arConfig.depends_on) {
        const depVal = formState?.[arConfig.depends_on];
        if (depVal && arConfig.values && arConfig.values[depVal] !== undefined) {
            return arConfig.values[depVal];
        }
        return arConfig.default ?? ALL_ASPECT_RATIOS.slice();
    }
    return ALL_ASPECT_RATIOS.slice();
}

export function resolveAspectRatio(task, provider, aliasState) {
    const raw = aliasState?.aspect_ratio ?? '';
    const allowed = allowedAspectRatios(provider, task.state.formState);
    const isT2I = effectiveGenerationMode(task) === 't2i';
    let effective;
    if (isT2I) {
        if (raw && allowed.includes(raw)) effective = raw;
        else if (raw) effective = fixAspectRatio(raw, allowed);
        else effective = allowed.includes('1:1') ? '1:1' : (allowed[0] || '');
    } else if (allowed.length === 0 || raw === '') {
        effective = '';
    } else {
        effective = fixAspectRatio(raw, allowed);
    }
    task.state.formState.aspect_ratio = effective;
    return { effective, allowed, isT2I };
}

export function isPromptEmpty(task) {
    if (!task?.state?.selectedProviderId) return false;
    const prompt = task.state.formState?.prompt;
    return !prompt || !String(prompt).trim();
}

export function isRefLimitExceeded(provider, task) {
    if (!task?.state?.selectedProviderId) return false;
    const count = task.state.references?.length ?? 0;
    const max = effectiveMaxRefs(provider, task);
    return (max > 0 && count > max) || (max === 0 && count > 0);
}

export function isMaskMissing(provider, task) {
    if (!task?.state?.selectedProviderId || !provider) return false;
    return Boolean(provider.mask_handling?.required && !task.data?.maskImage);
}

export function isAspectRatioMissing(task) {
    if (!task?.state?.selectedProviderId) return false;
    return effectiveGenerationMode(task) === 't2i'
        && (!task.state.formState?.aspect_ratio || String(task.state.formState.aspect_ratio).trim() === '');
}

export function isGenerateBlocked(provider, task) {
    if (!task?.state?.selectedProviderId || !provider) return true;
    const mode = effectiveGenerationMode(task);
    if (!providerSupportsMode(provider, mode)) return true;
    if (isMaskMissing(provider, task)) return true;
    if (isAspectRatioMissing(task)) return true;
    return false;
}

const VENDOR_RULES = [
    { tag: 'xai', test: /xai|grok/ },
    { tag: 'fal', test: /fal/ },
    { tag: 'replicate', test: /replicate/ },
    { tag: 'openai', test: /openai|gpt/ },
    { tag: 'bfl', test: /\bbfl\b|flux/ },
    { tag: 'seedream', test: /seedream/ },
    { tag: 'qwen', test: /qwen|wan|alibaba/ },
    { tag: 'pruna', test: /pruna/ }
];

export function providerTags(provider) {
    if (!provider) return [];
    const tags = [];
    const blob = `${provider.id} ${provider.name}`.toLowerCase();
    for (const rule of VENDOR_RULES) {
        if (rule.test.test(blob)) tags.push(rule.tag);
    }
    if (Array.isArray(provider.generation_modes)) {
        for (const mode of provider.generation_modes) {
            if (IMPLEMENTED_GENERATION_MODES.includes(mode) && !tags.includes(mode)) tags.push(mode);
        }
    }
    if (provider.mask_handling && provider.mask_handling.supported !== false) tags.push('mask');
    const maxRefs = maxReferenceImages(provider, {});
    if (maxRefs > 0) tags.push('refs');
    if (Array.isArray(provider.tags)) {
        for (const extra of provider.tags) {
            const t = String(extra).trim();
            if (t && !tags.includes(t)) tags.push(t);
        }
    }
    return tags;
}

export function allProviderTags(providers) {
    const set = new Set();
    for (const p of providers || []) {
        for (const t of providerTags(p)) set.add(t);
    }
    return [...set];
}

export function paramStateKey(param) {
    return param.alias || param.name;
}

export function resolveParamDefault(param, aliasState, formState) {
    const stateKey = paramStateKey(param);
    let val = formState[stateKey];
    if (val === undefined && param.alias) val = aliasState[param.alias];
    if (val === undefined) {
        let defVal = param.default;
        if (param.type === 'dropdown' && param.options) {
            const opt = param.options.find((o) => (typeof o === 'object' ? o.value : o) == defVal);
            if (opt && typeof opt === 'object' && opt.alias) defVal = opt.alias;
        }
        val = defVal;
    }
    return val;
}

export function visibleDropdownOptions(param, currentVal) {
    const options = param.options || [];
    let selectedIndex = -1;
    let selectedHiddenValue = null;
    const generated = [];

    options.forEach((opt) => {
        const optAlias = typeof opt === 'object' ? (opt.alias || opt.value) : opt;
        const label = typeof opt === 'object' ? (opt.label || opt.value) : opt;
        const hidden = typeof opt === 'object' ? (opt.hidden || false) : false;
        const isSelected = currentVal === optAlias;
        if (isSelected && selectedIndex === -1) {
            if (hidden) selectedHiddenValue = (typeof opt === 'object' ? opt.value : opt);
            else selectedIndex = generated.length;
        }
        if (!hidden) generated.push({ value: optAlias, label });
    });

    if (selectedIndex === -1 && selectedHiddenValue != null) {
        options.forEach((opt) => {
            if (selectedIndex !== -1) return;
            const hidden = typeof opt === 'object' ? (opt.hidden || false) : false;
            if (hidden) return;
            const optVal = typeof opt === 'object' ? opt.value : opt;
            if (optVal === selectedHiddenValue) {
                const optAlias = typeof opt === 'object' ? (opt.alias || opt.value) : opt;
                selectedIndex = generated.findIndex((go) => go.value === optAlias);
            }
        });
    }

    if (selectedIndex === -1) {
        options.forEach((opt, index) => {
            const optVal = typeof opt === 'object' ? opt.value : opt;
            if (currentVal === optVal && selectedIndex === -1) selectedIndex = index;
        });
        if (selectedIndex >= generated.length) selectedIndex = -1;
    }

    return { options: generated, selectedIndex };
}

export function dropdownApiValue(param, uiValue) {
    const opt = (param.options || []).find((o) => (typeof o === 'object' ? (o.alias || o.value) : o) == uiValue);
    if (!opt) return uiValue;
    return typeof opt === 'object' ? opt.value : opt;
}

export function readParamValueFromDom(root, param, formState) {
    const el = root.querySelector(`[data-param-name="${param.name}"]`);
    if (el) {
        if (el.type === 'checkbox') return el.checked;
        if (el.type === 'number' || el.type === 'range') return parseFloat(el.value);
        return el.value;
    }
    if (param.alias === 'prompt') {
        const prompt = root.querySelector('#prompt-input');
        return prompt ? prompt.value : formState.prompt;
    }
    if (param.alias === 'negative_prompt') {
        const neg = root.querySelector('#neg-prompt-input');
        return neg ? neg.value : formState.negative_prompt;
    }
    if (param.alias === 'num_images') {
        const num = root.querySelector('#num-images-input');
        return num ? parseInt(num.value, 10) : (formState.num_images || 1);
    }
    const key = paramStateKey(param);
    return formState[key] !== undefined ? formState[key] : param.default;
}

export function collectGenerateParams(provider, formState, root) {
    const finalParams = {};
    for (const param of provider.parameters || []) {
        let val = readParamValueFromDom(root, param, formState);
        if (param.type === 'dropdown') val = dropdownApiValue(param, val);
        finalParams[param.name] = val;
    }
    return finalParams;
}

export function applyParamValue(task, aliasState, name, alias, rawVal) {
    const stateKey = alias || name;
    task.state.formState[stateKey] = rawVal;
    if (alias) aliasState[alias] = rawVal;
}

export function seedForceSeparate(task, aliasState) {
    if (task.state.formState.force_separate_requests === undefined) {
        task.state.formState.force_separate_requests = aliasState.force_separate_requests || false;
    }
}
