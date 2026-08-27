# Provider Configuration Generation Prompt

## Task Parameters

```text
MODEL_ID = "[Insert the exact model ID here, or ask the user if not provided]"
PROVIDER_NAME = "[Insert the provider/API name here, or ask the user if not provided]"
API_KEY_ENV_VAR = "[Insert the API-key environment variable here, or ask the user if not provided]"
GENERATION_MODES = "[Optional: auto, t2i, i2i, or both; default: auto]"
```

Before starting, verify that the user clearly specified `MODEL_ID`, `PROVIDER_NAME`,
and `API_KEY_ENV_VAR`. If any required value is missing, stop and ask only for the
missing information. `GENERATION_MODES` is optional: when omitted or set to `auto`,
determine the supported modes from authoritative documentation.

## Objective and Source of Truth

Using the attached `Providers_Configuration_Guide.md`, create a ready-to-use JSON5
provider configuration for `MODEL_ID` through the specified provider's API.

Treat the guide as the authoritative contract for:

- provider fields and UI parameters;
- `tags` grouping metadata (`provider` API host and `family` model line);
- request templates and placeholders;
- conditional template expressions;
- template-facing image, mask, and reference values;
- preprocessors;
- response handlers;
- runtime limitations and supported transports.

Do not analyze or propose changes to the JavaScript implementation. Do not invent
configuration fields that are absent from the guide. If the provider requires a
transport or runtime capability that the guide does not support, report the
incompatibility instead of producing a configuration that only looks plausible.

## Documentation Research

Retrieve current model and provider API information through MCP Context7. When
Context7 is unavailable or does not contain the required details, use the provider's
official documentation. Do not infer one model's contract from a related model.

For every supported generation mode, independently verify:

- the exact endpoint and model identifier;
- the HTTP method, authorization scheme, and content type;
- the complete request body shape;
- mandatory, optional, and mutually exclusive fields;
- safety, moderation, NSFW filter, and safety tolerance/checker fields;
- the exact source-image, reference-image, and mask fields;
- accepted image encodings, limits, and ordering rules;
- output dimensions, aspect-ratio behavior, and resolution limits;
- the supported number of outputs per request;
- pricing, minimum billable sizes, and other cost boundaries;
- synchronous or asynchronous response behavior and the final image location;
- whether T2I and I2I responses are compatible with one shared response handler.

Provide direct links to the official pages used. Standard parameters (prompt, image
inputs, endpoints, authorization) must be configured directly without asking. If genuinely
ambiguous or non-standard parameters exist whose handling is uncertain, consolidate them
into a structured decision table rather than guessing.

## Generation-Mode Decision

First classify the official API support as `t2i`, `i2i`, or `both`.

- `GENERATION_MODES = auto`: include every mode that is clearly documented and can
  be represented correctly by the configuration system.
- `GENERATION_MODES = t2i` or `i2i`: configure only that mode after verifying it is
  supported.
- `GENERATION_MODES = both`: verify both modes independently. Never invent a missing
  endpoint or assume that two similarly named endpoints accept the same fields.
- If a requested mode is unsupported, say so explicitly and do not emit a fake branch.

Use one provider object for both modes only when their authorization, request
transport, and response processing are compatible with one provider definition. If
the response formats require incompatible handlers, explain why separate provider
objects or runtime support would be required.

The runtime decides the effective mode from normalized `source_image`:

- falsy `source_image` means T2I;
- truthy `source_image` means I2I;
- when the caller supplies references without a source, the first reference is
  promoted to `source_image` before request-template conditions are evaluated;
- the promoted image is removed from the remaining reference list. It is sent through
  the provider's source field, while `resolved_image_array`, `resolved_references`, and
  the numbered `reference_N` values contain only the remaining references (plus a
  referential mask when configured by the provider);
- a mask without an explicit source requires at least one reference. The promoted
  first reference must exactly match the mask dimensions; a mask by itself is rejected
  before any provider request is made.

Therefore, a reference-driven request must follow the I2I branch. Do not create a
separate configuration mode for this normalization behavior.

## Mode-Dependent Request Configuration

Follow the conditional-key system documented in the guide.

- Gate even a single-mode provider's endpoint: use a negative `source_image` condition
  for T2I-only and a positive `source_image` condition for I2I-only. A static endpoint
  would allow the unsupported mode to reach the provider accidentally.
- If T2I and I2I use the same endpoint and body schema, use one endpoint and include
  source, mask, and reference fields only when their normalized values are present.
- If the modes use different endpoints, select `endpoint_url` with mutually exclusive
  conditions based on `source_image`.
- If the modes require materially different request schemas, conditionally select the
  complete `body_template` and, when necessary, `method` or `headers` at the
  `request_config` level. Do not force incompatible schemas into one body merely to
  keep the configuration shorter.
- If endpoint selection also depends on a model dropdown, combine the mode condition
  with explicit comparisons against every allowed model value.
- After template resolution, every supported model/mode combination must produce
  exactly one non-empty `endpoint_url`; every unsupported combination and unknown
  model value must produce none.
