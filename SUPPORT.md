# Support

FromPS / ToPS connects Photoshop to external browser tools and optional API providers. Support is organized by the part of the workflow that failed.

## Before opening an issue

1. Install the latest package from [GitHub Releases](https://github.com/dgl-10/PhotoshopPlugin/releases).
2. Confirm that PhotoshopHelper is running in the system tray.
3. Confirm that Photoshop is version 24.0 or newer.
4. For WebHelper, open `http://localhost:18345/webhelper` and verify that the required provider key is configured.
5. Retry with a non-sensitive test image.

## Bug reports

Use the [bug report form](https://github.com/dgl-10/PhotoshopPlugin/issues/new?template=bug_report.yml). Include:

- operating system and architecture;
- Photoshop, plugin, and PhotoshopHelper versions;
- the affected workflow: Capture, Save, Copy/Paste, Drag Out, Send to WebHelper, API generation, or Place Back;
- exact reproduction steps;
- a redacted error message or log excerpt;
- provider and model name when the problem is API-specific.

Never post API keys, supporter keys, `.env` contents, private client images, purchase details, or unredacted personal paths.

## Feature requests

Use the [feature request form](https://github.com/dgl-10/PhotoshopPlugin/issues/new?template=feature_request.yml). Explain the artist workflow and the manual steps the proposal would remove.

## Third-party services

The project cannot resolve provider outages, moderation decisions, pricing, billing, account restrictions, or output-usage rights for ChatGPT, Gemini, Midjourney, FAL, Replicate, BFL, xAI, or other services. Contact the relevant provider for those issues.

## Supporter-key questions

For purchase or supporter-key problems, contact the seller through the [Gumroad product page](https://dgl10.gumroad.com/l/photoshop-plugin). Do not publish the key or receipt in a GitHub issue.

## Security reports

Do not use a public issue for security vulnerabilities. Follow [SECURITY.md](SECURITY.md).
