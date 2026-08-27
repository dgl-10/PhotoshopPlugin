# WebHelper UI — Current Behavior Snapshot

> **STATUS: TEMPORARY ARCHIVE.** Detailed dump of how the current WebHelper UI
> works, kept on branch `feature/redesign-webhelper-ui` in case we need to look
> something up. **Not** the list of what the redesign must keep.
>
> The working keep/drop list is [`REDESIGN_KEEP.md`](REDESIGN_KEEP.md). Edit that
> one. Delete both files when the redesign has shipped.

## TL;DR

Это справочник «как сейчас устроено», не ТЗ на редизайн.

Редизайн может менять схему работы, вкладки, что видно после Generate, и почти
любой текущий UX. Что реально нельзя потерять — короткий список в
[`REDESIGN_KEEP.md`](REDESIGN_KEEP.md).

Ниже — разбор текущего кода: жесты, payload, local/remote, крайние случаи.
Нужен, если при переписывании всплывёт «а как это вообще работало?».

---

## Зачем этот документ создан / Why this document exists

**RU.** Снимок текущего клиента (`webhelper.html` / `.js` / `theme.css`) на
момент старта редизайна. Сначала по ошибке был задуман как чеклист «всё это
обязанно выжить». Это не так: редизайн полный, схема работы тоже может
измениться. Файл оставлен как архив, чтобы не потерять неочевидные детали
(особенно local vs remote / ngrok), если они понадобятся. Рабочий документ,
который можно вычёркивать и дополнять — [`REDESIGN_KEEP.md`](REDESIGN_KEEP.md).

**EN.** Archive of current client behavior. Not a mandate to freeze the existing
UI or interaction scheme. The editable keep-list is `REDESIGN_KEEP.md`.

**How to use.** Do not treat sections below as required. Consult them when a
rewrite needs the old contract (API payloads, provider fields, drag MIME types,
thread isolation). Decisions about what to keep live in `REDESIGN_KEEP.md`.

**Source of this snapshot.** `webhelper.html`, `webhelper.js`, `theme.css`, plus
client-facing fields in
[`Providers_Configuration_Guide.md`](../Providers_Configuration_Guide.md).
Visuals of the old UI: `_screenshots/01/11.png`, `_screenshots/01/12.png`.

---

## 1. Scope

| In scope | Out of scope unless discussed |
|---|---|
| `webhelper.html` | PhotoshopHelper HTTP routes in `main.js` |
| `webhelper.js` | Generation pipeline (`apiGenerator*.js`) |
| `theme.css` (and any replacement styles) | `providers.json` / provider request templates |
| Client-only UX, layout, CSS framework swap | UXP plugin “Send to WebHelper” |
| Keeping the existing REST **contracts** | Local Generation API (`/api/local/v1/*`) |
| | Auth, pairing, password gate implementation |

The current SPA is three files, vanilla JS, Light DOM custom elements, Spectre.css
from unpkg CDN. All of that, and the interaction scheme around it, may be replaced.
This section only describes the old client’s boundaries.

---

## 2. Entry, shell, environment

### 2.1 URL and origin

- Page lives at `http://localhost:18345/webhelper` (and the same path behind a
  tunnel). All API calls are **same-origin relative URLs**. Do not switch the SPA
  to a different origin or absolute cross-origin fetches.
- There is **no in-app login screen**. If `WEBHELPER_ACCESS_PASSWORD` is set, the
  browser’s HTTP Basic prompt handles it. The SPA must keep sending same-origin
  requests so the browser can replay Basic credentials. Do not invent a custom
  session unless we discuss it.

### 2.2 Boot sequence

1. `GET /api/is-local` → fill `window.envInfo` (`isLocal`, `isMobile`, `threadId`).
   On network failure, defaults stay `{ isLocal: true, isMobile: false, threadId: null }`.
2. `GET /api/webhelper/providers` → `app.providers`. Failure shows a global error
   toast: *Failed to load configuration. Check server connection.*
3. Start queue polling (see §8).

`window.envInfo` and `window.app` are current globals. Result-tab “New Task”
calls `window.app.pollForTasks()`. `WHConfig` is read from `window.WHConfig`.
A rewrite may drop globals **only if** those call sites are rewired.

### 2.3 `WHConfig` extension hook (must keep)

Defined inline in `webhelper.html`, not in the JS module:

```js
window.WHConfig.tryElectronDrag(e, images)
```

