# Support

FromPS / ToPS connects Photoshop to external browser tools and optional API providers. Support is organized by the part of the workflow that failed.

## Before opening an issue

1. Install the latest package from [GitHub Releases](https://github.com/dgl-10/PhotoshopPlugin/releases).
2. Confirm that PhotoshopHelper is running in the system tray.
3. Confirm that Photoshop is version 24.0 or newer.
4. For WebHelper, open `http://localhost:18345/webhelper` and verify that the required provider key is configured.
5. If a plugin action reports "Helper not paired" rather than "Helper not running," the
   Helper is reachable but did not recognize the plugin's credentials. Reopen the panel
   (pairing is automatic and refreshes periodically), or copy the token manually from the
   Helper tray menu (**Access Tokens → Copy Plugin Pairing Token**) into the plugin's
   Settings dialog.
6. For CLI generation, confirm that the CLI works on its own in a terminal and is signed in,
   and that in **AI CLI Settings...** (Helper tray menu) it is **Enabled**, ticked for
   **Image**, and has a **Medium** model selected. Otherwise WebHelper does not offer the
   **CLI Native Image Generator**.
7. For the AI agent, open **AI Agent for Photoshop → AI Assist...** from the Helper tray menu
   and check that:
   - the access key is shown as saved (**Access Tokens → Save Token to User Environment...**);
   - the agent was restarted after the key was saved and after the server was registered;
   - **FromPS / ToPS AI...** is turned on in the panel menu and the window shows
     **Connected**. The line turns itself off after an hour without tasks.
8. Retry with a non-sensitive test image.

## Bug reports

Use the [bug report form](https://github.com/dgl-10/PhotoshopPlugin/issues/new?template=bug_report.yml). Include:

- operating system and architecture;
- Photoshop, plugin, and PhotoshopHelper versions;
- the affected workflow: Capture, Save, Copy/Paste, Drag Out, Send to WebHelper, API generation, CLI generation, AI agent, or Place Back;
- exact reproduction steps;
- a redacted error message or log excerpt;
- provider and model name when the problem is API-specific;
- for CLI generation: the CLI and its version and the model selected;
- for the AI agent: the agent application (and whether it is a terminal CLI, desktop app, or IDE extension), its version, the model, the task as you asked it, and the report shown in the AI Assist window.

Never post API keys, supporter keys, `.env` contents, private client images, purchase details, or unredacted personal paths.

## Feature requests

Use the [feature request form](https://github.com/dgl-10/PhotoshopPlugin/issues/new?template=feature_request.yml). Explain the artist workflow and the manual steps the proposal would remove.

## Third-party services

The project cannot resolve provider outages, moderation decisions, pricing, billing, account restrictions, or output-usage rights for ChatGPT, Gemini, Midjourney, FAL, Replicate, BFL, SpaceXAI, or other services. Contact the relevant provider for those issues.

The same applies to the AI CLIs and agent applications (Claude Code, OpenAI Codex, SpaceXAI Grok, Google Antigravity, and others): installation, sign-in, subscription limits, and the quality of an agent's work are the vendor's side. CLI vendors also change their command-line options between versions; if CLI generation stopped working right after a CLI update, report it with the CLI version so Helper can be adjusted.

## Supporter-key questions

For purchase or supporter-key problems, contact the seller through the [Gumroad product page](https://dgl10.gumroad.com/l/photoshop-plugin). Do not publish the key or receipt in a GitHub issue.

## Security reports

Do not use a public issue for security vulnerabilities. Follow [SECURITY.md](SECURITY.md).
