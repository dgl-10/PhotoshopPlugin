# Working with a Photoshop document

These rules are handed to you by `ps_start_task` and can change between tasks. Do not
rely on cached or remembered versions; always follow the text returned for this task.


## Look, change, check

In that order, every time.

- **Look first.** Read the document (`ps_get_document`) and look at the image
  (`ps_get_image`) before you plan your work or open the knowledge base. Until you have
  seen the layer tree and the picture with your own eyes, you do not know what the task
  actually needs. A script written against a guess about the layer tree or the picture is a
  script that damages something.
- **Change** through `ps_execute_script`, one clear step at a time, with a history name a
  person would understand.
- **Check.** If the result is something a person judges by eye — colour correction,
  filters, blending, masks, retouching — take a picture with `ps_get_image` and look at it
  yourself. Numbers and descriptors prove that a command ran, not that it looks right. The
  tokens this costs are being spent on purpose.

If you cannot see the image — if your client did not show it to you — say so plainly. Do
not work out what is in the document from layer names and present the guess as fact.

## Eyes find, pixels measure

`ps_get_image` is not only for checking a result. It is how you find out what is where —
and also how easily you fool yourself about exactly where.

- **Your eyes are for understanding and rough position.** On a reduced picture one of its
  pixels is several document pixels — the caption gives the scale. When a position has to
  be right, take the region again with `bounds` at full size and look closely.
- **Exact geometry comes from the pixels, not from your estimate.** When the job depends on
  an edge or a distance — follow the outline of an object, keep N pixels away from it, place
  something along a contour — first get that edge as data: a selection (Select Subject,
  Color Range, or an AI-drawn inpaint mask), a mask, or your own analysis of
  `imaging.getPixels` in a script. Compute the contour and the offset from that data, then
  draw. Use your eyes to confirm that the data is the right object.
- **Marks the person drew — arrows, circles, scribbles — show intent and a rough place.**
  They are not coordinates to trace. When it is unclear what exactly they point at, ask.
- **Do not report a measurement you did not take.** "50 px from the edge" in your report
  means you measured it on a close-up after drawing. Otherwise say it is approximate.

## Adjustment layers first, filters only where there is no other way

Tone and colour — exposure, contrast, curves, levels, colour balance, hue and saturation,
split toning, black and white — go into adjustment layers, even when Camera Raw could do
the same. An adjustment layer stays separate from the picture: the person can switch it
off, tune it, or replace the picture underneath and keep the whole look. A filter is tied
to the one layer or smart object it sits on.

Use a filter only for what no adjustment layer can do: blur, sharpening, noise reduction,
grain, texture, clarity, dehaze, distortion. And give that filter only those settings — do
not move tone and colour into it just because it has sliders for them.

## Selections, cutouts, and FromPS / ToPS

For cutting out an object or making a selection from a script, start by checking what
Photoshop's own tools give you (`select-subject-and-color-range`), and look at the edge
with `ps_get_image`. When the edge is fine or see-through — hair, fur, smoke, lace — and
comes out chopped, refine that selection with Select and Mask, Refine Hair included
(`select-and-mask`), and look again. When it is still wrong, or the selection misses whole
parts of the object, an image generator can draw a black-and-white mask of a capture and
`to_ps_place_back` (`mode: "inpaint_mask"`) turns it into the selection: see
`select-with-ai-inpaint-mask`.

The `from_ps_` and `to_ps_` tools are for your own work as much as for the person's — you
do not need to wait for the person to name the FromPS / ToPS panel:

- **To redraw, fix or replace part of the picture with an image generator**, select the
  area with a margin, capture the original piece with `from_ps_capture` and look at it once
  as its description says (and use `from_ps_get_capture` with `save_to_file: true` when you
  generate yourself, or let the
  person drag it from the FromPS card), then put the result back into the exact box as a
  masked smart object with `to_ps_load_file` and `to_ps_place_back`. Write the prompt the
  usual way for image edits: what to change, then that everything else stays as it is, with
  the same colours, light and tone — for example, "Redraw the woman's left hand in high
  quality: natural proportions, not puffy or swollen. Keep everything else exactly as it is;
  the hand must match the colours, light and tone of the rest of the picture." Hands and bare feet have
  their own article (`generator-hands-and-feet`). After placing, look at the border and
  correct a tone shift with adjustment layers clipped to the new layer
  (`placed-piece-tone-match`).
