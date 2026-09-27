---
id: content-aware-fill-and-sky-replacement
title: Content-Aware Fill and Sky Replacement from a script
problem: running Content-Aware Fill on a selection, or Sky Replacement, from a script — the batchPlay name and parameters, and the machine-specific sky file path
confidence: author-verified
task: verified by the author in Photoshop — each recorded with Actions → Copy As JavaScript
photoshop: 27.10.1
date: 2026-09-27
helped: 0
failed: 0
---

| command | `_obj` | parameters as recorded |
| --- | --- | --- |
| Content-Aware Fill | `cafWorkspace` — **not** `contentAwareFill` | works on the current selection; `cafSamplingRegion: { _enum: "cafSamplingRegion", _value: "cafSamplingRegionRectangular" }`, `cafOutput: { _enum: "cafOutput", _value: "cafOutputToNewLayer" }`, `cafColorAdaptationLevel`, `cafRotationAmount`, `cafScale`, `cafMirror`, `cafSampleAllLayers` |
| Sky Replacement | `skyReplacement` | see below |

**Sky Replacement.** Keys: `brightness`, `temperature`, `shiftEdge`, `borderSmoothness`
(Fade Edge), `lightingMode` (a blend mode), `edgeLightingOpacity`,
`foregroundLightingOpacity`, `harmonizationOpacity`,
`skyReplacementOutput: { _enum: "skyReplacementOutput", _value: "skyReplacementOutputToNewSheets" }`.
The sky itself is `file: { _kind: "local", _path: … }` pointing to a JPEG in the
`Sky_Presets` folder of this machine's Photoshop settings, plus its `ID` (the same GUID as
the file name) and `name`. That path differs on every machine — take it from a recording
made here, never from somewhere else. Photoshop refuses when it detects no sky in the image.
