# Local Generation API

Photoshop Helper exposes a small asynchronous image-generation API for other local
applications. A request supplies all inputs in one operation; there is no preliminary
task resource and no upload step.

The service listens on:

```text
http://127.0.0.1:18345
```

It is bound to the loopback interface and is not designed for public deployment.

## API overview

The complete API consists of two endpoints:

```http
POST /api/local/v1/generations
GET  /api/local/v1/generations/:generationId
```

`POST` validates local input paths, creates an asynchronous generation, and immediately
returns HTTP `202`. The client then polls the returned `statusUrl` until the generation
is `completed` or `failed`.

## Core behavior

- Requests contain absolute local file paths, not image bytes or Base64 data.
- Input files are read directly and are not copied into an intermediate task directory.
- Every supplied path must identify an existing readable regular file.
- Source, mask, references, provider parameters, and output settings belong to one
  self-contained generation request.
- Generated files are written to the existing `%TEMP%\ps_webhelper_tasks` directory.
- Successful status responses contain absolute output paths.
- Generation state is held in memory and is not restored after Photoshop Helper restarts.
- Local API generations do not enter or modify the Photoshop/WebHelper task registry.

## Provider discovery and configuration

The Local API uses the same provider catalog as WebHelper. The client sends a
provider ID and public parameters; request templates, response handlers, preprocessors,
and API keys remain owned by Photoshop Helper.

The only supported way to list available providers and their client-safe metadata is
this HTTP endpoint:

```http
GET http://127.0.0.1:18345/api/webhelper/providers
```

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:18345/api/webhelper/providers'
```

Do not open `providers.json`, `providers.template.json`, or any other file on disk
to discover providers or parameter names. The on-disk file is server-owned
configuration: packaged builds keep it outside the project tree, it includes
request templates and key placeholders, and it lists providers whose API keys are
missing. Discovery omits those unavailable providers and strips `request_config`,
`response_config`, `preprocessor`, `image_format`, and `filename_suffix`.

The response body is `{ "providers": [ ... ] }`.

There are two ways to select a provider on `POST /api/local/v1/generations`:

- `providerId` — `GET` the discovery URL above, then use a returned `id` with the
  legend in this section. Do not load `Providers_Configuration_Guide.md` for this
  path; that guide describes how to author a provider configuration, not how to
  call an existing provider.
- `provider` — send a complete inline configuration. Skip the legend below and see
  **When using an inline `provider` object** under **1. Start a generation**.

### Choosing a provider by id

Use a returned provider's `id` as `providerId`. Each provider includes an explicit
`generation_modes` array. Derive the effective mode using the normalization rules
under **Source and reference normalization** and select only a provider that lists
it:

```json
{
  "id": "example_provider",
  "generation_modes": ["t2i", "i2i"]
}
```

Only `t2i` and `i2i` are implemented. Video, SVG, and other output modalities are
possible future directions, not accepted Local API modes; adding an arbitrary mode name
to provider configuration does not enable it.

### How to turn a discovered provider into a request

Discovery is the live catalog of parameters and capabilities. This subsection is the
grammar for reading the HTTP response. Parameter names and allowed values change
when Helper's provider configuration changes; always `GET` discovery again rather
than reusing a frozen parameter list from this document or from disk.

The Local API does not apply discovery `default` values. WebHelper always sends every
declared parameter; the generator copies `params` into the template context as given.
An omitted key leaves `{{that_name}}` unresolved, and the literal placeholder text can
be forwarded to the paid provider. A `providerId` request must therefore include every
`parameters[].name`.

#### Fields to read

| Discovery field | How to use it |
|---|---|
| `id` | `providerId`. |
| `name` | Human-readable label for choosing a provider. Not a request field. |
| `generation_modes` | Must include the effective `t2i` or `i2i` mode. |
| `parameters` | Source of `params` keys and allowed values. |
| `mask_handling.supported` / `required` | Whether a mask may or must be supplied. |
| `max_reference_images` | Cap on remaining references after normalization. Number or `depends_on` object. |
| `allowed_aspect_ratios` | Constraint on root `aspect_ratio`. Absent, array, `[]`, or `depends_on` object. |
| `supports_negative_prompt` | If true, send the negative-prompt parameter (empty string is allowed). |
| `english_only` | Informational: `false` (multilingual), `true` (English only), or `"recommended"` (English recommended). |
| `single_image_per_request` | If true, the server already issues one provider call per output image; `force_separate_requests` is unnecessary. |
| `remarks` | Optional HTML for humans (pricing, warnings). Do not parse it into `params`. |
| `tags` | Optional grouping metadata (`provider` host slug, `family` model-line slug). Not a request field. |

#### Fields to ignore when building the POST body

- `alias` on a parameter or dropdown option — WebHelper UI persistence only.
- `hidden` on a dropdown option — alias bridge for the UI.
- `label` — display text, including prices. Never send it as a value.
- `nice_name` — result-tab title.
- `tags` — UI grouping labels. Do not send them in the generation request.
- `mask_handling.type` and `mask_handling.field_name` — how the server places the
  mask in the outbound provider request. The one exception is the reference-slot
  rule under **References**.

#### Building `params`

For each entry in `parameters`:

1. The POST key is `name`, never `alias`.
2. Always set the key. If you are not overriding it, copy `default`.
3. JSON types follow `type`:
   - `string` — JSON string. A parameter with `alias` `"prompt"` must be a non-empty
     prompt; `default: ""` is an empty UI field, not “optional”.
   - `boolean` — JSON `true` or `false`.
   - `integer`, `number`, `slider` — JSON number.
   - `dropdown` — one `options[].value`. If an option is a bare string, that string
     is the value. Do not send `label` or `alias`. Do not pick an option only because
     it is `hidden`.
4. If `supports_negative_prompt` is true, include the parameter whose `alias` is
   `"negative_prompt"` (key = that parameter's `name`). An empty string is allowed.
5. `num_images` and `aspect_ratio` are not provider parameters. Never put them in
   `params`.

#### Root `aspect_ratio`

Standard ratios, used when `allowed_aspect_ratios` is absent:

`21:9`, `2:1`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`, `1:2`, `9:21`