- **To get a clean selection or cutout of a hard edge**, capture the object and place the
  generated black-and-white mask back with `mode: "inpaint_mask"`
  (`select-with-ai-inpaint-mask`).
- **When the area is near nudity, underwear or swimwear**, read
  `generator-moderation-crop` and `generator-moderation-cover-layer` before you capture so
  a public generator does not refuse the piece.

Who generates depends on which agent you are:

- **Codex, Antigravity, Grok.** You have a built-in image generation tool on the person's
  subscription. Generate with it yourself, without asking for permission: give it the
  original piece as the picture to edit — `from_ps_get_capture` with `save_to_file: true`
  saves it and returns its path — and, if the tool takes an aspect ratio, the one the
  `from_ps_capture` answer named. Ask for PNG or JPEG and load the saved file with
  `to_ps_load_file`. One exception: Grok draws poor black-and-white masks, so for a mask
  Grok works as the next point says (`select-with-ai-inpaint-mask`). If your tool refuses
  because a generation limit is reached — Antigravity has one — do not retry and do not
  switch to paid generation on your own: tell the person the limit was reached and work as
  the next point says.
- **Any other agent** (Claude Code has no image generator at all). Give the person the
  prompt and the capture's number in the FromPS card. They drag the piece into their own
  chatbot or generator, or send it to the panel's WebHelper, and then put the result into
  the ToPS card themselves or give you the file's path for `to_ps_load_file`.

If the person gave you a picture to follow — the real object, a pattern, a logo — it goes
to the generator together with the piece, never retold in words. The prompt says which
picture is to be changed and which one shows how it should look. When the person
generates, tell them to attach that picture too.

Paid generation is only for when the person asks for it: the `gen_` tools of this server,
and any other paid image generator connected to you, even when its own description tells
you to prefer it over your built-in one.

## What the person is doing at the same time

The person is working in Photoshop while you are. Every answer ends with a state line,
and you should read it:

- **The person did something by hand.** Take it into account; your idea of the document
  may be out of date. Look again.
- **The person undid your work, or went back to a snapshot.** Do not repeat it blindly.
  Work out why, or ask.
- **The document changed or was closed.** Stop and tell the person. The task is tied to
  the document it started on; it does not follow them to another one.

Warn the person before you start something long, so they know why Photoshop has gone busy.

## Mouse, keyboard and the screen

Some agents can control the screen; most command-line ones cannot, and there is no way for
us to tell which you are. So this is a rule, not a setting. It is not a ban — the two ways
complement each other, they just have different places.

- Anything that can be done with these tools, do with these tools. A script is faster and
  more reliable, it lands in the document's history, and it appears in the report. Clicks
  do none of that.
- If it looks like only the mouse will do, check first. A menu item can be invoked by its
  command, and a filter — Camera Raw, a blur, sharpening — can be applied by a script with
  values you choose. Do that yourself: your job is to do the work, not to hand the person
  a dialog so they do it for you.
- Open a dialog in front of the person (`ps_execute_script` with `interactive: true`, the
  command inside with `_options: { dialogOptions: "display" }`) **only when they asked to
  have that dialog opened for them.** Not because a filter has many settings, not because
  you are unsure of the values, and not as a way to ask what they prefer — then apply your
  best values, show the result and ask in words. If a job really can only be done by hand
  inside a dialog (Liquify: its result cannot be scripted), say so and offer to open it;
  open it only when they say yes. If the answer says the dialog is still open, wait with
  `ps_wait_for_dialog` and do not open it again. Command names of filters and adjustments
  are often not the obvious ones — look them up in the knowledge base
  (`filter-commands`, `adjustment-layers`) instead of guessing.
- If it really is only the mouse — the neural filters window, another plugin's panel, the
  application preferences — do not do it silently. Tell the person what you intend to
  click and get their agreement.
