---
id: generator-hands-and-feet
title: Redraw a hand or a bare foot with an image generator
problem: a hand or a bare foot in a medium or long shot looks puffy, swollen or soft — generators rarely draw them well even when the fingers are right — redrawing it: the capture, a short prompt that always says whose hand it is (a man's, a woman's, a child's) and which one (left or right), and fixing the result with short corrections in plain words
confidence: agent-written
task: the author's experience with image generators, written up by an agent; agent runs task-a7be42, task-8d8117, task-c1ee68, task-5d4caa
photoshop: any — this is about the generator, not Photoshop
date: 2026-10-25
helped: 0
failed: 0
---

## What is usually wrong

In a medium shot, and in a long one, generators draw hands a little puffy, swollen or soft.
The shape is usually right — extra or missing fingers are rare now — but the hand looks
poor next to the rest of the photograph. Bare feet suffer the same way; feet in shoes do
not. So a hand in a medium shot often needs redrawing even when nothing is plainly wrong
with it.

When you are asked to finish or improve a photo with people in it, look at the hands and
bare feet on a full-size close-up, and offer to redraw the ones that look like this.

## Capture

The whole hand with the wrist and part of the forearm, plus a margin: the arm tells the
generator which hand it is and how it is turned. A box or an ellipse, not an outline
(`generator-moderation-crop` says why). When two hands touch, capture them together.

Not an outline even when the face or the other hand is close: keep the box or ellipse clear
of it on that side, with less margin there if need be. A selection cut to the old hand — by
hand, with Select Subject or with an AI mask (`select-with-ai-inpaint-mask`) — becomes the
mask of the result: it clips the new fingers and leaves pieces of the old ones showing. In
task-5d4caa an agent did this to keep the face safe, and the person had the mask redone as
a loose ellipse.

## Read the hand first

Before the first prompt, have the vision sub-agent read the hand with block 1 of
`generator-hands-and-feet-side-and-pose`, passed on word for word. That article also says
which of its answers go into the prompt. From a small piece a generator cannot tell whose
hand it is, which one, or how it is turned; the vision sub-agent sees the whole picture.

## The prompt

```text
Redraw the woman's right hand in this image in high quality: natural proportions, the
visible fingers and knuckles clearly drawn, not puffy or swollen. Keep the same pose,
position and size, do not mirror it, and keep the nail polish, rings and other details of
the hand as they are. Keep everything else exactly as it is; the hand must match the
colours, light and tone of the rest of the picture.
```

- **Always say whose hand it is and which one:** a man's, a woman's or a child's, left or
  right — never the hand's place in the frame ("the hand on the right"). When two people
  are close, name the one it belongs to: "the man's right hand, the man on the left".
- **When the piece does not show how the hand is turned** (block 1, line 6), add what faces
  the camera and what is nearer, farther or hidden — only what the vision sub-agent is sure
  of, and relative to the camera.
- **Fingers that are drawn wrong are not kept.** When the hand only looks poor — puffy,
  soft — keep the pose and the fingers as they are. When the fingers themselves are wrong —
  grown together, an extra stub, a joint bent the wrong way — keep only where the hand is,
  which way it is turned and how it meets the wrist. Do not ask to keep how the fingers
  lie: that is most likely what was generated wrong. Ask for fingers that are right for
  this pose instead: "The fingers are drawn wrong — draw them anew, natural for this pose;
  keep the hand where it is and turned the same way." Not "all five fingers": how many
  show is up to the pose — a hand on the hip or round a basket hides some.
- **When the hand is partly hidden** — behind clothing, an object, the other hand — say
  what covers it and that it stays covered exactly as now. Otherwise the generator tends
  to change what is in front: in task-8d8117 it did so twice.
- **Keep nail polish and rings in the prompt:** generators drop them. In task-a7be42 the
  polish came back missing from some nails.
- **Plain words.** No anatomy terms (joint names, "radial", "dorsal"), no long lists of
  constraints, no demand that every finger shows.

For a foot, the same with "bare foot" and "toes": "the man's right bare foot".

## Fixing the result

After every attempt, have the vision sub-agent check it with block 2 of
`generator-hands-and-feet-side-and-pose`. Then give the generator the latest result — not
the original again — with a short correction that names what is visibly wrong, in plain
words:

```text
The two middle fingers have grown together — separate them. Remove the stub inside the
palm; the thumb can stay hidden.
```

Do not start over with a longer prompt. The author fixed such a hand this way in two short
corrections, where an agent's long, precise prompts had failed three times. Small changes to
the hand's size, how open it is, or the cuff are fine when the hand looks natural in the
picture.

Two or three attempts are enough. If the hand is still wrong, show the person the best one
and say what is still wrong.

## The Gaussian Blur under the placed layer

`to_ps_place_back` puts a light Gaussian Blur smart filter on the new layer; its answer
gives the radius. For a hand it is sometimes a little too much. Look at the hand in the
picture as a whole and decide whether it looks too soft; if it does, lower the radius a
little. Do not match it to one particular spot: sharpness in a photo changes with distance,
and one hand can be near the camera and the other far. Raising the radius is almost never
needed.

Applying `gaussianBlur` again would add a second filter, not change the first. Change the
one Place Back added — it is the only smart filter on the new layer, so `_index: 1`:

```js
{ _obj: "select", _target: [{ _ref: "layer", _id: placedId }], makeVisible: false }
{ _obj: "set",
  _target: [{ _ref: "filterFX", _index: 1 }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
  filterFX: { _obj: "filterFX", filter: { _obj: "gaussianBlur", radius: { _unit: "pixelsUnit", _value: newRadius } } } }
```

`newRadius` is yours to choose: a little below the radius the `to_ps_place_back` answer
gave, decided by looking at the hand. Recorded by the author (`filter-commands` has the
general form).

## Check

Block 2 of `generator-hands-and-feet-side-and-pose` finds nothing wrong, and on a
full-size close-up: a hand that fits that person — a man's, a woman's, a child's; nail
polish and rings still there; not too soft for the picture; the wrist meets the arm at the
border; the tone matches the surroundings (`placed-piece-tone-match`). Never flip the layer
to fix the side.
