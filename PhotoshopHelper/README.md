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

# Nebula integration (recommended for security).
# Defines the mapping between .env keys and Nebula (i.e., your personal GSM — Google Secret Manager).
NEBULA_CS=XAI_API_KEY=XAI_API_KEY,FAL_API_KEY=FAL_API_KEY...
# To disable Nebula, simply comment out the NEBULA_CS= line.

# Standard key injection via environment variables is also supported.
```

### 3. Run
```bash
npm start
```
The application will minimize to the system tray. The server will be available at `http://localhost:18345`.

---

## 📡 API Reference

### 🛠 Core & System
- `GET /api/status` — Check server status, version, and retrieve update alerts.
  * Query parameters (optional):
    * `pluginVersion`: The version of the Photoshop UXP plugin.
  * Response details:
    * Returns an `alerts` object with platform-specific instructions if action is needed (e.g., plugin version mismatch, or Helper update is downloaded/ready).
- `GET /api/is-local` — Detect local vs. remote access and device type (mobile/desktop).

### 📋 Clipboard
- `POST /api/clipboard/copy` — Copy a base64-encoded image to the system clipboard.
- `GET /api/clipboard/paste` — Retrieve the current clipboard image as base64.

### 🖱 Drag & Drop
- `POST /api/drag/start` — Initiate a drag operation. Creates a floating preview window.
  - Accepts `image` (single file) or `images` (array).

### 💾 File System
- `POST /api/file/save` — Save an image to disk with automatic filename conflict resolution (`image_1.png`, `image_2.png`).

### 🌐 WebHelper (AI API)
- `GET /webhelper` — Entry point for the web UI (SPA).
- `GET /api/webhelper/providers` — List of available models (Grok, FAL, FLUX) and their parameters.
- `POST /api/webhelper/task` — Create a new task (upload Source + Mask from Photoshop).
- `POST /api/webhelper/task/from-file` — **Iterative workflow**: create a new task from an existing generation result.
- `GET /api/webhelper/queue` — Queue of new tasks (polled by the UI).
- `POST /api/webhelper/mark_opened` — Mark tasks as accepted by the UI (clears the queue).
- `GET /api/webhelper/task/:taskId` — Detailed task metadata and results.
- `GET /api/webhelper/file/:filename` — Access temporary images (sources, masks, generations).
- `POST /api/webhelper/generate` — Start the generation process via the selected AI provider.
- `POST /api/webhelper/file/copy2clipboard` — Copy any file from the working directory to the clipboard at full resolution.

---

## 📁 Project Structure

```text
PhotoshopHelper/
├── webhelper/                        # Frontend application (SPA)
│   ├── webhelper.html                # Main generator interface
│   ├── webhelper.js                  # Task management, forms, and API polling
│   └── theme.css                     # Design system based on Spectre.css
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
├── preload.js                        # Context bridge for secure inter-process communication
├── providers.template.json           # Template for AI provider parameter configuration
├── providers.json                    # Configuration for AI providers and parameters
├── Prompt_Providers_Configuration.md # LLM prompt for generating new provider configurations
├── Providers_Configuration_Guide.md  # Detailed guide for provider and API configuration
├── donation-manager.js               # Manages usage tracking and donation prompts
├── drag-window.html                  # Overlay window for Drag & Drop to browser
├── drag-window.js                    # File capture and drag-and-drop logic
├── apiGenerator.js                   # Generation core: context assembly and request templating
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

- **Security:** The application is designed for local and personal use. **Important: it is not intended for public deployment.** An environment detection system (`/api/is-local`) is implemented, allowing the UI to adapt when accessed via temporary tunnels (ngrok, cloudflared, etc.).
- **Temp Management:** Session files are stored in `%TEMP%\ps_webhelper_tasks`. Files older than 30 days are cleaned up automatically.
- **Nebula Secrets:** When `NEBULA_CS` is set, the application automatically calls `nebulabroker emit` to inject keys from your personal GSM (Google Secret Manager) into `process.env`.
- **High-Res Copy:** When copying from WebHelper, NativeImage is used to guarantee the original resolution is preserved without browser-side compression.

---

## 🔗 UXP Integration

To communicate with the helper from your plugin, use the standard `fetch` API.
**Important:** Your plugin's `manifest.json` must grant access to the following domains:
```json
"requiredPermissions": {
  "network": { "domains": "all" }
}
```

---

## 📝 License

This project is licensed under the CC BY-NC-SA 4.0 License.
