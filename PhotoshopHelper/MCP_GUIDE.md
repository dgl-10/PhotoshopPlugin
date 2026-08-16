# Photoshop Helper MCP

Local image-generation tools. Helper must already be running. Endpoint:
`http://127.0.0.1:18345/mcp` — use `127.0.0.1`, not `localhost`.

Generated files go to the shared temp directory. They are not placed into
Photoshop. All image fields are absolute paths to existing files.

## 1. Lifecycle

1. `list_providers` — pick a provider by `id` and `generation_modes`.
2. `get_providers_details` — only for chosen ids, and only when parameter
   names, enums, or constraints are not already known. Never pass `"*"`.
3. `generate_image` — wait for the tool result. Do not poll.

`list_providers` is the first call. Do not call `get_providers_details` for
every provider on every turn.

Modes: `t2i` (text-to-image) and `i2i` (image-to-image). A provider that
lists only `i2i` cannot do text-to-image.

## 2. Parameters

`get_providers_details` returns compact `parameters`. Each entry has:

- `name` — key under `generate_image.params`
- `type` — `string`, `dropdown`, `slider`, `toggle`, `checkbox`, `number`, …
- `default` — when set
- `options` — dropdown values only (`generate()` uses these, not UI labels)
- `min` / `max` / `step` — sliders

Send `params[name] = value`. Example: dropdown `model_xai` with options
`["grok-imagine-image", "grok-imagine-image-quality"]` →
`params.model_xai = "grok-imagine-image"`.

`prompt` may be top-level; it overwrites `params.prompt`.
`aspect_ratio` and `num_images` are top-level, not provider params.
`timeout_seconds` is MCP-only (default 180, max 600).

`allowed_aspect_ratios` and `max_reference_images` may be a plain value or
`{ default, depends_on, values }`. `depends_on` is a `params` key (usually
a model dropdown). Do not flatten that object.

`mask_handling` is `{ supported, required }` only.

## 3. Modalities

| Case | How to call |
|---|---|
| Text-to-image | No `sourceImagePath`, no mask, no references. `aspect_ratio` required. Provider must list `t2i`. |
| Image-to-image | `sourceImagePath` and/or `referenceImagePaths`. `aspect_ratio` optional. Provider must list `i2i`. |
| Inpaint | `sourceImagePath` + `maskImagePath` + `use_mask: true` (default when a mask is supplied). `use_mask: false` ignores the mask. |

No source + references → first reference becomes the source.
No source + active mask + no references → fails.
`use_mask: true` without `maskImagePath` → tool error (no generation).

Malformed input (relative path, missing t2i `aspect_ratio`, `"*"` on details)
is a tool error. Provider/mode/mask failures inside the executor return
`status: "failed"` — do not retry the same call as if it were a protocol error.

On timeout the tool returns `status: "failed"` and names the timeout. The
executor may still write files later. There is no `get_generation` tool.

## 4. Examples

Text-to-image:

```json
{
  "providerId": "seedream_v4_5_fal",
  "aspect_ratio": "1:1",
  "prompt": "A quiet observatory above a sea of clouds",
  "params": { "resolution": "1k" }
}
```

Inpaint:

```json
{
  "providerId": "gpt_image_2_openai",
  "sourceImagePath": "C:\\Images\\source.png",
  "maskImagePath": "C:\\Images\\mask.png",
  "use_mask": true,
  "prompt": "Replace the background with a quiet evening street",
  "params": { "quality": "medium" }
}
```

Variation with references (first path is promoted to source):

```json
{
  "providerId": "bfl_flux2",
  "referenceImagePaths": [
    "C:\\Images\\source.png",
    "C:\\Images\\style-ref.jpg"
  ],
  "prompt": "Create a bright editorial variation",
  "params": { "model_flux2": "klein-4b" }
}
```
