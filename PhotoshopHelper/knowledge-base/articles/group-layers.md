---
id: group-layers
title: Group layers from a script, and name the group
problem: grouping several layers from a script and giving the group a name — the batchPlay sequence; and a new layer that lands inside the group because the group was active, and how to move it out
confidence: author-verified
task: verified by the author in Photoshop — recorded with Actions → Copy As JavaScript; the section on a new layer inside the active group was seen in an agent run (task-32da6e)
photoshop: 25.3.1
date: 2026-10-25
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

## A new layer made while a group is active lands inside it

Seen in an agent run (task-32da6e, 25.3.1): a fill layer made while a group was the active
layer went inside that group, under the group's mask, and did not show. Moving it out with
the DOM worked — it lands right above the group, outside it:

```js
await newLayer.move(group, constants.ElementPlacement.PLACEBEFORE)
```

In the same run a batchPlay `move` with `to: { _ref: "layer", _name: "<the group's name>" }`
was rejected (-25920). Making a layer outside the group active before the `make` should
avoid the problem altogether; that was not tried there.
