---
id: select-subject-and-color-range
title: Select Subject and Color Range from a script
problem: selecting the subject of the image or a range of colours from a script — the batchPlay name and parameters, and why Select Subject can fail with "not currently available"
confidence: author-verified
task: verified by the author in Photoshop — each recorded with Actions → Copy As JavaScript
photoshop: 25.3.1, 27.10.1
date: 2026-09-27
helped: 0
failed: 0
---

| command | `_obj` | parameters as recorded |
| --- | --- | --- |
| Select Subject | `autoCutout` | `sampleAllLayers` (bool). **Unavailable when the active layer is hidden** — the menu item is disabled, and a script gets "The command “Select Subject” is not currently available". Make a visible layer active first |
| Color Range | `colorRange` | `fuzziness`, `minimum` / `maximum` as `labColor`, `colorModel: 0` |

When these leave a hard, chopped edge on hair, fur, smoke or lace, an image generator can
draw the mask instead: `select-with-ai-inpaint-mask`.
