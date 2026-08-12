# Local Generation API

Photoshop Helper can act as a small localhost image-generation service for another
local application. The API uses the same reusable-task workflow as WebHelper:

1. Create a task once with a source image and optional mask.
2. Start any number of independent generations on that task.
3. Poll each generation until it returns absolute output file paths.

This lets a caller reuse the same source and mask with different providers, prompts,
parameters, reference images, and `use_mask` values without copying the input files or
creating duplicate tasks.

The service listens on `http://127.0.0.1:18345`. It is bound to the loopback interface
and is not designed for public deployment.

## Core behavior

- Requests and responses contain file paths, not image bytes or Base64 data.
- The source and mask paths belong to the reusable task.
- Provider settings and reference paths belong to each individual generation.
- Input images may live anywhere on the local filesystem that Photoshop Helper can read.
- All input paths must be absolute paths to existing regular files.
- Task creation does not copy the source or mask into the WebHelper temp directory.
- Generated files use the existing `%TEMP%\ps_webhelper_tasks` output directory.
- Generation creation is asynchronous and returns HTTP `202` immediately.
- Tasks and generation state are in memory and are not restored after an app restart.

## Provider configuration

The local API does not accept a `providers.json` path and does not receive provider
request templates from the client. Photoshop Helper owns that configuration and uses the
same active `providers.json` as the browser WebHelper.

At generation time, Photoshop Helper loads the current configuration, finds the entry
whose `id` equals the request's `providerId`, then applies that provider's
`request_config`, `response_config`, preprocessors, and environment-backed API keys.

| Runtime mode | Active provider configuration |
|---|---|
| Development (`npm start`) | `PhotoshopHelper/providers.json` |
| Packaged application | `providers.json` in Photoshop Helper's user-data directory |

The external client sends only a provider ID and parameters, for example:

```json
{
  "providerId": "bfl_flux2_i2i",
  "params": {
    "prompt": "Create a variation",
    "model_flux2": "klein-4b"
  }
}
```

### Discovering available providers

Before submitting a generation, an external client can use the existing WebHelper
discovery endpoint:

```http
GET http://127.0.0.1:18345/api/webhelper/providers
```

It returns provider IDs and client-safe metadata such as parameters, model options,
mask capabilities, and supported reference-image settings. Provider request templates
and API keys are not returned. Providers that require an environment key missing from
the running Helper are omitted from this list.

Use a returned provider's `id` as `providerId` in
`POST /api/local/v1/tasks/:taskId/generations`. For the full meaning of provider fields
and parameters, see `Providers_Configuration_Guide.md`.

## Optional authentication

Authentication is disabled by default. To enable a minimal shared-token check, set
`LOCAL_GENERATION_API_TOKEN` in the Photoshop Helper `.env` file and restart the app.

Clients can use either header:

```http
Authorization: Bearer your-token
```

or:

```http
X-API-Key: your-token
```

When configured, the token is required by all endpoints under `/api/local/v1`.

## 1. Create a reusable task

```http
POST /api/local/v1/tasks
Content-Type: application/json
```

### Request body

| Field | Type | Required | Description |
|---|---:|:---:|---|
| `sourceImagePath` | string | yes | Absolute path to the main/source image. |
| `maskImagePath` | string | no | Absolute path to the reusable mask image. |

```json
{
  "sourceImagePath": "C:\\Projects\\MyApp\\inputs\\source.png",
  "maskImagePath": "C:\\Projects\\MyApp\\inputs\\mask.png"
}
```

### Response

```http
HTTP/1.1 201 Created
Location: /api/local/v1/tasks/local_task_...
```

```json
{
  "taskId": "local_task_1786540000000_00000000-0000-0000-0000-000000000000",
  "status": "ready",
  "taskUrl": "/api/local/v1/tasks/local_task_1786540000000_00000000-0000-0000-0000-000000000000"
}
```

Relative paths, missing files, directories, and unreadable files return HTTP `400`.

## 2. Start a generation on the task

```http
POST /api/local/v1/tasks/:taskId/generations
Content-Type: application/json
```

### Where `taskId` is passed

`taskId` is **not** repeated in the JSON body. It is the path segment in the request
URL. Save either `taskId` or, preferably, the returned `taskUrl` from task creation.

For example, task creation may return:

