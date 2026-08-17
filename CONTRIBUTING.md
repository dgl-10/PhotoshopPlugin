# Contributing to FromPS / ToPS

Thank you for helping improve the Photoshop workflow bridge. Contributions are welcome for the UXP panel, PhotoshopHelper, WebHelper, provider definitions, documentation, and packaging.

## License

This is a source-available project distributed under CC BY-NC-SA 4.0. By submitting a contribution, you agree that it may be distributed under the repository's existing license. Do not submit code or assets that you do not have permission to redistribute.

## Getting started

1. Read [DEVELOPMENT.md](DEVELOPMENT.md) for the project architecture and local setup.
2. Create a focused branch from `main`.
3. Keep each pull request limited to one fix or feature.
4. Explain the artist workflow before and after the change.

The main components are:

- the root UXP plugin for capture and placement in Photoshop;
- `PhotoshopHelper/` for clipboard, drag-and-drop, WebHelper, setup, and updates;
- `PhotoshopHelper/webhelper/` for the local generation interface;
- `PhotoshopHelper/providers*.json` for provider-driven API behavior.

## Provider contributions

Follow [Providers_Configuration_Guide.md](PhotoshopHelper/Providers_Configuration_Guide.md) and use [Prompt_Providers_Configuration.md](PhotoshopHelper/Prompt_Providers_Configuration.md) to generate configurations with LLMs. Keep API credentials out of provider definitions and reference them through `{{env:VARIABLE_NAME}}`. A submitted template must remain usable without the contributor's private account or local paths.

## Local verification

Run the checks relevant to the change. At minimum:

```powershell
cd PhotoshopHelper
npm ci
npm start
```

For workflow changes, manually verify the affected path in Photoshop 24.0+:

- Capture a selection and mask.
- Copy or drag the captured image out of Photoshop.
- Send a task to WebHelper when applicable.
- Copy or load a result and use Place Back.
- Confirm positioning, Smart Object creation, and mask behavior.

Provider changes should be tested with a non-sensitive image and the smallest practical paid request. Do not include generated test images unless they are safe and licensed for redistribution.

Changes touching `PhotoshopHelper/main.js`, `auth.js`, `plugin-pairing.js`, or `localGenerationApi.js` affect the local server's access control. Run `npm test` (covers `_tests_/auth.test.js` and `_tests_/localGenerationApi.test.js`) and confirm the plugin can still reach the Helper after the change — see [SECURITY.md](SECURITY.md) for the access model those tests enforce.

## Pull requests

A pull request should include:

- a concise summary;
- reproduction steps for a bug or a clear workflow for a feature;
- platforms tested;
- screenshots or a short recording for visible UI changes;
- any compatibility or migration notes.

Do not commit `.env`, API keys, supporter keys, `node_modules`, build directories, personal settings, or private artwork. Redact logs and screenshots before attaching them.

Use [GitHub Issues](https://github.com/dgl-10/PhotoshopPlugin/issues) for discussion before starting a large architectural change.
