---
id: group-layers
title: Group layers from a script, and name the group
problem: grouping several layers from a script and giving the group a name — the batchPlay sequence
confidence: author-verified
task: verified by the author in Photoshop — recorded with Actions → Copy As JavaScript
photoshop: 25.3.1
date: 2026-09-27
helped: 0
failed: 0
---

## Grouping layers

Recorded on 25.3.1: select the layers, then make a group from them, then rename it.

```js
{ _obj: "select", _target: [{ _ref: "layer", _name: "Layer 0" }], layerID: [6, 7],
  selectionModifier: { _enum: "selectionModifierType", _value: "addToSelectionContinuous" }, makeVisible: false }
{ _obj: "make", _target: [{ _ref: "layerSection" }],
  from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }, name: "Group 1" }
{ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _obj: "layer", name: "Test group" } }
```

The recording also carried `layerSectionStart` / `layerSectionEnd`: ids Photoshop gave the
new group — leave them out. The DOM does it in one call, with the name:
`await doc.createLayerGroup({ name: "Test group", fromLayers: [layerA, layerB] })`
(documented; not tried here).
