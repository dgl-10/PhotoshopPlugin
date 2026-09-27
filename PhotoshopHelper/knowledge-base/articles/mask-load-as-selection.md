---
id: mask-load-as-selection
title: Load a layer's mask as a selection (Ctrl+click on the mask thumbnail)
problem: turning a layer mask into a selection from a script, to reuse it for another layer or an edit
confidence: author-verified
task: verified by the author in Photoshop — recorded with Actions → Copy As JavaScript
photoshop: 25.3.1
date: 2026-09-28
helped: 0
failed: 0
---

## What works

Make the layer active, then set the selection to its mask:

```js
{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }
{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }],
  to: { _ref: "channel", _enum: "channel", _value: "mask" } }
```

`"mask"` means the mask of the active layer. Recorded on a hidden layer — the layer does
not have to be visible.

## A recorded form to avoid

When the mask thumbnail was already clicked, so the mask was the targeted channel,
Photoshop recorded `to: { _ref: "channel", _enum: "ordinal", _value: "targetEnum" }` —
"whatever channel is targeted now". From a script you rarely know that, and with the image
targeted you would load something else. Use `_value: "mask"`.

## What did not work

In an agent run, five attempts with the selection written as a channel value —
`_target: [{ _ref: "channel", _enum: "channel", _value: "selection" }]` — and the mask and
layer wrapped as `to: { _ref: [ { mask }, { layer } ] }` were all rejected with "The command
“Set” is not currently available". The selection is a *property* of the channel reference
(`_property: "selection"`), and the layer is chosen by selecting it first.