- Called on Global Stage `dragstart`.
- `images`: one base64 string or an array.
- Return `true` → Electron OS-drag was started; **cancel** the browser drag.
- Return `false` / function missing / throw → fall through to in-app browser drag.
- Current implementation: only when `envInfo.isLocal` **and** `e.altKey`; then
  `POST /api/drag/start` with `{ images }`. Failures are ignored.

Do not bury this hook inside a bundled module with no HTML escape hatch.

### 2.4 Connection status (navbar)

| State | Label | Style |
|---|---|---|
| Polling OK, local | `Connected` | success |
| Polling OK, remote | `Remote Access` | success |
| Polling fail / timeout | `Disconnected (Retrying...)` | error |

Initial HTML already shows the disconnected label before the first poll.

### 2.5 Global error toasts

`#error-container` — dismissible Spectre toasts (`toast-error`). Used for init
failures, failed T2I/image task creation, and “no image in selection/clipboard”.

### 2.6 Viewport / mobile chrome

- `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
- `overscroll-behavior: contain` on `body` (prevents pull-to-refresh fighting
  touch-drag of references).
- Source form uses a two-column grid that stacks on small screens
  (`col-6 col-sm-12`). A new layout may change this, but **touch-drag**,
  **stacked controls**, and **no horizontal pan stealing reference drags** must
  remain usable on phones.

### 2.7 Dark mode CSS

`body.wh-body.dark-mode` is fully styled in `theme.css` but **never applied** by
JS. Treat as unused styling, not a live feature — unless we decide to ship it.

`envInfo.isMobile` is stored and never read. Same: not a live feature.

---

## 3. Creating tasks (standalone, without Photoshop)

Empty state copy: *No tasks yet / Waiting for images from Photoshop, or drag and
drop an image here.* Two actions duplicate the navbar.

### 3.1 New Task (Text) — T2I

- Navbar: *New Task (Text)* (`#btn-create-text-task`).
- Empty state: *New Text-to-Image Task*.
- `POST /api/webhelper/task` with `{ threadId }` only — **no** `image` / `mask`.
- Then immediately `pollForTasks()`.

### 3.2 New Task (Image) — external I2I

- Navbar: *New Task (Image)* → hidden `<input type="file" accept="image/*">`.
- Empty state: *Select Image*.
- Body-level **drag-and-drop** of files onto the page (not onto Source Tab or
  Global Stage — those have their own handlers; see §6 and §7).
- **Paste image from clipboard**, but **only when there are zero open tasks**.
  If any task is already open, global paste is ignored so it cannot spawn a
  surprise extra task. Source-tab paste still works for references (§6.5).
- Only the **first image** in a file list / clipboard set becomes a task.
  Non-images are skipped; if none remain, toast *No image found…*.
- File is read as a data URL and sent as `{ image, threadId }`.
- File input is reset after change so the same file can be picked again.

### 3.3 Tasks from Photoshop

Not created by this UI. Plugin calls `POST /api/webhelper/task` with `image` +
optional `mask` and default `threadId: 'FromPS'`. The UI must **keep polling**
and surface those tasks on a local session without the user clicking anything.

### 3.4 Iterative task from a result

Result tab *New Task* → `POST /api/webhelper/task/from-file` with
`{ filename, sourceTaskId, threadId }`. Server copies the result as the new
source and may carry over / resize the original mask. UI then polls. Button
shows a temporary *Created!* success state (~2 s) and is disabled while the
request runs.

---

## 4. Multi-task model

- Many tasks can be open at once. Each is an independent `wh-task-control`
  (source image/mask, form state, references, result tabs).
- Only **one** task is visible. The rest stay in the DOM, `display: none`.
- `#global-task-selector` appears after the first task (hidden while empty).
  New tasks are **inserted at the top** of the `<select>` and auto-activated.
- Option label: `● [T2I] [Task {shortId}] @ {localTime}`
  - `[T2I]` prefix only when `taskData.sourceImage` is missing.
  - `shortId` = `taskId` without `task_`, first 12 chars.
- Each task gets a rotating color. The option text is colored; the
  `#wh-app-wrapper` **border** uses the active task’s color as a visual
  identity cue.
- Switching the selector shows that task and updates the wrapper border.
- **There is no Close / Delete task control.** Tasks live until page reload.
- **Nothing is persisted.** Reload loses tasks, Global Stage, `aliasState`,
  and form state. Queue only delivers tasks still in `status: 'new'`. This is
  current behavior — do not accidentally invent persistence, and do not
  accidentally start showing already-accepted server tasks unless we decide to.

