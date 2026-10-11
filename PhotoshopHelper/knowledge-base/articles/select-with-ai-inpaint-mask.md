---
id: select-with-ai-inpaint-mask
title: Select hair, fur, smoke or lace with a mask an image generator draws
problem: selecting hair, fur, smoke, lace or another object with a fine or see-through edge that Select Subject and Color Range do not separate well — an image generator draws a black-and-white mask of the capture, Place Back puts it in as an inpaint mask, and that layer becomes the selection
confidence: agent-written
task: written by an agent from the owner's description and the plugin's capture, Place Back and CLI generation code; not run end to end yet
photoshop: unknown
date: 2026-10-09
helped: 0
failed: 0
---

## Not tried yet

Nobody has run this whole flow yet. Two parts are known to work: `inpaint_mask` is the
panel's own Custom Inpaint Mask, and loading its layer as a selection with the form in
step 6 was verified in a real run. The prompt, the generation step and the way the capture
reaches the generator are **not verified**.

## When to use it

When Photoshop's own selection tools (`select-subject-and-color-range`) leave a chopped,
hard edge on an object that has none — hair, fur, smoke, lace, a veil — a generator can
draw the mask. Select and Mask, Photoshop's own tool for such edges, cannot be run from a
script (`workspaces-that-cannot-be-scripted`), though the person can run it.

## Who draws the mask

That depends on which agent you are:

- **Codex, Antigravity.** You have a built-in image generation tool on the person's
  subscription. Use it for the mask without asking for permission (step 4).
- **Grok.** You have one too, but it draws poor masks. Do not use it here; work as the next
  point says.
- **Any other agent** (Claude Code has no image generator at all, and the rest). Give the
  person the prompt and the
  capture's number in the FromPS card. They drag the piece from there into their own
  chatbot or generator, or send it to the panel's WebHelper. When the mask is back, they
  put it into the ToPS card themselves (Paste or Load File) and tell you, or give you the
  file's path for `to_ps_load_file`.

The paid `gen_` tools of this server are not part of this flow. Use them only when the
person asks for them.

## 1. Select roughly, with a margin

A plain box around the whole object with some of its surroundings is enough; finding the
edge is the generator's job. Every strand that should end up selected has to be inside it:
nothing outside the capture can be in the mask. The whole piece becomes one mask, so the
less there is around the object, the finer its strands come out — which is why
`full_document` rarely suits this.

## 2. Capture

`from_ps_capture` with the default `source` `"visible"`. Keep the capture id: Place Back
goes over the same capture. Look at the piece with `from_ps_get_capture`, so the prompt
names what is really in it. That copy is reduced and is for your eyes only. What goes to a
generator is always the original piece, never this copy.

## 3. The prompt

An example for hair:

```text
Make a black-and-white mask from this image. Paint the woman's hair pure white: all of it,
including the thin loose strands and flyaways at its edge and the hair lying over her
shoulder. Paint everything else pure black: her face, skin and clothes, and the whole
background. Where strands are thin or see-through, let the white fade softly into the
black instead of cutting a hard outline. Keep exactly the same framing, composition and
aspect ratio as this image: do not move, scale, crop, rotate, extend or add anything, so
the mask lies exactly over the original. Output only the flat mask: no colours, no
shading, no texture, no outlines, no text, and nothing else from the picture.
```

Adapt the sentences about the object. Name it as it looks in this piece, and where it
is when there are two alike ("the hair of the woman on the left"). Name the parts that
belong to it (loose strands, the tips of the fur, the thin edges of the smoke) and what
touches it that must stay black. For lace, say that the holes are black.

## 4. Generate it yourself (Codex, Antigravity)

With your built-in image tool, the way this Helper's own generation through Codex and
Antigravity works (the paid `gen_` tools only if the person asks):

- Give it the capture as the picture to edit: a file, by its absolute path. Get that file
  with `from_ps_get_capture` and `save_to_file: true`: it saves the original piece and
  returns its path. The reduced copy you looked at is not for the generator. Pass the mask
  prompt as it is.
