# Process overview

## What I built

**Digit Cannon Run**: a pseudo-3D lane runner where the player's identity
literally is a number. You start at 2 and auto-fire digit bullets down your
own lane. Road "zones" (+N, x2, -N) modify anything that touches them —
bullets and player alike — and walls block a lane with a printed value: clear
it if your number is at least as big, crash if it isn't. The twist the crit
asked for is that your own bullets travel faster than you do, so they reach a
zone or a wall first and can chip a wall's value down before you physically
arrive — "shoot the gate open before you get there" is a real, guaranteed
mechanic, not a lucky coincidence of timing.

## The moments that mattered

1. **Making bullets real, testable state instead of a rendering flourish.**
   The easy version of "bullets modify walls" is a visual trick with no
   ground truth. Instead `GameState` gained a `bullets` array and a parallel
   `wallHp` array, and a wall's live hp — not its authored value — is what
   `canBreakWall` actually sees at the moment of collision. That let me keep
   every existing collision test passing completely unmodified (the function
   signatures never changed, only what `step()` hands them) while still
   proving the new mechanic headlessly: a test drives the real level data,
   asserts a bullet grown through a +4 zone reduces a specific wall's
   `wallHp` below its authored value before the player has covered enough
   ground to reach it.
   [`5920fc1`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/5920fc1)

2. **Validating the level analytically before trusting a screenshot, again.**
   Same discipline as last week: before opening a browser, a standalone
   script imported `game.ts` directly and drove the real, hand-authored
   `OBSTACLES` track at a fixed timestep along both the intended win path and
   a "never leave the middle lane" loss path. That's what caught, on paper,
   that the win path's final value (16) only barely clears the lane-0 finish
   wall (16) *because* of bullet pre-damage along the way — if I'd trusted a
   manual read of the numbers instead of running the actual `step()`
   function, I'd have concluded the level was unwinnable and started
   loosening it for the wrong reason.

3. **A Playwright screenshot pass exposed a payoff that wasn't there.**
   I drove headless Chromium at both marking viewports through a full win and
   a full loss, polling the game's exposed live state (`window.__state`)
   frame-by-frame rather than guessing wall-clock delays — fixed delays kept
   drifting every time I retuned pacing, since the exact second a run ends
   depends on the speed curve. Once the screenshots reliably landed on the
   real win/loss frame, they showed the actual bug: `drawPlayerDigit`
   returned immediately the instant the round ended, so the one frame meant
   to read as "you smashed through" or "you got crushed" showed only a
   flash tint and the finish walls — no player, nothing to react to. Reading
   `game.ts` would never have surfaced this; it only showed up by looking at
   the rendered frame a marker actually sees. I made the digit hold for the
   first ~500ms of the existing result-hold window with a punch reaction
   (grows gold on a win, shrinks and shakes red on a loss) before fading, and
   confirmed it against fresh screenshots at both viewports.
   [`29516c0`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/29516c0)

4. **Treating "the player IS the number" as a rendering constraint, not a
   slogan.** The crit's core note was that the game didn't yet read as
   "Digit Cannon Run" — a dark anonymous block firing plain dots doesn't say
   anything about numbers. Every render pass this week was in service of
   that: the player's own body is `state.playerValue` drawn as a bold glowing
   digit, bullets show their live value on a small pill so a chipped wall is
   visibly a subtraction happening in front of you, and zones render as
   distinct translucent gates (not pickup-style rounded rects) labelled with
   their operator so the three effects are readable without a word of
   explanation.
   [`f41b86f`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/f41b86f)

## Directing the AI collaboration

I set the constraints this week (the player's identity must be the number
itself, bullets must be real state that modifiers can act on rather than a
rendering trick, walls must show live rather than static damage, and the pace
needed to read faster) and directed verification at each stage rather than
accepting a description of the result: an analytical script driving the real
`step()` against the real level data before ever opening a browser, then a
Playwright pass at both marking viewports polling the game's own exposed
state to land screenshots on the real win/loss frame instead of a guessed
one. That playtest pass is what caught the missing-player-at-the-payoff bug —
the kind of thing that only exists in the gap between "the logic is correct"
and "the screen a person looks at is correct," which is exactly the gap last
week's reflection said I'd start treating as a required check rather than an
afterthought. I held to that this week: the fix landed as its own commit,
citable separately from the rendering pass that introduced the bug, so the
correction is traceable rather than folded silently into the original change.
