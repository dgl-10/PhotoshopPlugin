---
id: generator-moderation-crop
title: Choose the capture so the piece passes a generator's moderation
problem: choosing the selection and padding for from_ps_capture when the picture has nudity, underwear or swimwear, so a public generator or chatbot does not refuse the piece
confidence: agent-written
task: written by an agent from the author's stage 3.5 task description and the plugin's capture code; not tried in Photoshop or with a generator yet
photoshop: unknown
date: 2026-10-09
helped: 0
failed: 0
---

## Not tried yet

What generators refuse comes from the author's task description; how the capture box grows
comes from the plugin's code (`captureSelectionInModal` in `modules/ps.js`).

## The trap: the piece is bigger than your selection

A selection that avoids the sensitive zone does not prove the piece avoids it.
`from_ps_capture` first adds `padding` on every side, then grows the box to the smallest
box of an allowed aspect ratio that holds it: 1:1 always, plus the ratios enabled in the
panel's settings. The box stays centred on the selection and is pushed inward at the
canvas edge. The growth goes along the short side, so a tall, narrow selection of a hand
grows sideways — often straight into the body you kept out.

So look at the piece after a capture (`from_ps_get_capture`). If a trigger got in, capture
again; earlier pieces stay in the FromPS card, so tell the person which one is the good one.
Because the box stays centred, extending the selection on the safe side moves the growth
there, and a selection already close to an allowed ratio leaves little to grow.

## Why a box with a margin usually beats an outline

The generator needs the anatomy and the light around the area to redraw it consistently.
And `to_ps_place_back` uses the capture's selection as the mask of the result, so a tight
outline of the old fingers would clip new fingers that come out in a slightly different
place. An ellipse can keep a corner of the box away from a trigger.

## Cut the triggers out

Ask what the generator must see for this one request, and leave everything else out: only
the head for a new hairstyle, only the hand, held away from the body, for the fingers.
Underwear and swimwear count as triggers, not only nudity. They have to stay out of the
whole piece, edges included, not just out of your selection.

## padding

`padding` is a minimum, not the final margin: the aspect-ratio growth comes on top of it,
so `padding: 0` does not give a tight crop. The default 50 px is a lot around a small
selection near a trigger — a small hand a few dozen pixels from the body. A smaller
`padding`, with the context put into the selection itself on the safe sides, keeps the
piece where you want it.

## full_document

It sends the whole picture, with the selection only as its mask — everything the crop was
meant to cut out. With a sensitive zone in the picture it is the surest way to be refused.

## When no crop keeps the zone out

When the area to fix touches the zone — a hand resting on a bare body — erasing the zone to
transparency (`keep_transparency`) is a poor way out: many models handle a PNG with holes
badly. Cover the zone instead: `generator-moderation-cover-layer`.