| `allowed_aspect_ratios` | Meaning |
|---|---|
| field absent | Any standard ratio. |
| non-empty array | Only those strings. |
| `[]` | The provider does not accept a ratio (match input). Omit `aspect_ratio`. |
| object with `depends_on` | Resolve as below, then apply the same array rules. |

Text-to-image still requires a non-empty root `aspect_ratio` before the generation
is accepted. A provider that declares `t2i` together with `allowed_aspect_ratios: []`
cannot satisfy that rule; do not pick it for text-to-image. Image-to-image may omit
`aspect_ratio` so preprocessing can match the source.

#### Masks

| `supported` | `required` | Client action |
|---|---|---|
| `false` | — | Do not send an active mask (`use_mask` must not be true). |
| `true` | `false` | Optional. Supply `maskImagePath` and `use_mask` as needed. |
| `true` | `true` | Supply `maskImagePath`; leave `use_mask` true (the default when a path is present). |

Unsupported or missing-mask failures are reported on the generation status resource
after HTTP `202`, not as a synchronous `400`.

#### References

After source/reference normalization, the number of remaining references must be at
most the resolved `max_reference_images`. `0` means no remaining references.

A single path in `referenceImagePaths` with no `sourceImagePath` becomes the source
and does not consume a reference slot.

If `max_reference_images` is an object, resolve `depends_on` first. If the mask is
active and `mask_handling.type` is `first_referential` or `last_referential`, subtract
one from the resolved limit.

#### Resolving `depends_on`

`max_reference_images` and `allowed_aspect_ratios` may use this object form:

