---
id: restore-the-persons-selection
title: Borrow the selection and give it back
problem: an operation needs the selection changed, but the person had their own selection
confidence: author-verified
task: seeded from the plugin's own code
photoshop: 24.0 and later
date: 2026-09-20
helped: 0
failed: 0
---

## Why this matters

The selection belongs to the person. Loading a channel, selecting a layer's transparency
or running a command that needs a selection all throw away what they had marked out, and
they will not thank you for it.

## The clean way: roll it back

If you only needed the selection in order to read something, suspend history, do the work,
and resume without committing. The document — selection included — goes back to where it
was:

```js
const suspensionId = await executionContext.hostControl.suspendHistory({
    documentID: doc.id,
    name: 'Agent: read a channel'
});
try {
    await doc.selection.load(channel);
    // read what you needed
} finally {
    await executionContext.hostControl.resumeHistory(suspensionId, false);  // false = roll back
}
```

## The other way: put it back by hand

When you genuinely changed the document and cannot roll back, save the selection first and
write it back afterwards:

```js
// Save: a grayscale image of the selection, and where it sat.
const saved = await imaging.getSelection({ documentID: doc.id });

// Restore.
await imaging.putSelection({
    documentID: doc.id,
    imageData: saved.imageData,
    replace: true,
    targetBounds: { left: saved.sourceBounds.left, top: saved.sourceBounds.top }
});
```

`getSelection` trims its result to the part of the canvas that actually has selected
pixels, so keep `sourceBounds` — without it you will put the selection back in the wrong
place. Call `dispose()` on the image data when you are done with it.

## Source

`modules/ps.js` in this plugin saves and restores the selection this way around every
capture.