```json
{
  "taskId": "local_task_123",
  "status": "ready",
  "taskUrl": "/api/local/v1/tasks/local_task_123"
}
```

The first generation is then created with this exact URL:

```http
POST http://127.0.0.1:18345/api/local/v1/tasks/local_task_123/generations
```

The second, third, and all later generations for the same source and mask use **the
same URL**. Only their JSON bodies differ. Do not create another task unless the source
or reusable mask needs to change.

### Request body

| Field | Type | Required | Description |
|---|---:|:---:|---|
| `providerId` | string | yes | Provider `id` from the active `providers.json`. |
| `params` | object | no | Provider parameters, including `prompt` when required. Defaults to `{}`. |
| `num_images` | integer | no | Requested image count from 1 to 100. Defaults to `1`. |
| `aspect_ratio` | string | no | Provider-compatible aspect ratio such as `"1:1"`. |
| `referenceImagePaths` | string[] | no | Absolute paths to references for this generation. Defaults to `[]`. |
| `use_mask` | boolean | no | Use the task mask for this generation. Defaults to `true` when the task has a mask. |
| `force_separate_requests` | boolean | no | Force one provider request per output image. Defaults to `false`. |

The caller is expected to know the active provider definition and send parameters
valid for that provider. Provider-specific request construction remains controlled by
`providers.json`.

### Generation using the task mask

```json
{
  "providerId": "gpt_image_2_i2i_openai",
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

### Another generation on the same task without the mask

```json
{
  "providerId": "seedream_v5_0_lite_i2i_fal",
  "use_mask": false,
  "num_images": 1,
  "aspect_ratio": "1:1",
  "params": {
    "prompt": "Create a bright editorial variation",
    "image_size": "2K",
    "max_images": 0
  }
}
```

The two requests above are sent separately to the same task URL:

```text
POST /api/local/v1/tasks/local_task_123/generations  <- first generation, use_mask: true
POST /api/local/v1/tasks/local_task_123/generations  <- second generation, use_mask: false
```

### Accepted response

```http
HTTP/1.1 202 Accepted
Location: /api/local/v1/tasks/local_task_.../generations/generation_...
```

```json
{
  "taskId": "local_task_1786540000000_00000000-0000-0000-0000-000000000000",
  "generationId": "generation_1786540001000_00000000-0000-0000-0000-000000000000",
  "status": "queued",
  "statusUrl": "/api/local/v1/tasks/local_task_1786540000000_00000000-0000-0000-0000-000000000000/generations/generation_1786540001000_00000000-0000-0000-0000-000000000000"
}
```

A provider error does not change the accepted response because generation runs in the
background. The error appears on that generation resource, while the parent task stays
ready for other provider calls.

## 3. Read one generation

```http
GET /api/local/v1/tasks/:taskId/generations/:generationId
```

### Running response

```json
{
  "generationId": "generation_1786540001000_00000000-0000-0000-0000-000000000000",
  "taskId": "local_task_1786540000000_00000000-0000-0000-0000-000000000000",
  "status": "running",
  "providerId": "gpt_image_2_i2i_openai",
  "createdAt": "2026-08-12T10:00:00.000Z",
  "startedAt": "2026-08-12T10:00:00.010Z",
  "completedAt": null,
  "outputPaths": [],
  "error": null,
  "statusUrl": "/api/local/v1/tasks/local_task_.../generations/generation_..."
}
```

### Completed response

```json
{
  "generationId": "generation_1786540001000_00000000-0000-0000-0000-000000000000",
  "taskId": "local_task_1786540000000_00000000-0000-0000-0000-000000000000",
  "status": "completed",
  "providerId": "gpt_image_2_i2i_openai",
  "createdAt": "2026-08-12T10:00:00.000Z",
  "startedAt": "2026-08-12T10:00:00.010Z",
  "completedAt": "2026-08-12T10:00:31.250Z",
  "outputPaths": [
    "C:\\Users\\user\\AppData\\Local\\Temp\\ps_webhelper_tasks\\generated_image_2026-08-12_1.wh.gpt_image_2_i2i.png"
  ],
  "error": null,
  "statusUrl": "/api/local/v1/tasks/local_task_.../generations/generation_..."
}
```

Generation states are `queued`, `running`, `completed`, and `failed`. Poll until the
state is `completed` or `failed`.

## 4. Read the reusable task

```http
GET /api/local/v1/tasks/:taskId
```

The task remains `ready` before, during, and after its child generations. Its response
contains the retained source/mask paths and a summary of every generation:

```json
{
  "taskId": "local_task_1786540000000_00000000-0000-0000-0000-000000000000",
  "status": "ready",
  "sourceImagePath": "C:\\Projects\\MyApp\\inputs\\source.png",
  "maskImagePath": "C:\\Projects\\MyApp\\inputs\\mask.png",
  "createdAt": "2026-08-12T10:00:00.000Z",
  "updatedAt": "2026-08-12T10:00:31.250Z",
  "generationCount": 2,
  "generations": [
    {
      "generationId": "generation_...",
      "taskId": "local_task_...",
      "status": "completed",
      "providerId": "gpt_image_2_i2i_openai",
      "createdAt": "2026-08-12T10:00:00.100Z",
      "startedAt": "2026-08-12T10:00:00.110Z",
      "completedAt": "2026-08-12T10:00:31.250Z",
      "outputPaths": [
        "C:\\Users\\user\\AppData\\Local\\Temp\\ps_webhelper_tasks\\generated_image.png"
      ],
      "error": null,
      "statusUrl": "/api/local/v1/tasks/local_task_.../generations/generation_..."
    }
  ]
}
```

## Complete PowerShell example: two generations on one task

```powershell
$taskRequest = @{
    sourceImagePath = 'C:\Projects\MyApp\inputs\source.png'
    maskImagePath = 'C:\Projects\MyApp\inputs\mask.png'
} | ConvertTo-Json