```json
{
  "default": 7,
  "depends_on": "model_flux2",
  "values": {
    "klein-9b": 3,
    "klein-4b": 3
  }
}
```

1. Read the already-chosen `params` value whose key equals `depends_on` (a parameter
   `name`).
2. If that value is a key in `values`, use the mapped value.
3. Otherwise use `default`.

#### Example: `gpt_image_2_openai`

Condensed discovery (dropdown `options` truncated):

```json
{
  "id": "gpt_image_2_openai",
  "generation_modes": ["t2i", "i2i"],
  "max_reference_images": 15,
  "supports_negative_prompt": false,
  "mask_handling": { "supported": true, "required": false },
  "single_image_per_request": false,
  "parameters": [
    { "name": "prompt", "type": "string", "alias": "prompt", "default": "" },
    {
      "name": "quality",
      "type": "dropdown",
      "default": "medium",
      "options": [
        { "value": "auto" },
        { "value": "low" },
        { "value": "medium" },
        { "value": "high" }
      ]
    },
    { "name": "output_resolution_mp", "type": "dropdown", "default": "2-" },
    { "name": "input_optimization", "type": "dropdown", "default": "auto_plus" }
  ]
}
```

The **Image-to-image example** below is a complete `params` object for this provider:
every `name` is present, dropdowns use `value` strings such as `"2-"`, and
`aspect_ratio` / `num_images` stay at the root.

#### Example: `bfl_flux2` (`depends_on`)

`max_reference_images` depends on `model_flux2`. Choosing `"klein-4b"` resolves the
limit to `3`. `mask_handling.type` is `first_referential`, so an active mask leaves
two user reference slots. `params` must still include the other declared names
(`output_resolution_mp`, `input_optimization`, `transparent_bg`) even when only the
model is being overridden. See **First reference used as source**.

## Authentication

Both Local API endpoints always require a shared token — this API triggers paid provider
calls, so it is never reachable without one. A token is generated automatically on first
run and stored in the Helper's local settings.

You can manage this token from the system tray menu (**Access Tokens**):
- **Copy Local API Token**: Copies the current token to your clipboard.
- **Save Local API Token to User Environment...**: Exports `PHOTOSHOP_HELPER_LOCAL_API_TOKEN`
  into your Windows User Environment Variables on demand. This allows local scripts,
  CLI tools, and AI agents (such as MCP servers, Claude Code, or Antigravity) to
  authenticate automatically without prompting for credentials.
- **Copy Env Var Name (PHOTOSHOP_HELPER_LOCAL_API_TOKEN)**: Copies the environment
  variable name string to your clipboard for easy pasting into code or configurations.
- **Regenerate Local API Token...**: Generates a fresh token, immediately invalidating the
  old one.

### Environment variable override (optional)

To pin a fixed value instead — for example when a script's configuration should not
change across reinstalls — set `PHOTOSHOP_HELPER_LOCAL_API_TOKEN` in the Photoshop
Helper `.env` file and restart the app; it overrides the generated token.

### Recommended client token discovery pattern

For automated scripts, CLI tools, and AI coding agents, the recommended discovery
order is:

1. Check the `PHOTOSHOP_HELPER_LOCAL_API_TOKEN` environment variable.
2. Fall back to prompting the user or reading from user settings.

```python
# Python client discovery example:
import os

token = os.environ.get("PHOTOSHOP_HELPER_LOCAL_API_TOKEN")
if not token:
    token = input("Enter Photoshop Helper Local API token (or export via tray): ").strip()
```

This token is intentionally separate from the one paired into the Photoshop plugin (used
for clipboard, drag-and-drop, and file save): the plugin's token is delivered as a file in
its UXP data folder, so it must not by itself unlock anything that spends money.

Clients may use either header:

```http
Authorization: Bearer your-token
```

or:

```http
X-API-Key: your-token
```

A request with a missing or incorrect token receives HTTP `401`.


## 1. Start a generation

```http
POST /api/local/v1/generations
Content-Type: application/json
```