### 4.1 Per-task chrome

- Header: `Task: {shortId}`.
- Tabs: always a *Source* tab, plus one tab per generation slot
  (`Res 1`, `Res 2`, …).
- While generating, the result tab shows a spinner in the tab label.
- On error, the tab label becomes `Res N (Error)` with error styling.
- Clicking a tab swaps the card body. Switching away and back **re-creates**
  the tab component from stored state (source form is re-rendered from
  `taskControl.state`; results from `_results[]`).

---

## 5. Source tab — generation form

Left: preview + references. Right: provider, dynamic params, prompts, generate.

### 5.1 Effective generation mode (client must match server)

```
effectiveMode = (sourceImage exists OR references.length > 0) ? 'i2i' : 't2i'
```

A mask **alone** does **not** make the task I2I. Adding the first reference to a
T2I task flips the mode to I2I and must re-filter providers.

Implemented modes are frozen: `['t2i', 'i2i']`. A provider whose
`generation_modes` is missing, empty, has duplicates, or contains any other
string is treated as **unsupported** (fail closed). Same rule exists on the
server — the UI is a preview of that check, not the authority.

### 5.2 Source preview

**With source image**

- Image is shown via **preview URL**:
  `/api/webhelper/file/…` → `/api/webhelper/filePreview/…` (compressed JPEG).
- If a mask exists **and** the current provider will actually use it, overlay
  modes are available:
  - **Image** — source only.
  - **Mask** — source hidden, mask shown as-is (`mask-only`).
  - **Overlay** (default `_viewMode`) — mask composited with
    `mix-blend-mode: multiply` at 0.7 opacity so non-masked areas darken.
- Mask overlay uses the **full** mask URL, not `filePreview`.
- Toggle group is **hidden** (visibility) when the mask will not be sent.
- Preview / mask toolbar is hidden entirely when there is no source image.

**Without source image (T2I empty preview)**

- Placeholder: *Text-to-Image Mode* / *Prompt and settings drive generation.
  No source image required.*

### 5.3 Use Mask checkbox

Visible only when a provider is selected **and** `taskData.maskImage` exists.

| Provider `mask_handling` | Checkbox |
|---|---|
| missing / `supported: false` | unchecked, **disabled** (mask will not be sent) |
| `supported: true`, `required: true` | checked, **disabled** (cannot turn off) |
| `supported: true`, `required: false` (default) | user-controlled, default **on** (`state.useMask = true`) |

`use_mask` in the generate payload must follow the same rules, including
“no mask file → false”.

**Blocking error:** `required: true` but this task has no mask → persistent
error toast *Provider requires a mask.* and Generate is disabled. Clicking
Generate still re-checks and refuses.

### 5.4 Reference images

- Dashed drop zone. Counter: `(n/max)` when `effectiveMaxRefs > 0`, else `(n)`.
- Counter turns error-colored when over limit.
- Thumbnails 80×80, `object-fit: cover`, remove button, grab cursor.
- Badge `@image1`, `@image2`, … (1-based). Reorder must **renumber**.
- “+” file input, `accept="image/*"`, **`multiple`**.
- Hint when empty: *Drag images here or click "+"*.
- Adding beyond the limit is **allowed**. Warning (not a block):
  *Too many references (n/max). Server will only receive the first {max}.*
  Generate still runs; payload sends `references.slice(0, effectiveMaxRefs)`.
- CSS class `.wh-reference-add-btn.disabled` exists but is **not** applied.
  Do not “fix” this by hard-blocking adds unless we decide to.

**`max_reference_images`**

- Number → that max.
- Object `{ default, depends_on, values }` → look up current form field;
  fall back to `default` then `0`. Changing the depended-on field **must
  re-render** the counter / warnings.
- Missing / other → `0`.

**Effective max** subtracts 1 when all of these are true:

- `mask_handling.type` contains `'referential'` (`first_referential` /
  `last_referential`);
- the mask will actually be sent (same rules as §5.3).

That slot is consumed by the mask on the server; the UI must show the reduced
user quota.

**Reorder (desktop):** HTML5 drag on items, `text/plain` payload `ref:{index}`,
vertical drop separator, row-aware insert index (nearest centroid, then
left/right of center). Dropping on the zone with `ref:` is reorder, not a new
file. Must `stopPropagation` so `#drop-zone` does not also call `processFiles`
(double-add bug).

**Drop onto prompt:** dragging a reference onto the prompt textarea inserts
`@imageN` at the caret and does not overwrite the rest of the prompt. This is
a UI convenience; the server does not parse `@imageN`.

