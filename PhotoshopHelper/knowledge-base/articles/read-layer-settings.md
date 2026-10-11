---
id: read-layer-settings
title: Read everything about a layer, including text and adjustment settings
problem: the DOM does not show a layer's text, adjustment values or effects
confidence: author-verified
task: seeded from the plugin's own code
photoshop: 24.0 and later
date: 2026-09-20
helped: 0
failed: 0
---

## The problem

The Photoshop DOM gives you a layer's name, kind, visibility, opacity, blend mode and
bounds, and stops there. What a text layer says, what a Curves layer's curve is, what
effects are on a layer — none of that is on the `Layer` object.

## What works

Read the layer's action descriptor with a plain `get`. It changes nothing, it does not
dirty the document and it does not create a history step:

```js
const [descriptor] = await action.batchPlay([{
    _obj: 'get',
    _target: [
        { _ref: 'layer', _id: layerId },
        { _ref: 'document', _id: doc.id }
    ]
}], { synchronousExecution: false });
```

Useful keys in what comes back:

| key | what it is |
| --- | --- |
| `layerKind` | a number: 1 pixel, 2 adjustment, 3 text, 5 shape, 7 group, 17 smart object |
| `textKey` | the whole text engine block of a text layer, including the string and the styling |
| `adjustment` | the settings of an adjustment layer, for example the curve of a Curves layer |
| `layerEffects` | layer styles |
| `hasUserMask`, `hasVectorMask`, `hasFilterMask` | which masks exist |
| `bounds`, `boundsNoEffects` | with and without effects |
| `mode`, `opacity`, `fillOpacity` | blending |

`ps_get_layer` already does this call for you and returns the interesting parts. Use
`ps_execute_script` with the snippet above when you need a key it does not return.

## Reading the same thing for the active layer

Instead of an id you can point at the current layer:

```js
_target: [
    { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }
]
```

## Source

This plugin reads layers this way in production, and the stage 2 testbench measured `get`
at roughly 15 to 30 ms across the bridge — it is the cheapest call there is.