### Request fields

| Field | Type | Required | Description |
|---|---:|:---:|---|
| `providerId` | string | conditional | Provider `id` from the active configuration. Mutually exclusive with `provider`. |
| `provider` | object | conditional | Complete inline provider configuration JSON object. Mutually exclusive with `providerId`. |
| `sourceImagePath` | string | no | Absolute path to the source image. |
| `maskImagePath` | string | no | Absolute path to the mask image. |
| `referenceImagePaths` | string[] | no | Ordered absolute reference paths. Defaults to `[]`. |
| `params` | object | no | Provider parameter values. For `providerId`, key by `parameters[].name` and include every declared parameter (the server does not apply discovery defaults). Defaults to `{}`. |
| `num_images` | integer | no | Requested output count from 1 to 100. Defaults to `1`. |
| `aspect_ratio` | string | conditional | Provider-compatible ratio such as `"1:1"`. Required for text-to-image; optional for image-to-image. |
| `use_mask` | boolean | no | Whether to use `maskImagePath`. Defaults to true when a mask path is supplied. |
| `force_separate_requests` | boolean | no | Force one provider request per output. Defaults to `false`. |

A request must specify **either** `providerId` **or** `provider`, but not both.

If `use_mask` is explicitly `true`, `maskImagePath` is required. Supplying a mask with
`use_mask: false` is allowed; that mask is ignored for this generation.

`aspect_ratio` must be a non-empty string for text-to-image. The API returns HTTP `400`
before creating a generation when an image-less request omits it. Image-to-image may
omit the field because provider preprocessing can derive dimensions from its source.

### When using an inline `provider` object

- `generation_modes`: Array containing `"t2i"` and/or `"i2i"`.
- `image_format`: Format string (e.g. `"url"`, `"data_uri"`, or `"base64_raw"`).
- `request_config`: Request template object including `endpoint_url`, `method`, `headers`, and `body_template`.
- `response_config`: Response handler configuration object. Its `$ref` field must match a handler name already defined in Helper's active provider configuration (e.g. `"replicate"`, `"fal"`, `"sync"`, `"bfl"`). If an unknown `$ref` is specified, the request is rejected with HTTP `400`.
- `id` (optional): Identifier used in status outputs and generated filenames. Defaults to `"inline"`.

An inline object is not looked up in discovery. `parameters` may be omitted; `params`
are copied into the template context under the keys you send. You cannot register a
new response handler: `$ref` must name one already known to Helper (see the examples
above). Do not open provider configuration files on disk to look this up.
UI-only fields (`parameters` aliases, `remarks`, `nice_name`) are unnecessary here.

For request templates, placeholders, and preprocessors, read only these sections of
`Providers_Configuration_Guide.md` — not the rest of that file:

- §3.2 Image Format
- §3.3 Mask Handling
- §3.4 Reference Images
- §3.10 Generation Modes
- §4 Request Configuration
- §5 Placeholder System
- §7 Response Configuration
- §8 Response Handlers (pick an existing `$ref`; do not author a new handler)
- §9 Preprocessors (only if the model needs size or mask conversion)

Skip §6 (UI parameters and alias persistence) and §13 unless you are copying a
`request_config` pattern from an annotated example.

### Source and reference normalization

Image roles are normalized before provider preprocessors run:

| Source | Active mask | References | Result |
|:---:|:---:|:---:|---|
| yes | either | any | The supplied source is used; all references remain references. |
| no | no | none | Text-to-image input; `aspect_ratio` is required. |
| no | no | one or more | First reference becomes source; remaining entries stay references. |
| no | yes | none | Generation fails because the mask has no source. |
| no | yes | one or more | First reference becomes source and must exactly match mask dimensions. |

The first reference is always the promotion candidate. The server does not search later
references for another image with matching dimensions.

This normalization is provider-independent. A particular provider may still reject a
text-to-image or image-to-image mode that its endpoint does not support.

### Image-to-image example