**Paste / files / Global Stage → refs:** see §6 and §7.

### 5.5 Provider dropdown

- First option: *Select a provider…* (empty value). Generate disabled until
  a real provider is chosen.
- Options from `GET /api/webhelper/providers` (already filtered by API keys
  server-side; the UI must not assume every configured model is present).
- Providers that do not support `effectiveGenerationMode` are **`disabled`**
  and suffixed ` [unavailable for T2I]` / ` [unavailable for I2I]`.
- Switching provider **re-renders** the whole Source tab (params, mask UI,
  remarks, aspect-ratio list, ref limits).
- Persistent error when the selected provider cannot run the current mode:
  *Provider does not support {MODE} generation.* Generate disabled; handleGenerate
  still guards this for programmatic calls.

### 5.6 Dynamic parameters (`provider.parameters`)

Rendered in a scrollable panel (`max-height: 300px`), hidden if empty.

| `type` | Control |
|---|---|
| `dropdown` | `<select>` |
| `slider` | range + live numeric label |
| `boolean` | labeled checkbox |
| `integer` / `number` | `<input type="number">` |
| `string` (and anything else) | text input |

- Label = `p.label || p.name`.
- Value key = `p.alias || p.name`.
- Parameters with `alias === 'prompt'` or `'num_images'` are **not** rendered
  here (fixed controls). `'negative_prompt'` is also skipped in this panel
  and synced into the dedicated textarea.
- Dropdown options may be strings or `{ value, label, alias, hidden }`.
  Hidden options are **not shown** but participate in alias matching
  (alias bridges, e.g. `ultra` → same API `value` as visible `high`).
- If the remembered alias is hidden, pick a **visible** option with the same
  underlying `value`. If even that fails, fall back to matching raw `value`.

**Alias persistence (`app.aliasState`) — must keep.**

Cross-provider, cross-task for the lifetime of the page:

1. Changing an aliased control writes `formState[alias]` **and** `aliasState[alias]`.
2. On provider switch, each param reads `formState[alias]`, then `aliasState[alias]`,
   then `p.default` (for dropdowns, default may itself be an option alias).
3. Parameters **without** an alias reset to that provider’s `default`.
4. `aspect_ratio` and `force_separate_requests` also live in `aliasState`.

Raw aspect-ratio **intent** is stored un-fixed. When the new provider cannot
honor it, the UI shows the nearest allowed ratio (`fixAspectRatio`) but must
**not** overwrite `aliasState['aspect_ratio']`, so switching back restores the
original choice.

### 5.7 Prompt / negative prompt

- Prompt textarea always visible. Placeholder *Describe what you want…*.
- Empty prompt is a **warning**, not a block: persistent *Prompt is empty.*
  Generate still runs and flashes *Prompt is empty. Generating anyway…*.
- Negative prompt textarea shown only if `provider.supports_negative_prompt`.

`english_only` is in the provider payload and documented as “visual indicator
only”, but the **current JS never displays it**. Do not treat it as a live
feature; do not silently invent a badge unless we decide to.

### 5.8 Remarks

`provider.remarks` is an HTML string, rendered as HTML above the generate row
(pricing notes, warnings). Display-only — no inputs inside. Preserve the
ability to show rich HTML from config.

### 5.9 Images count

- Number input, `min=1`, `max=10`, default `1`.
- When value `> 1`, show *Each image in separate request*.
- If `provider.single_image_per_request === true`, that checkbox is **checked
  and disabled** (provider always splits). Otherwise it is user-controlled
  and persisted in `aliasState['force_separate_requests']`.
- Payload field: `force_separate_requests` (boolean). The server also honors
  `single_image_per_request` from provider config, so the disabled checkbox is
  informational / consistent UX, not the only enforcement.

### 5.10 Aspect ratio

Global list (must stay in sync with `apiGeneratorPreprocessors.js` if the
client still does local snapping):

```
21:9, 2:1, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 1:2, 9:21
```

`provider.allowed_aspect_ratios`:

| Form | UI |
|---|---|
| absent | all ratios above |
| string array | that list |
| `[]` | select **disabled**; I2I shows only *Match Input* |
| `{ default, depends_on, values }` | list from current field / default |

**T2I**

- *Match Input* is **not** offered.
- Aspect ratio is **required**. Missing → error toast and Generate disabled.
- If raw intent is empty: prefer `1:1`, else first allowed.
- If raw intent is not allowed: nearest numeric ratio.

