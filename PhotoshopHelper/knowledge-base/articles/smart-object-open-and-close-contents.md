---
id: smart-object-open-and-close-contents
title: Open a smart object's contents, look inside, and close it again safely
problem: opening a smart object's contents from a script (also a nested one) and closing them again - placedLayerEditContents, making sure the contents really opened before closing anything, and the closed document's stale reference
confidence: author-verified
task: agent article from task-8861fc, rechecked in Photoshop 25.3.1 by an agent run at the author's request
photoshop: 25.3.1
date: 2026-11-11
helped: 0
failed: 0
---

## Open

With the smart object layer selected:

```js
const parentDoc = app.activeDocument;
const result = await action.batchPlay([{
    _obj: "placedLayerEditContents",
    _options: { dialogOptions: "dontDisplay" }
}], { synchronousExecution: true });

const soDoc = app.activeDocument;
if (result[0]?._obj === "error" || soDoc.id === parentDoc.id) {
    throw new Error("The smart object contents did not open");
}
```

The contents open as a separate document (a `.psb`), and it becomes the active document.
For a nested smart object, select its layer inside `soDoc` and do the same again.

## Make sure it opened before you close anything

batchPlay does not throw when Photoshop refuses a command: the refusal comes back as
`{ _obj: "error" }` in the returned list. In an agent run (2026-11-11, Photoshop 25.3.1)
`placedLayerEditContents` on a nested layer was refused with -25920, `app.activeDocument`
was still the person's document, and the next line - `closeWithoutSaving()` on what was
meant to be the smart object - closed the person's document without saving. Compare the
ids as above before every close; `modules/ps.js` does the same check.

## Close

Keep changes by saving the contents first - `modules/ps.js` does
`{ _obj: "save", _options: { dialogOptions: "dontDisplay" } }` - or close without saving
when you only looked:

```js
await soDoc.closeWithoutSaving();
app.activeDocument = parentDoc;
```

Close from the innermost document outwards and make the working document active again at
the end. Put the walk in `try`/`finally` so that what you opened is closed even when a step
fails - and close only documents whose ids you recorded when they opened.

In 25.3.1 Photoshop made the parent document active by itself after the close, and a
following batchPlay on `targetEnum` worked. What failed was any use of the closed `soDoc`
object ("The document with an id of … does not exist.") and batchPlay aimed at the
closed document's id (-25922). The explicit `app.activeDocument = parentDoc` costs nothing
and does not depend on which document Photoshop happens to pick.

Not rechecked: closing a nested child and then its parent.