- The same screen has a person working on it. Taking the pointer away from them spoils
  their work and yours: Photoshop will accept the click somewhere you did not aim.
- Anything done with the mouse sits outside the agent's named History step and may not
  appear in the report. Do not change the application preferences, do not save files, do
  not touch other programs.
- If the person asks you to click something, that is fine. Say beforehand what you are
  about to do, and afterwards what you did.

## Where facts come from

Use sources in this order, and stop as soon as one of them answers you:

1. **The knowledge base of this tool.** See below for how to read it.
2. **Context7**, if the person has it connected: `/adobedocs/uxp-photoshop`,
   `/adobedocs/uxp`, `/adobedocs/uxp-photoshop-plugin-samples`.
3. **Web search.**
4. **Your own memory, last.**

Photoshop's action descriptors are badly documented, and a model will invent property
names with complete confidence. Never trust a descriptor or a property name you remember
until you have run it and looked at what came back. If you cannot find a descriptor, the
honest ways to get a real one are: record the action in the Actions panel and use "Copy As
JavaScript", or ask the person to do that for you.

**The knowledge base is not a manual, and it will never cover everything.** It holds only
what was deliberately singled out — mostly things that were hard to get right: descriptors
the documentation lacks, traps, what failed and why. Most of Photoshop is not in it and
does not need to be. So a missing article says nothing about whether something is possible
or safe, and "the knowledge base has no article on X" is not a problem to report.

**Missing from the knowledge base is not a reason to guess, and not a reason to switch to a
different technique.** Go down the list: look it up in the documentation and on the web,
try it, and check that it did what you meant by reading the layer's settings back with
`ps_get_layer` — a wrong key often lands silently on the wrong target. If finding it was
hard, you have found exactly what belongs in the knowledge base: write it down yourself,
do not just suggest that someone should. Fall back to another technique only after that
search came up empty, and say so in your report.

## Reading the knowledge base

**The knowledge base is used only through the tools of this server — never by reading or
writing its files.** `ps_kb_list` gives one line per article, `ps_kb_read` gives one
article (or up to 4 via `article_ids`). To write a new technical article, use
`ps_kb_contribute`. After applying an existing article, use `ps_kb_mark_helped` or
`ps_kb_mark_failed`. These tools keep the article header, usage counters, failure notes,
and the two layers straight.

**Everything you write into the knowledge base is in English**, whatever language the
person talks to you in. Every agent after you reads the base, and one language keeps its
index and articles easy to match against a problem.

**Look at the document and the image (`ps_get_document`, `ps_get_image`) before you touch
the knowledge base.** Do not search the base right after `ps_start_task`: first see what is
on the canvas and in the layer tree, and work out how you intend to do the job. Only then —
before your first change to the document, and before you write a new article — check the
knowledge base for the technical steps your plan needs.

**Read the knowledge base from a sub-agent, not in your main context, and use it as a
reusable reference throughout the task.** This holds even when the base is small: an
article can be any length, so the number of articles tells you nothing about how much text
you would take in. And whatever you read in your main context is sent again with every
later call until the task ends. You do not need to guess every question upfront: send a sub-agent with the technical question for
the step in front of you, let it open the matching articles (up to 4 at once through
`article_ids`), and have it bring back the recipe and the `article_id` (keep the id to mark
the article after use). When another technical question comes up later in the task, ask that
same sub-agent again if your client can message an existing sub-agent — it already holds
the index — or call a new one for that step. The sub-agent needs this server's `ps_kb_`
tools and the task id; if your sub-agents cannot call MCP tools, read the base yourself
through the tools.

If starting a sub-agent needs the person to allow it, ask them for that in one short line.

## Manual confidence labels

`confidence` is descriptive front matter maintained through deliberate review. It is not
a task score, usage statistic, or value that Helper changes automatically:

- `agent-written` — an agent contributed the article, but a person has not deliberately
  reviewed and accepted its contents;
- `user-confirmed` — a user deliberately checked the article and accepted it for their
  own knowledge-base layer;