**I2I**

- Extra option `value=""` labeled **Match Input**.
- Empty `allowed_aspect_ratios` **or** empty raw intent → Match Input.
- Otherwise snap via `fixAspectRatio`.

Current gap (do not blindly preserve as a bug, do not regress further):
changing a `depends_on` field for **aspect ratios** does not currently
re-render the AR dropdown (only `max_reference_images.depends_on` does).
Prefer fixing this during redesign.

### 5.11 Generate

Button disabled when any of:

- no provider selected;
- required mask missing;
- provider does not support effective mode;
- T2I aspect ratio missing.

Warnings (do not disable): empty prompt, too many references.

Click:

1. Re-run the same guards (mode / AR / mask). Empty prompt and over-limit refs
   still produce a transient toast.
2. Open a **new** result tab in `generating` state **without switching to it**
   (`addGeneratingTab(false)`). User stays on Source and may fire **another**
   generation immediately (concurrent slots on the same task).
3. Collect params from the **DOM first**, then state/defaults. Dropdown aliases
   are resolved back to the option’s API `value` before send.
4. `POST /api/webhelper/generate` with:

```json
{
  "taskId": "...",
  "providerId": "...",
  "num_images": 1,
  "aspect_ratio": "1:1" | "",
  "use_mask": true,
  "params": { "...": "provider field names, API values" },
  "referenceImages": ["data:image/...base64,..."],
  "force_separate_requests": false
}
```

5. This fetch has **no client timeout**. Do not add a short abort — generations
   are long-running on the same HTTP request.
6. HTTP error → that slot becomes an error result.
7. HTTP 200 `{ results: [...] }` → first item replaces the generating slot;
   extra items create extra `Res N` tabs (same params/provider). Duplicate
   errors with the same `error_hash` are collapsed to one tab.
8. User is **not** auto-switched to the new result. They click `Res N`.
   If they are already viewing a result tab, that tab re-renders.

Transient toasts live under `#tab-notification-container`, auto-remove in 5 s,
and are dismissible. Persistent warnings/errors for prompt/refs/mask/mode/AR
stay until the condition clears.

---

## 6. Drag, drop, paste, touch (Source tab)

These are easy to lose in a redesign. Treat as first-class.

| Input | Behavior |
|---|---|
| OS files dropped on Source tab / drop zone / refs row | add as references (all images, not just the first) |
| OS files dropped on **page body** outside Source and Global Stage | new Image task (first image only) |
| Paste while Source tab of the **visible** task is mounted | add clipboard images as references; `preventDefault` so global paste does not also create a task |
| Paste while that task is `display: none` | ignore (other task is active) |
| Paste with **no** tasks open | new Image task |
| Drag from Global Stage (`wh/ref-image` MIME) onto Source | **copy** base64 into this task’s references |
| Drag reference (`ref:N`) onto Global Stage | **copy** that ref into Global Stage |
| Drag reference onto prompt | insert `@imageN` at caret |
| Drag reference among refs | reorder with separator |
| Click “+” | multi file picker |

Paste is bound in **capture** phase so it runs before the document handler.
`disconnectedCallback` must remove paste + touch listeners (today Source and
Global Stage both leak if this is forgotten after a re-render cycle — the
current code already tries to clean up).

### 6.1 Touch (phones)

Reference items and Global Stage items:

- `touch-action: none`, no iOS callout, no text select, `contextmenu` prevented
  (blocks “Save Image”).
- `touchstart` `preventDefault` except on the delete button.
- 8 px move threshold before a drag is armed.
- `touchmove` / `touchend` on `document` so the finger can leave the thumbnail.
- If the browser also fires HTML5 drag (`nativeDragActive`), touch-end must
  **not** apply a second drop.
- Hovering Global Stage header on touch **auto-opens** it and sets `drag-over`.
- Dropping a task-ref onto Global Stage via touch **copies** (does not remove
  from the task).
- Dropping a Global Stage item onto Source via touch **copies** into that
  task’s references and highlights `#drop-zone`.

---

## 7. Global Stage (shared reference pool)

Accordion **above** the task selector, collapsed by default.

- Header: `Global Stage (N)` + arrow icon; click toggles.
- **Auto-open** when something draggable is dragged over the header
  (files, `wh/ref-image`, or `text/plain` task refs). Same on touch hover.
