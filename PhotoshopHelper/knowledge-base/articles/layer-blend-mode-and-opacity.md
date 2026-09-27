---
id: layer-blend-mode-and-opacity
title: Set a layer's blend mode and opacity from a script
problem: setting a layer's blend mode or opacity from a script — the batchPlay shape, and a case where combining them with a rename silently dropped two of the three
confidence: author-verified
task: verified by the author in Photoshop — recorded with Actions → Copy As JavaScript
photoshop: 25.3.1
date: 2026-09-27
helped: 0
failed: 0
---

## Layer blend mode and opacity

Recorded as two separate commands:
`{ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _obj: "layer", mode: { _enum: "blendMode", _value: "softLight" } } }`
and the same with `to: { _obj: "layer", opacity: { _unit: "percentUnit", _value: 67 } }`.
In an agent run one `set` carrying name, mode and opacity together applied only the name,
with no error — cause not separated. The DOM (`layer.blendMode`, `layer.opacity`) worked.
Whichever you use, look at the result.
