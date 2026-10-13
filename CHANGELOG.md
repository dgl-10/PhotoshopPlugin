# Changelog

All notable changes to **FromPS / ToPS** and **PhotoshopHelper** are documented in this file.

## [1.3.1]

### 🤖 Model Context Protocol (MCP) & AI Agent Integration
- **Photoshop MCP Server**: Published a local Model Context Protocol server endpoint (`http://127.0.0.1:18345/mcp`, Streamable HTTP / JSON-RPC 2.0) secured by the Local API token, allowing external AI coding assistants and agents (Claude Code, OpenAI Codex, SpaceXAI Grok, Google Antigravity, and others) to interact directly with Photoshop.
- **Photoshop Document Tools (`ps_*`, `from_ps_*`, `to_ps_*`)**: Comprehensive tool suite for inspecting layers and canvas state, executing ExtendScript/batchPlay scripts, capturing document selections, placing images back, and managing dialogs within dedicated task sessions (`ps_start_task` / `ps_finish_task`).
- **MCP Generation Tools (`gen_*`)**: Exposed headless image generation directly to MCP agents through the Local Generation API service.
- **AI Assist Window**: Added a dedicated floating monitoring window (Helper tray → **AI Agent for Photoshop** → **AI Assist...**) providing real-time connection status, active task step logs, diagnostic journal history, and one-click copy setup prompts / terminal registration commands for supported agents.
- **Verified Knowledge Base (`ps_kb_*`)**: Integrated an extensible Photoshop recipe and rule system for AI agents with automatic background updates of author articles from GitHub.

### 💻 CLI Native Image Generator
- **CLI Native Image Generator (`native-cli-image-generator`)**: Added an in-memory virtual provider enabling WebHelper and the Local API to generate images via locally installed AI CLI agents (OpenAI, SpaceXAI, Google) on your existing subscriptions without separate third-party API keys.

### 🛠️ Improvements & Maintenance
- **Plugin & Helper**: Minor improvements for plugin and helper.

## [1.2.3]

### 🔄 Providers Auto-Update
- **Providers Auto-Update**: Added automatic background updating of the shared providers list.

## [1.2.2]

### 🧩 New Providers & AI Integrations
- **GPT Image 2.5**: Added support for GPT Image 2.5.

### 🛠️ Improvements & Maintenance
- **Plugin & Helper**: Minor improvements for plugin and helper.

## [1.2.1]

### 🧩 New Providers & API Integrations
- **Civitai Orchestration API Integration**: Added native support for image generation via the Civitai Orchestration API (billed via Yellow Buzz):
  - **Qwen 2 / 3**: Qwen 2.0, 2.0 Pro, 3.0 Pro.
  - **Wan 2.7**: Alibaba Wan 2.7 (Standard and Pro tiers).
  - **Seedream**: Seedream v4, v4.5, and v5.0 Lite.
- **Civitai Response Handler**: Added universal async polling response handler (`civitai`) supporting job status tracking and error reporting for Orchestration API workflows.

## [1.2.0]

### 🌐 WebHelper Redesign
- **Redesigned WebHelper UI**: Brand new modern interface featuring an improved workspace layout, global Dump stage for reusable images, streamlined task selector, and enhanced parameter controls.

## [1.1.0]

### 🎨 Photoshop Plugin & Placement Workflow
- **Restore Selection**: Added support for restoring the original selection back into the active Photoshop document.
- **Mask & Selection Feathering**: Added support for mask and selection edge softening (feathering / blur) with bias controls when placing results back into the document.

### 🔒 Security & Connectivity
- **Enhanced Security**: Improved security, authentication, and token-based protection for PhotoshopHelper.

### 🤖 AI Integrations & API Core
- **Local Generation API**: Added headless local API for image generation with support for both configured WebHelper models and dynamic inline providers (for on-the-fly model testing).

### 🌐 WebHelper & UI Features
- **Text-to-Image (T2I) Mode**: Added standalone text-to-image generation directly within WebHelper with aspect ratio selection.

### 🧩 New Providers for WebHelper & Local API
- **SeedDream 5.0 Pro**: Added support for ByteDance SeedDream 5.0 Pro via Fal.ai and Replicate.
- **OpenAI GPT-Image-2**: Added native integration for GPT-Image-2 via OpenAI API.
