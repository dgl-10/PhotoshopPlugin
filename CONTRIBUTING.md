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

- the root UXP plugin for capture and placement in Photoshop, and for running agent commands (`modules/agent-*.js`, `modules/command-handlers.js`, `modules/ws-bridge.js`);
- `PhotoshopHelper/` for clipboard, drag-and-drop, WebHelper, setup, and updates;
- `PhotoshopHelper/webhelper/` for the local generation interface;
- `PhotoshopHelper/providers*.json` for provider-driven API behavior;
- `PhotoshopHelper/agent/` and `mcp-server.js` for the MCP server, the agent's tools, the AI Assist window, and the CLI integration;
- `PhotoshopHelper/knowledge-base/` for the rules and articles handed to the agent.

## Provider contributions

Follow [Providers_Configuration_Guide.md](PhotoshopHelper/Providers_Configuration_Guide.md) and use [Prompt_Providers_Configuration.md](PhotoshopHelper/Prompt_Providers_Configuration.md) to generate configurations with LLMs. Keep API credentials out of provider definitions and reference them through `{{env:VARIABLE_NAME}}`. A submitted template must remain usable without the contributor's private account or local paths.

## Agent tools and knowledge base

New MCP tools are named by area: tools that work with Photoshop start with `ps_` (or `from_ps_` / `to_ps_`), and tools that generate images start with `gen_`. Document tools must keep requiring the task id returned by `ps_start_task`.

The shared knowledge base is curated by the maintainer. A proposed article goes through a pull request or an issue like any other change and should:

- be written in English, including its title and the one-line `problem` used in the index;
- cover one problem, so an agent searching for that problem finds it;
- describe a recipe that was actually run in Photoshop, with what did not work if that is useful.

Changes to `PhotoshopHelper/knowledge-base/` reach installed Helpers as soon as they are merged into `main`, without a release.

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

For agent changes, also turn on **FromPS / ToPS AI...** in the panel menu, connect an AI agent as described in [DEVELOPMENT.md](DEVELOPMENT.md), and run one short task on a test document. For CLI changes, run one generation through the **CLI Native Image Generator** with the CLI you changed. Both spend your own subscription allowance; name the agent or CLI and its version in the pull request.

Changes touching `PhotoshopHelper/main.js`, `auth.js`, `plugin-pairing.js`, `localGenerationApi.js`, `mcp-server.js`, `ws-bridge.js`, or `agent/agent-api.js` affect the local server's access control. Run `npm test` (covers `_tests_/auth.test.js`, `_tests_/localGenerationApi.test.js`, `_tests_/mcpServer.test.js`, and `_tests_/wsBridge.test.js` among others) and confirm the plugin can still reach the Helper after the change — see [SECURITY.md](SECURITY.md) for the access model those tests enforce.

## Pull requests

A pull request should include:

- a concise summary;
- reproduction steps for a bug or a clear workflow for a feature;
- platforms tested;
- screenshots or a short recording for visible UI changes;
- any compatibility or migration notes.

Do not commit `.env`, API keys, supporter keys, `node_modules`, build directories, personal settings, or private artwork. Redact logs and screenshots before attaching them.

Use [GitHub Issues](https://github.com/dgl-10/PhotoshopPlugin/issues) for discussion before starting a large architectural change.
