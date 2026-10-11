# Security Policy

FromPS / ToPS is a Photoshop workflow bridge made of an Adobe UXP plugin and a local Electron companion application (PhotoshopHelper). PhotoshopHelper serves WebHelper, its local API, and an MCP server for AI agents on `127.0.0.1:18345`, and a command channel to the plugin on `127.0.0.1:18346`; it is not designed to be exposed to a LAN or the public internet.

## Supported versions

Security fixes are provided for the latest published release. Before reporting a problem, reproduce it with the newest version available on the [Releases page](https://github.com/dgl-10/PhotoshopPlugin/releases).

## Reporting a vulnerability

Please do not disclose a vulnerability in a public issue.

1. Use GitHub's [private vulnerability report](https://github.com/dgl-10/PhotoshopPlugin/security/advisories/new).
2. Describe the affected version and operating system.
3. Include clear reproduction steps and the expected security impact.
4. Remove API keys, supporter keys, personal file paths, and private images from all attachments.

If private reporting is temporarily unavailable, open a minimal issue titled `Security contact requested` without technical details. The maintainer will arrange a private channel.

Useful reports include unintended access to clipboard or files, unsafe handling of local paths, exposure of API credentials, bypasses of the localhost-only model, ways to run scripts in Photoshop or start a CLI without the person's consent, and vulnerabilities in the update or packaging process.

## Security model

- Browser drag-and-drop and clipboard workflows are initiated by the user.
- WebHelper sends generation requests directly from the local Helper to the API provider configured by the user, or runs a CLI the user has installed, enabled, and signed in to.
- API keys belong in the Helper settings `.env` file or an environment/secret manager, never in source files or issue reports.
- Temporary source images, masks, and results are stored locally in the system temporary directory.
- The project does not operate a proxy or image-processing server between the user and the selected AI provider.
- AI agents connect to Helper's MCP server from the agent application the user runs on the same computer (a terminal CLI, desktop app, or IDE extension), and reach Photoshop only through a channel the user turns on in the plugin.

### Local HTTP server access control

Binding to `127.0.0.1` keeps the server off the network, but it does not stop other
software on the same machine — including a page open in the user's browser — from
reaching it. Every route on the local server therefore requires one of the following:

| Access level | Routes | Requirement |
|---|---|---|
| Plugin-only | Clipboard, file save, `/api/agent/*` (agent line state, task stop, MCP setup, AI Assist window) | A dedicated token, always required. |
| Plugin channel | WebSocket on `127.0.0.1:18346` | The plugin token in the first message; any other socket is closed. |
| Plugin or local WebHelper | Drag-and-drop start | Plugin token, or a same-origin request that is actually local (not a tunnel). |
| WebHelper | The WebHelper page and its API | A same-origin browser request, or the plugin token. `GET /api/webhelper/providers` also accepts the local service API token. |
| Local service API | `/api/local/v1/*`, MCP server `/mcp` | A separate dedicated token, always required. |
| Internal | `/api/internal/cli-image/*` | A per-process secret that exists only in Helper's memory. |
| Open | `/api/status`, `/api/is-local` | None — needed before a client can pair. |

Two independent tokens are generated on first run and stored in the Helper's local
settings, not shared between the levels above:

- The **plugin token** is delivered automatically into the Photoshop plugin's private
  UXP data folder, so it exists as a file readable by any process running as the same
  Windows/macOS user. It guards the sandbox-escape endpoints (clipboard, drag, file save),
  the agent line routes, and the plugin channel, and is never sufficient to trigger a paid
  generation or to call an MCP tool. Arbitrary file saving via `/api/file/save` is
  additionally forced off in packaged builds, even with a valid plugin token.
- The **local service API token** (`PHOTOSHOP_HELPER_LOCAL_API_TOKEN`) guards `/api/local/v1/*`
  and the MCP server. It is configured independently so that a leak of the plugin token
  cannot be used to spend API credits or to drive Photoshop. Through the MCP server this
  token can also run scripts in the open Photoshop document while the plugin's
  **FromPS / ToPS AI** line is on. Saving it to the user environment from the tray menu
  makes it readable by every process of that user, which is what lets agents connect
  without a configuration secret; register the MCP server only in agents you trust.

Cross-origin browser requests are also rejected outright: the server reflects only its
own origin instead of `Access-Control-Allow-Origin: *`, so a page from any other site
fails its CORS check before a mutating request is even authenticated.

While WebHelper is designed as a local service, it is common to access it remotely via reverse tunnels (e.g., ngrok or cloudflared). Because tunneled traffic appears as same-origin to the browser, standard local origin protections are bypassed. If you choose to expose your instance this way, you can set `WEBHELPER_ACCESS_PASSWORD` to enforce an HTTP Basic Authentication prompt, protecting the interface and your API keys from unauthorized access.

### AI agents and command-line tools

- **Agent access to Photoshop.** An agent connected to the MCP server can read the open
  document, look at its pixels, and run scripts in Photoshop that change it. Scripts run
  inside the plugin with the plugin's own permissions, which include network access and the
  clipboard. This works only while the plugin's **FromPS / ToPS AI** line is on. The line is
  turned on only by the person, from the panel menu; Helper cannot open it, and it turns
  itself off after an hour without tasks (`PHOTOSHOP_HELPER_AGENT_LINE_IDLE_MINUTES`).
- **CLIs launched by Helper.** For CLI image generation and for **Refresh via CLI** in the
  model settings, Helper starts the person's CLI non-interactively with approval prompts
  switched off: Claude Code with `--permission-mode dontAsk` and an allow-list that includes
  `Bash` and file editing, Codex with `--dangerously-bypass-approvals-and-sandbox`, Grok with
  `--always-approve`, and Antigravity with `--dangerously-skip-permissions`. Such a run can
  execute commands and change files with the user's rights. Its prompt carries the text and
  images of the generation request, so whoever can start a generation can steer that CLI.
  This is one more reason not to expose WebHelper beyond this machine. Generation launches
  only CLIs ticked as **Enabled** in **AI CLI Settings...**, so leave the rest unticked;
  **Refresh via CLI** runs only when the person presses it.
- **MCP registration.** Helper never edits an agent's configuration on its own. The setup
  text shown in the AI Assist window is pasted into the agent's chat or run as a terminal
  command by the person; the `/api/agent/mcp-setup/install` route runs only the fixed
  command for one of the four named agents. Claude Code, Codex, and Grok store a reference
  to `PHOTOSHOP_HELPER_LOCAL_API_TOKEN`. Antigravity cannot expand variables in headers, so
  its registration writes the token value itself into `~/.gemini/config/mcp_config.json`;
  other agents may do the same, depending on how they store MCP headers.

Reports are reviewed on a best-effort basis. Please allow time for verification before publishing details.