```json
{
  "providerId": "gpt_image_2_openai",
  "sourceImagePath": "C:\\Projects\\MyApp\\inputs\\source.png",
  "maskImagePath": "C:\\Projects\\MyApp\\inputs\\mask.png",
  "referenceImagePaths": [
    "C:\\Projects\\MyApp\\inputs\\style-reference.jpg"
  ],
  "use_mask": true,
  "num_images": 2,
  "aspect_ratio": "1:1",
  "params": {
    "prompt": "Replace the background with a quiet evening street",
    "quality": "medium",
    "output_resolution_mp": "2-",
    "input_optimization": "auto_plus"
  }
}
```

### First reference used as source

```json
{
  "providerId": "bfl_flux2",
  "referenceImagePaths": [
    "C:\\Projects\\MyApp\\inputs\\source.png",
    "C:\\Projects\\MyApp\\inputs\\style-reference.jpg"
  ],
  "params": {
    "prompt": "Create a bright editorial variation",
    "model_flux2": "klein-4b",
    "output_resolution_mp": "1-",
    "input_optimization": "auto_plus",
    "transparent_bg": false
  }
}
```

Here `source.png` becomes the source and only `style-reference.jpg` remains a reference.

### Text-to-image example

```json
{
  "providerId": "provider-supporting-text-to-image",
  "aspect_ratio": "1:1",
  "params": {
    "prompt": "A quiet observatory above a sea of clouds"
  }
}
```

This sketch shows only the transport shape. For a real provider, populate `params`
with every discovered `parameters[].name` as described in **How to turn a discovered
provider into a request**.

### Inline provider example (Replicate model test)

```json
{
  "provider": {
    "id": "my_replicate_test",
    "generation_modes": ["t2i"],
    "image_format": "url",
    "request_config": {
      "endpoint_url": "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
      "method": "POST",
      "headers": {
        "Authorization": "Bearer {{env:REPLICATE_API_TOKEN}}",
        "Content-Type": "application/json"
      },
      "body_template": {
        "input": {
          "prompt": "{{prompt}}",
          "aspect_ratio": "{{aspect_ratio}}"
        }
      }
    },
    "response_config": {
      "$ref": "replicate"
    }
  },
  "aspect_ratio": "1:1",
  "params": {
    "prompt": "A quiet observatory above a sea of clouds"
  }
}
```

### Accepted response

```http
HTTP/1.1 202 Accepted
Location: /api/local/v1/generations/generation_...
```

```json
{
  "generationId": "generation_1786540000000_00000000-0000-0000-0000-000000000000",
  "status": "queued",
  "statusUrl": "/api/local/v1/generations/generation_1786540000000_00000000-0000-0000-0000-000000000000"
}
```

Malformed JSON fields, text-to-image requests without `aspect_ratio`, relative paths,
missing files, directories, and unreadable files return HTTP `400` before a generation
is accepted.

Provider failures, unsupported provider/mode combinations, and semantic image failures
discovered by the generation core occur after acceptance. The core rejects an
unsupported mode before preprocessing or any external provider request, and the failure
is reported through the generation status resource.

## 2. Read generation status

```http
GET /api/local/v1/generations/:generationId
```

Generation states are:

- `queued`
- `running`
- `completed`
- `failed`

Poll until the state becomes `completed` or `failed`.

### Running response

```json
{
  "generationId": "generation_1786540000000_00000000-0000-0000-0000-000000000000",
  "status": "running",
  "providerId": "gpt_image_2_openai",
  "createdAt": "2026-08-13T10:00:00.000Z",
  "startedAt": "2026-08-13T10:00:00.010Z",
  "completedAt": null,
  "outputPaths": [],
  "error": null,
  "statusUrl": "/api/local/v1/generations/generation_1786540000000_00000000-0000-0000-0000-000000000000"
}
```

### Completed response

