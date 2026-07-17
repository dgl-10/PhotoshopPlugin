---
name: generate-release-notes
description: Generates formatted GitHub release notes for PhotoshopDaDHelper releases.
---

# Skill: Generate Release Notes

Use this skill to generate clean, professionally formatted release notes in English for new versions of the **PhotoshopDaDHelper** project.

## Procedure

When this skill is triggered, perform the following steps:

1. **Retrieve Version and Changes**:
   * Read `PhotoshopHelper/package.json` to get the latest version (or ask the user for the target version if it's different).
   * Ask the user for a summary of changes to build the **Changelog**, or inspect recent git commit messages.

2. **Generate Release Notes**:
   * Format the release notes strictly in Markdown.
   * Ensure all download links point to the correct GitHub release assets using the version retrieved (e.g., `v1.0.1` if the version is `1.0.1`).
   * Write the content entirely in **English**.

3. **Template to Use**:

```markdown
## Changelog
* [Change item 1]
* [Change item 2]

---

### 💾 Downloads

*   💻 **For Windows (x64):** 
    [Download PhotoshopHelper-Setup-{version}.exe](https://github.com/dgl-10/PhotoshopPlugin/releases/download/v{version}/PhotoshopHelper-Setup-{version}.exe) — *Standard installer.*

*   🍏 **For macOS (M1 / M2 / M3 / Apple Silicon):** 
    [Download PhotoshopHelper-{version}-arm64.dmg](https://github.com/dgl-10/PhotoshopPlugin/releases/download/v{version}/PhotoshopHelper-{version}-arm64.dmg) — *Recommended for Apple Silicon.*

*   💻 **For macOS (Intel):** 
    [Download PhotoshopHelper-{version}.dmg](https://github.com/dgl-10/PhotoshopPlugin/releases/download/v{version}/PhotoshopHelper-{version}.dmg) — *For older Intel-based Macs.*

---

### 🪟 Windows Installation (SmartScreen)
Because this is an open-source project without a paid corporate certificate, Windows SmartScreen may show a blue "Windows protected your PC" warning. To install safely:
1. Click **More info** in the blue warning window.
2. Click the **Run anyway** button that appears.

### 🍏 macOS Installation (Unsigned Build)
Because this macOS build is currently unsigned, macOS Gatekeeper will block it by default with a "damaged app" or "unidentified developer" warning. To safely bypass this:

1. Always download the **.dmg** file (ignore the .zip file).
2. Open the `.dmg` and drag the `PhotoshopHelper` app into your **Applications** folder.
3. To open it for the first time, **Right-click** (or Control-click) the app in your Applications folder and select **Open**. Click **Open anyway** in the security prompt.
4. *(Alternative)* If macOS still blocks the app, open Terminal and run this command:
   `xattr -cr /Applications/PhotoshopHelper.app`

---

> [!NOTE]  
> Other assets listed below (`.zip`, `.yml`, `.blockmap`) are technical files utilized by the built-in auto-updater. You do not need to download them manually.
```

Replace `{version}` with the actual version string (e.g., `1.0.1`).