- Body is a floating dashed panel (`position: absolute`, high z-index).
- Same 80×80 thumbs, remove buttons, “+” multi upload.
- Badges `@glb1`, `@glb2`, … (distinct from `@imageN`).
- Empty hint: *Drag images here or click "+"*.
- Non-empty hint:
  - local: *Drag to use in WebHelper, Alt+Drag to use externally*
  - remote: *Drag to use in WebHelper* (no Alt+Drag)
- Highlight `drag-over` on the accordion while a valid drag is over it.
- Accepts: OS files (all images), `wh/ref-image`, `ref:N` from the **active**
  task (looked up via `app.taskSelector.value`).
- **Self-drop ignored** (dragging a stage item onto the same stage does not
  duplicate).
- Outbound desktop drag sets `wh/ref-image` = base64, `effectAllowed = 'copy'`.
- Outbound **Alt+Drag** (local only): `WHConfig.tryElectronDrag` → OS drag via
  `/api/drag/start` (drop into Photoshop, Explorer, browsers, etc.).
- Images are **in-memory only** (data URLs), not uploaded until used as task
  references and sent on Generate.

---

## 8. Queue polling and thread isolation

- Local: `setInterval` every **2 s**, plus an immediate poll. Each request
  aborts after **3 s**.
- Remote (`isLocal === false`): **automatic polling is off** after one
  initial poll (connection check + any already-queued session tasks). Remote
  users will not receive later Photoshop tasks; they only see their own
  `threadId`.
- `GET /api/webhelper/queue?threadId={envInfo.threadId}`.
- Server filter (do not break the client’s assumptions):
  - local browser → `threadId === 'FromPS'` **or** this session’s id;
  - remote browser → **only** this session’s id.
- On new ids: `POST /api/webhelper/mark_opened` with `{ taskIds }`, then
  `GET /api/webhelper/task/:taskId` for each unknown id and mount a control.
- Two local tabs: the first to poll **consumes** the queue. That is current
  behavior.

Photoshop-originated tasks must appear on the local WebHelper without a
manual refresh.

---

## 9. Result tab

### 9.1 Generating

Centered spinner + *Generating…*.

### 9.2 Success

- Header: `{nice_name || providerId || 'Unknown'} | Aspect: {aspect_ratio || 'Match Input'}`.
- Header is a disclosure: **click toggles** immediately; **hover opens after
  1 s**, **leave closes after 1.5 s**. Body contains params JSON (`<pre>`,
  max-height 100 px) and actions.
- Image:
  - local → full `/api/webhelper/file/…`;
  - remote → `filePreview` (JPEG). Labels on Download become
    *Download Full Res* when remote.

**Actions**

| Action | When | Behavior |
|---|---|---|
| **Copy** | local only | `POST /api/webhelper/file/copy2clipboard` `{ filename }` (full-res file on disk, not the preview). Button flashes success ~1 s. |
| **Download** | always | `<a href="{full file URL}" download>`. Remote label *Download Full Res*. |
| **Re-generate** | always | Switch to Source; restore `providerId`, `params`, `num_images`, `aspect_ratio` into `formState`. Previous result tabs **stay**. |
| **New Task** | always | §3.4. Success flash *Created!*. |

The Copy button label *Copy Full Res* is currently **dead** (Copy is only
rendered when local, and local does not use preview). Do not treat that string
as a live state.

### 9.3 Error

- Error toast with `resultData.error`.
- If `fallback_url` is present: *Download Manually* (`target="_blank"`).
  Used when the provider finished but the Helper could not fetch the bytes.
- Params block still shown when present (so Re-generate context exists).
  Error results currently do **not** render the action buttons — Re-generate
  is only on the success layout. Preserve unless we deliberately add
  Re-generate on errors too.

### 9.4 Multi-image / multi-error

One Generate click may return N results. First fills the placeholder tab;
the rest append tabs. Identical `error_hash` values are shown once.

---

## 10. Provider-driven UI contract

The Source tab is a **generic renderer** of sanitized provider objects. A
redesign must still honor every client-visible field:

| Field | UI effect |
|---|---|
| `id` | value sent as `providerId` |
| `name` | dropdown label (often includes price) |
| `generation_modes` | enable/disable + T2I/I2I errors |
| `tags.provider` / `tags.family` | grouping metadata for a future combobox (API host vs model family). Not used by the current Source tab. Do not drop it. |
| `mask_handling.supported / required / type` | checkbox, overlay, ref-slot math |
| `max_reference_images` | number or `depends_on` object |
| `supports_negative_prompt` | negative textarea |
| `english_only` | unused in JS today |
| `allowed_aspect_ratios` | array, `[]`, or `depends_on` object |
| `remarks` | HTML block |
| `single_image_per_request` | elevated by server from `request_config`; forces split checkbox |
| `parameters[]` | dynamic controls; `alias`, `hidden` options, reserved aliases |
| `nice_name` | not used on Source; resolved by **server** onto each result |

