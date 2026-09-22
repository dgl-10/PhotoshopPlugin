---
id: open-filter-dialog-for-the-person
title: Open a filter dialog for the person, when they asked for it
problem: the person asked to have a filter dialog (Camera Raw, Liquify…) opened so they can work in it themselves
confidence: author-verified
task: verified by the author in Photoshop
photoshop: 25.3.1
date: 2026-09-22
helped: 0
failed: 0
---

## Only on request

Do this only when the person asked to have the dialog opened for them. Otherwise apply the
command yourself, silently, with values you choose — names and parameters are in
`filter-and-adjustment-commands`.

## The pattern

```js
return await action.batchPlay([{
    _obj: "<command>",
    _options: { dialogOptions: "display" }
}], {});
```

Run it through `ps_execute_script` with `interactive: true`. The call waits while the
person works in the dialog and presses OK or Cancel; if it answers that the dialog is still
open, wait with `ps_wait_for_dialog` and do not open it again.

Without `dialogOptions: "display"`, or without `interactive: true`, a command applies
silently with whatever values it carries — a recording included.

## Verified

- **Camera Raw** — `_obj: "Adobe Camera Raw Filter"`. On OK, `batchPlay` returns exactly the
  settings the person changed; they can be replayed silently elsewhere (`camera-raw-filter`).
- **Liquify** — `_obj: "$LqFy"`. On OK it returns `[{ "$LqMe": {} }]`: the mesh does not come
  back in a usable form, so a Liquify result cannot be replayed by the agent. A Liquify
  recording carries the mesh as a large base64 blob — do not try to build one.
  `_obj: "liquify"` does **not** work: Photoshop shows the person the alert
  `The command "<unknown>" is not currently available` and returns -128.

Other names in `filter-and-adjustment-commands` are confirmed as names, but opening them as
a dialog this way was only tried for the two above.

## Reading -128

`{ _obj: "error", message: "", result: -128 }` from an interactive call means the person
pressed Cancel, cancelled the plugin command, or Photoshop could not open the dialog and
showed them an alert instead. The answer does not say which — ask the person. `<unknown>` in
such an alert means the command name is wrong.
