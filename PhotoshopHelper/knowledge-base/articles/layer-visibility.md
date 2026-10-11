---
id: layer-visibility
title: Show and hide layers, including every layer of one kind
problem: hiding or showing layers, walking the layer tree including groups
confidence: author-verified
task: seeded from the plugin's own code
photoshop: 24.0 and later
date: 2026-09-20
helped: 0
failed: 0
---

## Use the DOM

Visibility is one of the few things the DOM does properly, and it needs no descriptor:

```js
layer.visible = false;
```

It works on a group too, and hiding a group hides everything inside it.

## Finding the layers

`doc.layers` is only the top level. Groups have their own `layers`, so walk the tree:

```js
function walk(layers, found = []) {
    for (const layer of layers) {
        found.push(layer);
        if (layer.layers && layer.layers.length) walk(layer.layers, found);
    }
    return found;
}
```

## Telling kinds apart

`layer.kind` is a string from `constants.LayerKind`. The values worth knowing:
`text`, `normal` (a pixel layer), `group`, `solidFill`, `gradientFill`, `smartObject`,
`brightnessContrast`, `curves`, `levels`, `hueSaturation` and the rest of the adjustment
kinds — each adjustment type is its own kind, so "is this an adjustment layer" is not one
comparison.

So, hiding every text layer:

```js
const hidden = [];
for (const layer of walk(doc.layers)) {
    if (String(layer.kind) === 'text' && layer.visible) {
        layer.visible = false;
        hidden.push(layer.name);
    }
}
return hidden;
```

Return the names, not just a count: the person reads your report, and "hid Title, Subtitle,
Caption" tells them whether you got the right ones.

## The descriptor version

If you need it inside a longer `batchPlay` sequence:

```js
{ _obj: 'hide', _target: [{ _ref: 'layer', _id: layerId }] }
{ _obj: 'show', _target: [{ _ref: 'layer', _id: layerId }] }
```

## Source

Adobe's UXP documentation for the `Layer` class, and the layer walking this plugin does in
`modules/ps.js`.