Reserved aliases (must remain special, not dumped into the dynamic panel):
`prompt`, `negative_prompt`. `num_images` and `aspect_ratio` are **global**
controls — never render them from `parameters` even if a config mistakenly
declares them.

Server strips `request_config`, `response_config`, `image_format`,
`filename_suffix`, `preprocessor` before the list reaches the browser. The UI
must not depend on those.

---

## 11. API surface the client depends on

Do not change these without a discussion. Payloads/URLs the SPA uses today:

| Method | Path | Role |
|---|---|---|
| GET | `/api/is-local` | `{ isLocal, isMobile, threadId }` |
| GET | `/api/webhelper/providers` | `{ providers: [...] }` |
| POST | `/api/webhelper/task` | create T2I or image task |
| POST | `/api/webhelper/task/from-file` | chain from a result file |
| GET | `/api/webhelper/queue?threadId=` | new task ids |
| POST | `/api/webhelper/mark_opened` | `{ taskIds }` |
| GET | `/api/webhelper/task/:taskId` | `{ sourceImage, maskImage, status, results, threadId }` |
| GET | `/api/webhelper/file/:filename` | original bytes |
| GET | `/api/webhelper/filePreview/:filename` | JPEG preview |
| POST | `/api/webhelper/generate` | long-running; `{ results }` |
| POST | `/api/webhelper/file/copy2clipboard` | `{ filename }` local only |
| POST | `/api/drag/start` | `{ images }` from `WHConfig` Alt+Drag |

Task `sourceImage` / `maskImage` / result `image` are URL paths like
`/api/webhelper/file/task_…_image.png`.

---

## 12. Local vs remote vs Photoshop-adjacent workflows

Must remain distinguishable in the new UI:

| | Local desktop | Remote (tunnel / phone) |
|---|---|---|
| Poll Photoshop (`FromPS`) tasks | yes, every 2 s | no |
| Create T2I / image tasks | yes | yes (own `threadId`) |
| Copy to system clipboard | yes | hidden (no Helper clipboard from a remote browser) |
| Result image | full file | preview JPEG + *Download Full Res* |
| Source preview | always preview endpoint | same |
| Alt+Drag out of Global Stage | yes | no |
| HTTP Basic password | optional | typical when tunneled |

Standalone (no Photoshop) must keep working: T2I button, file upload, paste,
drag-drop, Global Stage.

Photoshop loop that must still work after redesign:

1. Capture in the plugin → Send to WebHelper.
2. Local WebHelper picks the task up (image + mask overlay).
3. User generates.
4. Copy (local) or Download, then Place Back in the plugin.

---

## 13. Accessibility / small UX details easy to miss

- Navbar tooltips: *Create Text-to-Image Task*, *Upload or Drag & Drop Image*.
- Generate uses a primary, large, full-width-in-its-column control.
- Result Copy/New Task have a short success flash (`btn-success`).
- Task identity color on selector **and** wrapper border.
- Loading spinner class on the generating tab label, not only in the body.
- `accept="image/*"` on all file inputs.
- Hidden file inputs must stay reachable from visible buttons.
- Do not let a nested drop zone fall through to “create new task”.
- Do not let internal `ref:` drags be treated as file drops (double-add).
- Do not let Global Stage self-drop duplicate items.
- Do not steal paste from the prompt textarea when the user is typing text
  (current code only hijacks paste when clipboard items are `image/*`).

---

## 14. What the redesign **may** change freely

These are not preservation requirements:

- Spectre.css, unpkg CDN, class names, card/tab look.
- Custom element names and Light DOM vs a framework.
- Two-column Source layout, accordion vs always-on Global Stage **as long as**
  the pool and its drag contracts remain.
- Hover-delay params disclosure vs a simpler details/summary.
- Color palette, typography, icon set (Spectre `icon-*`).
- Applying the unused dark-mode CSS, or dropping it.
- Showing `english_only` (currently undocumented-in-code).
- Adding a Close-task button, persistence, or auto-switch to the new result
  — those would be **new** features, not silent behavior changes. Call them out.

---

## 15. Current gaps / dead code (do not confuse with features)

Record here so a rewrite does not “preserve” accidents, and so we can choose:

