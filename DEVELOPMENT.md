# FromPS / ToPS — A Bridge for Free AI Inpainting Without API Keys (Technical review)

**FromPS / ToPS** is a plugin for Adobe Photoshop 2024 (Windows) that automates repetitive workflows when using web-based AI services (Midjourney, Gemini, ChatGPT, Leonardo, and others) for Inpainting tasks — filling in or replacing areas of an image.

Most AI plugins for Photoshop require an embedded API key and charge a fee for every individual generation. This project solves that problem: it lets you use any AI service through a browser interface (for free or via your existing web subscription), acting as a convenient automation bridge for routine copy-and-paste operations.

**Core concept and value:**
- **FromPS (Export to Browser):** Select an area — the plugin automatically crops the image, generates a precise mask, and adjusts the capture to fit popular aspect ratios (1:1, 2:3, 3:4, 9:16) for maximum compatibility with AI services. Via the companion helper app, files can be dragged and dropped directly into the browser window.
- **ToPS (Import back to Photoshop):** Copy the finished generation from the browser and click the button. The plugin automatically places and fits the image exactly at the original selection coordinates, converts it to a Smart Object, applies the original mask, and smooths the edges with a Gaussian Blur for a seamless blend with the background.
- **WebHelper (API Generations):** A built-in local web application (`http://localhost:18345/webhelper`), running in tandem with the companion server. It allows you to generate Inpaint images directly via AI APIs (OpenAI, Leonardo, Stable Diffusion, BFL Flux, and others), or through an AI CLI already installed on the machine (OpenAI Codex, SpaceXAI Grok, Google Antigravity) on the person's own subscription, bypassing the need to manually upload images to third-party services. Can operate either alongside the plugin or fully standalone.

