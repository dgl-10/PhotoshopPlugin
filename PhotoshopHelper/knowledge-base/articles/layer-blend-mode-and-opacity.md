---
id: layer-blend-mode-and-opacity
title: Set a layer's blend mode, opacity and channel restrictions from a script
problem: setting a layer's blend mode, opacity or the R/G/B channel checkboxes of Blending Options from a script — the batchPlay shape, a case where combining them with a rename silently dropped two of the three, and channelRestrictions holding the enabled channels
confidence: author-verified
task: verified by the author in Photoshop — recorded with Actions → Copy As JavaScript
photoshop: 25.3.1
date: 2026-10-21
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

## Channel restrictions (the R, G, B checkboxes in Blending Options)

Recorded after unticking G and B in Blending Options → Advanced Blending:
`{ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _obj: "layer", channelRestrictions: [{ _enum: "channel", _value: "red" }] } }`.
The dialog also put `layerEffects: { _obj: "layerEffects", scale: { _unit: "percentUnit", _value: 100 } }`
into `to`; an agent's `set` without it worked (task-b6d767, checked by pixels).

So `channelRestrictions` lists the channels that stay **enabled**, as plain enums with no
`_ref`. An agent's `get` on a normal layer returned `red`, `grain`, `blue` — green is
`grain`.

An agent saw two forms rejected with -1715 (task-b6d767): the list as the disabled
channels (`[grain, blue]` to keep red), and entries written as references
(`{ _ref: "channel", _enum: "channel", _value: "red" }`). batchPlay did not throw — the
rejection came back as `{ _obj: "error" }` in the returned list — so read the layer back
with `get` (`read-layer-settings`) and check `channelRestrictions`.

One use: lateral chromatic aberration — two duplicates of a smart object above the
original, one restricted to red and scaled 100.08 %, the other to blue at 99.92 %.
