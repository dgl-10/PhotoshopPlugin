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

Reports are reviewed on a best-effort basis. Please allow time for verification before publishing details.
