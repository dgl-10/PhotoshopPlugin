---
id: generator-hands-and-feet-side-and-pose
title: Which hand is it, left or right, and how is it turned — what to ask the vision sub-agent
problem: which hand is it, left or right, and how is it turned — reading a hand's (or a bare foot's) side and pose from the picture before a generator redraws it, and checking the result; two blocks to pass to the vision sub-agent word for word, because a curled hand's side is easy to misread and a misread becomes a wrong prompt or a wrong "mirrored"
confidence: agent-written
task: written up by an agent from the author's experience and agent runs task-8d8117 and task-c1ee68, where an agent misread the side of a curled hand seen from behind, then judged a correct result "mirrored" and flipped the layer
photoshop: any — this is about reading the picture, not Photoshop
date: 2026-10-25
helped: 0
failed: 0
---

## How to use it

Pass the two blocks below to the vision sub-agent word for word — do not retell or shorten
them. With block 1 give it the whole picture and a full-size close-up of the hand; with
block 2, the generated result and the original. For a bare foot, read "hand" as "foot",
"thumb" as "big toe", "little finger" as "little toe".

Block 1 goes before the first generation, block 2 after every attempt.

## Block 1: reading the hand in the original — pass on word for word

```text
Look at the whole picture and at the close-up of the hand. Answer every line; "not sure" is an allowed answer.
1. The person faces: the camera / away from the camera / in profile, showing their left or right side.
2. The arm comes from the person's own: left / right shoulder. Follow the arm up from the hand; an arm can cross the body.
3. So it is the person's: left / right hand. Facing the camera, left and right are swapped against the picture; with the back to the camera they match it; in profile, the arm nearer the camera is on the side shown.
4. Toward the camera: the palm / the back of the hand / the thumb edge / the little-finger edge.
5. Nearest the camera: ...; farther: ...; hidden: .... Hidden fingers are normal; do not list a finger you cannot see.
6. Could someone who sees only the close-up tell how the hand is turned: yes / no.
7. Sure about line 3: yes / no. Sure about lines 4 and 5: yes / no.
Give positions only relative to the camera (nearer, farther, hidden), never as up, down, left or right in the picture.
```

## Block 2: checking a generated hand — pass on word for word

```text
Compare the generated hand with the original.
1. The same hand or mirrored: same / mirrored / cannot tell. A curled hand, or one seen from behind, often cannot be told; say so rather than guess.
2. What is wrong, in plain words: fingers grown together, an extra stub, a finger too long or too thick, a swollen hand, a thumb where none should show.
3. What changed around the hand: its size, how open it is, the cuff, the sleeve. Report it; it is not a reason to reject.
4. Does the hand look natural in the picture, with fingers that are anatomically right for this pose: yes / no. They need not match the original finger for finger; the original's fingers may be what was wrong.
```

## What to do with the answers

- **Into the prompt:** whose hand it is and which one, always. What faces the camera and
  what is nearer or hidden only when line 6 is "no" and line 7 says "sure" for lines 4 and
  5 — and written the same way, relative to the camera. A wrong description is worse than
  none. When the original's fingers are drawn wrong, give only what faces the camera (line
  4), not where each finger is (line 5): that would keep the mistake.
- **Never ask the generator to show every finger.** If a finger is hidden in the original,
  say it stays hidden. A demand for five clearly visible fingers makes the generator invent
  a thumb inside the palm.
- **Not sure which hand it is:** ask the person. Do not guess, and do not leave the side
  out of the prompt.
- **Block 2 says "mirrored" or "cannot tell":** show the person the result next to the
  original and ask before you regenerate. **Never flip the layer** to fix the side: a
  flipped piece no longer meets the wrist, and the reading may be the thing that is wrong.
  In task-c1ee68 the side was right, the agent read it as mirrored and flipped it.
- **Block 2 lists what is wrong:** that list is the next correction for the generator
  (`generator-hands-and-feet`).
