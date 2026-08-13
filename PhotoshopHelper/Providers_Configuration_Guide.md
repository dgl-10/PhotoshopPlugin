# Provider Configuration Guide (`providers.json`)

> **Audience:** Developers and administrators who need to add, modify, or understand API provider configurations for the WebHelper image generation system.

---

## Table of Contents

1. [Overview](#1-overview)
2. [File Format and Top-Level Structure](#2-file-format-and-top-level-structure)
3. [Provider Object — Complete Field Reference](#3-provider-object--complete-field-reference)
   - 3.1 [Identity and Display](#31-identity-and-display)
   - 3.2 [Image Format (`image_format`)](#32-image-format-image_format)
   - 3.3 [Mask Handling (`mask_handling`)](#33-mask-handling-mask_handling)
   - 3.4 [Reference Images (`max_reference_images`)](#34-reference-images-max_reference_images)
   - 3.5 [Prompt Configuration](#35-prompt-configuration)
   - 3.6 [Aspect Ratios (`allowed_aspect_ratios`)](#36-aspect-ratios-allowed_aspect_ratios)
   - 3.7 [Filename Suffix (`filename_suffix`)](#37-filename-suffix-filename_suffix)
   - 3.8 [Remarks (`remarks`)](#38-remarks-remarks)
   - 3.9 [Nice Name (`nice_name`)](#39-nice-name-nice_name)
4. [Request Configuration (`request_config`)](#4-request-configuration-request_config)
   - 4.1 [Basic Structure](#41-basic-structure)
   - 4.2 [Single Image Per Request](#42-single-image-per-request)
   - 4.3 [Reference Item Template](#43-reference-item-template)
   - 4.4 [Body Template (`body_template`)](#44-body-template-body_template)
5. [Placeholder System](#5-placeholder-system)
   - 5.1 [Basic Placeholders (`{{key}}`)](#51-basic-placeholders-key)
   - 5.2 [Environment Variable Placeholders (`{{env:VAR_NAME}}`)](#52-environment-variable-placeholders-envvar_name)
   - 5.3 [Conditional Key Inclusion (`{{?variable}}key`)](#53-conditional-key-inclusion-variablekey)
   - 5.4 [Negative Conditional (`{{?!variable}}key`)](#54-negative-conditional-variablekey)
   - 5.5 [Conditional Expressions](#55-conditional-expressions)
   - 5.6 [Built-in / System Variables](#56-built-in--system-variables)
   - 5.7 [Reference Variables](#57-reference-variables)
6. [UI Parameters (`parameters`)](#6-ui-parameters-parameters)
   - 6.1 [Supported Parameter Types](#61-supported-parameter-types)
   - 6.2 [Dropdown Options — Aliases and Hidden Values](#62-dropdown-options--aliases-and-hidden-values)
   - 6.3 [Reserved Aliases](#63-reserved-aliases)
   - 6.4 [Alias Persistence Across Provider Switches](#64-alias-persistence-across-provider-switches)
7. [Response Configuration (`response_config`)](#7-response-configuration-response_config)
   - 7.1 [Linking to a Response Handler (`$ref`)](#71-linking-to-a-response-handler-ref)
   - 7.2 [Provider-Specific Params](#72-provider-specific-params)
8. [Response Handlers (`response_handlers`)](#8-response-handlers-response_handlers)
   - 8.1 [Handler Types](#81-handler-types)
   - 8.2 [`sync` — Synchronous Response](#82-sync--synchronous-response)
   - 8.3 [`async_poll` — Asynchronous with Polling](#83-async_poll--asynchronous-with-polling)
   - 8.4 [`async_poll_and_get` — Poll + Separate GET](#84-async_poll_and_get--poll--separate-get)
   - 8.5 [Polling Configuration](#85-polling-configuration)
   - 8.6 [Result Configuration](#86-result-configuration)
   - 8.7 [Image Extraction (`images`)](#87-image-extraction-images)
9. [Preprocessors (`preprocessor`)](#9-preprocessors-preprocessor)
   - 9.1 [Overview](#91-overview)
   - 9.2 [Preprocessor Array Structure](#92-preprocessor-array-structure)
   - 9.3 [Conditional Execution (Filtering)](#93-conditional-execution-filtering)
   - 9.4 [Available Preprocessors](#94-available-preprocessors)
     - 9.4.1 [`image_get_size`](#941-image_get_size)
     - 9.4.2 [`image_get_size_mp`](#942-image_get_size_mp)
     - 9.4.3 [`image_optimizer_mp`](#943-image_optimizer_mp)
     - 9.4.4 [`image_optimizer_by_min_size`](#944-image_optimizer_by_min_size)
     - 9.4.5 [`convert_mask_to_alpha`](#945-convert_mask_to_alpha)
   - 9.5 [Preprocessor Output Variables](#95-preprocessor-output-variables)
10. [The `depends_on` Pattern — Dynamic Configuration](#10-the-depends_on-pattern--dynamic-configuration)
11. [Server-Side Processing Flow](#11-server-side-processing-flow)
12. [Security Model](#12-security-model)
13. [Complete Examples with Annotations](#13-complete-examples-with-annotations)
    - 13.1 [Grok Imagine (Sync, xAI Direct API)](#131-grok-imagine-sync-xai-direct-api)
    - 13.2 [Seedream v4.5 via FAL (Async Poll+GET, Preprocessor)](#132-seedream-v45-via-fal-async-pollget-preprocessor)
    - 13.3 [FLUX.1 Fill (Async Poll, BFL, Inpainting Required)](#133-flux1-fill-async-poll-bfl-inpainting-required)
    - 13.4 [FLUX.2 (BFL, Multiple Models, Megapixel Preprocessors)](#134-flux2-bfl-multiple-models-megapixel-preprocessors)
    - 13.5 [Alibaba / Wan / Qwen (Multi-Model with Conditional Preprocessors)](#135-alibaba--wan--qwen-multi-model-with-conditional-preprocessors)
    - 13.6 [FLUX Kontext (BFL, English-Only, Simple)](#136-flux-kontext-bfl-english-only-simple)
    - 13.7 [GPT-Image-2 (OpenAI, Megapixel Preprocessors, Mask Alpha Conversion)](#137-gpt-image-2-openai-megapixel-preprocessors-mask-alpha-conversion)

---

## 1. Overview

The `providers.json` file is the single source of truth for all AI image generation API integrations in the WebHelper system. It lives on the server side at:

```
PhotoshopHelper/providers.json
```

This file defines:
- **Which APIs are available** (providers)
- **How to call them** (request templates, headers, endpoints)
- **How to read their responses** (response handlers)
- **What UI controls to show the user** (parameters)
- **How to preprocess images before sending** (preprocessors)

The file uses **JSON5** format (comments and trailing commas are allowed).

### Key Design Principles

1. **Separation of concerns:** Request/response configuration stays on the server. Only UI-relevant data is sent to the browser.
2. **No hardcoding:** The UI renders dynamically from the provider schema — adding a new AI model requires zero code changes.
3. **Template-driven:** All API requests are built from templates with placeholder substitution, not from code.

---

## 2. File Format and Top-Level Structure

```jsonc
{
    "response_handlers": {
        // Shared response handler definitions (see §8)
        "sync": { ... },
        "fal": { ... },
        "bfl": { ... },
        "replicate": { ... }
    },
    "providers": [
        // Array of provider configuration objects (see §3)
        { "id": "grok_imagine", ... },
        { "id": "seedream_v4_5_fal", ... },
        ...
    ]
}
```

| Block | Purpose |
|-------|---------|
| `response_handlers` | Reusable response processing configurations. Defined once, referenced by multiple providers via `$ref`. |
| `providers` | Array of individual provider definitions. Each object fully configures one API endpoint for the UI and server. |

---

## 3. Provider Object — Complete Field Reference

Each object in the `providers` array has the following structure. Fields marked with ★ are **required**.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | ★ | Unique identifier for this provider (e.g., `"grok_imagine"`). Used internally for routing. |
| `name` | `string` | ★ | Human-readable name shown in the provider dropdown (e.g., `"Grok Imagine - via XAI API Key ($0.02/image)"`). |
| `image_format` | `string` | ★ | Format for encoding images sent TO the API. See §3.2. |
| `mask_handling` | `object` | ★ | How this provider handles inpainting masks. See §3.3. |
| `max_reference_images` | `number` or `object` | ★ | Maximum additional reference images. See §3.4. |
| `supports_negative_prompt` | `boolean` | ★ | Whether to show a "Negative Prompt" text field in the UI. |
| `english_only` | `boolean` | ★ | Informational flag — provider only accepts English prompts. |
| `request_config` | `object` | ★ | Server-side HTTP request configuration. See §4. |
| `response_config` | `object` | ★ | Reference to a response handler + provider-specific params. See §7. |
| `parameters` | `array` | ★ | UI parameter definitions (inputs rendered in the browser). See §6. |
| `preprocessor` | `array` | | Server-side image preprocessing pipeline. See §9. |
| `allowed_aspect_ratios` | `array` or `object` | | Restricts available aspect ratios. See §3.6. |
| `filename_suffix` | `string` or `object` | | Custom suffix for saved result files. See §3.7. |
| `remarks` | `string` (HTML) | | Informational HTML block shown in the UI. See §3.8. |
| `nice_name` | `string` or `object` | | Human-readable model label shown in the result tab header. See §3.9. |

### 3.1 Identity and Display

```jsonc
{
    "id": "seedream_v4_5_fal",
    "name": "Seedream v4.5 via Fal API Key ($0.04/per image)"
}
```

- `id`: Must be unique across all providers. Used in API calls (`/api/webhelper/generate`) and internally.
- `name`: Displayed as-is in the provider `<select>` dropdown. Include pricing info for user convenience.

### 3.2 Image Format (`image_format`)

Defines how source images, masks, and reference images are encoded before being sent to the external API.

| Value | Encoding | Example |
|-------|----------|---------|
| `"data_uri"` | Base64 with MIME prefix | `data:image/png;base64,iVBOR...` |
| `"base64_raw"` | Raw base64 without prefix | `iVBORw0KGgoAAAANSU...` |
| `"url"` | Direct URL to the file | Falls back to `data_uri` internally since files are local |

> **Note:** The `"url"` format currently falls back to `data_uri` because images are stored locally and there's no public URL service configured. This may change in the future.

**This field is server-side only** — it is stripped before sending provider data to the browser.

### 3.3 Mask Handling (`mask_handling`)

Controls whether the provider supports inpainting masks and how they are transmitted to the API.

```jsonc
// Provider that REQUIRES a mask (inpainting-only model):
"mask_handling": {
    "supported": true,
    "required": true,
    "type": "separate_field",
    "field_name": "mask"
}

// Provider that SUPPORTS mask optionally (user can disable):
"mask_handling": {
    "supported": true,
    "type": "first_referential",
    "field_name": "image_urls"
}

// Provider that does NOT support masks:
"mask_handling": {
    "supported": false,
    "required": false
}
```

| Sub-field | Type | Description |
|-----------|------|-------------|
| `supported` | `boolean` | Whether the API accepts a mask image at all. |
| `required` | `boolean` | If `true`, the mask is mandatory — the "Use Mask" checkbox is locked on and the user cannot uncheck it. Defaults to `false`. |
| `type` | `string` | How the mask is placed in the request body. Only relevant when `supported: true`. |
| `field_name` | `string` | The JSON field name where the mask ends up (used for `separate_field`) or the array to which it's added (for referential types). |

#### Mask Transmission Types

| `type` Value | Behavior | Example |
|-------------|----------|---------|
| `"separate_field"` | Mask is sent as its own dedicated field in the request body. | `"mask": "base64data..."` |
| `"first_referential"` | Mask is prepended to the image array (before reference images). | `"image_urls": [mask, ref1, ref2, ...]` |
| `"last_referential"` | Mask is appended to the image array (after reference images). | `"image_urls": [ref1, ref2, ..., mask]` |

#### UI Behavior Summary

| `supported` | `required` | Checkbox State |
|-------------|-----------|----------------|
| `false` | — | Unchecked, disabled |
| `true` | `false` | User-controllable |
| `true` | `true` | Checked, disabled |

### 3.4 Reference Images (`max_reference_images`)

Defines the maximum number of additional reference images (beyond the source and mask) that the provider accepts.

**Simple form — fixed number:**
```jsonc
"max_reference_images": 4
```

**Dynamic form — depends on a UI parameter:**
```jsonc
"max_reference_images": {
    "default": 7,
    "depends_on": "model_flux2",
    "values": {
        "klein-9b": 3,
        "klein-4b": 3
    }
}
```

When `model_flux2` is `"klein-9b"`, the limit is 3. For `"pro"` or `"max"` (not listed in `values`), the `default` of 7 applies.

> **Note:** If the mask uses a referential type (`first_referential` / `last_referential`), it consumes one reference slot. The UI automatically accounts for this — the effective limit shown to the user is `max_reference_images - 1` when mask is active.

Setting `max_reference_images: 0` means the provider does not accept any reference images.

### 3.5 Prompt Configuration

| Field | Type | Description |
|-------|------|-------------|
| `supports_negative_prompt` | `boolean` | If `true`, a "Negative Prompt" text area appears in the UI below the main prompt. |
| `english_only` | `boolean` | Informational flag. Currently displayed as a visual indicator only. |

### 3.6 Aspect Ratios (`allowed_aspect_ratios`)

Controls which aspect ratios are available in the "Aspect Ratio" dropdown for this provider.

**Global list (system default):** When this field is absent, ALL standard ratios are available:
```
21:9, 2:1, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 1:2, 9:21
```

**Form 1 — Fixed array:**
```jsonc
"allowed_aspect_ratios": ["16:9", "4:3", "1:1", "3:4", "9:16"]
```

**Form 2 — Empty array (provider does not support ratio changes):**
```jsonc
"allowed_aspect_ratios": []
```
The select shows only "Match Input" and is disabled.

**Form 3 — Dynamic, depends on another field:**
```jsonc
"allowed_aspect_ratios": {
    "default": ["16:9", "1:1", "9:16"],
    "depends_on": "model_name",
    "values": {
        "model-x": ["1:1"],
        "model-y": ["16:9", "4:3", "1:1", "3:4", "9:16"]
    }
}
```

**Form 4 — Absent:**
All ratios from the global list are allowed.

> When the user switches providers, the previously selected ratio is preserved if possible. If the new provider doesn't support it, the system automatically picks the closest allowed ratio.

### 3.7 Filename Suffix (`filename_suffix`)

Controls the suffix appended to generated image filenames on disk. If absent, the provider `id` is used.

The server automatically detects the generation mode and appends `_i2i` (Image-to-Image) or `_t2i` (Text-to-Image) to the resolved suffix.

Generated files follow this naming pattern:
```
generated_image_YYYY-MM-DD_N.wh.SUFFIX_MODE.EXT
```
*(where `MODE` is `i2i` or `t2i`)*

**Form 1 — Static string (with placeholders):**
```jsonc
"filename_suffix": "flux_kontext_{{model_flux_kontext}}"
// Result (i2i): generated_image_2026-04-15_1.wh.flux_kontext_pro_i2i.png
// Result (t2i): generated_image_2026-04-15_1.wh.flux_kontext_pro_t2i.png
```

**Form 2 — Plain string (no placeholders):**
```jsonc
"filename_suffix": "seedream_v4_5"
// Result (i2i): generated_image_2026-04-15_1.wh.seedream_v4_5_i2i.png
// Result (t2i): generated_image_2026-04-15_1.wh.seedream_v4_5_t2i.png
```

**Form 3 — Dynamic object:**
```jsonc
"filename_suffix": {
    "default": "flux2_{{model_flux2}}",
    "depends_on": "model_flux2",
    "values": {
        "klein-9b": "flux2_klein_9b",
        "klein-4b": "flux2_klein_4b"
    }
}
```

**This field is server-side only** — it is stripped before sending provider data to the browser.

### 3.8 Remarks (`remarks`)

An optional HTML string displayed in the Source Tab, directly above the generation controls (images count, aspect ratio, generate button). Intended for pricing details, warnings, or usage notes.

```jsonc
"remarks": "Aspect ratio adjustments are only supported when at least one additional reference image is provided."
```

Rendered with CSS classes `p-2 mb-2 rounded bg-gray text-tiny` (Spectre CSS framework). You can use standard HTML tags like `<b>`, `<br>`, `<table>`, `<a>`, etc.

> **Important:** Do not include input elements (`<input>`, `<textarea>`, `<select>`) in remarks — it's for display only.

### 3.9 Nice Name (`nice_name`)

An optional human-readable label for a specific model/variant within a provider. When present, the server resolves it and sends it to the browser, where it replaces the raw `providerId` in the result tab header.

This is particularly useful for multi-model providers (e.g. `alibaba_fal`, `bfl_flux2`) where the same provider `id` covers several distinct models — making it impossible to tell which model produced a given result from the header alone.

The configuration schema is identical to `filename_suffix` (string with optional `{{placeholders}}`, or a `depends_on` object), **but unlike `filename_suffix` it is NOT a server-side-only field** — the resolved value is forwarded to the client.

**Form 1 — Static string:**
```jsonc
"nice_name": "Seedream v4.5"
// Result header: "Seedream v4.5 | Aspect: 16:9"
```

**Form 2 — Static string with placeholder:**
```jsonc
"nice_name": "FLUX Kontext {{model_flux_kontext}}"
// Result header: "FLUX Kontext pro | Aspect: Match Input"
```

**Form 3 — Dynamic object (depends on a UI parameter):**
```jsonc
"nice_name": {
    "default": "FLUX.2 {{model_flux2}}",
    "depends_on": "model_flux2",
    "values": {
        "pro":      "FLUX.2 Pro",
        "max":      "FLUX.2 Max",
        "klein-9b": "FLUX.2 Klein 9B",
        "klein-4b": "FLUX.2 Klein 4B"
    }
}
// Result header: "FLUX.2 Pro | Aspect: 1:1"
```

| Sub-field | Type | Description |
|-----------|------|-------------|
| `default` | `string` | Template used when the current value is not listed in `values`. Supports `{{placeholders}}`. |
| `depends_on` | `string` | Name of the UI parameter whose current value drives the lookup. |
| `values` | `object` | Map from parameter value → display string. Values do **not** support placeholders (they are literal strings). |

> **Note:** If `nice_name` is absent, the result header falls back to showing the raw `providerId`.

---

## 4. Request Configuration (`request_config`)

This section defines everything the server needs to make the HTTP request to the external API. **It is never sent to the browser.**

### 4.1 Basic Structure

```jsonc
"request_config": {
    "endpoint_url": "https://api.x.ai/v1/images/edits",
    "method": "POST",
    "headers": {
        "Content-Type": "application/json",
        "Authorization": "Bearer {{env:XAI_API_KEY}}"
    },
    "body_template": {
        "prompt": "{{prompt}}",
        "image": "{{source_image}}"
    }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `endpoint_url` | `string` | ★ | API endpoint URL. Supports placeholders (e.g., `"https://api.bfl.ai/v1/flux-2-{{model_flux2}}"`) and conditional key selection. |
| `method` | `string` | ★ | HTTP method (typically `"POST"`). |
| `headers` | `object` | ★ | HTTP headers. Supports `{{env:VAR_NAME}}` placeholders for API keys. |
| `body_template` | `object` | ★ | JSON request body template with placeholders. See §4.4. |
| `single_image_per_request` | `boolean` | | If `true`, the API generates only one image per request. When the user requests multiple images, the server sends multiple sequential requests. Default: `false`. |
| `reference_item_template` | `object` | | Template for wrapping each reference image into an object (used with `{{resolved_references}}`). See §4.3. |

When one provider uses different endpoints by generation mode, conditional keys may
select `endpoint_url` from the normalized image context. For example, the following
uses the generation endpoint when no source exists and the edit endpoint otherwise:

```jsonc
"request_config": {
    "{{?!source_image}}endpoint_url": "https://api.example.com/v1/images/generations",
    "{{?source_image}}endpoint_url": "https://api.example.com/v1/images/edits",
    "method": "POST",
    "headers": { "Content-Type": "application/json" },
    "body_template": {
        "prompt": "{{prompt}}",
        "{{?source_image}}image": "{{source_image}}"
    }
}
```

The complete `request_config` is resolved immediately before each HTTP request, after
source/reference normalization and preprocessing. Exactly one conditional
`endpoint_url` branch must resolve to a non-empty string.

When both the endpoint and its T2I/I2I variant depend on a model dropdown, combine
the normalized source condition with a strict model comparison. This remains ordinary
template syntax and does not require a provider-specific request field:

```jsonc
"request_config": {
    "{{?!source_image && model == 'model/edit'}}endpoint_url":
        "https://queue.example/model/text-to-image",
    "{{?source_image && model == 'model/edit'}}endpoint_url":
        "https://queue.example/model/edit",
    "method": "POST",
    "headers": { "Content-Type": "application/json" },
    "body_template": {
        "prompt": "{{prompt}}",
        "{{?source_image}}image_urls": ["{{source_image}}"]
    }
}
```

See §5.5 for the complete condition grammar. Explicit model comparisons ensure an
unknown or forged dropdown value resolves no endpoint and fails before a remote call.

### 4.2 Single Image Per Request

```jsonc
"request_config": {
    "single_image_per_request": true,
    ...
}
```

When `true` and the user requests `num_images = 3`, the server makes 3 separate API calls and aggregates results. When `false` (default), the server sends one request with `num_images` in the body and expects multiple results back.

### 4.3 Reference Item Template

Some APIs (like xAI Grok) require reference images to be wrapped in specific object structures instead of being plain strings.

```jsonc
"request_config": {
    "reference_item_template": {
        "url": "{{item}}",
        "type": "image_url"
    },
    "body_template": {
        "images": [
            { "url": "{{source_image}}", "type": "image_url" },
            "{{resolved_references}}"
        ]
    }
}
```

The server processes each reference image through the template, replacing `{{item}}` with the actual image data, then substitutes the full array into `{{resolved_references}}`.

Result (3 references):
```json
"images": [
    { "url": "data:image/png;base64,source...", "type": "image_url" },
    { "url": "data:image/png;base64,ref1...", "type": "image_url" },
    { "url": "data:image/png;base64,ref2...", "type": "image_url" },
    { "url": "data:image/png;base64,ref3...", "type": "image_url" }
]
```

### 4.4 Body Template (`body_template`)

The heart of the request configuration. A JSON object with placeholders that the server fills in before sending.

```jsonc
"body_template": {
    "prompt": "{{prompt}}",
    "enable_safety_checker": false,           // Static value — always included
    "num_images": "{{num_images}}",           // Replaced with value from user input
    "{{?aspect_ratio}}aspect_ratio": "{{aspect_ratio}}",  // Conditional — only included if aspect_ratio is set
    "{{?!aspect_ratio}}image_size": "auto_{{image_size}}", // Inverse conditional — included only if aspect_ratio is NOT set
    "image_urls": [
        "{{source_image}}",                   // Source image in the configured format
        "{{resolved_image_array}}"            // Reference images spread into the array
    ]
}
```

See §5 for the full placeholder syntax documentation.

---

## 5. Placeholder System

The template engine recursively resolves placeholders in all strings, arrays, and objects within `body_template`, `endpoint_url`, `headers`, and related fields.

### 5.1 Basic Placeholders (`{{key}}`)

Replaced with the value of `key` from the context. The context includes:
- All user-provided parameters (from the `parameters` array)
- System variables like `source_image`, `mask_image`, `num_images`
- Values computed by preprocessors (e.g., `calculated_output_size`)

```jsonc
"prompt": "{{prompt}}"           // → "a beautiful landscape"
"model": "{{model_xai}}"        // → "grok-imagine-image-pro"
```

**Inline usage (part of a larger string):**
```jsonc
"image_size": "auto_{{image_size}}"  // → "auto_2K"
"endpoint_url": "https://api.bfl.ai/v1/flux-2-{{model_flux2}}"  // → "https://api.bfl.ai/v1/flux-2-pro"
```

**Type preservation:** If a placeholder is the *entire* string value (`"{{key}}"`), the resolved value retains its original type (number, boolean, array, object). If it's part of a larger string, it's stringified.

### 5.2 Environment Variable Placeholders (`{{env:VAR_NAME}}`)

Resolved from `process.env` on the server. Used for API keys and secrets.

```jsonc
"Authorization": "Bearer {{env:XAI_API_KEY}}"  // → "Bearer sk-abc123..."
"x-key": "{{env:BFL_API_KEY}}"                 // → "bfl-xyz789..."
```

API keys are loaded from:
1. The `.env` file in the project root
2. Optionally, from a NebulaSecrets broker (if configured via `NEBULA_CS` env var)

> **Dynamic Provider Filtering:** When the client requests the list of available providers (`GET /api/webhelper/providers`), the server automatically scans each provider's configuration (and its linked `response_config`) for any `{{env:...}}` placeholders. If a required environment variable is missing or empty in `process.env`, the provider is considered unavailable and is completely excluded from the list sent to the UI.

### 5.3 Conditional Key Inclusion (`{{?variable}}key`)

Includes the key in the output object **only if** the variable is present and truthy (not `null`, `false`, empty string, or `undefined`).

```jsonc
"{{?mask_image}}mask": "{{mask_image}}"
```
- If `mask_image` has a value → `"mask": "base64data..."` is included
- If `mask_image` is absent/empty → the entire `"mask"` key is **omitted from the request**

```jsonc
"{{?reference_1}}input_image_2": "{{reference_1}}"
```
- If the user provided at least 1 reference image → `"input_image_2": "base64data..."` is included
- If no references → key is omitted

### 5.4 Negative Conditional (`{{?!variable}}key`)

Includes the key **only if** the variable is **absent or falsy**. This is the inverse of `{{?variable}}`.

```jsonc
"{{?!aspect_ratio}}aspect_ratio": "match_input_image",
"{{?aspect_ratio}}aspect_ratio": "{{aspect_ratio}}"
```

This pattern provides a fallback value:
- If the user selected an aspect ratio → `"aspect_ratio": "16:9"`
- If the user left it as "Match Input" (empty) → `"aspect_ratio": "match_input_image"`

Another example:
```jsonc
"{{?!aspect_ratio}}image_size": "auto_{{image_size}}",
"{{?aspect_ratio}}image_size": "{{calculated_output_size}}"
```
- No aspect ratio → use automatic sizing based on the selected resolution label
- Aspect ratio set → use pixel dimensions calculated by a preprocessor

### 5.5 Conditional Expressions

The content after `{{?` may be a boolean expression instead of a single variable.
Conditions are supported only in object-key prefixes; template values continue to use
the ordinary `{{placeholder}}` syntax.

```jsonc
"{{?source_image && model == 'model/edit'}}endpoint_url": "https://api.example/edit",
"{{?!source_image && (model == 'model/a' || model == 'model/b')}}endpoint_url": "https://api.example/generate"
```

Supported syntax:

| Syntax | Meaning |
|--------|---------|
| `variable` | JavaScript-style truthiness of an own context property |
| `!condition` | Logical NOT |
| `left == right` | Strict equality; no type coercion |
| `left != right` | Strict inequality; no type coercion |
| `left && right` | Logical AND |
| `left \|\| right` | Logical OR |
| `(condition)` | Explicit grouping |
| `'text'`, `"text"`, numbers, `true`, `false`, `null` | Literal values |

Identifiers must begin with an ASCII letter or underscore and may then contain
ASCII letters, digits, or underscores (`[A-Za-z_][A-Za-z0-9_]*`). This matches all
built-in variables and checked-in provider parameters.

Operator precedence, from highest to lowest, is `!`, `==`/`!=`, `&&`, then `||`.
An unknown identifier resolves as `undefined` and is therefore falsy, preserving the
behavior of optional legacy variables such as `reference_1`. Equality is always strict:
the string `'1'` does not equal the number `1` even though the operator is written `==`.

The expression language intentionally does not support property access, function
calls, arrays, arithmetic, ternaries, assignment, or executable JavaScript. If two
active template branches resolve to the same output key, request construction fails
with a key-collision error instead of silently overwriting one branch.

Existing `{{?variable}}key` and `{{?!variable}}key` forms that use the identifier
format above are valid expressions and retain their previous truthiness behavior.

### 5.6 Built-in / System Variables

These variables are always available in the placeholder context during request building:

| Variable | Source | Description |
|----------|--------|-------------|
| `{{source_image}}` | Server | Source image encoded in the provider's `image_format` |
| `{{mask_image}}` | Server | Mask image encoded in the provider's `image_format` (or `null` if not using mask) |
| `{{num_images}}` | Client (root payload) | Number of images the user wants to generate |
| `{{aspect_ratio}}` | Client (root payload) | Selected aspect ratio (e.g., `"16:9"`) or empty string for "Match Input" |
| `{{prompt}}` | Client (params) | The user's text prompt |
| `{{negative_prompt}}` | Client (params) | Negative prompt (if supported by provider) |
| `{{env:VAR_NAME}}` | Environment | Server-side environment variable |
| `{{resolved_image_array}}` | Server | Flat array of encoded reference images (optionally with mask prepended/appended). Automatically flattened into the parent array. |
| `{{resolved_references}}` | Server | Array of reference image objects generated via `reference_item_template`. Automatically flattened into the parent array. |
| `{{reference_1}}`, `{{reference_2}}`, ... | Server | Individual reference images by index (1-based) |
| `{{calculated_output_size}}` | Preprocessor | An `{width, height}` object calculated by `image_get_size` or `image_get_size_mp` |
| `{{calculated_output_size_width}}` | Preprocessor | Calculated width as a number by `image_get_size` or `image_get_size_mp`|
| `{{calculated_output_size_height}}` | Preprocessor | Calculated height as a number by `image_get_size` or `image_get_size_mp`|
| `{{calculated_output_aspect_ratio}}` | Preprocessor | Calculated aspect ratio by `image_get_size`|
| `{{calculated_output_aspect_ratio_changed}}` | Preprocessor | `true` if aspect ratio was changed by `image_get_size`|

### 5.7 Reference Variables

There are three ways to include reference images in the request body, depending on what the API expects:

#### Method 1: Flat Array (`{{resolved_image_array}}`)
Inserts reference images as plain strings into an array. If placed inside a JSON array, the elements are automatically spread (flattened).

```jsonc
"image_urls": ["{{source_image}}", "{{resolved_image_array}}"]
// Result: ["data:image/png;base64,src...", "data:image/png;base64,ref1...", "data:image/png;base64,ref2..."]
```

**Used by:** FAL-based providers (Seedream, Wan, Qwen)

#### Method 2: Object Array (`{{resolved_references}}` + `reference_item_template`)
Each reference image is wrapped through the `reference_item_template` and the resulting objects are spread into the array.

```jsonc
"reference_item_template": { "url": "{{item}}", "type": "image_url" },
"body_template": {
    "images": [
        { "url": "{{source_image}}", "type": "image_url" },
        "{{resolved_references}}"
    ]
}
// Result: [{ "url": "src...", "type": "image_url" }, { "url": "ref1...", "type": "image_url" }, ...]
```

**Used by:** xAI Grok

#### Method 3: Flat Fields (`{{reference_1}}`, `{{reference_2}}`, ...)
Each reference image is placed into a separate named field using conditional syntax to omit empty ones.

```jsonc
"body_template": {
    "input_image": "{{source_image}}",
    "{{?reference_1}}input_image_2": "{{reference_1}}",
    "{{?reference_2}}input_image_3": "{{reference_2}}",
    "{{?reference_3}}input_image_4": "{{reference_3}}"
}
// If 2 refs provided: { "input_image": "src...", "input_image_2": "ref1...", "input_image_3": "ref2..." }
// If 0 refs: { "input_image": "src..." }
```

**Used by:** BFL providers (FLUX.2, Kontext)

---

## 6. UI Parameters (`parameters`)

The `parameters` array defines the dynamic UI controls rendered in the browser. Each entry creates an input element in the Source Tab's settings panel.

### 6.1 Supported Parameter Types

| `type` | UI Element | Required Fields | Optional Fields |
|--------|-----------|----------------|-----------------|
| `"string"` | Text input | `name`, `default` | `label`, `alias` |
| `"boolean"` | Checkbox | `name`, `default` | `label`, `alias` |
| `"integer"` | Number input (whole numbers) | `name`, `default` | `label`, `alias` |
| `"number"` | Number input (decimals) | `name`, `default` | `label`, `alias` |
| `"slider"` | Range slider | `name`, `min`, `max`, `step`, `default` | `label`, `alias` |
| `"dropdown"` | Select dropdown | `name`, `options`, `default` | `label`, `alias` |

#### Common Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | **Required.** The key used in the request body template (`{{name}}`). Must be unique within the provider. |
| `label` | `string` | Human-readable label shown in the UI. Defaults to `name` if absent. |
| `alias` | `string` | Cross-provider identifier for value persistence. See §6.3 and §6.4. |
| `default` | `any` | Default value when the parameter has no saved state. |

### 6.2 Dropdown Options — Aliases and Hidden Values

Dropdown `options` can be either simple strings or objects with additional metadata:

**Simple string options:**
```jsonc
{
    "name": "model",
    "type": "dropdown",
    "options": ["pro", "max"],
    "default": "pro"
}
```

**Object options with aliases and labels:**
```jsonc
{
    "name": "resolution",
    "type": "dropdown",
    "alias": "output_resolution",
    "options": [
        { "value": "1k", "alias": "std" },
        { "value": "2k", "alias": "high" },
        { "value": "2k", "alias": "ultra", "hidden": true }
    ],
    "default": "1k"
}
```

| Option Field | Type | Description |
|-------------|------|-------------|
| `value` | `string` | **Required.** The actual value sent to the API. |
| `label` | `string` | Text shown in the dropdown. Defaults to `value`. |
| `alias` | `string` | Cross-provider value alias for persistence. See §6.4. |
| `hidden` | `boolean` | If `true`, this option is not rendered in the dropdown but can be selected via alias matching. See below. |

#### Hidden Options — Explained

Hidden options serve as **alias bridges** between providers with different resolution levels.

**Example scenario:** Provider A has resolutions "std", "high", "ultra", while Provider B only has "high" and "ultra" (where "ultra" in B corresponds to "2k", same as "high").

```jsonc
// Provider B (Seedream) — only 2K and 4K available
"options": [
    { "value": "2K", "alias": "std", "hidden": true },  // Hidden: "std"→"2K" silently
    { "value": "2K", "alias": "high" },                   // Visible
    { "value": "4K", "alias": "ultra" }                    // Visible
]
```

If the user switches from Provider A (where they selected "std" = "1k") to Provider B, the system:
1. Looks for an option with `alias: "std"` → finds the hidden option with `value: "2K"`
2. Since it's hidden, finds a visible option with the same `value` ("2K") → selects "high"
3. The dropdown shows "high" selected

This creates seamless value mapping between providers with different capability sets.

**Object options with labels (no aliases):**
```jsonc
{
    "name": "model_xai",
    "type": "dropdown",
    "label": "Model",
    "options": [
        { "value": "grok-imagine-image", "label": "Standard ($0.02/per output image + $0.002/per input image)" },
        { "value": "grok-imagine-image-pro", "label": "Pro ($0.07/per output image + $0.002/per input image)" }
    ],
    "default": "grok-imagine-image"
}
```

### 6.3 Reserved Aliases

Some alias values have special meaning — parameters with these aliases are **not rendered** in the dynamic settings panel. Instead, they appear in fixed, pre-defined locations in the UI:

| Alias | UI Location | Notes |
|-------|-------------|-------|
| `"prompt"` | Fixed text area at the top of Source Tab | **Must** be declared in `parameters` so the value gets collected and sent to the server. |
| `"negative_prompt"` | Text area below the main prompt | Only shown when `supports_negative_prompt: true`. Must be declared in `parameters`. |
| `"num_images"` | Fixed number input next to the "Generate" button | **Global variable.** Extracted from the root payload, NOT from `parameters`. Do NOT declare in `parameters` — it is not needed and will be ignored by the UI. |
| `"aspect_ratio"` | Fixed dropdown at the top of Source Tab | **Global variable.** Managed by a fixed UI control. Do NOT declare in `parameters`. Use `allowed_aspect_ratios` (§3.6) to restrict available values. Available as `{{aspect_ratio}}` in templates. |

> [!CAUTION]
> `aspect_ratio` and `num_images` are **global system variables**, not provider parameters. They are managed by fixed UI controls and are always available as `{{aspect_ratio}}` and `{{num_images}}` in templates. **Never** create a parameter with `alias: "aspect_ratio"` or `alias: "num_images"`. To restrict available aspect ratios, use the `allowed_aspect_ratios` provider field (§3.6).

### 6.4 Alias Persistence Across Provider Switches

Aliases enable value persistence when the user switches between providers. The system maintains a global `aliasState` map:

1. When the user changes a parameter with an alias, both `formState[alias]` and `aliasState[alias]` are updated
2. When switching to a new provider, each parameter checks `aliasState[alias]` for a previously saved value
3. If found and the new provider has an option with a matching alias/value, that value is pre-selected
4. Parameters without aliases are always reset to their `default` value

**Example flow:**
1. User selects "high" resolution (alias: `"high"`) in Provider A
2. User switches to Provider B
3. Provider B's resolution dropdown has an option with `"alias": "high"` → it's auto-selected
4. User switches to Provider C which has no resolution parameter → nothing happens
5. User switches back to Provider A → "high" is restored from `aliasState`

---

## 7. Response Configuration (`response_config`)

Each provider's `response_config` links to a shared response handler and optionally provides provider-specific parameters.

### 7.1 Linking to a Response Handler (`$ref`)

```jsonc
"response_config": {
    "$ref": "bfl"
}
```

The `$ref` value must match a key in the top-level `response_handlers` object. The handler defines the full response processing logic (polling, extraction, etc.).

### 7.2 Provider-Specific Params

Some handlers are parameterized — the provider supplies values that the handler uses for URL construction or result extraction.

```jsonc
// FAL provider: supplies the model path for URL construction
"response_config": {
    "$ref": "fal",
    "params": { "model_path": "fal-ai/bytedance/seedream/v4.5/edit" }
}

// Sync provider: supplies the image extraction strategy
"response_config": {
    "$ref": "sync",
    "params": {
        "format": "url",
        "extract": [
            { "path": "data", "mode": "array", "item_path": "url" }
        ]
    }
}
```

**This field is server-side only** — it is stripped before sending provider data to the browser.

---

## 8. Response Handlers (`response_handlers`)

Response handlers are defined at the top level of `providers.json` to avoid duplication. Multiple providers from the same platform share one handler.

### 8.1 Handler Types

| Type | Description | Use Case |
|------|-------------|----------|
| `"sync"` | Result is immediately available in the response to the initial POST request. | xAI Grok, OpenRouter |
| `"async_poll"` | Server polls a status URL until completion. The result data is in the poll response itself. | BFL FLUX, Replicate |
| `"async_poll_and_get"` | Server polls for status, then makes a **separate GET request** to fetch the actual result. | FAL |

### 8.2 `sync` — Synchronous Response

The simplest type. The API returns generated images directly in the response to the generation request.

```jsonc
"sync": {
    "type": "sync",
    "result": {
        "source": "submit_response",
        "images": {
            "format": "{{format}}",
            "extract": ["{{extract}}"]
        }
    }
}
```

The `{{format}}` and `{{extract}}` placeholders are filled from the provider's `response_config.params`:
```jsonc
"params": {
    "format": "url",
    "extract": [{ "path": "data", "mode": "array", "item_path": "url" }]
}
```

### 8.3 `async_poll` — Asynchronous with Polling

The server sends the generation request, receives a job ID/URL, then polls until the job completes. The final result is in the poll response body.

```jsonc
"bfl": {
    "type": "async_poll",
    "polling": {
        "url_template": "{{polling_url}}",
        "variables_from_submit": {
            "polling_url": "polling_url"
        },
        "method": "GET",
        "headers": {
            "accept": "application/json",
            "x-key": "{{env:BFL_API_KEY}}"
        },
        "interval_ms": 2000,
        "timeout_ms": 180000,
        "status": {
            "path": "status",
            "in_progress": ["Pending", "Processing"],
            "completed": ["Ready"],
            "failed": ["Error", "Failed", "Content Moderated", "Insufficient credits"]
        },
        "error_path": "status"
    },
    "result": {
        "source": "poll_response",
        "images": {
            "format": "url",
            "extract": [
                { "path": "result.sample", "mode": "single" }
            ]
        }
    }
}
```

### 8.4 `async_poll_and_get` — Poll + Separate GET

Similar to `async_poll`, but after polling confirms completion, the server makes an additional GET request to a result endpoint to fetch the actual data.

```jsonc
"fal": {
    "type": "async_poll_and_get",
    "polling": {
        "url_template": "{{status_url}}",
        "variables_from_submit": {
            "request_id": "request_id",
            "status_url": "status_url",
            "response_url": "response_url"
        },
        "method": "GET",
        "use_request_headers": true,
        "interval_ms": 2000,
        "timeout_ms": 180000,
        "status": {
            "path": "status",
            "in_progress": ["IN_QUEUE", "IN_PROGRESS"],
            "completed": ["COMPLETED"],
            "failed": ["FAILED", "ERROR"]
        },
        "error_path": "error"
    },
    "result": {
        "source": "separate_request",
        "url_template": "{{response_url}}",
        "method": "GET",
        "use_request_headers": true,
        "images": {
            "format": "url",
            "extract": [
                { "path": "images", "mode": "array", "item_path": "url" },
                { "path": "image", "mode": "single", "item_path": "url" }
            ]
        }
    }
}
```

### 8.5 Polling Configuration

| Field | Type | Description |
|-------|------|-------------|
| `url_template` | `string` | URL to poll for status. Supports placeholders from `variables_from_submit`. |
| `variables_from_submit` | `object` | Maps variable names to JSON paths in the initial submit response. Example: `{"request_id": "request_id"}` extracts `response.request_id` as `{{request_id}}`. |
| `method` | `string` | HTTP method for polling (`"GET"`). |
| `use_request_headers` | `boolean` | If `true`, reuses the original request headers (from `request_config.headers`) for polling. `Content-Type` is automatically stripped for GET. |
| `headers` | `object` | Alternative headers for polling (used when a different auth key is needed). |
| `interval_ms` | `number` | Milliseconds between poll requests. |
| `timeout_ms` | `number` | Maximum time to wait before reporting a timeout error. |
| `status.path` | `string` | JSON dot-path to the status field in poll responses (e.g., `"status"`). |
| `status.in_progress` | `string[]` | Status values that mean "keep polling". |
| `status.completed` | `string[]` | Status values that mean "done, extract results". |
| `status.failed` | `string[]` | Status values that mean "generation failed". |
| `error_path` | `string` | JSON dot-path to the error message in failed responses. |

### 8.6 Result Configuration

| Field | Type | Description |
|-------|------|-------------|
| `source` | `string` | Where to get the final data. One of: `"submit_response"`, `"poll_response"`, `"separate_request"`. |
| `url_template` | `string` | (For `"separate_request"`) URL template for the GET request. |
| `method` | `string` | HTTP method (default: `"GET"`). |
| `use_request_headers` | `boolean` | Reuse original request headers. |
| `images` | `object` | Image extraction configuration. See §8.7. |

### 8.7 Image Extraction (`images`)

Defines how to find and download generated images from the API response.

```jsonc
"images": {
    "format": "url",
    "extract": [
        { "path": "images", "mode": "array", "item_path": "url" },
        { "path": "image", "mode": "single", "item_path": "url" }
    ],
    "download_headers": { ... }  // Optional
}
```

| Field | Type | Description |
|-------|------|-------------|
| `format` | `string` | Format of image data in the response: `"url"` (download URL), `"data_uri"`, or `"base64_raw"`. |
| `extract` | `array` | **Ordered** array of extraction strategies. The engine tries each in order and uses the first one that yields results. |
| `download_headers` | `object` | Optional headers to include when downloading images (e.g., authentication for protected URLs). |

#### Extraction Strategy Object

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | JSON dot-path to the image data in the response (e.g., `"data"`, `"result.sample"`, `"images"`). |
| `mode` | `string` | `"array"` — expects an array of items at `path`; `"single"` — expects a single value at `path`. |
| `item_path` | `string` | Optional. For `"array"` mode: JSON dot-path within each array element to the actual image URL/data. If absent, the element itself is treated as the image string. For `"single"` mode: sub-path within the object at `path`. |

**Example: Multiple extraction strategies as fallbacks**
```jsonc
"extract": [
    { "path": "images", "mode": "array", "item_path": "url" },  // Try: response.images[].url
    { "path": "image", "mode": "single", "item_path": "url" }   // Fallback: response.image.url
]
```

This handles APIs that return `{ images: [{url: "..."}, ...] }` for multi-image results and `{ image: {url: "..."} }` for single results.

---

## 9. Preprocessors (`preprocessor`)

### 9.1 Overview

Preprocessors are server-side functions that run **before** the request is built. They can:
- Resize source images, masks, and reference images
- Calculate output dimensions based on aspect ratios and resolution targets
- Inject computed variables (like `calculated_output_size`) into the template context

The preprocessor pipeline runs sequentially — each preprocessor in the array executes in order, and its output feeds into the next.

**This field is server-side only** — it is stripped before sending provider data to the browser.

### 9.2 Preprocessor Array Structure

```jsonc
"preprocessor": [
    {
        "name": "image_get_size",        // Name of the preprocessor function
        "args": {                         // Arguments passed to the function
            "max_size": "{{image_size}}", // Supports placeholders (resolved from user params)
            "auto_resize_2_max": true,
            "filter_by": "{{aspect_ratio}}",
            "filter_type": "not_empty"
        }
    }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Identifies which preprocessor function to execute. |
| `args` | `object` | Arguments object. Supports `{{placeholder}}` syntax — resolved against user parameters before execution. |

### 9.3 Conditional Execution (Filtering)

Preprocessors can have filter conditions that determine whether they should execute. This is critical when a single provider encompasses multiple models with different requirements.

| Filter Arg | Type | Description |
|-----------|------|-------------|
| `filter_by` | `string` | The value to test (typically a `{{placeholder}}` resolved from user params). |
| `filter_type` | `string` | The comparison operation. See table below. |
| `values` | `string` or `array` | The reference value(s) to compare against. |

#### Filter Types

| `filter_type` | Logic | Example |
|--------------|-------|---------|
| `"contains"` | At least one value contains `filter_by` as a substring, OR `filter_by` contains at least one value as a substring. | `filter_by: "fal-ai/qwen-image-2/edit"`, `values: "qwen-image-2"` → ✅ match |
| `"not_contains"` | Inverse of `contains`. | |
| `"equals"` | At least one value equals `filter_by` exactly. | `filter_by: "pro"`, `values: ["pro", "max"]` → ✅ match |
| `"not_equals"` | At least one value does NOT equal `filter_by`. | |
| `"not_empty"` | `filter_by` is not null, not undefined, and not an empty string. `values` is ignored. | `filter_by: "16:9"` → ✅ match; `filter_by: ""` → ❌ skip |
| `"empty"` | `filter_by` IS null, undefined, or empty string. `values` is ignored. | `filter_by: ""` → ✅ match |

**Example: Multiple conditional preprocessors for different models**
```jsonc
"preprocessor": [
    {
        "name": "image_get_size",
        "args": {
            "max_size": 2048,
            "min_size": 512,
            "auto_resize_2_max": "{{auto_resize_2_max}}",
            "filter_by": "{{model_alibaba}}",    // Current model selection
            "filter_type": "contains",
            "values": "qwen-image-2"             // Only run for Qwen models
        }
    },
    {
        "name": "image_get_size",
        "args": {
            "max_size": 1280,
            "min_size": 768,
            "auto_resize_2_max": "{{auto_resize_2_max}}",
            "filter_by": "{{model_alibaba}}",
            "filter_type": "contains",
            "values": "wan/"                     // Only run for Wan 2.6/2.7 models
        }
    }
]
```

**Example: Fixed-set size APIs (different `max_size` per aspect ratio)**

Some APIs accept only a fixed set of size strings (e.g., OpenAI GPT-Image: `"1024x1024"`, `"1536x1024"`, `"1024x1536"`). Since `image_get_size` assigns `max_size` to the longer side, a single call cannot produce correct values for all ratios (e.g., `max_size: 1536` gives `1536x1536` for `1:1`, but the API requires `1024x1024`). Use multiple preprocessors with `filter_type: "equals"` to match specific aspect ratios:

```jsonc
"allowed_aspect_ratios": ["3:2", "1:1", "2:3"],
"preprocessor": [
    {
        "name": "image_get_size",
        "args": {
            "max_size": 1024,                      // 1:1 → 1024×1024
            "filter_by": "{{aspect_ratio}}",
            "filter_type": "equals",
            "values": "1:1"
        }
    },
    {
        "name": "image_get_size",
        "args": {
            "max_size": 1536,                      // 3:2 → 1536×1024, 2:3 → 1024×1536
            "filter_by": "{{aspect_ratio}}",
            "filter_type": "equals",
            "values": ["3:2", "2:3"]
        }
    }
]
```

In the `body_template`, use conditional keys to pass the default when no aspect ratio is selected, or the calculated dimensions when one is:
```jsonc
"{{?!aspect_ratio}}size": "auto",
"{{?aspect_ratio}}size": "{{calculated_output_size_width}}x{{calculated_output_size_height}}"
```

### 9.4 Available Preprocessors

#### 9.4.1 `image_get_size`

**Purpose:** Calculates output dimensions based on aspect ratio and size constraints. Optionally resizes source image to fit within limits.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `max_size` | `number` or `string` | `1440` | Maximum pixel dimension for the longer side. Accepts numbers or strings like `"2K"`, `"4K"` (converted to `2048`, `4096`). Supports placeholders. |
| `min_size` | `number` | `256` | Minimum pixel dimension for the shorter side. |
| `step` | `number` | `1` | Dimensions are rounded down to the nearest multiple of this value (e.g., `32` for models requiring multiples of 32). |
| `auto_resize_2_max` | `boolean` | `false` | If `true`, always scale the source image to fill the `max_size`. If `false`, only downscale if larger. |
| `filter_by` | `string` | — | Filter value for conditional execution. |
| `filter_type` | `string` | — | Filter comparison type. |
| `values` | `string`/`array` | — | Reference value(s) for filter comparison. |

**Behavior:**
- If `aspect_ratio` is set → calculates dimensions from the ratio and `max_size`
- If `aspect_ratio` is empty → reads the source image dimensions and constrains them to `max_size`/`min_size`

**Sets context variables:** `calculated_output_size`, `calculated_output_size_width`, `calculated_output_size_height`, `calculated_output_aspect_ratio`, `calculated_output_aspect_ratio_changed`

#### 9.4.2 `image_get_size_mp`

**Purpose:** Calculates output dimensions targeting a specific megapixel area. Used by providers that bill per-megapixel (e.g., BFL FLUX.2).

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `auto_resize_2_max` | `boolean` | `false` | If `true`, upscale to target resolution. If `false`, only downscale if larger. |
| `output_resolution_mp` | `string` | `"1"` | Target megapixels. Format: `"N"` (exact) or `"N-"` (up to, no upscaling, `auto_resize_2_max` has priority). Examples: `"1"`, `"2-"`, `"4"`. |
| `min_size` | `number` | `256` | Minimum dimension. |
| `min_area` | `number` / `string` | `0` | Minimum allowed total area. Can be a number (e.g., `1048576`) or a string formula (e.g., `"1024*1024"`). |
| `step` | `number` | `1` | Rounding step. |
| `always_output` | `boolean` | `true` | If `false`, skip setting output variables when no resize is needed. |

**Resolution string format:**
- `"1"` → exactly 1 megapixel (~1024×1024). Will upscale if needed.
- `"1-"` → up to 1 megapixel. Will only downscale, never upscale.
- `"4"` → exactly 4 megapixels (~2048×2048).
- `"4-"` → up to 4 megapixels.

**Sets context variables:** `calculated_output_size`, `calculated_output_size_width`, `calculated_output_size_height`

#### 9.4.3 `image_optimizer_mp`

**Purpose:** Reduces the dimensions of the actual input image data (source, mask, and references) to optimize for per-megapixel pricing and save on API costs. 

> **Important:** This preprocessor **never upscales** images. It evaluates whether the image needs to be reduced and only downscales it if it exceeds the target resolution. If the original image is smaller, its size remains unchanged.

This optimizer is highly effective for cost-saving strategies. For example, if you are requesting a provider to generate a 4 MP output image, sending a 4 MP input image can be expensive. By using this optimizer (e.g., in `"all_1mp"` mode), you can downscale the input image to 1 MP before sending it, while the generation request variables will still instruct the model to produce a 4 MP output. This approach drastically cuts input costs while maintaining the desired output resolution.

Unlike the `image_get_size*` preprocessors that only *calculate* dimensions, this one actually **transforms the image buffers**.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `optimization_mode` | `string` | — | How to resize. See modes below. |
| `output_resolution_mp` | `string` | `"1"` | Target megapixels (same format as `image_get_size_mp`). |
| `min_size` | `number` | `256` | Minimum dimension. |
| `step` | `number` | `1` | Rounding step. |

**Optimization Modes:**

| Mode | Source Image | Reference Images |
|------|-------------|-----------------|
| `"auto"` | Downscale to `output_resolution_mp` | Downscale to `output_resolution_mp` |
| `"auto_plus"` | Downscale to `output_resolution_mp` | Downscale to 1 MP each |
| `"refs_2_1mp"` | No change | Downscale to 1 MP each |
| `"all_1mp"` | Downscale to 1 MP | Downscale to 1 MP each |

**Returns modified images:** Unlike other preprocessors, this one actually returns new image data (`source_image`, `mask_image`, `reference_images`) that replaces the originals in the pipeline.

> **Note:** The mask is always resized to match the source image dimensions, maintaining synchronization.

### 9.4.4 `image_optimizer_by_min_size`

**Purpose:** Resizes the actual image data (source and mask) to ensure they meet a minimum side length and/or minimum total area (in pixels) requirements, upscaling if necessary. Useful for models that require inputs to be above a certain resolution (e.g., Alibaba, Flux inpaint).

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `uscale_2_min` | `boolean` | `false` | Must be explicitly set to `true` for the preprocessor to run. |
| `min_size` | `number` | `256` | Minimum allowed length for either side (width or height). |
| `min_area` | `number` / `string` | `0` | Minimum allowed total area. Can be a number (e.g., `1048576`) or a string formula (e.g., `"1024*1024"`). |
| `step` | `number` | `1` | Rounding step for the final dimensions. |

**Returns modified images:** If upscaling was needed, it returns new upscaled image data (`source_image`, `mask_image`, `reference_images`) that replaces the originals in the pipeline. References are returned unmodified.

#### 9.4.5 `convert_mask_to_alpha`

**Purpose:** Converts a white/black mask image into a PNG with alpha channel transparency. Required by APIs (e.g., OpenAI GPT-Image) that expect mask transparency to indicate editable areas, rather than white/black pixel values.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `mode` | `string` | `"white_to_transparent"` | Which color becomes transparent. `"white_to_transparent"`: white pixels → transparent. `"black_to_transparent"`: black pixels → transparent. |
| `threshold` | `number` | `128` | Grayscale threshold (0–255). Pixels above threshold are treated as "white", below as "black". |
| `filter_by` | `string` | — | Filter value for conditional execution. |
| `filter_type` | `string` | — | Filter comparison type. |

**Returns modified images:** Returns a new `mask_image` with the alpha channel applied, replacing the original mask in the pipeline. The mask is re-encoded as PNG with transparency.

**Typical usage (only runs when mask is present):**
```jsonc
{
    "name": "convert_mask_to_alpha",
    "args": {
        "mode": "white_to_transparent",
        "threshold": 128,
        "filter_by": "{{mask_image}}",
        "filter_type": "not_empty"
    }
}
```

### 9.5 Preprocessor Output Variables

Preprocessors inject the following computed variables into the template context, making them available as placeholders in `body_template`:

| Variable | Type | Set by |
|----------|------|--------|
| `calculated_output_size` | `{width, height}` object | `image_get_size`, `image_get_size_mp` |
| `calculated_output_size_width` | `number` | `image_get_size`, `image_get_size_mp` |
| `calculated_output_size_height` | `number` | `image_get_size`, `image_get_size_mp` |

---

## 10. The `depends_on` Pattern — Dynamic Configuration

Multiple fields support a dynamic object form that changes behavior based on the value of a UI parameter. This pattern is used consistently for:

- `max_reference_images`
- `allowed_aspect_ratios`
- `filename_suffix`

**Standard structure:**
```jsonc
{
    "default": <fallback_value>,
    "depends_on": "<parameter_name>",
    "values": {
        "<option_value_1>": <specific_value_1>,
        "<option_value_2>": <specific_value_2>
    }
}
```

**Resolution logic:**
1. Read the current value of the parameter named in `depends_on`
2. Look it up in the `values` map
3. If found → use the mapped value
4. If not found → use `default`

**Example:**
```jsonc
"max_reference_images": {
    "default": 2,
    "depends_on": "model_alibaba",
    "values": {
        "fal-ai/qwen-image-2/edit": 2,
        "fal-ai/wan/v2.7/edit": 3,
        "fal-ai/wan/v2.7/pro/edit": 3
    }
}
```

When the user selects "Wan 2.7 Pro" (`"fal-ai/wan/v2.7/pro/edit"`), `max_reference_images` becomes `3`.
When they select any model not in `values`, it falls back to `2`.

---

## 11. Server-Side Processing Flow

When the user clicks "Generate", this is the complete server-side sequence:

```
1. Load providers.json
2. Find provider by providerId
3. Validate mask requirements
4. Build context from user params + system variables
5. Convert images to provider's image_format
6. ──── PREPROCESSOR PIPELINE ────
   │  For each preprocessor in provider.preprocessor[]:
   │    a. Resolve {{placeholders}} in args
   │    b. Check filter condition
   │    c. If filter passes → execute preprocessor
   │    d. Preprocessor may modify images & add context vars
   └────────────────────────────────
7. Build reference variables (resolved_image_array, resolved_references, reference_1..N)
8. Resolve all placeholders in endpoint_url
9. Resolve all placeholders in headers
10. Resolve all placeholders in body_template
    - Remove conditional keys where condition is false
    - Flatten arrays with spread variables
11. ──── REQUEST EXECUTION ────
    │  If single_image_per_request:
    │    Loop num_images times, one request each
    │  Else:
    │    Single request with num_images in body
    └──────────────────────────
12. ──── RESPONSE HANDLING ────
    │  Resolve response handler via $ref
    │  Based on handler type:
    │    sync → extract from submit response
    │    async_poll → poll, extract from poll response
    │    async_poll_and_get → poll, GET, extract from GET response
    │  Extract images using extract[] strategies
    │  Download/save each image to disk
    └──────────────────────────
13. Return results array to client
```

---

## 12. Security Model

| Aspect | Implementation |
|--------|---------------|
| **API Keys** | Stored in `.env` file or injected via NebulaSecrets. Referenced via `{{env:VAR_NAME}}` in templates. Never exposed to the browser. |
| **Request Config** | `request_config`, `response_config`, `image_format`, `filename_suffix`, and `preprocessor` are all stripped from provider data before sending to the browser (`GET /api/webhelper/providers`). |
| **Browser Isolation** | The browser only sees: `id`, `name`, `parameters`, `mask_handling`, `max_reference_images`, `supports_negative_prompt`, `english_only`, `allowed_aspect_ratios`, `remarks`. |
| **Dynamic Visibility**| Providers requiring API keys (via `{{env:VAR_NAME}}`) that are absent or empty in the server's `process.env` are entirely filtered out and never sent to the client. |
| **Path Traversal** | File serving endpoints validate paths against the temp directory to prevent directory traversal attacks. |

---

## 13. Complete Examples with Annotations

### 13.1 Grok Imagine (Sync, xAI Direct API)

A synchronous provider using xAI's Grok API. Supports reference images as objects and optional mask via referential mode.

```jsonc
{
            "id": "grok_imagine",
            "name": "Grok Imagine - via XAI API Key (from $0.022/$0.06 (quality) per image)", // Grok Imagine on FAL applies strong moderation filters
            "remarks": "Note that all generations that do not pass moderation are charged at full cost.",
            "image_format": "data_uri",
            "max_reference_images": 4,
            "supports_negative_prompt": false,
            "english_only": false,
            "mask_handling": {
                //"supported": true,
                //"type": "separate_field",
                //"field_name": "mask"
                //"supported": false,
                //"required": false
                "supported": true,
                "type": "first_referential",
                "field_name": "images"
            },
            "allowed_aspect_ratios": [ // works only when at least one referential image provided
                "2:1",
                "16:9",
                "3:2",
                "4:3",
                "1:1",
                "3:4",
                "2:3",
                "9:16",
                "1:2"
            ],
            "nice_name": {
                "default": "Grok Imagine Standard (XAI Key)",
                "depends_on": "model_xai",
                "values": {
                    "grok-imagine-image": "Grok Imagine Standard (XAI Key)",
                    "grok-imagine-image-quality": "Grok Imagine Quality (XAI Key)"
                }
            },
            "filename_suffix": {
                "default": "grok_imagine",
                "depends_on": "model_xai",
                "values": {
                    "grok-imagine-image": "grok_imagine",
                    "grok-imagine-image-quality": "grok_imagine_quality"
                }
            },
            "request_config": {
                "{{?!source_image}}endpoint_url": "https://api.x.ai/v1/images/generations",
                "{{?source_image}}endpoint_url": "https://api.x.ai/v1/images/edits",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer {{env:XAI_API_KEY}}"
                },
                "reference_item_template": {
                    "url": "{{item}}",
                    "type": "image_url"
                },
                "body_template": {
                    "model": "{{model_xai}}",
                    "prompt": "{{prompt}}",
                    "n": "{{num_images}}",
                    "resolution": "{{resolution}}",
                    "{{?aspect_ratio}}aspect_ratio": "{{aspect_ratio}}",
                    "{{?source_image}}images": [
                        {
                            "url": "{{source_image}}",
                            "type": "image_url"
                        },
                        "{{resolved_references}}"
                    ] //,
                    //"{{?mask_image}}mask": {
                    //    "url": "{{mask_image}}",
                    //    "type": "image_url"
                    //}
                }
            },
            "response_config": {
                "$ref": "sync",
                "params": {
                    "format": "url",
                    "extract": [
                        {
                            "path": "data",
                            "mode": "array",
                            "item_path": "url"
                        }
                    ]
                }
            },
            "parameters": [
                {
                    "name": "prompt",
                    "type": "string",
                    "alias": "prompt",
                    "label": "Text Prompt",
                    "default": ""
                },
                {
                    "name": "model_xai",
                    "type": "dropdown",
                    "label": "Model",
                    "options": [
                        {
                            "value": "grok-imagine-image",
                            "label": "Standard ($0.02/per output image + $0.002/per input image)"
                        },
                        {
                            "value": "grok-imagine-image-quality",
                            "label": "Quality ($0.05(1K)/$0.07(2K)/per output image + $0.01/per input image)"
                        }
                    ],
                    "default": "grok-imagine-image"
                },
                //{
                //    "name": "n",
                //    "type": "slider",
                //    "alias": "num_images",
                //    "label": "Number of images",
                //    "min": 1,
                //    "max": 4,
                //    "step": 1,
                //    "default": 2
                //},
                {
                    "name": "resolution",
                    "type": "dropdown",
                    "alias": "output_resolution",
                    "label": "Resolution",
                    "options": [
                        {
                            "value": "1k",
                            "alias": "std"
                        },
                        {
                            "value": "2k",
                            "alias": "high"
                        },
                        {
                            "value": "2k",
                            "alias": "ultra",
                            "hidden": true
                        }
                    ],
                    "default": "1k"
                }
            ]
        }
```

### 13.2 Seedream v4.5 via FAL (Async Poll+GET, Preprocessor)

An asynchronous provider using FAL's queue API. Features a preprocessor for dynamic image sizing.

```jsonc
{
            "id": "seedream_v4_5_fal",
            "name": "Seedream v4.5 via Fal API Key ($0.04/per image)",
            "nice_name": "Seedream v4.5 (FAL Key)",
            "filename_suffix": "seedream_v4_5",
            "image_format": "data_uri",
            "max_reference_images": 9,
            "supports_negative_prompt": false,
            "english_only": false,
            "mask_handling": {
                "supported": true,
                "type": "first_referential",
                "field_name": "image_urls"
            },
            // "allowed_aspect_ratios": [
            //     "16:9",
            //     "4:3",
            //     "1:1",
            //     "3:4",
            //     "9:16"
            // ],
            "preprocessor": [
                {
                    "name": "image_get_size",
                    "args": {
                        "max_size": "{{image_size}}",
                        "auto_resize_2_max": true,
                        "filter_by": "{{aspect_ratio}}",
                        "filter_type": "not_empty"
                    }
                }
            ],
            "request_config": {
                "{{?!source_image}}endpoint_url": "https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image",
                "{{?source_image}}endpoint_url": "https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/edit",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "Authorization": "Key {{env:FAL_API_KEY}}",
                    "X-Fal-Store-IO": "0"
                },
                "body_template": {
                    "prompt": "{{prompt}}",
                    "enable_safety_checker": false,
                    "{{?!aspect_ratio}}image_size": "auto_{{image_size}}",
                    "{{?aspect_ratio}}image_size": "{{calculated_output_size}}",
                    "num_images": "{{num_images}}",
                    "{{?!max_images}}max_images": 1,
                    "{{?max_images}}max_images": "{{max_images}}",
                    "{{?source_image}}image_urls": [
                        "{{source_image}}",
                        "{{resolved_image_array}}"
                    ]
                }
            },
            "response_config": {
                "$ref": "fal",
                "params": {
                    "model_path": "fal-ai/bytedance/seedream/v4.5/edit"
                }
            },
            "parameters": [
                {
                    "name": "prompt",
                    "type": "string",
                    "alias": "prompt",
                    "label": "Text Prompt",
                    "default": ""
                },
                {
                    "name": "image_size",
                    "type": "dropdown",
                    "alias": "output_resolution",
                    "label": "Output Size",
                    "options": [
                        {
                            "value": "2K",
                            "alias": "std",
                            "hidden": true
                        },
                        {
                            "value": "2K",
                            "alias": "high"
                        },
                        {
                            "value": "4K",
                            "alias": "ultra"
                        }
                    ],
                    "default": "2K"
                },
                {
                    "name": "max_images",
                    "type": "dropdown",
                    "alias": "sequential_image_generation",
                    "label": "Model decides whether to generate multiple related images",
                    "options": [
                        {
                            "value": 0,
                            "alias": "0",
                            "label": "No"
                        },
                        {
                            "value": 2,
                            "alias": "2",
                            "label": "Up to 2"
                        },
                        {
                            "value": 3,
                            "alias": "3",
                            "label": "Up to 3"
                        },
                        {
                            "value": 4,
                            "alias": "4",
                            "label": "Up to 4"
                        },
                        {
                            "value": 5,
                            "alias": "5",
                            "label": "Up to 5"
                        }
                    ],
                    "default": 0
                }
            ]
        }
```

### 13.3 FLUX.1 Fill (Async Poll, BFL, Inpainting Required)

A provider that strictly requires a mask for inpainting. Uses BFL's polling API.

```jsonc
{
            "id": "bfl_flux_fill_inpaint",
            "name": "FLUX.1 Fill inpaint via BFL API Key ($0.05/image)",
            "nice_name": "FLUX.1 Fill (BFL Key)",
            "image_format": "base64_raw",
            "max_reference_images": 0,
            "supports_negative_prompt": false,
            "english_only": false,
            "mask_handling": {
                "supported": true,
                "required": true,
                "type": "separate_field",
                "field_name": "mask"
            },
            // Empty array: provider does not support aspect ratio changes (always matches input size)
            "allowed_aspect_ratios": [],
            "preprocessor": [
                {
                    "name": "image_optimizer_by_min_size",
                    "args": {
                        "min_size": 256,
                        "uscale_2_min": "{{allow_uscale_2_min}}"
                    }
                }
            ],
            "request_config": {
                "single_image_per_request": true,
                "endpoint_url": "https://api.bfl.ai/v1/flux-pro-1.0-fill",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "x-key": "{{env:BFL_API_KEY}}"
                },
                "body_template": {
                    "prompt": "{{prompt}}",
                    "image": "{{source_image}}",
                    "mask": "{{mask_image}}",
                    "steps": 25,
                    "guidance": 30,
                    "output_format": "png",
                    "safety_tolerance": 6
                }
            },
            "response_config": {
                "$ref": "bfl"
            },
            "parameters": [
                {
                    "name": "prompt",
                    "type": "string",
                    "alias": "prompt",
                    "label": "Text Prompt",
                    "default": ""
                },
                {
                    "name": "allow_uscale_2_min",
                    "alias": "allow_uscale_2_min",
                    "type": "boolean",
                    "label": "Allow upscale to min size",
                    "default": false
                }
            ]
        }
```

### 13.4 FLUX.2 (BFL, Multiple Models, Megapixel Preprocessors)

A complex provider featuring multiple model variants, megapixel-based pricing optimization, and two chained preprocessors.

```jsonc
{
            "id": "bfl_flux2",
            "name": "FLUX.2 via BFL API Key (from $0.015 per image)",
            "nice_name": {
                "default": "FLUX.2 {{model_flux2}} (BFL Key)",
                "depends_on": "model_flux2",
                "values": {
                    "pro": "FLUX.2 Pro (BFL Key)",
                    "max": "FLUX.2 Max (BFL Key)",
                    "klein-9b": "FLUX.2 Klein 9B (BFL Key)",
                    "klein-4b": "FLUX.2 Klein 4B (BFL Key)"
                }
            },
            "filename_suffix": {
                "default": "flux2_{{model_flux2}}",
                "depends_on": "model_flux2",
                "values": {
                    "klein-9b": "flux2_klein_9b",
                    "klein-4b": "flux2_klein_4b"
                }
            },
            "remarks": "<b>Pricing:</b> based on megapixels (1 MP = 1024x1024). Each image (input and output) is rounded up to the next MP. Each reference photo counts as at least 1 MP. Max 4 MP.<br><table style='width:100%; font-size: 0.8em; border-top: 1px solid #555; margin-top: 4px;'><tr><td>Model</td><td>1st MP</td><td>Next</td><td>Refs</td></tr><tr><td><b>Pro</b></td><td>$0.03</td><td>$0.015</td><td>$0.015</td></tr><tr><td><b>Max</b></td><td>$0.07</td><td>$0.03</td><td>$0.03</td></tr><tr><td><b>9B (K)</b></td><td>$0.015</td><td>$0.002</td><td>$0.002</td></tr><tr><td><b>4B (K)</b></td><td>$0.014</td><td>$0.001</td><td>$0.001</td></tr></table><br>Note: all generations that do not pass moderation are charged at full cost.",
            "image_format": "base64_raw",
            "max_reference_images": {
                "default": 7,
                "depends_on": "model_flux2",
                "values": {
                    "klein-9b": 3,
                    "klein-4b": 3
                }
            },
            "supports_negative_prompt": false,
            "english_only": false,
            "mask_handling": {
                "supported": true,
                "type": "first_referential",
                "field_name": "image_urls"
            },
            "preprocessor": [
                {
                    "name": "image_optimizer_mp",
                    "args": {
                        "optimization_mode": "{{input_optimization}}",
                        "output_resolution_mp": "{{output_resolution_mp}}",
                        "min_size": 64,
                        "step": 16
                    }
                },
                {
                    "name": "image_get_size_mp",
                    "args": {
                        "output_resolution_mp": "{{output_resolution_mp}}",
                        "min_size": 64,
                        "step": 16,
                        "always_output": false
                    }
                }
            ],
            "request_config": {
                "single_image_per_request": true,
                "endpoint_url": "https://api.bfl.ai/v1/flux-2-{{model_flux2}}",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "x-key": "{{env:BFL_API_KEY}}"
                },
                "body_template": {
                    "prompt": "{{prompt}}",
                    "output_format": "png",
                    "safety_tolerance": 5,
                    "disable_pup": true,
                    "transparent_bg": "{{transparent_bg}}",
                    "{{?calculated_output_size_width}}width": "{{calculated_output_size_width}}",
                    "{{?calculated_output_size_height}}height": "{{calculated_output_size_height}}",
                    "{{?source_image}}input_image": "{{source_image}}",
                    "{{?reference_1}}input_image_2": "{{reference_1}}",
                    "{{?reference_2}}input_image_3": "{{reference_2}}",
                    "{{?reference_3}}input_image_4": "{{reference_3}}",
                    "{{?reference_4}}input_image_5": "{{reference_4}}",
                    "{{?reference_5}}input_image_6": "{{reference_5}}",
                    "{{?reference_6}}input_image_7": "{{reference_6}}",
                    "{{?reference_7}}input_image_8": "{{reference_7}}"
                }
            },
            "response_config": {
                "$ref": "bfl"
            },
            "parameters": [
                {
                    "name": "prompt",
                    "type": "string",
                    "alias": "prompt",
                    "label": "Text Prompt",
                    "default": ""
                },
                {
                    "name": "model_flux2",
                    "type": "dropdown",
                    "label": "Model Variant",
                    "options": [
                        {
                            "value": "pro",
                            "label": "Flux 2 Pro (from $0.045 per image)"
                        },
                        {
                            "value": "max",
                            "label": "Flux 2 Max (from $0.1 per image)"
                        },
                        {
                            "value": "klein-9b",
                            "label": "Flux 2 Klein 9B (from $0.017 per image)"
                        },
                        {
                            "value": "klein-4b",
                            "label": "Flux 2 Klein 4B (from $0.015 per image)"
                        }
                    ],
                    "default": "pro"
                },
                {
                    "alias": "output_resolution_mp",
                    "name": "output_resolution_mp",
                    "type": "dropdown",
                    "label": "Output Resolution",
                    "options": [
                        {
                            "value": "1-",
                            "label": "up to 1mp [~ 1K]"
                        },
                        {
                            "value": "1",
                            "label": "1mp [~ 1K]"
                        },
                        {
                            "value": "2-",
                            "label": "up to 2mp [~ 1.5K]"
                        },
                        {
                            "value": "2",
                            "label": "2mp [~ 1.5K]"
                        },
                        {
                            "value": "3-",
                            "label": "up to 3mp [~ 1.7K]"
                        },
                        {
                            "value": "3",
                            "label": "3mp [~ 1.7K]"
                        },
                        {
                            "value": "4-",
                            "label": "up to 4mp [~ 2K]"
                        },
                        {
                            "value": "4",
                            "label": "4mp [~ 2K]"
                        }
                    ],
                    "default": "1-"
                },
                {
                    "name": "input_optimization",
                    "type": "dropdown",
                    "label": "Price optimization input images",
                    "options": [
                        {
                            "value": "auto",
                            "label": "Auto - all images will be downscaled to chosen Output Resolution"
                        },
                        {
                            "value": "auto_plus",
                            "label": "Auto - main image will be downscaled to chosen Output Resolution, reference images will be downscaled to 1MP each"
                        },
                        {
                            "value": "refs_2_1mp",
                            "label": "Only reference images up to 1MP each"
                        },
                        {
                            "value": "all_1mp",
                            "label": "All images up to 1MP each"
                        }
                    ],
                    "default": "auto_plus"
                },
                {
                    "name": "transparent_bg",
                    "type": "boolean",
                    "label": "Transparent Background",
                    "default": false
                }
            ]
        }
```

### 13.5 Alibaba / Wan / Qwen (Multi-Model with Conditional Preprocessors)

A provider that bundles multiple Alibaba-family models (Wan 2.5/2.6/2.7, Qwen 2) under one dropdown, with model-specific preprocessor filters.

```jsonc
{
            "id": "alibaba_fal",
            "name": "Wan/Qwen via Fal API Key (from $0.03/per image)",
            "nice_name": {
                "depends_on": "model_alibaba",
                "values": {
                    "fal-ai/qwen-image-2/edit": "Qwen 2 (FAL Key)",
                    "fal-ai/qwen-image-2/pro/edit": "Qwen 2 Pro (FAL Key)",
                    "wan/v2.6/image-to-image": "Wan 2.6 (FAL Key)",
                    "fal-ai/wan/v2.7/edit": "Wan 2.7 (FAL Key)",
                    "fal-ai/wan/v2.7/pro/edit": "Wan 2.7 Pro (FAL Key)",
                    "fal-ai/wan-25-preview/image-to-image": "Wan 2.5 (FAL Key)"
                }
            },
            "image_format": "data_uri",
            // All models support the full standard list by default.
            // Per-model overrides can be added under "values" when a model has restrictions.
            // "allowed_aspect_ratios": {
            //     "default": [
            //         "16:9",
            //         "4:3",
            //         "1:1",
            //         "3:4",
            //         "9:16"
            //     ],
            //     "depends_on": "model_alibaba",
            //     "values": {}
            // },
            "filename_suffix": {
                "depends_on": "model_alibaba",
                "values": {
                    "fal-ai/qwen-image-2/edit": "qwen_v2",
                    "fal-ai/qwen-image-2/pro/edit": "qwen_v2_pro",
                    "wan/v2.6/image-to-image": "wan_v2_6",
                    "fal-ai/wan/v2.7/edit": "wan_v2_7",
                    "fal-ai/wan/v2.7/pro/edit": "wan_v2_7_pro",
                    "fal-ai/wan-25-preview/image-to-image": "wan_v2_5"
                }
            },
            "max_reference_images": {
                "default": 2,
                "depends_on": "model_alibaba",
                "values": {
                    "fal-ai/qwen-image-2/edit": 2,
                    "fal-ai/qwen-image-2/pro/edit": 2,
                    "fal-ai/wan-25-preview/image-to-image": 1,
                    "wan/v2.6/image-to-image": 2,
                    "fal-ai/wan/v2.7/edit": 3,
                    "fal-ai/wan/v2.7/pro/edit": 3
                }
            },
            "supports_negative_prompt": true,
            "english_only": false,
            "mask_handling": {
                "supported": false,
                "required": false
            },
            "preprocessor": [
                {
                    "name": "image_optimizer_by_min_size",
                    "args": {
                        "min_size": 384,
                        "uscale_2_min": "{{allow_uscale_2_min}}",
                        "filter_by": "{{model_alibaba}}",
                        "filter_type": "contains",
                        "values": [
                            "wan/v2.6/",
                            "wan-25"
                        ]
                    }
                },
                {
                    "name": "image_optimizer_by_min_size",
                    "args": {
                        "min_size": 272,
                        "min_area": 589824,
                        "uscale_2_min": "{{allow_uscale_2_min}}",
                        "filter_by": "{{model_alibaba}}",
                        "filter_type": "contains",
                        "values": "wan/v2.7/"
                    }
                },
                // {
                //     "name": "image_get_size",
                //     "args": {
                //         "max_size": 2048, //qwen
                //         "min_size": 512,
                //         "auto_resize_2_max": "{{auto_resize_2_max}}",
                //         "filter_by": "{{model_alibaba}}",
                //         "filter_type": "contains",
                //         "values": "qwen-image-2"
                //     }
                // },
                {
                    "name": "image_get_size_mp",
                    "args": {
                        "output_resolution_mp": 4, //qwen
                        "min_size": 512,
                        "auto_resize_2_max": "{{auto_resize_2_max}}",
                        "filter_by": "{{model_alibaba}}",
                        "filter_type": "contains",
                        "values": "qwen-image-2"
                    }
                },
                {
                    "name": "image_get_size",
                    "args": {
                        "max_size": 1280, //wan 2.6-2.7
                        "min_size": 768,
                        "auto_resize_2_max": "{{auto_resize_2_max}}",
                        "filter_by": "{{model_alibaba}}",
                        "filter_type": "contains",
                        "values": "wan/"
                    }
                },
                {
                    "name": "image_get_size",
                    "args": {
                        "max_size": 1440, //wan 2.5
                        "min_size": 384,
                        "filter_by": "{{model_alibaba}}",
                        "auto_resize_2_max": "{{auto_resize_2_max}}",
                        "filter_type": "contains",
                        "values": "wan-25-preview"
                    }
                }
            ],
            "request_config": {
                // Each route is an ordinary conditional template key. Explicit
                // model checks reject unknown dropdown values before any FAL call.
                "{{?!source_image && model_alibaba == 'fal-ai/qwen-image-2/edit'}}endpoint_url": "https://queue.fal.run/fal-ai/qwen-image-2/text-to-image",
                "{{?source_image && model_alibaba == 'fal-ai/qwen-image-2/edit'}}endpoint_url": "https://queue.fal.run/fal-ai/qwen-image-2/edit",
                "{{?!source_image && model_alibaba == 'fal-ai/qwen-image-2/pro/edit'}}endpoint_url": "https://queue.fal.run/fal-ai/qwen-image-2/pro/text-to-image",
                "{{?source_image && model_alibaba == 'fal-ai/qwen-image-2/pro/edit'}}endpoint_url": "https://queue.fal.run/fal-ai/qwen-image-2/pro/edit",
                "{{?!source_image && model_alibaba == 'wan/v2.6/image-to-image'}}endpoint_url": "https://queue.fal.run/wan/v2.6/text-to-image",
                "{{?source_image && model_alibaba == 'wan/v2.6/image-to-image'}}endpoint_url": "https://queue.fal.run/wan/v2.6/image-to-image",
                "{{?!source_image && model_alibaba == 'fal-ai/wan/v2.7/edit'}}endpoint_url": "https://queue.fal.run/fal-ai/wan/v2.7/text-to-image",
                "{{?source_image && model_alibaba == 'fal-ai/wan/v2.7/edit'}}endpoint_url": "https://queue.fal.run/fal-ai/wan/v2.7/edit",
                "{{?!source_image && model_alibaba == 'fal-ai/wan/v2.7/pro/edit'}}endpoint_url": "https://queue.fal.run/fal-ai/wan/v2.7/pro/text-to-image",
                "{{?source_image && model_alibaba == 'fal-ai/wan/v2.7/pro/edit'}}endpoint_url": "https://queue.fal.run/fal-ai/wan/v2.7/pro/edit",
                "{{?!source_image && model_alibaba == 'fal-ai/wan-25-preview/image-to-image'}}endpoint_url": "https://queue.fal.run/fal-ai/wan-25-preview/text-to-image",
                "{{?source_image && model_alibaba == 'fal-ai/wan-25-preview/image-to-image'}}endpoint_url": "https://queue.fal.run/fal-ai/wan-25-preview/image-to-image",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "Authorization": "Key {{env:FAL_API_KEY}}",
                    "X-Fal-Store-IO": "0"
                },
                "body_template": {
                    "prompt": "{{prompt}}",
                    "{{?negative_prompt}}negative_prompt": "{{negative_prompt}}",
                    "enable_safety_checker": false,
                    "enable_prompt_expansion": false,
                    "image_size": "{{calculated_output_size}}",
                    "num_images": "{{num_images}}",
                    "output_format": "png",
                    "{{?source_image}}image_urls": [
                        "{{source_image}}",
                        "{{resolved_image_array}}"
                    ]
                }
            },
            "response_config": {
                "$ref": "fal",
                "params": {
                    "model_path": "{{model_alibaba}}"
                }
            },
            "parameters": [
                {
                    "name": "prompt",
                    "type": "string",
                    "alias": "prompt",
                    "label": "Text Prompt",
                    "default": ""
                },
                {
                    "name": "negative_prompt",
                    "type": "string",
                    "alias": "negative_prompt",
                    "label": "Negative Prompt",
                    "default": "censored, nsfw censored"
                },
                {
                    "name": "model_alibaba",
                    "type": "dropdown",
                    "label": "Model",
                    "options": [
                        {
                            "value": "fal-ai/wan/v2.7/edit",
                            "label": "Wan 2.7 (0.03 per image) - 1280 px"
                        },
                        {
                            "value": "fal-ai/wan/v2.7/pro/edit",
                            "label": "Wan 2.7 Pro (0.075 per image) - 1280 px"
                        },
                        {
                            "value": "fal-ai/qwen-image-2/edit",
                            "label": "Qwen 2 (0.035 per image) - 2048 px"
                        },
                        {
                            "value": "fal-ai/qwen-image-2/pro/edit",
                            "label": "Qwen 2 Pro (0.075 per image) - 2048 px"
                        },
                        {
                            "value": "wan/v2.6/image-to-image",
                            "label": "Wan 2.6 (0.03 per image) - 1280 px"
                        },
                        {
                            "value": "fal-ai/wan-25-preview/image-to-image",
                            "label": "Wan 2.5 (0.05 per image) - 1440 px"
                        }
                    ],
                    "default": "fal-ai/qwen-image-2/edit"
                },
                {
                    "name": "auto_resize_2_max",
                    "type": "boolean",
                    "label": "Auto resize to max size — the model will resize the output image to its maximum size",
                    "default": true
                },
                {
                    "name": "allow_uscale_2_min",
                    "alias": "allow_uscale_2_min",
                    "type": "boolean",
                    "label": "Allow upscale to minimum size - only for Wan models",
                    "default": false
                }
            ]
        }
```

### 13.6 FLUX Kontext (BFL, English-Only, Simple)

A straightforward BFL provider with a dynamic endpoint URL and the `english_only` flag.

```jsonc
{
            "id": "bfl_kontext",
            "name": "FLUX Kontext via BFL API Key ($0.04/$0.08 (FLUX Kontext Max) per image)",
            "nice_name": {
                "default": "FLUX Kontext (BFL Key)",
                "depends_on": "model_flux_kontext",
                "values": {
                    "pro": "FLUX Kontext Pro (BFL Key)",
                    "max": "FLUX Kontext Max (BFL Key)"
                }
            },
            "filename_suffix": "flux_kontext_{{model_flux_kontext}}",
            "image_format": "base64_raw",
            "max_reference_images": 3,
            "supports_negative_prompt": false,
            "english_only": true,
            "mask_handling": {
                "supported": false,
                "required": false
            },
            "request_config": {
                "single_image_per_request": true,
                "endpoint_url": "https://api.bfl.ai/v1/flux-kontext-{{model_flux_kontext}}",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "x-key": "{{env:BFL_API_KEY}}"
                },
                "body_template": {
                    "prompt": "{{prompt}}",
                    "{{?aspect_ratio}}aspect_ratio": "{{aspect_ratio}}",
                    "{{?source_image}}input_image": "{{source_image}}",
                    "{{?reference_1}}input_image_2": "{{reference_1}}",
                    "{{?reference_2}}input_image_3": "{{reference_2}}",
                    "{{?reference_3}}input_image_4": "{{reference_3}}",
                    "output_format": "png",
                    "safety_tolerance": 6
                }
            },
            "response_config": {
                "$ref": "bfl"
            },
            "parameters": [
                {
                    "name": "prompt",
                    "type": "string",
                    "alias": "prompt",
                    "label": "Text Prompt",
                    "default": ""
                },
                {
                    "name": "model_flux_kontext",
                    "type": "dropdown",
                    "label": "Model Variant",
                    "options": [
                        {
                            "value": "pro"
                        },
                        {
                            "value": "max"
                        }
                    ],
                    "default": "pro"
                }
            ]
        }
```

### 13.7 GPT-Image-2 (OpenAI, Megapixel Preprocessors, Mask Alpha Conversion)

Demonstrates several unique patterns:
- **Megapixel Preprocessors** — `image_optimizer_mp` and `image_get_size_mp` chain for complex price optimization
- **Mask alpha conversion** — `convert_mask_to_alpha` preprocessor to convert white/black masks to alpha transparency
- **Optional mask** — `separate_field` mask with conditional `{{?mask_image}}` inclusion
- **Hardcoded values** — `moderation` and `output_format` baked into `body_template` (not exposed as UI parameters)
- **Sync response** — with `b64_json`/`url` extraction fallback

```jsonc
{
            "id": "gpt_image_2_openai",
            "name": "GPT-Image-2 via OpenAI API Key (from ~$0.01)",
            "nice_name": "GPT-Image-2 (OpenAI Key)",
            "filename_suffix": "gpt_image_2",
            "image_format": "data_uri",
            "max_reference_images": 15,
            "supports_negative_prompt": false,
            "english_only": false,
            "remarks": "<b>Empirical price guide (Medium quality):</b><br><table style='width:100%; font-size:0.8em; border-top:1px solid #555; margin-top:4px; border-collapse:collapse;'><tr><td><b>Resolution</b></td><td><b>Square</b></td><td><b>Landscape / Portrait (2:3)</b></td></tr><tr><td>0.63 MP</td><td>$0.052 (816×816)</td><td>$0.035 (656×1008)</td></tr><tr><td>1.0 MP</td><td>$0.061 (1024×1024)</td><td>$0.043 (832×1248)</td></tr><tr><td>1.5 MP</td><td>$0.071 (1248×1248)</td><td>$0.051 (1024×1536)</td></tr><tr><td>2.0 MP</td><td>$0.080 (1440×1440)</td><td>$0.056 (1168×1760)</td></tr><tr><td>3.0 MP</td><td>$0.098 (1760×1760)</td><td>$0.068 (1440×2160)</td></tr><tr><td>3.5 MP</td><td>$0.107 (1904×1904)</td><td>$0.074 (1552×2336)</td></tr></table><br><i>Note: Table prices are approximate empirical estimates for Medium quality. Low quality is ~3–5× cheaper, while High quality is ~4× more expensive.</i><br><br>Billed by tokens ($30 / 1M output + $8 / 1M image input).<br><b>Quality</b> is the main cost driver. Input images also cost money.<br><b>Tip:</b> Use Low/Medium + Input Optimization to save money.",
            "mask_handling": {
                "supported": true,
                "required": false,
                "type": "separate_field",
                "field_name": "mask"
            },
            "preprocessor": [
                {
                    "name": "image_optimizer_mp",
                    "args": {
                        "optimization_mode": "{{input_optimization}}",
                        "output_resolution_mp": "{{output_resolution_mp}}",
                        "min_size": 64,
                        "step": 16
                    }
                },
                {
                    "name": "image_get_size_mp",
                    "args": {
                        "output_resolution_mp": "{{output_resolution_mp}}",
                        "min_area": 655360,
                        "min_size": 64,
                        "step": 16,
                        "always_output": true
                    }
                },
                {
                    "name": "convert_mask_to_alpha",
                    "args": {
                        "mode": "white_to_transparent",
                        "threshold": 128,
                        "filter_by": "{{mask_image}}",
                        "filter_type": "not_empty"
                    }
                }
            ],
            "request_config": {
                "{{?!source_image}}endpoint_url": "https://api.openai.com/v1/images/generations",
                "{{?source_image}}endpoint_url": "https://api.openai.com/v1/images/edits",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer {{env:OPENAI_API_KEY}}"
                },
                "reference_item_template": {
                    "image_url": "{{item}}"
                },
                "body_template": {
                    "model": "gpt-image-2",
                    "prompt": "{{prompt}}",
                    "{{?source_image}}images": [
                        {
                            "image_url": "{{source_image}}"
                        },
                        "{{resolved_references}}"
                    ],
                    "{{?mask_image}}mask": {
                        "image_url": "{{mask_image}}"
                    },
                    "n": "{{num_images}}",
                    "quality": "{{quality}}",
                    "moderation": "low",
                    "output_format": "png",
                    //"size": "auto"
                    "{{?!calculated_output_size}}size": "auto",
                    "{{?calculated_output_size}}size": "{{calculated_output_size_width}}x{{calculated_output_size_height}}"
                }
            },
            "response_config": {
                "$ref": "sync",
                "params": {
                    "extract": [
                        {
                            "path": "data",
                            "mode": "array",
                            "item_path": "b64_json"
                        },
                        {
                            "path": "data",
                            "mode": "array",
                            "item_path": "url"
                        }
                    ]
                }
            },
            "parameters": [
                {
                    "name": "prompt",
                    "type": "string",
                    "alias": "prompt",
                    "label": "Text Prompt",
                    "default": ""
                },
                {
                    "name": "quality",
                    "type": "dropdown",
                    "label": "Quality",
                    "options": [
                        {
                            "value": "auto",
                            "label": "Auto"
                        },
                        {
                            "value": "low",
                            "label": "Low"
                        },
                        {
                            "value": "medium",
                            "label": "Medium"
                        },
                        {
                            "value": "high",
                            "label": "High"
                        }
                    ],
                    "default": "medium"
                },
                {
                    "name": "output_resolution_mp",
                    "type": "dropdown",
                    "alias": "output_resolution_mp",
                    "label": "Output Resolution (MP)",
                    "options": [
                        {
                            "value": "0.63",
                            "label": "0.63mp - minimum for this model"
                        },
                        {
                            "value": "1-",
                            "label": "up to 1mp [~ 1K]"
                        },
                        {
                            "value": "1",
                            "label": "1mp [~ 1K]"
                        },
                        {
                            "value": "1.5",
                            "label": "1.5mp - OpenAI default (Auto)"
                        },
                        {
                            "value": "2-",
                            "label": "up to 2mp [~ 1.5K]"
                        },
                        {
                            "value": "2",
                            "label": "2mp [~ 1.5K]"
                        },
                        {
                            "value": "3-",
                            "label": "up to 3mp [~ 1.7K]"
                        },
                        {
                            "value": "3",
                            "label": "3mp [~ 1.7K]"
                        },
                        {
                            "value": "3.5-",
                            "label": "up to 3.5mp [~ 1.85K]"
                        },
                        {
                            "value": "3.5",
                            "label": "3.5mp [~ 1.85K]"
                        }
                    ],
                    "default": "2-"
                },
                {
                    "name": "input_optimization",
                    "type": "dropdown",
                    "label": "Input images optimization (экономия на входных токенах)",
                    "options": [
                        {
                            "value": "auto",
                            "label": "Auto - all images will be downscaled to chosen Output Resolution"
                        },
                        {
                            "value": "auto_plus",
                            "label": "Auto - main image will be downscaled to chosen Output Resolution, reference images will be downscaled to 1MP each"
                        },
                        {
                            "value": "refs_2_1mp",
                            "label": "Only reference images up to 1MP each"
                        },
                        {
                            "value": "all_1mp",
                            "label": "All images up to 1MP each"
                        }
                    ],
                    "default": "auto_plus"
                }
            ]
        }
```
