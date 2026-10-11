# 🧩 Photoshop Helper

**Photoshop Helper** is a specialized Electron application that acts as a bridge between Adobe Photoshop (UXP) and the operating system. It works around the security restrictions of the UXP platform to provide full clipboard support, Drag & Drop functionality, a powerful UI for AI-driven image generation via cloud services or local AI CLIs, and an MCP server for AI agents working in Photoshop.

---

## 🎯 Key Features

- **Clipboard Harmony:** Copy and paste full PNG images (UXP natively supports text only).
- **Pro Drag & Drop:** Drag a single file or a group of files from Photoshop directly into a browser or file explorer.
- **WebHelper UI:** A local SPA (`http://localhost:18345/webhelper`) for working with neural networks (Grok, FLUX, Seedream, Civitai).
- **CLI Generation:** Native image generation through an AI CLI already installed and signed in on the machine (OpenAI Codex, SpaceXAI Grok, Google Antigravity), on the person's own subscription and without an image API key. Configured in **AI CLI Settings...** in the tray menu.
- **AI Agent for Photoshop (MCP):** An MCP server at `http://127.0.0.1:18345/mcp` that lets the AI agent the person already uses read and change the open Photoshop document and generate images through the configured providers. Any agent application on this computer that supports MCP servers works — a terminal CLI, a desktop app, or an IDE extension (Claude Code, Codex, Grok, Antigravity, and others).

---

## 🚀 Quick Start

### 1. Installation
```bash
cd PhotoshopHelper
npm install
```

### 2. Configuration
Create a `.env` file in the project root based on the example below:
```env
# Local keys (all are optional; the recommended minimum is FAL_API_KEY only)
SPACEXAI_API_KEY=
FAL_API_KEY=
REPLICATE_API_KEY=
BFL_API_KEY=
OPENAI_API_KEY=
CIVITAI_API_KEY=

# Standard key injection via environment variables is also supported.

# Local server authentication (optional — see "Access control" below).
PHOTOSHOP_HELPER_LOCAL_API_TOKEN=
WEBHELPER_ACCESS_PASSWORD=

# AI agent (optional): minutes without a task before the plugin's
# "FromPS / ToPS AI" line closes itself. Default: 60.
PHOTOSHOP_HELPER_AGENT_LINE_IDLE_MINUTES=
```

CLI generation and the AI agent need no `.env` entries: the CLIs are chosen and their
models selected in **AI CLI Settings...** in the tray menu, and the agent is connected from
**AI Agent for Photoshop → AI Assist...**.

### 3. Run
```bash
npm start
```
The application will minimize to the system tray. The server will be available at `http://localhost:18345`.

---

## 📡 API Reference