**AI Agent for Photoshop (MCP)** is a separate tool shipped in the same package. PhotoshopHelper publishes an MCP server that lets the AI agent the person already uses read and change the document open in Photoshop. Any agent application that can connect to MCP servers (an MCP host, in the protocol's terms) works, whether it runs as a terminal CLI, a desktop app, or an IDE extension: Claude Code, OpenAI Codex, SpaceXAI Grok, Google Antigravity, and others. It does not use the capture / place-back workflow above; the UXP plugin serves only as the agent's way into Photoshop.

## 📋 Features

### FromPS (From Photoshop)
- Captures the current selection as an image
- Saves an alpha mask of the exact selection shape
- Modes: Copy Merged (all layers) / Current Layer (active layer only)
- Export options: Save PNG, Copy to Clipboard, Drag Out (image + mask), and Send to WebHelper (image + mask)

### ToPS (To Photoshop)
- Accepts finished generations from files or from the clipboard (one click)
- Automatically places the image into the active document
- Precisely positions the result at the location of the original selection

### WebHelper (Browser UI for Generations)
- Runs locally at `http://localhost:18345/webhelper`
- Automatically receives tasks (Image + Mask) from the FromPS plugin
- Allows you to select a model, write prompts, and configure generation parameters
- Displays a visual mask overlay and supports Reference images
- Can generate through an installed AI CLI instead of an image API key. CLIs are set up in **AI CLI Settings...** in the Helper tray menu; WebHelper adds one in-memory provider, **CLI Native Image Generator** (`native-cli-image-generator`), when at least one installed CLI is enabled, marked for native image generation, and has a Medium model selected. This provider does not accept masks.
- Finished generations can be copied and pasted back into Photoshop via ToPS in one click
- Can operate either alongside the plugin or fully standalone

### Local Generation API (Service-to-Service)
- Runs on the same loopback-only Helper server: `http://127.0.0.1:18345`
- Lets another local process reuse one source image and optional mask across multiple provider runs
- Exchanges absolute local file paths only; generated image bytes are not returned by the API
- Uses the active merged provider catalog (the shared catalog plus `providers.user.json`, plus the CLI provider when it is available), the same provider preprocessors, and the same output directory as WebHelper
- Saves results in `%TEMP%\ps_webhelper_tasks\_WH_Generated` and returns their absolute paths after completion
- Uses asynchronous polling. Webhooks are not part of the current local contract.
- The same generation service is also published to MCP agents as the `gen_` tools; a generation started through one entry point can be read through the other

### AI Agent for Photoshop (MCP)
- PhotoshopHelper publishes an MCP server at `http://127.0.0.1:18345/mcp` (Streamable HTTP, JSON-RPC 2.0), protected by the Local API token
- The server is registered once in the person's agent application under the name `photoshop-helper`. The agent must run on the same computer (the server listens only on `127.0.0.1`), support HTTP MCP servers with an `Authorization` header, and be able to read local files, because generation tools and some document tools exchange absolute file paths
- The AI Assist window gives a text to paste into any agent's chat, after which the agent registers the server by itself, and ready terminal commands for Claude Code, OpenAI Codex, SpaceXAI Grok, and Google Antigravity
- Document tools (`ps_`, `from_ps_`, `to_ps_` prefixes) read and change the open document, run scripts in Photoshop, and return images of the canvas. They work only inside a task opened with `ps_start_task` and closed with `ps_finish_task`
- Generation tools (`gen_` prefix) run the Local Generation API service, do not touch the document, and need no task
- The agent reaches Photoshop through the plugin's **FromPS / ToPS AI** line: a WebSocket channel (`ws://127.0.0.1:18346`) that opens only when the person turns the line on from the panel menu, and closes itself after an hour without tasks (`PHOTOSHOP_HELPER_AGENT_LINE_IDLE_MINUTES` changes this)
- The AI Assist window (Helper tray → **AI Agent for Photoshop → AI Assist...**) shows the connection, the running task with its steps, the agent's final report, and the setup instructions
- A knowledge base of verified Photoshop recipes is handed to the agent through the `ps_kb_` tools. Helper downloads the author's articles from the repository's `main` branch, so changes reach installed copies without a release; articles written by agents stay in the person's own data folder

## 🚀 Installation & Setup

### Requirements
- Adobe Photoshop 2024 (version 24.0.0 or higher)
- Windows
- [Adobe UXP Developer Tools](https://developer.adobe.com/photoshop/uxp/devtool/) (installed via Adobe Creative Cloud)
- Optional, for CLI generation: at least one of OpenAI Codex (`codex`), SpaceXAI Grok (`grok`), or Google Antigravity (`agy`), installed on `PATH` and signed in
- Optional, for the AI agent: any agent application on the same computer that supports MCP servers (terminal CLI, desktop app, or IDE extension)

### Installation Steps

1. **Install and open UXP Developer Tools**
   - **Installation:** If the tool is not installed, open **Adobe Creative Cloud Desktop**, go to the **Apps** section, search for **"UXP Developer Tools"**, and click **Install**.
   - **Launching:** This is a standalone application called **Adobe UXP Developer Tool**. You can find it in the Windows **Start Menu** or open it from within Photoshop: **Plugins** → **Development** → **Get Developer Tools** (the exact name may vary by Photoshop version).
   - **Note:** On first launch, you may be prompted to enable **Developer Mode** (administrator privileges required).

2. **Load the plugin**
   - In the UDT application, click **"Add Plugin..."**
   - Select the `manifest.json` file located in the root folder of this repository.

3. **Run the plugin**
   - Find "FromPS-ToPS" in the plugin list
   - Click **"⋮"** → **"Load"** (the plugin will load and appear in Photoshop as a dockable panel)
   - Optionally click **"⋮"** → **"Debug"** (for debugging)

## 📖 Usage

### Capturing a Selection (FromPS)
1. Create a selection in Photoshop (using any selection tool)
2. Choose a source mode:
   - **Copy Merged** — the visible result of all layers
   - **Copy [Current] Layer** — the active layer only
3. Click **Capture Selection**. The following capture modes are available:
   - **Fast** — quick selection capture; the primary capture method. Applies a uniform padding on all sides of the selection and finds the optimal aspect ratio for the source.
   - **Slow with transparency** — slow selection capture. Use this when you need to preserve the transparency of the selection.
   - **Full Doc Mask — Fast** — quick capture of the entire document. Use this when the mask needs to be positioned outside the central area of the source.
   - **Full Doc Mask — Slow** — slow full-document capture with transparency preserved.
4. Use the export buttons:
   - **Save** — save the source as a PNG
   - **Mask** — save the mask as a PNG
   - **Save Both** — save both the source and the mask simultaneously (requires PhotoshopHelper to be running)
   - **Copy** — copy to clipboard (requires PhotoshopHelper to be running)
   - **Drag Out** — drag image + mask into an external application (requires PhotoshopHelper to be running)
   - **Send to WebHelper** — send image + mask to WebHelper (requires PhotoshopHelper to be running)

### Placing the Result (ToPS)
1. Load the processed image:
   - **Load File...** — select a file
   - **Paste** — paste from clipboard (requires PhotoshopHelper to be running)
2. Click **Place Back**
3. The result will appear as a new layer in the form of a Smart Object with an applied mask and a Gaussian Blur filter applied to the Smart Object

### Generating through an AI CLI (WebHelper)
1. Install the CLI and sign in to it with your own subscription
2. Open **AI CLI Settings...** from the Helper tray menu. Installed CLIs are detected automatically
3. Tick **Enabled** and **Image** for the CLI, then click **Configure** and choose at least the **Medium** model (**Refresh via CLI** asks the CLI itself for its current model list)
4. In WebHelper choose **CLI Native Image Generator** and pick the CLI in its **CLI provider** field. A run can take several minutes; **Show CLI window** lets you watch it

### Connecting an AI agent (MCP)
1. Helper tray menu → **Access Tokens → Save Token to User Environment...** (stores `PHOTOSHOP_HELPER_LOCAL_API_TOKEN` for your user account)
2. Helper tray menu → **AI Agent for Photoshop → AI Assist...** → copy the setup text once: either **Any agent: paste into its chat** (the agent adds the server to its own settings) or the terminal command for your agent
3. In the FromPS / ToPS panel menu choose **FromPS / ToPS AI...** to turn on the line at the bottom of the panel
4. Restart the agent so it loads the tools, then ask it to work on the active Photoshop document. The AI Assist window offers a starter prompt

## ⚠️ Known Limitations

### ✅ UXP Limitations — RESOLVED via PhotoshopHelper

**Date resolved:** 02/05/2026

Direct access to the system clipboard (for images) and Drag & Drop from the plugin into external applications are not possible due to Adobe UXP sandbox restrictions.

**Solution:** The companion application **PhotoshopHelper** (Electron) runs in the background and provides an HTTP API for accessing the system clipboard.

#### How to use:
1. Install
   ```bash
   cd PhotoshopHelper
   npm install
   ```
2. Start `PhotoshopHelper` (from the `./PhotoshopHelper` directory)
   ```bash
   cd PhotoshopHelper
   npm start
   ```
3. Helper will launch as a background application (tray icon)
4. The **Copy**, **Paste**, **Drag & Drop**, and **Send to WebHelper** functions will now work correctly


## 📁 Project Structure

```
├── manifest.json                         # Plugin configuration (Adobe UXP)
├── index.html                            # Main plugin panel interface (HTML)
├── index.js                              # Main JS logic and plugin initialization
├── styles.css                            # Panel styling
├── icons/                                # Plugin icons in all sizes
├── modules/                              # Functional JavaScript modules
│   ├── agent-capture.js                  # Imaging API visual feedback for agents (previews, viewport crops)
│   ├── agent-document.js                 # Working document lifecycle and context resolution for agent tasks
│   ├── agent-line.js                     # Bottom status line UI and connection controller for agent tasks
│   ├── batchplay-watch.js                # batchPlay execution wrapper capturing silent descriptor errors
│   ├── command-handlers.js               # Execution handlers for agent tool commands inside Photoshop
│   ├── error-text.js                     # Error formatting utility normalizing Photoshop and script errors
│   ├── fs.js                             # File and Base64 module (UXP File Access)
│   ├── helper.js                         # API client for network communication with PhotoshopHelper
│   ├── image-size.js                     # Reads real pixel size from PNG/JPEG headers (Place scaling correction)
│   ├── image-utils.js                    # Image processing utilities (crop, masks, resize)
│   ├── ps.js                             # Core Photoshop API module (Inpaint, Capture, Layers)
│   ├── settings.js                       # Settings management and UI rendering
│   ├── ui.js                             # Button and input state management
│   └── ws-bridge.js                      # WebSocket bridge client connecting plugin to PhotoshopHelper
└── PhotoshopHelper/                      # Companion Electron application (UXP sandbox bypass)
    ├── package.json                      # Dependency manifest (Electron, Express, electron-store)
    ├── main.js                           # Main process: HTTP/REST API implementation, system tray, and agent service
    ├── auth.js                           # Shared token generation, timing-safe comparison, and access-control middleware
    ├── plugin-pairing.js                 # Delivers the plugin token into the Photoshop plugin's UXP data folder for automatic pairing
    ├── preload.js                        # Context bridge for secure inter-process communication
    ├── providers.template.json           # Shared provider catalog source (development)
    ├── providers.user.json               # User provider overlay: additions, replacements, and disabled shared models
    ├── providers-catalog.js              # Provider catalog loader, validator, and overlay merger (shared + user models)
    ├── providers-discovery.js            # Provider catalog discovery and filtering based on active API keys
    ├── providers-updater.js              # Background updater for the shared provider catalog from GitHub
    ├── kb-updater.js                     # Background updater for the shared knowledge base from GitHub
    ├── .env.template                     # Template for environment variables
    ├── Prompt_Providers_Configuration.md # LLM prompt for generating new provider configurations
    ├── Providers_Configuration_Guide.md  # Detailed guide for configuring providers and APIs
    ├── README.md                         # PhotoshopHelper documentation and technical overview
    ├── donation-manager.js               # Manages usage tracking and donation prompts
    ├── auto-start.js                     # Cross-platform login item and startup configuration manager (Windows / macOS)
    ├── updater.js                        # Update service: GitHub release checks, tray notifications, and version sync
    ├── drag-window.html                  # Overlay window for the Drag & Drop files-to-browser feature
    ├── drag-window.js                    # File capture and drag logic
    ├── apiGenerator.js                   # Generation core: context assembly and request templating
    ├── templateEngine.js                 # Shared placeholder resolver and conditional-key expression parser
    ├── localGenerationApi.js             # Direct asynchronous local REST API adapter
    ├── apiGeneratorResultsGetter.js      # Results module: polling and response parsing
    ├── apiGeneratorPreprocessors.js      # Preprocessors: resizing, MP optimization, and filtering
    ├── imageUtils.js                     # Image processing utilities (MIME, Base64, NativeImage)
    ├── atomic-write.js                   # Atomic file replacement utility (safe temporary-file write and rename)
    ├── llm-engine.js                     # Direct LLM adapter supporting API mode and CLI execution mode
    ├── mcp-server.js                     # Model Context Protocol (MCP) Streamable HTTP/JSON-RPC server endpoint
    ├── ws-bridge.js                      # WebSocket server bridge managing command channel with Photoshop plugin
    ├── webhelper-storage.js              # Temp root layout and URL resolution for WebHelper tasks and generated files
    ├── Local_Generation_API.md           # Complete local API schema and integration examples
    ├── tray-icon.png                     # Application icon for the system tray
    ├── user-settings.js                  # Persistent settings manager using electron-store
    ├── user-settings.json                # Runtime configuration state file (dev mode only, excluded from build)
    ├── agent/                            # AI agent subsystem (MCP server, CLI runner, and UI)
    │   ├── index.js                      # Agent service entry point (MCP tools, WS bridge, session coordinator)
    │   ├── agent-api.js                  # Plugin REST API router (task state, abort, assist window trigger)
    │   ├── task-session.js               # Document-bound task session coordinator and timeout tracking
    │   ├── mcp-setup.js                  # MCP registration commands and setup text for agents
    │   ├── mcp-tools.js                  # Core Photoshop document MCP tools (ps_* commands)
    │   ├── combine-tools.js              # Aggregates document (ps_*) and generation (gen_*) tool layers
    │   ├── gen-tools.js                  # MCP tools for image generation (gen_* commands)
    │   ├── journal.js                    # Diagnostic logger for MCP tool calls and results
    │   ├── knowledge-base.js             # Knowledge base loader, search index, and article provider for MCP tools
    │   ├── reduce-image.js               # Reduced copies of images for the agent to look at
    │   ├── cli-service.js                # Core CLI agent service, discovery, and tier execution (Light/Medium/High)
    │   ├── cli-runner.js                 # Subprocess manager for spawning and controlling external CLI agents
    │   ├── cli-prompts.js                # Standardized system prompts and model querying templates for CLI agents
    │   ├── cli-transcript.js             # Output parser converting varied CLI streams into human-readable transcripts
    │   ├── cli-image-provider.js         # Virtual WebHelper image provider adapter backed by local CLI agents
    │   ├── cli-window.js                 # External console window for live CLI agent output streaming
    │   ├── cli-models-cache.js           # Cache storage manager for CLI models and capabilities
    │   ├── cli-models-window.html        # Markup for the CLI models catalog window
    │   ├── cli-models-window.js          # Window controller for CLI models catalog
    │   ├── cli-models-preload.js         # Secure IPC bridge for the CLI models window
    │   ├── cli-models-renderer.js        # UI logic and renderer for CLI models catalog window
    │   ├── cli-settings-window.html      # Markup for the CLI settings window
    │   ├── cli-settings-window.js        # Window controller for CLI settings
    │   ├── cli-settings-preload.js       # Secure IPC bridge for the CLI settings window
    │   ├── cli-settings-renderer.js      # UI logic and renderer for CLI settings window
    │   ├── assist-window.html            # Markup for the AI Assist floating status window
    │   ├── assist-window.js              # Electron window manager for the AI Assist window
    │   ├── assist-window-preload.js      # Secure IPC bridge for the AI Assist window
    │   └── assist-window-renderer.js     # Live status and task step renderer for AI Assist window
    ├── knowledge-base/                   # Author knowledge base for the agent (downloaded by installed Helpers from main)
    │   ├── rules.md                      # Rules handed to the agent at ps_start_task
    │   └── articles/                     # One verified recipe per article
    ├── setup/                            # Initial configuration and setup wizard
    │   ├── config-paths.js               # Logic for locating configuration files
    │   ├── first-run-wizard.html         # First run configuration UI
    │   ├── first-run.js                  # Setup wizard logic and directory creation
    │   ├── wizard-preload.js             # Secure bridge for the setup wizard
    │   ├── license-activation.html       # License activation UI
    │   ├── license-activation.js         # License activation logic
    │   └── license-activation-preload.js # Secure bridge for license activation window
    └── webhelper/                        # Local web application directory for generation
        ├── index.html                    # Current UI at http://localhost:18345/webhelper
        ├── v0/                           # Previous UI at http://localhost:18345/webhelper/v0
        ├── assets/                       # UI assets and graphics
        ├── js/                           # Web application scripts and provider handlers
        └── app.css                       # Web application styling
```

## 🔧 Development

### Debugging
1. In UXP Developer Tools, click "Debug" on the plugin
2. Chrome DevTools will open for debugging
3. Logs are output to the Console

### Reloading
- UXP Developer Tools → click the "Reload" button on the plugin
- Or press Ctrl+R in the debug window

### Running PhotoshopHelper locally

```powershell
cd PhotoshopHelper
npm install
npm start
```

The Electron Helper should expose `GET http://127.0.0.1:18345/api/status` after startup —
this route stays open without a token so a client can check the server before pairing.
Every other route requires either the plugin token, a same-origin WebHelper request, or
the separate Local API token; see `SECURITY.md` for the full access model.
If `npm start` fails with `TypeError: Cannot read properties of undefined (reading
'isPackaged')`, check whether the shell inherited `ELECTRON_RUN_AS_NODE=1`. Remove it
only for the Helper process, without changing the system environment:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm start
```

### Local Generation API workflow

The Local API accepts one self-contained asynchronous generation request. It does not
create task resources or add entries to the Photoshop/WebHelper task registry:

```text
POST /api/local/v1/generations
    -> 202 { generationId, statusUrl, status: "queued" }

GET /api/local/v1/generations/:generationId
    -> poll until status is "completed" or "failed"
```

`POST /api/local/v1/generations` accepts either `providerId` (a catalog id from
the active merged provider catalog) or a complete inline `provider` object — not both —
plus optional absolute `sourceImagePath`/`maskImagePath`, `referenceImagePaths`,
`params`, `num_images`, `aspect_ratio`, `use_mask`, and `force_separate_requests`.
`aspect_ratio` is required when the effective request is text-to-image and optional
for image-to-image. Supplied paths must identify readable regular files; they are
read directly and are not copied. A `providerId` request must send parameters
compatible with that catalog entry; an inline `provider` is not looked up in
discovery.

Every provider explicitly declares a non-empty `generation_modes` array. The current
runtime implements only `t2i` and `i2i`; video, SVG, and other modality names are
possible future extensions only and are rejected by the present generator.

If source is omitted, the generation core promotes the first reference to source. If
there are no effective image inputs, the generic request is text-to-image and the Local
API rejects it unless it includes a non-empty `aspect_ratio`. An active mask without
source requires a first reference with exactly matching pixel dimensions.

Poll `statusUrl` every 1–2 seconds. A completed response contains `outputPaths` with
absolute paths under `%TEMP%\ps_webhelper_tasks`; a failed response contains `error`.
Each generation is independent, so one failure cannot affect another request.

For the full request and response schema, authentication, and PowerShell examples, see
`PhotoshopHelper/Local_Generation_API.md`.

### MCP server and agent workflow

The MCP server is a single route, `POST /mcp`, on the main Helper server
(`PhotoshopHelper/mcp-server.js`). It speaks Streamable HTTP with JSON-RPC 2.0 and
requires the Local API token as `Authorization: Bearer <token>` or `X-API-Key`. A quick
manual check from PowerShell:

```powershell
$headers = @{ Authorization = "Bearer $env:PHOTOSHOP_HELPER_LOCAL_API_TOKEN" }
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:18345/mcp' -Headers $headers `
    -ContentType 'application/json' -Body $body
```

The tool list is built from two layers merged by `agent/combine-tools.js`:

- `agent/mcp-tools.js` — document tools (`ps_`, `from_ps_`, `to_ps_`) and the knowledge
  base tools (`ps_kb_`). Every call except `ps_start_task` requires the task id it
  returns; a document tool is sent to the plugin over the WebSocket channel
  (`ws-bridge.js` in Helper, `modules/ws-bridge.js` and `modules/command-handlers.js`
  in the plugin) and fails with a readable message when the **FromPS / ToPS AI** line is
  off.
- `agent/gen-tools.js` — generation tools (`gen_`) over the same generation service as
  the Local Generation API. They point the agent at `Local_Generation_API.md` in the
  resources folder, so section titles in that file are part of the contract.

MCP tool names are prefixed by area: everything that works with Photoshop starts with
`ps_` (or `from_ps_` / `to_ps_`), everything that generates images starts with `gen_`.
Keep that rule for new tools.

The plugin channel listens on `ws://127.0.0.1:18346` and accepts a socket only after it
presents the plugin token. It is opened by the plugin, never by Helper, and only while
the line is on.

Development runs (`npm start`) differ from installed builds in where agent data lives:

- the knowledge base is read directly from `PhotoshopHelper/knowledge-base/` instead of
  the copy downloaded from GitHub, so article edits are picked up without a download;
- the journal of MCP calls (`agent-journal/`) is always written; in installed builds it
  is off by default;
- articles written by agents go to `knowledge-base.user/`, and CLI model lists are cached
  in `cli-models-cache/`.

`agent-journal/`, `knowledge-base.user/`, and `cli-models-cache/` are runtime data and
are listed in `.gitignore`.

### CLI integration

`agent/cli-service.js` detects installed CLIs (`claude`, `codex`, `grok`, `agy`) on
`PATH`, reads the per-CLI settings saved by the **AI CLI Settings** window, and runs a
prompt with the Light, Medium, or High model chosen for that CLI. `agent/cli-runner.js`
builds each CLI's command line and parses its output; CLI vendors change their options
between versions, so this file is where a broken CLI update is usually fixed.

The WebHelper CLI provider (`agent/cli-image-provider.js`) is built in memory and is
never written to a provider catalog. `apiGenerator.js` calls it through a private route,
`POST /api/internal/cli-image/generate`, protected by a per-process secret, exactly as
it would call a remote image API. It always uses the Medium tier and works in
`%TEMP%\ps_webhelper_tasks\_WH_CliScratch`.

A CLI run spends the person's subscription allowance and can take several minutes.
Use a cheap model for smoke tests.

### Tests

```powershell
cd PhotoshopHelper
npm test
```

`npm test` runs every suite in `PhotoshopHelper/_tests_/` with the Node test runner.
None of them starts Photoshop, a real CLI, or a paid provider.

Suites that cover the MCP server and the agent: `mcpServer`, `agentTools`, `genTools`,
`agentService`, `agentTaskSession`, `agentKnowledgeBase`, `kbUpdater`, `wsBridge`,
`batchPlayWatch`, `agentLineSource`. Suites that cover the CLI integration:
`agentCliRunner`, `cliImageProvider`, `cliModelsCache`, `cliTranscript`.

`_tests_/localGenerationApi.test.js` starts an isolated Express server with a mocked
generator. It validates direct generation inputs, polling states, absolute-path
validation, mandatory token protection, and error isolation; it does not contact external
providers and does not create permanent files in `%TEMP%\ps_webhelper_tasks`.
`_tests_/auth.test.js` covers the shared authentication and same-origin CORS middleware
(`PhotoshopHelper/auth.js`) directly, independent of any router.

To verify a provider integration manually, start Helper, submit one generation, and poll
its `statusUrl`. This makes a real provider request and may incur provider charges. Use
a low-cost provider/model and one output image for smoke tests.

### Template Engine

`PhotoshopHelper/templateEngine.js` is the shared resolver for provider request
templates, preprocessor arguments, filenames, and display names. In addition to the
legacy `{{placeholder}}`, `{{?variable}}key`, and `{{?!variable}}key` forms, it parses
the documented conditional expressions (`!`, `==`, `!=`, `&&`, `||`, and parentheses)
without evaluating arbitrary JavaScript. Parser details and configuration examples
are documented in `PhotoshopHelper/Providers_Configuration_Guide.md` under
**Conditional Expressions**.

### Preparing to release a new version

1. Prepare a new version for the Photoshop plugin (if needed):
   1. Update the version number in `manifest.json` and update `ps-plugin-version` in `PhotoshopHelper/package.json` to match it.
   2. Run `prepare-package-ccx.bat` (it copies all needed files to the `_PluginToCCX` directory).
   3. Open Adobe UXP Developer Tools, load the plugin from the `_PluginToCCX` directory, and select "Package..." to build the CCX.
   4. Rename the generated package to `plugin.ccx` and move it to the root of the workspace.
2. Revalidate `PhotoshopHelper/providers.template.json` and review `PhotoshopHelper/knowledge-base/`. Installed Helpers download both from the `main` branch, so whatever is merged into `main` reaches every installed copy, including older Helper versions, without waiting for the installer.
3. Update the version number in `PhotoshopHelper/package.json`.
4. Update the changelog and documentation:
   1. Add release information and a summary of changes to `CHANGELOG.md`.
   2. Review and update all relevant `.md` files (such as `README.md`, `DEVELOPMENT.md`, `SECURITY.md`, `PRIVACY.md`, `SUPPORT.md`, `CONTRIBUTING.md`, `PhotoshopHelper/README.md`, `PhotoshopHelper/Providers_Configuration_Guide.md`, `PhotoshopHelper/Local_Generation_API.md`) if new features, configurations, or changes require updates. `Local_Generation_API.md` and `Providers_Configuration_Guide.md` ship with the installer and are read by agents through the `gen_` tools.
   3. Review and update the two GitHub Pages in the `docs` folder (`docs/index.html` and `docs/manual/index.html`) if UI features, user guides, or manual instructions need adjustments.
5. Build the application installer using one of the following methods:
   - **Method A: Local Build (Windows only)**
     1. Run `npm run dist:win` in PowerShell with admin rights.
     2. The installer will be created in the `PhotoshopHelper/dist` folder as `PhotoshopHelper Setup [version].exe`.
   - **Method B: GitHub Actions Build (Auto-Update via GitHub Releases)**
     1. Commit and push your changes to the repository.
     2. Go to the **Actions** tab on GitHub, select the **Build App Binaries** workflow, click "Run workflow" and enter the new version number.
     3. Once the workflow completes, go to the **Releases** section on your GitHub repository page.
     4. You will find a new **Draft** release created automatically (containing the installers and `latest.yml` files). 
     5. Edit the draft, add any release notes (you can use the AI assistant's `/generate-release-notes` skill to generate them), and click **Publish release**. As soon as it's published, the auto-updater in the app will detect the new version.
6. Post-release (Update GitHub Pages):
   1. Update `APP_VERSION` at the top of `docs/script.js` to match the newly published version so the GitHub Pages download links and displayed version point to the live release.
   2. Commit and push the changes to update GitHub Pages.

## 📜 License

This project is licensed under the CC BY-NC-SA 4.0 License.