```json
{
  "generationId": "generation_1786540000000_00000000-0000-0000-0000-000000000000",
  "status": "completed",
  "providerId": "gpt_image_2_openai",
  "createdAt": "2026-08-13T10:00:00.000Z",
  "startedAt": "2026-08-13T10:00:00.010Z",
  "completedAt": "2026-08-13T10:00:31.250Z",
  "outputPaths": [
    "C:\\Users\\user\\AppData\\Local\\Temp\\ps_webhelper_tasks\\generated_image_2026-08-13_1.wh.gpt_image_2_i2i.png"
  ],
  "error": null,
  "statusUrl": "/api/local/v1/generations/generation_1786540000000_00000000-0000-0000-0000-000000000000"
}
```

When the generation was created using an inline `provider` object, the response also includes `providerSnapshot` echoing the configuration object used:

```json
{
  "generationId": "generation_1786540000000_00000000-0000-0000-0000-000000000000",
  "status": "completed",
  "providerId": "my_replicate_test",
  "providerSnapshot": {
    "id": "my_replicate_test",
    "generation_modes": ["t2i"],
    "image_format": "url",
    "request_config": { ... },
    "response_config": { "$ref": "replicate" }
  },
  "createdAt": "2026-08-13T10:00:00.000Z",
  "startedAt": "2026-08-13T10:00:00.010Z",
  "completedAt": "2026-08-13T10:00:31.250Z",
  "outputPaths": [
    "C:\\Users\\user\\AppData\\Local\\Temp\\ps_webhelper_tasks\\generated_image_2026-08-13_1.wh.my_replicate_test_t2i.png"
  ],
  "error": null,
  "statusUrl": "/api/local/v1/generations/generation_1786540000000_00000000-0000-0000-0000-000000000000"
}
```

### Failed response

```json
{
  "generationId": "generation_1786540000000_00000000-0000-0000-0000-000000000000",
  "status": "failed",
  "providerId": "gpt_image_2_openai",
  "createdAt": "2026-08-13T10:00:00.000Z",
  "startedAt": "2026-08-13T10:00:00.010Z",
  "completedAt": "2026-08-13T10:00:00.250Z",
  "outputPaths": [],
  "error": "Provider unavailable",
  "statusUrl": "/api/local/v1/generations/generation_1786540000000_00000000-0000-0000-0000-000000000000"
}
```

An unknown `generationId` returns HTTP `404`.

## Complete PowerShell example

```powershell
$generationRequest = @{
    providerId = 'gpt_image_2_openai'
    sourceImagePath = 'C:\Projects\MyApp\inputs\source.png'
    num_images = 1
    params = @{
        prompt = 'Turn this into a pencil illustration'
        quality = 'medium'
        output_resolution_mp = '2-'
        input_optimization = 'auto_plus'
    }
} | ConvertTo-Json -Depth 10

# Discover token from environment or use direct value
$token = $env:PHOTOSHOP_HELPER_LOCAL_API_TOKEN
if (-not $token) {
    $token = 'your-token' # Or copy from tray: Access Tokens -> Copy Local API Token
}

$authHeaders = @{ Authorization = "Bearer $token" }

$generation = Invoke-RestMethod `
    -Method Post `
    -Uri 'http://127.0.0.1:18345/api/local/v1/generations' `
    -ContentType 'application/json' `
    -Headers $authHeaders `
    -Body $generationRequest

do {
    Start-Sleep -Milliseconds 500
    $result = Invoke-RestMethod `
        -Uri ('http://127.0.0.1:18345' + $generation.statusUrl) `
        -Headers $authHeaders
} while ($result.status -in @('queued', 'running'))

if ($result.status -eq 'failed') {
    throw $result.error
}

$result.outputPaths
```

Replace `your-token` with the value copied from the tray menu (**Access Tokens → Copy
Local API Token**), exported to your environment (**Access Tokens → Save Local API Token to User Environment...**),
or with your pinned `PHOTOSHOP_HELPER_LOCAL_API_TOKEN` if configured in `.env`.


