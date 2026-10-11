---
id: workspaces-that-cannot-be-scripted
title: Workspaces that cannot be recorded, and so cannot be scripted
problem: a job needs Select and Mask, Blur Gallery, Adaptive Wide Angle, Vanishing Point or a Neural Filter, and there is no recorded command name to script it with
confidence: author-verified
task: verified by the author in Photoshop — tried recording each with Actions → Copy As JavaScript
photoshop: 25.3.1, 27.10.1
date: 2026-09-27
helped: 0
failed: 0
---

## Cannot be recorded

Entering these workspaces silently stops the Actions recording: no step appears, although
the result lands in History. So there is no recorded name to use.

- **Select and Mask**
- **Blur Gallery** — tried with Iris Blur; Field Blur and Tilt-Shift are the same workspace
  and were not tried separately
- **Adaptive Wide Angle**
- **Vanishing Point** — reported the same by others ([Adobe Community](https://community.adobe.com/questions-712/automate-vanishing-point-tool-by-script-1178490)), not tried here

Not every workspace behaves this way — Content-Aware Fill and Sky Replacement record fine
(`content-aware-fill-and-sky-replacement`) — so try recording before giving up on one.

**Neural Filters** — undetermined: the test photos had no face the filters would accept.

If a job needs one of these, say plainly that it cannot be done by script and leave that
step to the person. Without a recorded name there is also nothing to open for them.