- Dark mode CSS never toggled.
- `envInfo.isMobile` never read.
- `english_only` never shown, despite the provider guide.
- `.wh-reference-add-btn.disabled` never applied; over-limit adds are warnings.
- Copy label *Copy Full Res* unreachable.
- `allowed_aspect_ratios.depends_on` does not rebuild the AR `<select>` live.
- Generate payload sends `force_separate_requests` from **state**, while the
  checkbox can look forced-on via `provider.single_image_per_request`. Server
  still splits when the provider flag is set; keep the checkbox honest.
- No generation cancel, no task close, no resume after reload.
- `console.log` paste/debug noise in Source paste and Generate.
- Commented-out generate short-circuit in `handleGenerate`.

---

## 16. Old-UI verification notes (archive)

How the **current** UI can be exercised, if we need to compare an old build.
Not a pass/fail list for the redesign — that lives in `REDESIGN_KEEP.md`.

**Empty / create**

- [ ] Empty state actions create T2I and Image tasks.
- [ ] Navbar duplicates work once tasks exist.
- [ ] Body drop of an image creates a task; drop onto refs / Global Stage does not.
- [ ] Paste with zero tasks creates an Image task; paste with tasks open does not.
- [ ] Multi-file drop for a **new task** uses only the first image.

**Photoshop / polling**

- [ ] Local: Send to WebHelper from the plugin appears within ~2 s, with mask.
- [ ] Remote session does not steal `FromPS` tasks.
- [ ] Disconnect label appears if the Helper is stopped; recovers when it returns.

**Source / providers**

- [ ] T2I placeholder vs I2I preview + mask overlay (Image / Mask / Overlay).
- [ ] Use Mask: optional / forced on / forced off per provider.
- [ ] Referential mask reduces the visible ref quota by 1.
- [ ] Provider list disables models that cannot do current T2I or I2I.
- [ ] Adding the first reference flips T2I → I2I and updates that list.
- [ ] Dynamic params: dropdown, slider, boolean, number, text.
- [ ] Aliased values survive provider switch and restore on switch-back
      (including hidden-option bridges).
- [ ] Negative prompt appears only when `supports_negative_prompt`.
- [ ] Remarks HTML renders.
- [ ] T2I requires aspect ratio; I2I offers Match Input; empty allowed list
      disables the select.
- [ ] Aspect-ratio intent snaps per provider but restores when returning.
- [ ] Empty prompt warns but still generates.
- [ ] Over-limit refs warn; extras are not sent.
- [ ] Required-mask provider without a mask blocks Generate.
- [ ] `num_images > 1` shows split-request checkbox; provider-forced split
      is checked + disabled.

**References / Global Stage / gestures**

- [ ] Add via +, files, paste, drag from OS, drag from Global Stage.
- [ ] Reorder refs (mouse separator + touch).
- [ ] Drop ref onto prompt inserts `@imageN`.
- [ ] Delete ref / Global Stage item.
- [ ] Global Stage collapse, auto-open on drag, copy in both directions.
- [ ] Alt+Drag from Global Stage to an external app (local Electron only).
- [ ] Touch: no save-image callout; drag to the other pool works.

**Generate / results**

- [ ] Generate stays on Source; extra clicks create extra Res tabs.
- [ ] Spinner on the tab; error styling on failure.
- [ ] Multi-image results create multiple tabs; duplicate errors collapse.
- [ ] Success: params disclosure (click + hover delay), Download, Re-generate
      (keeps old tabs, restores form), New Task (new selector entry, mask
      carried when the server can).
- [ ] Local Copy puts a full-res image on the clipboard (paste in Photoshop).
- [ ] Remote: no Copy; preview image; Download Full Res still hits the file URL.
- [ ] `fallback_url` error offers a manual download link.

**Multi-task**

- [ ] Selector lists tasks, T2I prefix, colors, wrapper border.
- [ ] Switching tasks hides the other form/results but keeps their state.
- [ ] Paste/drag apply to the visible task’s refs, not a hidden one.

---

## Explicitly dropped

Keep/drop decisions belong in [`REDESIGN_KEEP.md`](REDESIGN_KEEP.md), not here.

---

## File map (current)

```
PhotoshopHelper/webhelper/
  webhelper.html   # shell, empty state, WHConfig, Spectre CDN
  webhelper.js     # WebHelperApp + WhTaskControl + WhSourceTab
                   #   + WhResultTab + WhGlobalStage
  theme.css        # Spectre overrides, task colors, overlay, stage, dark unused
```
