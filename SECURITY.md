# Security Policy

FromPS / ToPS is a Photoshop workflow bridge made of an Adobe UXP plugin and a local Electron companion application (PhotoshopHelper). PhotoshopHelper serves WebHelper and its local API on `127.0.0.1:18345`; it is not designed to be exposed to a LAN or the public internet.

## Supported versions

Security fixes are provided for the latest published release. Before reporting a problem, reproduce it with the newest version available on the [Releases page](https://github.com/dgl-10/PhotoshopPlugin/releases).

## Reporting a vulnerability

Please do not disclose a vulnerability in a public issue.

1. Use GitHub's [private vulnerability report](https://github.com/dgl-10/PhotoshopPlugin/security/advisories/new).
2. Describe the affected version and operating system.
3. Include clear reproduction steps and the expected security impact.
4. Remove API keys, supporter keys, personal file paths, and private images from all attachments.

If private reporting is temporarily unavailable, open a minimal issue titled `Security contact requested` without technical details. The maintainer will arrange a private channel.

Useful reports include unintended access to clipboard or files, unsafe handling of local paths, exposure of API credentials, bypasses of the localhost-only model, and vulnerabilities in the update or packaging process.

## Security model

- Browser drag-and-drop and clipboard workflows are initiated by the user.
- WebHelper sends generation requests directly from the local Helper to the API provider configured by the user.
- API keys belong in the Helper settings `.env` file or an environment/secret manager, never in source files or issue reports.
- Temporary source images, masks, and results are stored locally in the system temporary directory.
- The project does not operate a proxy or image-processing server between the user and the selected AI provider.

### Local HTTP server access control

Binding to `127.0.0.1` keeps the server off the network, but it does not stop other
software on the same machine — including a page open in the user's browser — from
reaching it. Every route on the local server therefore requires one of the following:

| Access level | Routes | Requirement |
|---|---|---|
| Plugin-only | Clipboard, drag-and-drop, file save | A dedicated token, always required. |
| WebHelper | The WebHelper page and its API | A same-origin browser request, or the plugin token. |
| Local service API | `/api/local/v1/*` | A separate dedicated token, always required. |
| Open | `/api/status`, `/api/is-local` | None — needed before a client can pair. |

Two independent tokens are generated on first run and stored in the Helper's local
settings, not shared between the levels above:

- The **plugin token** is delivered automatically into the Photoshop plugin's private
  UXP data folder, so it exists as a file readable by any process running as the same
  Windows/macOS user. It guards only the sandbox-escape endpoints (clipboard, drag,
  file save) and is never sufficient to trigger a paid generation. Arbitrary file saving
  via `/api/file/save` is additionally forced off in packaged builds, even with a valid
  plugin token.
- The **local service API token** (`PHOTOSHOP_HELPER_LOCAL_API_TOKEN`) guards `/api/local/v1/*`
  and any local MCP server or automated scripts built on the same router. It is configured
  independently so that a leak of the plugin token cannot be used to spend API credits.

Cross-origin browser requests are also rejected outright: the server reflects only its
own origin instead of `Access-Control-Allow-Origin: *`, so a page from any other site
fails its CORS check before a mutating request is even authenticated.

WebHelper itself stays reachable without a token when accessed from the machine it runs
on, including through a tunnel such as ngrok, because that traffic is same-origin from
the browser's perspective. Setting `WEBHELPER_ACCESS_PASSWORD` adds an HTTP Basic
password gate for the case where WebHelper is deliberately exposed beyond this machine.

Reports are reviewed on a best-effort basis. Please allow time for verification before publishing details.
