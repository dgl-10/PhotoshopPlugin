# Privacy

Last updated: 2026-10-09

FromPS / ToPS is primarily a local workflow bridge. This document explains what data is handled by the Photoshop plugin, PhotoshopHelper, and the AI tools the user connects to them.

## Browser workflow

Capture, clipboard, and drag-and-drop operations are performed locally. Images leave the computer only when the user uploads, pastes, or drops them into a third-party website or application. That destination's privacy policy and terms then apply.

## WebHelper API workflow

When the user starts an API generation, PhotoshopHelper sends the selected source image, mask, reference images, prompt, and chosen parameters directly to the configured API provider. The project does not operate an intermediate generation server.

API providers may retain inputs, outputs, prompts, account identifiers, or billing records according to their own policies. Users should review the policy of each provider they enable.

## CLI generation

When the user generates with the **CLI Native Image Generator**, PhotoshopHelper runs the AI CLI the user installed and signed in to (OpenAI Codex, SpaceXAI Grok, or Google Antigravity). The prompt is passed to the CLI, and the source and reference images are passed as local file paths; the CLI sends them to its vendor under the user's own account, subscription, and that vendor's terms. Working files for a run are kept under `ps_webhelper_tasks\_WH_CliScratch` in the system temporary directory.

**Refresh via CLI** in the model settings asks the CLI for its current model list. The answer is cached locally in `cli-models-cache` in the Helper's application data folder for 14 days.

## AI agent for Photoshop

An AI agent the user connects to PhotoshopHelper's MCP server (Claude Code, Codex, Grok, Antigravity, or another agent application that supports MCP, whether a terminal CLI, desktop app, or IDE extension) runs under the user's own account with its vendor. While the plugin's **FromPS / ToPS AI** line is on, the agent can read the open document's structure and layer settings and view images of the canvas; whatever it reads is sent to its vendor as part of the conversation, under that vendor's terms. The agent's generation tools send requests to the configured providers in the same way as WebHelper.

PhotoshopHelper does not relay or store the conversation. It keeps:

- the current task's steps in memory, to show them in the AI Assist window;
- captures the agent asks to save as files, under `ps_webhelper_tasks\_Agent_Captures` in the system temporary directory;
- articles and "helped" / "failed" marks written by agents, in `knowledge-base.user` in the application data folder. An article records the name of the agent client that wrote it. These files are not uploaded anywhere;
- optionally, a journal of MCP calls (tool name, shortened arguments, and a short result; no images) in `agent-journal` in the application data folder, keeping the last 20 tasks. It is off by default in installed builds.

## API keys and provider configuration

- Installed builds keep `.env`, `providers.user.json`, and user settings in the Electron application data directory shown by the setup wizard. They also download the shared provider catalog there as `providers.remote.json`.
- API keys are read by PhotoshopHelper and inserted into requests to the selected provider.
- Provider definitions reference keys by environment-variable name; keys should never be placed directly in either provider catalog file.

Do not attach `.env` files or unredacted configuration files to GitHub issues.

## Local server authentication

PhotoshopHelper generates two access tokens on first run and stores them alongside the
other local settings above. One is delivered automatically into the Photoshop plugin's
private UXP data folder so the plugin can authenticate without any manual step; the other
protects the local automation API (`/api/local/v1/*`) and the MCP server (`/mcp`). Neither
token leaves the machine.

At the user's request (tray menu → **Access Tokens → Save Token to User Environment...**),
the second token is also saved as the `PHOTOSHOP_HELPER_LOCAL_API_TOKEN` user environment
variable so AI agents can connect. Registering the MCP server in Google Antigravity writes
the token value into that agent's own configuration file; Claude Code, Codex, and Grok store
only a reference to the variable, and other agents depend on how they store MCP settings. See [SECURITY.md](SECURITY.md) for what each token protects.

## Local images and temporary files

PhotoshopHelper stores working images, masks, generation results, and drag-and-drop files under the system temporary directory in a folder named `ps_webhelper_tasks`. The Helper removes items older than 30 days when it starts. The folder can also be opened from the tray menu and cleaned manually after closing active tasks.

## Logs

PhotoshopHelper writes local diagnostic logs through `electron-log`. Logs may contain application and runtime versions, operating-system information, error messages, stack traces, and local file paths. Logs are not uploaded automatically. Review and redact them before sharing.

## Usage reminders and supporter keys

Support reminders use a counter stored locally in `user-settings.json`. The project does not send this usage count to an analytics service.

When a user chooses to verify a supporter key, the key and product identifier are sent directly to Gumroad's license-verification API. PhotoshopHelper stores a derived local activation marker after successful verification rather than the entered key. Gumroad's privacy policy applies to purchase and verification data.

## Updates

PhotoshopHelper may contact GitHub Releases to check for application updates. Windows builds can download an available update; macOS builds may direct the user to the Releases page.

On the same schedule, PhotoshopHelper downloads the shared provider catalog and the author's knowledge base for the AI agent from the project's public GitHub repository (`api.github.com` and `raw.githubusercontent.com`). These are plain downloads; they carry the Helper version in the `User-Agent` header and nothing about the user beyond what any HTTPS request carries.

## Data deletion

To remove local project data, close PhotoshopHelper and delete its application-data configuration (including `knowledge-base.user`, `agent-journal`, and `cli-models-cache`), local logs, and the `ps_webhelper_tasks` temporary folder. If the MCP server was connected to an agent, also remove the `photoshop-helper` server from that agent's configuration and delete the `PHOTOSHOP_HELPER_LOCAL_API_TOKEN` user environment variable. This does not delete data previously sent to a browser service, API provider, CLI vendor, or agent vendor; contact that provider for its deletion options.

## No project analytics service

The project does not currently operate its own telemetry, analytics, prompt-storage, image-storage, generation relay, or agent relay service. Nothing written by agents on the user's machine is sent back to the project.
