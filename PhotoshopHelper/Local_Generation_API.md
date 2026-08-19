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

The Local API uses the same active `providers.json` as WebHelper. The client sends a
provider ID and public parameters; request templates, response handlers, preprocessors,
and API keys remain owned by Photoshop Helper.

| Runtime mode | Active provider configuration |
|---|---|
| Development (`npm start`) | `PhotoshopHelper/providers.json` |
| Packaged application | `providers.json` in Photoshop Helper's user-data directory |

Available providers and their client-safe metadata can be read from the existing
WebHelper discovery endpoint:

```http
GET http://127.0.0.1:18345/api/webhelper/providers
```

Providers whose required environment key is unavailable are omitted. Use a returned
provider's `id` as `providerId`. See `Providers_Configuration_Guide.md` for the meaning
of provider parameters and capabilities.

Each returned provider includes an explicit `generation_modes` array. Clients should
derive the effective mode using the normalization rules below and select only a provider
that lists it:

```json
{
  "id": "example_provider",
  "generation_modes": ["t2i", "i2i"]
}
```

Only `t2i` and `i2i` are implemented. Video, SVG, and other output modalities are
possible future directions, not accepted Local API modes; adding an arbitrary mode name
to provider configuration does not enable it.

## Authentication

Both Local API endpoints always require a shared token — this API triggers paid provider
calls, so it is never reachable without one. A token is generated automatically on first
run and stored in the Helper's local settings; copy it from the system tray menu
(**Access Tokens → Copy Local API Token**). To pin a fixed value instead — for example
when a script's configuration should not change across reinstalls — set
`LOCAL_GENERATION_API_TOKEN` in the Photoshop Helper `.env` file and restart the app; it
overrides the generated token.

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
| `params` | object | no | Provider parameters, including `prompt` when applicable. Defaults to `{}`. |
| `num_images` | integer | no | Requested output count from 1 to 100. Defaults to `1`. |
| `aspect_ratio` | string | conditional | Provider-compatible ratio such as `"1:1"`. Required for text-to-image; optional for image-to-image. |
| `use_mask` | boolean | no | Whether to use `maskImagePath`. Defaults to true when a mask path is supplied. |
| `force_separate_requests` | boolean | no | Force one provider request per output. Defaults to `false`. |

A request must specify **either** `providerId` **or** `provider`, but not both.

When using an inline `provider` object:
- `generation_modes`: Array containing `"t2i"` and/or `"i2i"`.
- `image_format`: Format string (e.g. `"url"`, `"data_uri"`, or `"base64_raw"`).
- `request_config`: Request template object including `endpoint_url`, `method`, `headers`, and `body_template`.
- `response_config`: Response handler configuration object. Its `$ref` field must match a handler name already defined in `providers.json` (e.g. `"replicate"`, `"fal"`, `"sync"`, `"bfl"`). If an unknown `$ref` is specified, the request is rejected with HTTP `400`.
- `id` (optional): Identifier used in status outputs and generated filenames. Defaults to `"inline"`.

If `use_mask` is explicitly `true`, `maskImagePath` is required. Supplying a mask with
`use_mask: false` is allowed; that mask is ignored for this generation.

`aspect_ratio` must be a non-empty string for text-to-image. The API returns HTTP `400`
before creating a generation when an image-less request omits it. Image-to-image may
omit the field because provider preprocessing can derive dimensions from its source.

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
    "model_flux2": "klein-4b"
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

$authHeaders = @{ Authorization = 'Bearer your-token' }

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
Local API Token**), or with your pinned `LOCAL_GENERATION_API_TOKEN` if you set one.