- If the tool takes an aspect ratio, give it the ratio the `from_ps_capture` answer named,
  such as 3:2.
- `to_ps_load_file` takes PNG or JPEG, so ask for one of those, and keep the absolute path
  of the file the tool saved.

Look at the mask before you load it: black and white, grey only along the soft edges, the
object white, nothing moved and nothing added. If it is wrong, see "When the mask is not
right" below.

## 5. Place it back as an inpaint mask

`to_ps_load_file` with the mask's path (or the person loads it), then `to_ps_place_back`
with the same `capture_id` and `mode: "inpaint_mask"`. Place Back fits the mask into the
capture's box, whatever size it came at. `feather` does nothing in this mode. The answer
names a new hidden layer `[ai mask] …` and gives its id.

## 6. Load it as the selection

Select that layer by id and set the selection to its transparency, as Ctrl+click on its
thumbnail does:

```js
await action.batchPlay([
    { _obj: "select", _target: [{ _ref: "layer", _id: aiMaskLayerId }], makeVisible: false },
    { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }],
      to: { _ref: "channel", _enum: "channel", _value: "transparencyEnum" } }
], { synchronousExecution: true });
```

The white of the mask is now selected, partly selected where it was grey. The form in
`mask-load-as-selection` (`_value: "mask"`) is not this one: it loads a layer mask, and this
layer has none. Do not inspect, read or measure the `[ai mask]` layer; it works as it is.
Leave it hidden where it is: loading it again gives the same selection.

Then look at the selection with `ps_get_image`, `target: "selection"` and the capture's box
as `bounds`, next to the document over the same box. The white must lie on the object,
strands included. Anything outside the box is not selected.

## When the mask is not right

Expect it: a good mask often takes two or three generations, not one.

- **Look, then name what is wrong.** Compare the mask, or the selection after step 6, with
  the piece itself, part by part. Say in plain words what was left black that belongs to
  the object, and what is white that does not. Typical misses: strands lying over the face
  or a shoulder, hair seen through a gap between an arm and the body, a bun or a tail
  behind the head, the thin tips at the edge. And the other way round: a dark background or
  a shadow taken for hair.
- **Try the same prompt once more.** Generation is not repeatable; a second run is
  sometimes simply better.
- **Then make the prompt specific.** The first prompt names the object; the next one also
  names what the last mask got wrong, and where: "Also paint white the strands that cross
  her left cheek and the hair visible between her right arm and her body. Keep the dark
  shadow on the wall behind her black." Point at places by what is there and where it is
  in the picture — over the shoulder, along the right edge — not by pixel coordinates.
- **When the person generates** (see "Who draws the mask"), do the same for them: look at
  the mask they brought back, and give them the next prompt with these corrections.
- **Keep the best, not the last.** Keep the paths of the earlier masks; any of them can be
  loaded and placed back again.

The generated mask does not have to be the end either. When it is close but not right,
take the best one as a starting point and finish the selection whichever way suits the
case: Photoshop's own selection commands, combining it with another selection, your own
code over the mask's pixels (the saved mask file, or the selection read with
`imaging.getSelection` and written back with `imaging.putSelection`, as `modules/ps.js`
does), or Select and Mask in the person's hands. Agents have finished hard selections this
way when generation alone fell short. One thing worth knowing if you read the selection as
pixels: `getSelection` may hand back a tighter box than you asked for; use the
`sourceBounds` it returns.

## 7. Use the selection

From here it is an ordinary selection; use it as the task needs. If you make a layer mask
from it, this is the descriptor the plugin's own Custom Inpaint Mask code runs inside the
`[ai mask]` smart object (`modules/ps.js`); it has not been run by an agent on an ordinary
layer:

```js
{ _obj: "make", at: { _ref: "channel", _enum: "channel", _value: "mask" },
  new: { _class: "channel" }, using: { _enum: "userMaskEnabled", _value: "revealSelection" } }
```
