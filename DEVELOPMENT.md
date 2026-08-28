# FromPS / ToPS — A Bridge for Free AI Inpainting Without API Keys (Technical review)

**FromPS / ToPS** is a plugin for Adobe Photoshop 2024 (Windows) that automates repetitive workflows when using web-based AI services (Midjourney, Gemini, ChatGPT, Leonardo, and others) for Inpainting tasks — filling in or replacing areas of an image.

Most AI plugins for Photoshop require an embedded API key and charge a fee for every individual generation. This project solves that problem: it lets you use any AI service through a browser interface (for free or via your existing web subscription), acting as a convenient automation bridge for routine copy-and-paste operations.

**Core concept and value:**
- **FromPS (Export to Browser):** Select an area — the plugin automatically crops the image, generates a precise mask, and adjusts the capture to fit popular aspect ratios (1:1, 2:3, 3:4, 9:16) for maximum compatibility with AI services. Via the companion helper app, files can be dragged and dropped directly into the browser window.
- **ToPS (Import back to Photoshop):** Copy the finished generation from the browser and click the button. The plugin automatically places and fits the image exactly at the original selection coordinates, converts it to a Smart Object, applies the original mask, and smooths the edges with a Gaussian Blur for a seamless blend with the background.
- **WebHelper (API Generations):** A built-in local web application (`http://localhost:18345/webhelper`), running in tandem with the companion server. It allows you to generate Inpaint images directly via AI APIs (OpenAI, Leonardo, Stable Diffusion, BFL Flux, and others), bypassing the need to manually upload images to third-party services. Can operate either alongside the plugin or fully standalone.

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
- Finished generations can be copied and pasted back into Photoshop via ToPS in one click
- Can operate either alongside the plugin or fully standalone

### Local Generation API (Service-to-Service)
- Runs on the same loopback-only Helper server: `http://127.0.0.1:18345`
- Lets another local process reuse one source image and optional mask across multiple provider runs
- Exchanges absolute local file paths only; generated image bytes are not returned by the API
- Uses the active `providers.json`, the same provider preprocessors, and the same output directory as WebHelper
- Saves results in `%TEMP%\ps_webhelper_tasks` and returns their absolute paths after completion
- Uses asynchronous polling. Webhooks are not part of the current local contract.

## 🚀 Installation & Setup

### Requirements
- Adobe Photoshop 2024 (version 24.0.0 or higher)
- Windows
- [Adobe UXP Developer Tools](https://developer.adobe.com/photoshop/uxp/devtool/) (installed via Adobe Creative Cloud)

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
│   ├── ps.js                             # Core Photoshop API module (Inpaint, Capture, Layers)
│   ├── fs.js                             # File and Base64 module (UXP File Access)
│   ├── ui.js                             # Button and input state management
│   ├── helper.js                         # API client for network communication with PhotoshopHelper
│   ├── settings.js                       # Settings management and UI rendering
│   └── image-utils.js                    # Image processing utilities (crop, masks, resize)
└── PhotoshopHelper/                      # Companion Electron application (UXP sandbox bypass)
    ├── package.json                      # Dependency manifest (Electron, Express, Sharp)
    ├── main.js                           # Main process: HTTP/REST API implementation and system tray
    ├── auth.js                           # Shared token generation, timing-safe comparison, and access-control middleware for the local HTTP server
    ├── plugin-pairing.js                 # Delivers the plugin token into the Photoshop plugin's UXP data folder for automatic pairing
    ├── preload.js                        # Context bridge for secure inter-process communication
    ├── providers.template.json           # Template for AI provider parameter configuration
    ├── providers.json                    # Configuration for AI providers and parameters
    ├── .env.template                     # Template for environment variables
    ├── Prompt_Providers_Configuration.md # LLM prompt for generating new provider configurations
    ├── Providers_Configuration_Guide.md  # Detailed guide for configuring providers and APIs
    ├── donation-manager.js               # Manages usage tracking and donation prompts
    ├── drag-window.html                  # Overlay window for the Drag & Drop files-to-browser feature
    ├── drag-window.js                    # File capture and drag logic
    ├── apiGenerator.js                   # Generation core: context assembly and request templating
    ├── templateEngine.js                 # Shared placeholder resolver and conditional-key expression parser
    ├── localGenerationApi.js             # Direct asynchronous local REST API adapter
    ├── apiGeneratorResultsGetter.js      # Results module: polling and response parsing
    ├── apiGeneratorPreprocessors.js      # Preprocessors: resizing, MP optimization, and filtering
    ├── imageUtils.js                     # Image processing utilities (MIME, Base64, NativeImage)
    ├── Local_Generation_API.md           # Complete local API schema and integration examples
    ├── tray-icon.png                     # Application icon for the system tray
    ├── user-settings.js                  # Persistent settings manager using electron-store
    ├── user-settings.json                # Runtime configuration state file (dev mode only, excluded from build)
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
        ├── js/
        └── app.css
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
the active `providers.json`) or a complete inline `provider` object — not both —
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

### Testing the local API

```powershell
cd PhotoshopHelper
npm test
```

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
2. Revalidate `PhotoshopHelper/providers.template.json`.
3. Update the version number in `PhotoshopHelper/package.json`.
4. Update the changelog and documentation:
   1. Add release information and a summary of changes to `CHANGELOG.md`.
   2. Review and update all relevant `.md` files (such as `README.md`, `DEVELOPMENT.md`, `SECURITY.md`, `PhotoshopHelper/README.md`, `PhotoshopHelper/Providers_Configuration_Guide.md`, `PhotoshopHelper/Local_Generation_API.md`) if new features, configurations, or changes require updates.
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
