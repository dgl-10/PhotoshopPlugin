---
id: one-history-step-per-script
title: Make a whole script one step in the History panel
problem: your changes fill the History panel with a dozen entries, or the person cannot undo your work in one go
confidence: author-verified
task: seeded from the plugin's own code
photoshop: 24.0 and later
date: 2026-09-20
helped: 0
failed: 0
---

## What happens by default

Every `batchPlay` call you make lands in the History panel as its own step. A script that
creates a layer, sets its blend mode and adds a mask leaves three or four entries with
Photoshop's own names, and the person has to press undo several times to get rid of them.

## What to do

You do not have to do anything: `ps_execute_script` already wraps your code in a history
suspension named after the `history_name` you passed. That is why the tool asks for a name
in plain words — it is what the person reads in their own History panel.

This is what the plugin does around your code:

```js
await core.executeAsModal(async (executionContext) => {
    const suspensionId = await executionContext.hostControl.suspendHistory({
        documentID: doc.id,
        name: 'Agent: hide 5 text layers'
    });
    try {
        // your code
    } finally {
        await executionContext.hostControl.resumeHistory(suspensionId);
    }
}, { commandName: 'Agent: hide 5 text layers' });
```

## What this does not do

The suspension only holds inside one modal scope. Two separate `ps_execute_script` calls
are two separate history steps, and there is no way to merge them afterwards. So put
everything that belongs to one visible change into one call, and give it a name that says
what changed.

`resumeHistory(suspensionId, false)` rolls the document back to where it was instead of
committing. That is how a read-only operation that has to disturb the document — loading a
channel as a selection, for instance — puts everything back.

## Source

Adobe's UXP documentation for `executeAsModal`, section "History state suspension", and
the code of this plugin's own agent tools.