$task = Invoke-RestMethod `
    -Method Post `
    -Uri 'http://127.0.0.1:18345/api/local/v1/tasks' `
    -ContentType 'application/json' `
    -Body $taskRequest

# $task.taskUrl is the persisted task identifier in URL form, for example:
# /api/local/v1/tasks/local_task_1786540000000_...
# Keep it and reuse it for every future generation of this source/mask pair.
$generationUrl = "http://127.0.0.1:18345" + $task.taskUrl + '/generations'

$firstGenerationRequest = @{
    providerId = 'gpt_image_2_i2i_openai'
    use_mask = $true
    num_images = 1
    params = @{
        prompt = 'Turn this into a pencil illustration'
        quality = 'medium'
        output_resolution_mp = '2-'
        input_optimization = 'auto_plus'
    }
} | ConvertTo-Json -Depth 10

$firstGeneration = Invoke-RestMethod `
    -Method Post `
    -Uri $generationUrl `
    -ContentType 'application/json' `
    -Body $firstGenerationRequest

do {
    Start-Sleep -Milliseconds 500
    $firstResult = Invoke-RestMethod -Uri ("http://127.0.0.1:18345" + $firstGeneration.statusUrl)
} while ($firstResult.status -in @('queued', 'running'))

if ($firstResult.status -eq 'failed') {
    throw $firstResult.error
}

$firstResult.outputPaths
```

To create a second variation on the same task, do not call `POST /tasks` again. Reuse
the saved `$generationUrl`:

```powershell
$secondGenerationRequest = @{
    providerId = 'bfl_flux2_i2i'
    use_mask = $false
    num_images = 1
    params = @{
        prompt = 'Create a bright editorial variation'
        model_flux2 = 'klein-4b'
        output_resolution_mp = '1-'
        input_optimization = 'all_1mp'
        transparent_bg = $false
    }
} | ConvertTo-Json -Depth 10

$secondGeneration = Invoke-RestMethod `
    -Method Post `
    -Uri $generationUrl `
    -ContentType 'application/json' `
    -Body $secondGenerationRequest

# $secondGeneration has another generationId/statusUrl, but the same taskId.
do {
    Start-Sleep -Milliseconds 500
    $secondResult = Invoke-RestMethod -Uri ("http://127.0.0.1:18345" + $secondGeneration.statusUrl)
} while ($secondResult.status -in @('queued', 'running'))

if ($secondResult.status -eq 'failed') {
    throw $secondResult.error
}

$secondResult.outputPaths
```

When authentication is enabled, add
`-Headers @{ Authorization = 'Bearer your-token' }` to every request.