Every route below is marked with the access level it requires. See
[SECURITY.md](../SECURITY.md#local-http-server-access-control) for what each level means
and how the tokens are delivered — in short, the plugin is paired automatically and
WebHelper works from its own page without any setup.

- 🔓 **Open** — no credential required.
- 🔌 **Plugin token** — the dedicated secret paired into the Photoshop plugin.
- 🌐 **WebHelper** — same-origin browser request, or the plugin token.
- 🔑 **Local API token** — the `PHOTOSHOP_HELPER_LOCAL_API_TOKEN` secret.

### 🛠 Core & System
- 🔓 `GET /api/status` — Check server status, version, and retrieve update alerts.
  * Query parameters (optional):
    * `pluginVersion`: The version of the Photoshop UXP plugin.
  * Response details:
    * Returns an `alerts` object with platform-specific instructions if action is needed (e.g., plugin version mismatch, or Helper update is downloaded/ready).
- 🔓 `GET /api/is-local` — Detect local vs. remote access and device type (mobile/desktop).

### 📋 Clipboard
- 🔌 `POST /api/clipboard/copy` — Copy a base64-encoded image to the system clipboard.
- 🔌 `GET /api/clipboard/paste` — Retrieve the current clipboard image as base64.

### 🖱 Drag & Drop
- 🌐 `POST /api/drag/start` — Initiate a drag operation. Creates a floating preview window. Same-origin WebHelper may call this only when the request is local (not via a tunnel); otherwise the plugin token is required.
  - Accepts `image` (single file) or `images` (array).

### 💾 File System
- 🔌 `POST /api/file/save` — Save an image to disk with automatic filename conflict resolution (`image_1.png`, `image_2.png`). Accepts any absolute destination path, so it is restricted to the plugin token rather than to a fixed directory. Currently disabled (`403`, `FEATURE_DISABLED`) in packaged builds; in development it stays off unless the source flag is flipped.

### 🌐 WebHelper (AI API)
- 🌐 `GET /webhelper` — Entry point for the web UI (SPA).
- 🌐 `GET /api/webhelper/providers` — List of available models (Grok, FAL, FLUX, Civitai, and the CLI provider when one is configured) and their parameters. This one read-only route also accepts the 🔑 Local API token, because Local API and MCP clients use it for provider discovery.
- 🌐 `POST /api/webhelper/task` — Create a new task (upload Source + Mask from Photoshop).
- 🌐 `POST /api/webhelper/task/from-file` — **Iterative workflow**: create a new task from an existing generation result.
- 🌐 `GET /api/webhelper/queue` — Queue of new tasks (polled by the UI).
- 🌐 `POST /api/webhelper/mark_opened` — Mark tasks as accepted by the UI (clears the queue).
- 🌐 `GET /api/webhelper/task/:taskId` — Detailed task metadata and results.
- 🌐 `GET /api/webhelper/file/tasks/:filename` and `GET /api/webhelper/file/generated/:filename` — Access task images and generated images.
- 🌐 `POST /api/webhelper/generate` — Start the generation process via the selected AI provider.
- 🌐 `POST /api/webhelper/file/copy2clipboard` — Copy any file from the working directory to the clipboard at full resolution.

### Local Generation Service

- 🔑 `POST /api/local/v1/generations` — Start one self-contained asynchronous generation from optional source/mask paths, reference paths, and provider parameters.
- 🔑 `GET /api/local/v1/generations/:generationId` — Return one generation's state and absolute output paths.
- See [Local_Generation_API.md](Local_Generation_API.md) for the complete request schema, polling flow, authentication, and examples.

### 🤖 AI Agent (MCP)
- 🔑 `POST /mcp` — MCP server (Streamable HTTP, JSON-RPC 2.0) for AI agents. Publishes the document tools (`ps_`, `from_ps_`, `to_ps_`), the knowledge base tools (`ps_kb_`), and the generation tools (`gen_`). Registered in an agent under the name `photoshop-helper`.
- 🔌 `GET /api/agent/state` — Connection and task state shown by the plugin's FromPS / ToPS AI line.
- 🔌 `POST /api/agent/stop` — Close the active agent task.
- 🔌 `GET /api/agent/mcp-setup` — Registration commands for Claude Code, Codex, Grok, and Antigravity, plus a text any agent can follow to register the server itself.
- 🔌 `POST /api/agent/mcp-setup/install` — Run the registration command for one of those four agents (`{ "cli": "claude" | "codex" | "grok" | "agy" }`).
- 🔌 `POST /api/agent/open-window` — Bring the AI Assist window to the front.
- 🔌 `ws://127.0.0.1:18346` — Command channel to the plugin. The plugin opens it only while its FromPS / ToPS AI line is on and must present the plugin token in its first message.

### 🔒 Internal
- `POST /api/internal/cli-image/generate` — Private route the generator uses to run the CLI provider. It accepts only a per-process secret that never leaves Helper and is not part of the public API.

---

## 📁 Project Structure

```text
PhotoshopHelper/
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
├── webhelper/                        # Frontend application (SPA)
│   ├── index.html                    # Current generator UI (`/webhelper`)
│   ├── app.css                       # Web application styling
│   ├── assets/                       # UI assets and graphics
│   ├── js/                           # Web application scripts and provider handlers
│   └── v0/                           # Previous Spectre UI (`/webhelper/v0`)
├── package.json                      # Dependencies (Electron, Express, electron-store)
├── main.js                           # Main process: HTTP/REST API, system tray, and agent service
├── auth.js                           # Shared token generation, timing-safe comparison, and access-control middleware
├── plugin-pairing.js                 # Delivers the plugin token into the Photoshop plugin's UXP data folder
├── preload.js                        # Context bridge for secure inter-process communication
├── providers.template.json           # Shared provider catalog source (development)
├── providers.user.json               # User provider overlay: additions, replacements, and disabled shared models
├── providers-catalog.js              # Provider catalog loader, validator, and overlay merger (shared + user models)
├── providers-discovery.js            # Provider catalog discovery and filtering based on active API keys
├── providers-updater.js              # Background updater for the shared provider catalog from GitHub
├── kb-updater.js                     # Background updater for the shared knowledge base from GitHub
├── Prompt_Providers_Configuration.md # LLM prompt for generating new provider configurations
├── Providers_Configuration_Guide.md  # Detailed guide for provider and API configuration
├── Local_Generation_API.md           # File-path-based localhost automation API guide
├── donation-manager.js               # Manages usage tracking and donation prompts
├── auto-start.js                     # Cross-platform login item and startup configuration manager (Windows / macOS)
├── updater.js                        # Update service: GitHub release checks, tray notifications, and version sync
├── drag-window.html                  # Overlay window for Drag & Drop to browser
├── drag-window.js                    # File capture and drag-and-drop logic
├── apiGenerator.js                   # Generation core: context assembly and request templating
├── templateEngine.js                 # Shared placeholder resolver and conditional-key expression parser
├── localGenerationApi.js             # Asynchronous local service-to-service API adapter
├── apiGeneratorResultsGetter.js      # Results module: polling and response parsing
├── apiGeneratorPreprocessors.js      # Preprocessors: resizing, MP optimization, and filtering
├── imageUtils.js                     # Image processing utilities (MIME, Base64, NativeImage)
├── atomic-write.js                   # Atomic file replacement utility (safe temporary-file write and rename)
├── llm-engine.js                     # Direct LLM adapter supporting API mode and CLI execution mode
├── mcp-server.js                     # Model Context Protocol (MCP) Streamable HTTP/JSON-RPC server endpoint
├── ws-bridge.js                      # WebSocket server bridge managing command channel with Photoshop plugin
├── webhelper-storage.js              # Temp root layout and URL resolution for WebHelper tasks and generated files
├── tray-icon.png                     # Application icon for the system tray
├── user-settings.js                  # Persistent settings manager using electron-store
├── user-settings.json                # Runtime configuration state file (dev mode only, excluded from build)
└── .env.template                     # Template for secrets and environment settings
```

---

## 🔧 Technical Details

- **Security:** The application is designed for local and personal use. **Important: it is not intended for public deployment.** Its local HTTP server requires a paired token or a same-origin browser request on every route except the health check — see [SECURITY.md](../SECURITY.md#local-http-server-access-control) for the full model. An environment detection system (`/api/is-local`) is implemented, allowing the UI to adapt when accessed via temporary tunnels (ngrok, cloudflared, etc.).
- **Temp Management:** Session files are stored in `%TEMP%\ps_webhelper_tasks`. Task uploads live in `_WH_Tasks`, generated images and their JSON sidecars live in `_WH_Generated`, CLI working files live in `_WH_CliScratch`, and captures the agent saves to files live in `_Agent_Captures`. Files older than 30 days are removed from every subdirectory.
- **High-Res Copy:** When copying from WebHelper, NativeImage is used to guarantee the original resolution is preserved without browser-side compression.
- **Template Engine:** `templateEngine.js` resolves provider placeholders and parses
  safe conditional object keys such as `{{?source_image && model == 'model/edit'}}endpoint_url`.
  It contains no arbitrary JavaScript evaluation; the complete expression grammar is
  documented in `Providers_Configuration_Guide.md`.
- **CLI Runs:** CLI generation runs only a CLI that is installed on `PATH` and ticked as
  **Enabled** in **AI CLI Settings...**, with the model chosen there for its Medium tier.
  Runs are non-interactive, so approval prompts are switched off on the command line (see
  [SECURITY.md](../SECURITY.md#ai-agents-and-command-line-tools)). Model lists fetched
  through **Refresh via CLI** are cached for 14 days in `cli-models-cache` in the data folder.
- **Agent Channel:** Document tools reach Photoshop over the WebSocket channel on port
  `18346`. The plugin opens it only when the person turns on **FromPS / ToPS AI...** in the
  panel menu, and it closes itself after an hour without tasks
  (`PHOTOSHOP_HELPER_AGENT_LINE_IDLE_MINUTES`). Turning the line off pauses a task rather
  than cancelling it.
- **Knowledge Base:** The author's rules and articles in `knowledge-base/` are downloaded
  from the repository's `main` branch at startup and on the update schedule (tray:
  **AI Agent for Photoshop → Check for Knowledge Base Updates**), like the provider catalog.
  Articles and marks written by agents are kept separately in `knowledge-base.user` in the
  data folder and are never uploaded. Development runs read the project folder directly.

---

## 🔗 UXP Integration

To communicate with the helper from your plugin, use the standard `fetch` API.
**Important:** Your plugin's `manifest.json` must grant access to the following domains:
```json
"requiredPermissions": {
  "network": { "domains": "all" }
}
```

The plugin-only routes (clipboard, drag, file save, `/api/agent/*`) require the Helper's
plugin token on every request, sent as an `X-API-Key` header. The agent channel on
`ws://127.0.0.1:18346` uses the same token in its first (`hello`) message. Pairing is automatic: on startup, the Helper
writes the token into the plugin's private UXP data folder (`getDataFolder()`), which the
plugin reads without any user interaction. If a plugin installation is not found by that
scan — an unusual install location, or a change to Adobe's storage layout — copy the token
from the tray menu (**Access Tokens → Copy Plugin Pairing Token**) into the plugin's own
Settings dialog as a one-time manual fallback.

---

## 📝 License

This project is licensed under the CC BY-NC-SA 4.0 License.
