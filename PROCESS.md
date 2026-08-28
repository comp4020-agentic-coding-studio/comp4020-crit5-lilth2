# Process overview

## What I built

**Threshold**: a one-screen gravity-flip corridor. A ball rides one of two
rails scrolling left to right; the only input is a tap/click/spacebar, which
flips it to the other rail. Spikes jut from one rail at a time — touch one on
the rail it's attached to and you lose; be on the other rail when it passes and
you're fine. Reach the glowing gate at the end and you win. One mechanic, one
rule, nothing else to learn.

## The moments that mattered

1. **Choosing the mechanic before writing any code.** The brief's hard
   constraint — a stranger must find the first move within 10 seconds, with
   zero tutorial — ruled out anything needing an explained goal (score
   attack, multi-key controls, an inventory). A single binary input with a
   single failure mode (gravity-flip / "Impossible Game"-style) was the
   smallest thing that could still be lost and still be won. I split the
   rules into a pure, DOM-free `game.ts` from the start specifically so the
   one required automated test could drive real game logic without mocking a
   canvas — a structural decision made before the first line of gameplay
   code, not a refactor after the fact.
   [`324e909`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/324e909)

2. **Validating the level analytically before trusting a screenshot.**
   Rather than tune obstacle spacing by eye and hope it was fair, I wrote a
   standalone Node script that imports `game.ts`'s own `step()` and drives it
   with a lookahead bot, to check the hand-authored track was actually
   winnable and to measure how much reaction lead a real player needs. That
   surfaced the numbers I used to judge the design: a clean run takes ~23
   seconds, and as little as 0.16s of anticipation is enough to clear every
   spike — both comfortably inside the "finishable in 5 minutes" and "still
   has real stakes" requirements. I checked this before playtesting in a
   browser at all, so the in-browser session was verifying presentation, not
   discovering whether the level was possible.
   [`324e909`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/324e909)

3. **What actually playing the finished game caught, that reading the code
   didn't.** I built the site, served it with `vite preview`, and drove real
   Chromium at both marking viewports (1920×1080 and 390×844) with
   Playwright — not to unit-test, but to *look at the opening frame the way a
   stranger would*. The screenshot showed a lone ball on a rail and nothing
   else: the first spike was authored at 1.35 screens out, which is
   mathematically off-canvas while the world is frozen at rest (only ~0.84
   screens of world are visible from the ball's fixed screen position). The
   number looked fine in `game.ts`; it only failed as a *screen*. I shifted
   the whole track 0.8 screens earlier so the first spike sits inside the
   canvas, on the ball's own rail, before any input — re-ran the same
   screenshots to confirm it now reads immediately in both viewports, then
   committed the fix separately from the original implementation so it's
   traceable as its own decision.
   [`9e2a0c2`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/9e2a0c2)

4. **Keeping the no-tutorial constraint as a design discipline, not an
   afterthought.** Every piece of idle-screen motion — the ball's bob, the
   pulsing ring, the drifting starfield — exists so the opening frame reads
   as alive and interactive without a word of instruction, and every outcome
   (win, loss) is communicated purely by a particle burst and a colour-tinted
   flash, never text. I treated "no `<h1>` explaining how to play, no modal,
   no README rules" as a constraint to design *around* from the first
   commit, rather than a rule to check for at the end and strip out.
   [`324e909`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/324e909)

## Directing the AI collaboration

I set the constraints (one mechanic, no tutorial, resolution-independent
tunables, pure-logic module for testability, real playtesting before calling
it done) and the AI wrote the implementation against them. I grounded it by
demanding evidence at each stage rather than trusting a description of the
result: the analytical bot simulation before trusting the level was fair, and
real Playwright screenshots at both marking viewports before trusting the
opening frame read correctly — the latter directly caught the off-canvas
spike bug that no amount of re-reading `game.ts` would have surfaced, because
the bug was in the relationship between a number and a viewport, not in the
number itself. I corrected the process once concretely: the first playtesting
finding became a separate, clearly-labelled commit rather than being folded
into the original implementation commit, so the repo's history shows the
correction as a distinct, citable decision rather than an invisible edit.
