# Privacy

Last updated: 2026-07-16

FromPS / ToPS is primarily a local workflow bridge. This document explains what data is handled by the Photoshop plugin and PhotoshopHelper.

## Browser workflow

Capture, clipboard, and drag-and-drop operations are performed locally. Images leave the computer only when the user uploads, pastes, or drops them into a third-party website or application. That destination's privacy policy and terms then apply.

## WebHelper API workflow

When the user starts an API generation, PhotoshopHelper sends the selected source image, mask, reference images, prompt, and chosen parameters directly to the configured API provider. The project does not operate an intermediate generation server.

API providers may retain inputs, outputs, prompts, account identifiers, or billing records according to their own policies. Users should review the policy of each provider they enable.

## API keys and provider configuration

- Installed builds keep `.env`, `providers.json`, and user settings in the Electron application data directory shown by the setup wizard.
- API keys are read by PhotoshopHelper and inserted into requests to the selected provider.
- Provider definitions reference keys by environment-variable name; keys should never be placed directly in `providers.json`.
- Optional Nebula integration can inject keys from the user's own secret-management setup.

Do not attach `.env` files or unredacted configuration files to GitHub issues.

## Local server authentication

PhotoshopHelper generates two access tokens on first run and stores them alongside the
other local settings above. One is delivered automatically into the Photoshop plugin's
private UXP data folder so the plugin can authenticate without any manual step; the other
protects the local automation API (`/api/local/v1/*`). Neither token leaves the machine.
See [SECURITY.md](SECURITY.md) for what each token protects.

## Local images and temporary files

PhotoshopHelper stores working images, masks, generation results, and drag-and-drop files under the system temporary directory in a folder named `ps_webhelper_tasks`. The Helper removes items older than 30 days when it starts. The folder can also be opened from the tray menu and cleaned manually after closing active tasks.

## Logs

PhotoshopHelper writes local diagnostic logs through `electron-log`. Logs may contain application and runtime versions, operating-system information, error messages, stack traces, and local file paths. Logs are not uploaded automatically. Review and redact them before sharing.

## Usage reminders and supporter keys

Support reminders use a counter stored locally in `user-settings.json`. The project does not send this usage count to an analytics service.

When a user chooses to verify a supporter key, the key and product identifier are sent directly to Gumroad's license-verification API. PhotoshopHelper stores a derived local activation marker after successful verification rather than the entered key. Gumroad's privacy policy applies to purchase and verification data.

## Updates

PhotoshopHelper may contact GitHub Releases to check for application updates. Windows builds can download an available update; macOS builds may direct the user to the Releases page.

## Data deletion

To remove local project data, close PhotoshopHelper and delete its application-data configuration, local logs, and the `ps_webhelper_tasks` temporary folder. This does not delete data previously sent to a browser service or API provider; contact that provider for its deletion options.

## No project analytics service

The project does not currently operate its own telemetry, analytics, prompt-storage, image-storage, or generation relay service.
