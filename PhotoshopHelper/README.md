# 🧩 Photoshop Helper

**Photoshop Helper** is a specialized Electron application that acts as a bridge between Adobe Photoshop (UXP) and the operating system. It works around the security restrictions of the UXP platform to provide full clipboard support, Drag & Drop functionality, and a powerful UI for AI-driven image generation via cloud services.

---

## 🎯 Key Features

- **Clipboard Harmony:** Copy and paste full PNG images (UXP natively supports text only).
- **Pro Drag & Drop:** Drag a single file or a group of files from Photoshop directly into a browser or file explorer.
- **WebHelper UI:** A local SPA (`http://localhost:18345/webhelper`) for working with neural networks (Grok, FLUX, Seedream).
- **Nebula Integration:** Dynamic API key injection via the Nebula Broker.

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
XAI_API_KEY=
FAL_API_KEY=
REPLICATE_API_KEY=
BFL_API_KEY=
OPENAI_API_KEY=

# Nebula integration (recommended for security).
# Defines the mapping between .env keys and Nebula (i.e., your personal GSM — Google Secret Manager).
NEBULA_CS=XAI_API_KEY=XAI_API_KEY,FAL_API_KEY=FAL_API_KEY...
# To disable Nebula, simply comment out the NEBULA_CS= line.

# Standard key injection via environment variables is also supported.

# Local server authentication (optional — see "Access control" below).
PHOTOSHOP_HELPER_LOCAL_API_TOKEN=
WEBHELPER_ACCESS_PASSWORD=
```

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
- 🌐 `GET /api/webhelper/providers` — List of available models (Grok, FAL, FLUX) and their parameters.
- 🌐 `POST /api/webhelper/task` — Create a new task (upload Source + Mask from Photoshop).
- 🌐 `POST /api/webhelper/task/from-file` — **Iterative workflow**: create a new task from an existing generation result.
- 🌐 `GET /api/webhelper/queue` — Queue of new tasks (polled by the UI).
- 🌐 `POST /api/webhelper/mark_opened` — Mark tasks as accepted by the UI (clears the queue).
- 🌐 `GET /api/webhelper/task/:taskId` — Detailed task metadata and results.
- 🌐 `GET /api/webhelper/file/:filename` — Access temporary images (sources, masks, generations).
- 🌐 `POST /api/webhelper/generate` — Start the generation process via the selected AI provider.
- 🌐 `POST /api/webhelper/file/copy2clipboard` — Copy any file from the working directory to the clipboard at full resolution.

### Local Generation Service

- 🔑 `POST /api/local/v1/generations` — Start one self-contained asynchronous generation from optional source/mask paths, reference paths, and provider parameters.
- 🔑 `GET /api/local/v1/generations/:generationId` — Return one generation's state and absolute output paths.
- See [Local_Generation_API.md](Local_Generation_API.md) for the complete request schema, polling flow, authentication, and examples.

---

## 📁 Project Structure

```text
PhotoshopHelper/
├── webhelper/                        # Frontend application (SPA)
│   ├── index.html                    # Current generator UI (`/webhelper`)
│   ├── app.css
│   ├── js/
│   └── v0/                           # Previous Spectre UI (`/webhelper/v0`)
├── setup/                            # Initial configuration and setup wizard
│   ├── config-paths.js               # Logic for locating configuration files
│   ├── first-run-wizard.html         # First run configuration UI
│   ├── first-run.js                  # Setup wizard logic and directory creation
│   ├── wizard-preload.js             # Secure bridge for the setup wizard
│   ├── license-activation.html       # License activation UI
│   ├── license-activation.js         # License activation logic
│   └── license-activation-preload.js # Secure bridge for license activation window
├── package.json                      # Dependencies (Electron, Express, Sharp)
├── main.js                           # Main process: HTTP/REST API and system tray
├── auth.js                           # Shared token generation, timing-safe comparison, and access-control middleware
├── plugin-pairing.js                 # Delivers the plugin token into the Photoshop plugin's UXP data folder
├── preload.js                        # Context bridge for secure inter-process communication
├── providers.template.json           # Template for AI provider parameter configuration
├── providers.json                    # Configuration for AI providers and parameters
├── Prompt_Providers_Configuration.md # LLM prompt for generating new provider configurations
├── Providers_Configuration_Guide.md  # Detailed guide for provider and API configuration
├── Local_Generation_API.md           # File-path-based localhost automation API guide
├── donation-manager.js               # Manages usage tracking and donation prompts
├── drag-window.html                  # Overlay window for Drag & Drop to browser
├── drag-window.js                    # File capture and drag-and-drop logic
├── apiGenerator.js                   # Generation core: context assembly and request templating
├── templateEngine.js                 # Shared placeholder resolver and conditional-key expression parser
├── localGenerationApi.js             # Asynchronous local service-to-service API adapter
├── apiGeneratorResultsGetter.js      # Results module: polling and response parsing
├── apiGeneratorPreprocessors.js      # Preprocessors: resizing, MP optimization, and filtering
├── imageUtils.js                     # Image processing utilities (MIME, Base64, NativeImage)
├── tray-icon.png                     # Application icon for the system tray
├── user-settings.js                  # Persistent settings manager using electron-store
├── user-settings.json                # Runtime configuration state file (dev mode only, excluded from build)
└── .env.template                     # Template for secrets and environment settings
```

---

## 🔧 Technical Details

- **Security:** The application is designed for local and personal use. **Important: it is not intended for public deployment.** Its local HTTP server requires a paired token or a same-origin browser request on every route except the health check — see [SECURITY.md](../SECURITY.md#local-http-server-access-control) for the full model. An environment detection system (`/api/is-local`) is implemented, allowing the UI to adapt when accessed via temporary tunnels (ngrok, cloudflared, etc.).
- **Temp Management:** Session files are stored in `%TEMP%\ps_webhelper_tasks`. Files older than 30 days are cleaned up automatically.
- **Nebula Secrets:** When `NEBULA_CS` is set, the application automatically calls `nebulabroker emit` to inject keys from your personal GSM (Google Secret Manager) into `process.env`.
- **High-Res Copy:** When copying from WebHelper, NativeImage is used to guarantee the original resolution is preserved without browser-side compression.
- **Template Engine:** `templateEngine.js` resolves provider placeholders and parses
  safe conditional object keys such as `{{?source_image && model == 'model/edit'}}endpoint_url`.
  It contains no arbitrary JavaScript evaluation; the complete expression grammar is
  documented in `Providers_Configuration_Guide.md`.

---

## 🔗 UXP Integration

To communicate with the helper from your plugin, use the standard `fetch` API.
**Important:** Your plugin's `manifest.json` must grant access to the following domains:
```json
"requiredPermissions": {
  "network": { "domains": "all" }
}
```

The plugin-only routes (clipboard, drag, file save) require the Helper's plugin token on
every request, sent as an `X-API-Key` header. Pairing is automatic: on startup, the Helper
writes the token into the plugin's private UXP data folder (`getDataFolder()`), which the
plugin reads without any user interaction. If a plugin installation is not found by that
scan — an unusual install location, or a change to Adobe's storage layout — copy the token
from the tray menu (**Access Tokens → Copy Plugin Pairing Token**) into the plugin's own
Settings dialog as a one-time manual fallback.

---

## 📝 License

This project is licensed under the CC BY-NC-SA 4.0 License.