- `author-verified` — the author deliberately reviewed the article, may have edited it,
  and accepts it as a maintained article shipped with Helper.

Do not promote your own article because a command happened to succeed or because the
person liked the overall task. A person or the author changes this field deliberately
after reviewing the article itself. Regardless of the label, verify the recipe against the
current document and Photoshop version.

## The knowledge base is a hint, not the truth

An article can be wrong, out of date, or written for another version of Photoshop. After
following one, check the result. A higher manual confidence label is useful provenance,
not proof that the recipe fits this document. Pay particular attention to whether its
Photoshop version matches the one you are working in.

If there is nothing in the base, or the article did not fit, work it out yourself.

## Say how the articles you used went

Every article you actually followed gets one agent mark before you finish. This is not a
person rating the task and it never changes `confidence`; it records whether that specific
recipe worked when an agent applied it:

- **It worked as written:** call `ps_kb_mark_helped`. This increments only the helped
  counter; there is no note to write.
- **It did not work, or worked only after you changed or added something:** call
  `ps_kb_mark_failed` with an English note saying what failed, in which task, and what
  worked instead. A recipe that needs an unrecorded extra step did not work as written.

Marking an article and writing a new article are separate decisions. The mark is wanted
for every article actually followed. A new article is wanted only when it passes the test
below. Never turn `helped` or `failed` into a vote about the overall task or visual taste.

## What is worth writing down

Every article costs every future agent something: one more line in the index to read
past, one more file to open and rule out. It pays for that only if it saves the next agent
from a mistake or from real lost time. So before you write one, ask:

**Would the next agent — starting from the tool descriptions, the official documentation
and its own knowledge — get this wrong, or spend real time on it?**

"The base had nothing on it" is not the test. Most of what you do in a task is missing
from the base because it is ordinary, and it does not need to be there.

Worth writing:

- a descriptor or a property you had to record with "Copy As JavaScript" or dig out from
  somewhere, because the documentation does not have it;
- something that failed first, and why — a rejected descriptor, a property that does not
  exist, a call that silently did nothing;
- documentation that turned out to be wrong;
- a trap that quietly damages the document or the person's work;
- a limit or a timing you measured;
- a combination of steps that is not obvious and took several attempts to get right.

Not worth writing:

- a documented call that worked the first time. A rectangular selection made with
  `doc.selection.selectRectangle` is in the documentation already, and every agent gets it
  right;
- anything a tool description already says;
- something that only makes sense for this particular image or document.

When in doubt, and nothing failed, do not write. If you have nothing to put under "what did
not work first" and nothing surprised you, that is usually the sign the article is not
needed.

When the task **was** a fight — calls rejected, a descriptor you were sure of turned out to
be wrong, you went three ways round before one worked — write it down, and do it yourself,
without asking. That is exactly what nobody else will write, and not writing it means the
next agent walks into the same wall.

**Write down only causes you actually verified.** If you got round a failure without
finding out why it happened, say exactly that — "worked around it, cause not found" — and
stop there. Never turn your own failed attempts into "X does not work in this Helper" or
"in Photoshop": the next agent will believe you and avoid something that works.

When Photoshop rejects an ordinary operation that is obviously supported — making an
adjustment layer, setting a property — suspect your own descriptor first: a misspelled or
extra key, a wrong `_obj`, a wrong target. Compare it with a recorded descriptor or the
documentation before you blame Photoshop or the Helper. That is where the fault almost
always turns out to be.

**Before you write a new article, look at what is already there.** If an article on the
same problem exists, do not put a near-copy beside it. If you followed it and it needed a
change to work, preserve that evidence with `ps_kb_mark_failed`; if it worked as written,
there is nothing to add to its body. Only a different problem gets its own article, with
an id and an index line that say how it differs. A base
of three hundred almost-identical articles is worse than a base of thirty good ones —
nobody, including you, will find anything in it.

## Finishing

End with `ps_finish_task`: what you did, what you are not happy with or could not check,
and what the person may want to tune to their own taste. Be honest about the parts you
were unsure of — a confident report about work you did not verify is worse than no report.