- Never construct an outbound URL from an unvalidated model value.
- Do not propose provider-specific routing code or undocumented routing fields. The
  provider object must express routing through the generic template system.
- Omit image-only request fields from T2I requests unless official documentation
  explicitly requires them.

Conditional branches that resolve to the same output key must be mutually exclusive.
Use the expression syntax and precedence exactly as documented in the guide rather
than reproducing JavaScript syntax by assumption.

## Images, References, and Masks

For each supported mode:

- choose the correct provider-level `image_format`;
- configure `mask_handling` only according to documented mask support;
- set `max_reference_images` to a verified limit;
- preserve the provider's required source/reference order;
- use the guide's canonical source and reference placeholders;
- include a mask only in modes and fields that officially accept it;
- verify mask dimensions, alpha/transparency expectations, and required preprocessing;
- do not send an empty source, mask, or image array merely to satisfy a field name.

If capabilities differ by model or mode and the guide supports a dynamic provider
field for that capability, use it. Otherwise choose a conservative valid value and
explain the limitation.

## Parameters and Template Values

For every API property, deliberately choose one of these representations:

- **A fixed/static value in `body_template` (read-only/hidden configuration)**:
  Parameters sent automatically with fixed, pre-configured values that the user does
  not need to see or adjust in the UI (e.g., technical flags, fixed model constants,
  disabled safety checkers, default tolerances).
- **A useful user-facing parameter in `parameters`**:
  Controls exposed in the UI (dropdown, slider, checkbox, text) for settings with a
  meaningful creative, cost, quality, or workflow tradeoff for the user.
- **A conditionally included field**:
  Fields added only when a specific condition (e.g., aspect ratio, source image) is met.
- **An omitted field**:
  Optional or irrelevant properties deliberately not sent.

Keep the UI focused. Expose only settings with a meaningful user tradeoff. Hardcode
technical constants and a single fixed `MODEL_ID` in the template. Create a model
dropdown only when the user explicitly asks to bundle multiple model IDs into one provider.

### Safety, NSFW, and Content Moderation

Never silently omit or drop safety, NSFW, or content-moderation parameters when the
provider API supports them (such as `enable_safety_checker`, `disable_safety_checker`,
`safety_tolerance`, `nsfw_filter`, or `moderation_level`).

- **Standard project convention**: Configure safety/NSFW checkers as static, fixed
  values in `body_template` set to the most permissive or disabled setting supported
  by the API (for example, `"enable_safety_checker": false`, `"disable_safety_checker": true`,
  or `"safety_tolerance": 6` / `"safety_tolerance": 5`). This prevents unexpected
  filtering of creative generations unless the provider enforces unconfigurable server-side
  moderation.
- **Ask the user**: If the provider's safety options, levels, or expected behavior are
  ambiguous, or if multiple non-trivial moderation modes exist, ask the user what they
  prefer (e.g., permissive static value in `body_template` vs. a user-facing parameter).

### Parameter Classification and Resolving Doubts

Do not interrupt or pester the user with piecemeal, one-by-one questions.

- **Clear / Standard parameters must NOT be asked**: Core API fields (such as `prompt`,
  `negative_prompt`, source image/mask fields, model IDs, endpoints, and standard sizing)
  are completely unambiguous and must be configured directly according to the guide.
- **No table if no ambiguity**: If all parameters in the provider's API are clear and
  straightforward, do not prompt the user or show a table at all—proceed directly to
  generating the configuration.
- **Include ONLY genuinely ambiguous, non-standard, or nuanced parameters** (e.g.,
  unusual safety/moderation scales, optional provider-specific toggles like `watermark`,
  `enhance_prompt`, custom upscaler toggles, or obscure post-processing options where the
  tradeoff between static `body_template`, user UI parameter, or omission is truly non-obvious).

If and only if such genuinely ambiguous parameters exist:

1. **Consolidate them into a single structured decision table**:
   Format the decision table with the following mandatory columns:
   - **`API Field`**: the exact parameter name in the provider's API;
   - **`Description`**: a concise explanation of what the parameter does;
   - **`Available Options`**: possible representations (e.g., static in `body_template`, user-facing in `parameters` with control type, or omitted);
   - **`Agent Recommendation & Rationale`**: the agent's explicit recommendation and reasoning based on project patterns.

   Example format:
   ```markdown
   | API Field | Description | Available Options | Agent Recommendation & Rationale |
   | :--- | :--- | :--- | :--- |
   | `safety_tolerance` | Filter sensitivity (1-6) | 1. Static `body_template`: `6`<br>2. User slider (1-6)<br>3. Omit | **Static `body_template`: `6`** — project standard is permissive defaults without UI clutter. |
   ```

2. **Present the table in a single batch** so the user can easily review, adjust, or
   confirm all decisions in a single response before you finalize the configuration.

Follow the guide's reserved-parameter rules precisely:

