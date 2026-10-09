---
id: generator-moderation-cover-layer
title: Cover a sensitive zone on a temporary layer for the capture, and keep it out after Place Back
problem: the area to fix touches nudity, underwear or swimwear, so no crop keeps it out of the piece for a public generator — cover it with a flat colour on a temporary top layer, then keep the covered area out of the placed result
confidence: agent-written
task: written by an agent from the author's stage 3.5 task description and the plugin's capture and Place Back code; in task-be788b the cover, the capture and the place back worked, and the agent skipped the cut-out step below — the person had to fix the mask by hand
photoshop: unknown
date: 2026-10-09
helped: 0
failed: 0
---

## The trap: hiding the cover is not enough

`to_ps_place_back` masks the new layer with the capture's selection, and that selection
runs over the covered area. The generator has redrawn your cover there, as a top or a shirt
or as skin — whatever it made of it. Hide the cover, and what it drew stays in the document,
on the new layer. Cut the covered area out of the new layer's mask as well.

This holds even when the result looks clean in a reduced view: in task-be788b the generator
painted plain skin over the cover, the agent judged by eye that the seam was fine and
skipped the cut, and a strip of generated skin stayed in the picture over the original.

Cutting the cover out of the selection before the capture is not enough on its own either:
Place Back's `outward` and `center` feather put all or half of the soft edge outside the
selection, back over the covered area.

## Why a cover and not a hole

A piece with the zone erased to transparency is a PNG with holes, and many models handle
that badly. A flat colour shaped roughly like clothing gives the generator an ordinary, safe
picture. Make it look like outerwear, a top or a T-shirt, not like a bra or a bikini:
underwear and swimwear are refused too.

## 1. Paint the cover

A temporary top layer with a flat, opaque colour over the zone, with a margin, shaped
roughly like clothing. Leave the area to fix uncovered: the generator cannot redraw what is
under the cover. It has to sit above every layer that shows in the box. Keep its id, name it
so the person recognises it, and tell them what the patch is: it stays in their document
until you hide it.

How you paint it is up to you. Two things known here: `doc.createLayer({ name })` makes the
layer (`modules/ps.js` does this); the `fill` descriptor in `mask-write-pixels` was recorded
with a mask targeted — on a pixel layer it is the same Edit → Fill, but it has not been run
there yet.

Paint the cover before you make the capture selection: painting it usually replaces the
selection.

The person may do it better: when you cannot see the image, when the cover's edge has to
follow the very fingers that must be redrawn, or when they would rather paint it, ask them
for a new top layer with a flat colour, and for its name.

## 2. Capture with the cover visible

`from_ps_capture` with `source` `"visible"`, the default, takes the cover along;
`"current_layer"` would leave it out. The piece is larger than your selection, so look at
its edges for anything uncovered (`from_ps_get_capture`).

## 3. After to_ps_place_back: cut the covered area out of the new mask

With the new layer's id from the answer:

- The cover's shape as a selection is Ctrl+click on its thumbnail, which from a script is
  this form (verified on a layer without a mask):

  ```js
  { _obj: "select", _target: [{ _ref: "layer", _id: coverId }], makeVisible: false }
  { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }],
    to: { _ref: "channel", _enum: "channel", _value: "transparencyEnum" } }
  ```

- Grow it by at least the mask Feather the answer reports. That feather stays live and
  softens every edge of the mask, including the one you are about to make, so whatever the
  generator drew there would show at partial strength along it. Where the cover meets the
  fixed area, the same width of the fix goes too, so look at that seam.
- Fill that part of the new layer's mask with black. Writing it with `imaging.putLayerMask`
  is the case where the image may not update: the layer already has its mask from Place
  Back. `mask-write-pixels` has a way with ordinary commands that redraws.
- Hide the cover rather than delete it until the person is happy: another attempt needs the
  same cover.

Then check: where the cover was, the original picture must show again. The generator may
have drawn a little past your shape. You may also want to narrow the rest of the mask to
the part that was really fixed.
