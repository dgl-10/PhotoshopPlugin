# Working with a Photoshop document

These rules are handed to you by `ps_start_task`. They are a text file, not code: the
person who owns this machine can correct them at any time, and the corrected version is
what the next task gets.

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

## Reading the knowledge base

**The knowledge base is used only through the tools of this server — never by reading or
writing its files.** `ps_kb_list` gives one line per article, `ps_kb_read` gives one
article (or up to 4 via `article_ids`). To write, use `ps_kb_contribute`,
`ps_kb_mark_helped` and `ps_kb_mark_failed`: they keep the header, the counters and the
two layers straight.

**Everything you write into the knowledge base is in English** — a new article and the
note on a failed mark alike — whatever language the person talks to you in. Every agent
after you reads the base, and one language keeps its index and articles easy to match
against a problem.

**Look at the knowledge base before your first change to the document, and before you
write a new article. Read it from a sub-agent, not in your main context.** This holds
even when the base is small: an article can be any length, so the number of articles tells
you nothing about how much text you would take in. And whatever you read in your main
context is sent again with every later call until the task ends.

Send a sub-agent with the problem. Let it open every article whose index line looks like
that problem — several at once through `article_ids` — and nothing else, and have it bring
back the recipe and the article id it came from. You need the id later to mark the article.
The sub-agent needs this server's `ps_kb_` tools and the task id; if your sub-agents cannot
call MCP tools, read the base yourself through the tools.

If starting a sub-agent needs the person to allow it, ask them for that in one short line.

## The knowledge base is a hint, not the truth

An article can be wrong, out of date, or written for another version of Photoshop. After
following one, check the result. Trust an article more when its rung is higher
(`agent-written` → `user-confirmed` → `author-verified`), when it has few failures, and
when its Photoshop version matches the one you are working in.

If there is nothing in the base, or the article did not fit, work it out yourself.

## Say how the articles you used went

Every article you actually followed gets a mark before you finish. Do this every time, even
when you write nothing else. It is one call, and those counts are how the next agent
decides how far to trust the article.

- **It worked as written:** `ps_kb_mark_helped`. It only counts; there is nothing to write.
- **It did not work, or worked only after you changed or added something** — a step,
  a value, a key: `ps_kb_mark_failed`, with a note saying in what task, why, and what
  helped instead. An article that needed a change is inaccurate, and your note is how the
  next agent finds out. Never delete an article and never quietly correct it: the next
  agent needs to see the whole history.

Marking an article and writing a new one are separate decisions. The first is always
wanted. The second only when it passes the test below.

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
change to work, that change goes onto it with `ps_kb_mark_failed`; if it worked as written,
there is nothing to write. Only a different problem gets its own article, with an id and an
index line that say how it differs. A base of three hundred almost-identical articles is
worse than a base of thirty good ones — nobody, including you, will find anything in it.

## Look, change, check

In that order, every time.

- **Look first.** Read the document and the layer you are about to touch. A script written
  against a guess about the layer tree is a script that damages something.
- **Change** through `ps_execute_script`, one clear step at a time, with a history name a
  person would understand.
- **Check.** If the result is something a person judges by eye — colour correction,
  filters, blending, masks, retouching — take a picture with `ps_get_image` and look at it
  yourself. Numbers and descriptors prove that a command ran, not that it looks right. The
  tokens this costs are being spent on purpose.

If you cannot see the image — if your client did not show it to you — say so plainly. Do
not work out what is in the document from layer names and present the guess as fact.

## Adjustment layers first, filters only where there is no other way

Tone and colour — exposure, contrast, curves, levels, colour balance, hue and saturation,
split toning, black and white — go into adjustment layers, even when Camera Raw could do
the same. An adjustment layer stays separate from the picture: the person can switch it
off, tune it, or replace the picture underneath and keep the whole look. A filter is tied
to the one layer or smart object it sits on.

Use a filter only for what no adjustment layer can do: blur, sharpening, noise reduction,
grain, texture, clarity, dehaze, distortion. And give that filter only those settings — do
not move tone and colour into it just because it has sliders for them.

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
  (`filter-and-adjustment-commands`) instead of guessing.
- If it really is only the mouse — the neural filters window, another plugin's panel, the
  application preferences — do not do it silently. Tell the person what you intend to
  click and get their agreement.
- The same screen has a person working on it. Taking the pointer away from them spoils
  their work and yours: Photoshop will accept the click somewhere you did not aim.
- Anything done with the mouse is not undone by the "Before the task" snapshot and does
  not appear in the report. Do not change the application preferences, do not save files,
  do not touch other programs.
- If the person asks you to click something, that is fine. Say beforehand what you are
  about to do, and afterwards what you did.

## Finishing

End with `ps_finish_task`: what you did, what you are not happy with or could not check,
and what the person may want to tune to their own taste. Be honest about the parts you
were unsure of — a confident report about work you did not verify is worse than no report.