- declare the main prompt parameter with `alias: "prompt"`;
- declare `negative_prompt` with `alias: "negative_prompt"` only when the provider
  genuinely supports it, and keep `supports_negative_prompt` consistent;
- use `{{num_images}}` and `{{aspect_ratio}}` as system values;
- never create UI parameters for `num_images` or `aspect_ratio`;
- express aspect-ratio restrictions through the provider field documented in the guide.

Pure T2I requests require a non-empty root `aspect_ratio` from the caller. Account for
that requirement in the configuration and sizing logic, but do not duplicate it as a
provider parameter. I2I may derive its output shape from the normalized source when
the provider permits it. Consequently, a T2I-capable configuration must expose at
least one non-empty, valid aspect ratio. Never use an empty `allowed_aspect_ratios`
array for such a configuration. Omit the field only if every system ratio is genuinely
supported; otherwise list only ratios that the request template or preprocessor maps
to dimensions accepted by the provider.

## Authorization and Secrets

Read the API key only from the supplied environment variable using the guide's
`{{env:...}}` placeholder. Use the provider's documented header name and scheme; do
not assume every provider uses `Authorization: Bearer`.

Possible patterns include `"Authorization": "Bearer {{env:<API_KEY_ENV_VAR>}}"`,
`"Authorization": "Key {{env:<API_KEY_ENV_VAR>}}"`, and
`"x-key": "{{env:<API_KEY_ENV_VAR>}}"`.

Choose exactly the documented pattern. Never output the secret value and never create
a UI field for it.

## Preprocessing and Cost Control

Add a preprocessor only when it is needed to:

- satisfy documented size, area, step, or mask constraints;
- calculate an output size required by the API;
- reduce billable input dimensions deliberately;
- convert a mask into the required representation.

Analyze whether pricing is per image, megapixel, token, or resolution bracket. When
image dimensions materially affect cost, expose a concise cost/quality control and use
the guide's established preprocessor patterns. Do not add a complex optimization chain
without a verified billing or compatibility reason.

## Response Handling

Reuse an existing response handler whenever its polling flow and extraction strategies
match the documented response. Correctly distinguish URLs, Data URIs, and raw Base64.
Create a separate response handler only when none of the existing handlers can represent
the real response contract.

Do not assume request endpoint differences require different response handlers, but do
verify this explicitly. Conversely, do not combine modes into one provider when their
response contracts cannot be represented safely by one compatible handler.
`response_config` is shared by the provider and is not a mode-conditional request
template; do not invent conditional response-handler routing.

## Validation Before Output

Mentally resolve the final template for every configured and rejected model/mode
combination and verify:

- exactly one endpoint remains for every supported combination;
- no endpoint remains for an unsupported mode or unknown model value;
- T2I contains no unintended source, mask, reference, or empty image fields;
- I2I contains the source field in the documented format;
- a reference-only request follows I2I, sends its first reference through the source
  field, and does not duplicate that image among remaining references;
- optional masks and references appear only when present;
- all placeholders are documented by the guide or declared parameters;
- every dropdown default is one of its declared values;
- conditional branches cannot collide on the same output key;
- all documented safety, NSFW, and moderation parameters are explicitly accounted for
  (e.g., as permissive static values in `body_template` or declared parameters) and not
  silently dropped;
- any genuinely ambiguous, non-standard parameter was clarified via a decision table
  (and standard parameters were configured directly without asking);
- the selected response handler can process each configured mode;
- no secret, undocumented field, or executable JavaScript appears in the result;
- `tags.provider` and `tags.family` are present, use documented lowercase slugs, and
  reuse an existing host or family slug when the new configuration belongs to one.

Do not make a paid API request unless the user separately and explicitly asks for a
live test.

## Provider Tags

Always include a `tags` object on the provider as documented in the guide.

- `tags.provider`: slug of the API host from `PROVIDER_NAME` (for example `replicate`,
  `fal`, `openai`, `xai`, `bfl`). This is the service that owns the key and endpoint,
  not the model brand. Reuse an existing host slug when the same API family is used.
- `tags.family`: slug of the model line from `MODEL_ID` (for example `seedream`,
  `flux`, `grok`, `gpt-image`, `qwen`, `alibaba`, `p-image`). Reuse an existing family
  slug when the configuration is another host or version of the same line.

Use lowercase slugs with optional hyphens. One family slug per provider object — a
bundled dropdown (Wan + Qwen in one entry) gets a single bundle slug such as
`alibaba`. Do not add a favorites flag or any per-user state to `tags`.

## Output

Return:

1. The complete ready-to-use provider object in JSON5 format.
2. A separate response handler only if no existing handler is compatible.
3. A compact support matrix showing each configured mode, endpoint, source-image field,
   mask field, and response handler.
4. A brief explanation of the important configuration, compatibility, and cost choices.
5. Direct links to the official documentation used for verification.
6. A minimal smoke-test checklist covering every configured mode, reference-only
   normalization, masked reference-only input when masks are supported, rejection of
   unsupported modes, and rejection of unknown model values, without executing any
   paid request.

Write all comments inside JSON5 in English.
