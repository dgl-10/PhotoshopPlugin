# Changelog

All notable changes to **FromPS / ToPS** and **PhotoshopHelper** are documented in this file.

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
