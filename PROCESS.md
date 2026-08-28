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

## Round two: matching the reference images, and what playtesting corrected

The crit's next round of feedback pointed at three real screenshots of
hypercasual "number gun runner" mobile games and asked for the core visual
language — not the ad buttons, coins, or share-screen chrome those games also
show — plus a faster pace. Concretely: a true 9:16 portrait frame instead of a
wide landscape canvas; the player's body *is* a large 3D digit, not a block;
digit bullets that read as paper-plane projectiles carrying a value; zones and
walls as translucent glass gates with bold outlined labels; and a stacked
cluster of digits behind the finish line. None of `game.ts`'s rules changed —
only tunables (speed, spacing) and all of `main.ts`'s rendering did.
[`bcc3fe4`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/bcc3fe4)
[`2a4733d`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/2a4733d)

**Pacing, before/after:** `BASE_SPEED` 0.32 → 0.42 track units/sec (+31%),
`MAX_SPEED` 0.44 → 0.57 (+30%), and every `OBSTACLES` position plus
`TRACK_LENGTH` scaled down by a uniform 0.85 (9.0 → 7.65 units) — same
operation order and lanes, just closer together. A clean run now finishes in
roughly 12–40s (`spec/game.test.ts`'s tightened pacing bound) instead of the
prior 20–60s window.

**What playtesting corrected:** driving the built site through Playwright at
both marking viewports (as established last week) and actually looking at the
win/loss frames — not just checking `status: "won"`/`"lost"` — caught two
bugs the logic-level tests had no way to see:

- `drawResultFlash`'s full-canvas tint peaked at alpha 0.32, which turned the
  cyan sky and gray-purple road into a muddy sepia (win) or mauve (loss) wash
  at the exact moment the payoff most needs to read clearly. Screenshots
  before the fix look almost monochrome; the fix (alpha 0.16) keeps a visible
  mood-tint without drowning the scene.
- Two of the six decorative `FINISH_CLUSTER` digits (both "6"s) were
  positioned close enough to stack directly on top of each other, reading as
  a rendering glitch rather than the intended "cluster of digits" backdrop.
  Rearranged into a back row of smaller/higher digits and a front row of
  larger/lower ones so none overlap.

Same lesson as last week's reflection, showing up in a new spot: the analytic
level-driving script and the full `pnpm test` suite stayed green through both
of these bugs, because neither one is a rule the game logic could violate —
they're only visible in the rendered frame. The correction landed as its own
commit, separate from the rendering pass that introduced it.
[`2c862be`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/2c862be)

## Round three: bullet power scales with you, a fire-rate gate, and rebalancing every wall

The next crit round asked for the combat economy pushed further: a bullet's
power should be whatever the player's own number is *at the moment it's
fired* (previously every bullet was hard-pinned to `BULLET_BASE_VALUE = 1`,
so "shoot the gate open" chipped walls by a flat amount regardless of how big
you'd grown), a capped `-N` weaken gate that floors at 1 instead of being a
death trap, and a brand-new `RATE+` gate that permanently speeds up fire rate
(floored so it can't run away). None of that is free once bullets hit far
harder than a flat 1 — every wall needed re-tuning so a run stays winnable
but not trivial with the starting value alone.

**What changed, before/after:**

- `PLAYER_START_VALUE`: `2` → `4`. Not arbitrary — it's what makes the
  opening self-teaching with zero on-screen text: player is 4, bullets carry
  4, the first wall (12) takes exactly three stock shots to break with no
  zone touched yet, then a `×2` gate turns player/bullets into 8. "Bullet
  power = your current number" has to be legible from that sequence alone.
- `BULLET_BASE_VALUE` (flat `1`) removed entirely; bullets now spawn via
  `spawnBullet(playerValue, ...)`, carrying whatever the player's number was
  at fire time, frozen on the bullet (`spawnValue`) as the baseline the
  renderer compares against for boosted/weakened styling.
- Walls: `2, 6, 10, 14` → `12, 20` (teaching), then `48, 72, 96` (mid,
  previously the level had nothing at this scale), `150, 220, 300` (late),
  finish gauntlet `16/32/64` → `400/650/900`. `TRACK_LENGTH` grew from `7.65`
  to `15.25` to fit the extra mid/late tier and enough `+N`/`×2`/`RATE+`
  gates to make each tier reachable without being free.
- New `RATE+` gate (`⚡`, deliberately no label text): starting fire interval
  stays `BULLET_FIRE_INTERVAL = 0.45`s, each gate shaves `RATE_BOOST_STEP =
  0.06`s off `GameState.fireRate`, floored at `MIN_FIRE_INTERVAL = 0.16`s,
  permanent for the run.

**Validating the rebalance analytically before ever opening a browser, same
discipline as the last two rounds:** a throwaway script
(`scripts/balance-sim.ts`, imports `game.ts` directly, driven at a fixed
timestep) drove three lane paths against the real `OBSTACLES` data. The first
version of that script got a false negative — its "reasonable" driver picked
a fork lane once and never came back to lane 1, so it never physically
touched any wall (every non-finish wall lives in lane 1, and the game's own
header comment documents that a lane with no wall is always a safe, permanent
dodge). Rereading that rule is what caught it: a real player doesn't abandon
lane 1 forever after one side pickup, they detour out for the bonus and
return in front of the gun. Fixed with a `zigzag(visits)` driver that returns
to lane 1 by default and only diverts into a fork lane in a narrow window
around each pickup. With that corrected, the three target behaviors held:

- **Reasonable** (grabs every `+N`/`×2`, dodges every `-N`, returns to lane 1
  between forks): wins at `playerValue=384`, every mid/late wall chipped to 0
  by bullets alone before the player physically arrives.
- **Careless** (never leaves the middle lane, skips every zone): loses partway
  through the mid tier, at the third mid wall (96, `worldX=7.65` of `15.25`)
  — not an instant first-wall death, but not a free win either.
- **Miss one buff** (skips exactly one `+20` pickup, takes everything else):
  still wins, at `playerValue=304` — confirming a single missed buff doesn't
  guarantee a loss.

**A Playwright pass confirmed the same three runs read correctly on the
actual rendered frame**, not just in `state.status`: the opening beat shows
the player digit and bullet badges both reading `4` with the wall `12` ahead
and no on-screen text; the fire-rate HUD (five pips, no label) fills in step
with each `RATE+` gate; a chip burst reads as a distinct, smaller event than
a wall's actual destruction (bigger white/cyan burst, wider spread, stronger
shake, and the wall is gone from the track afterward rather than left as a
faded remnant); the loss frame drains the player digit from red toward gray
as it shatters, and a "RESTART" pill appears about 300ms in and a tap on it
immediately resets the round rather than waiting out the full hold timer.

Both throwaway scripts (`scripts/balance-sim.ts`, `scripts/visual-check.ts`)
are deleted once this section was written, per the same "verify, then
discard the harness" pattern the last two rounds established.

## Round four: the bug that made bullets vanish, a harder economy, divide gates, and giving gates/walls their own animations

This round's brief led with a real bug report ("有时子弹发射不出去" — sometimes
bullets just don't fire), then asked for the difficulty to go up
substantially, a new `÷N` projectile modifier, and for buff gates and wall
destruction to read as distinct animated events rather than a static panel
and an instant vanish.

**The bug, root-caused, not just patched.** Reading `step()`'s bullet block
closely: a bullet freshly spawned this frame (`bulletTimer <= 0`) was pushed
straight into the same move-and-resolve loop that pre-existing bullets go
through, in the *same* call. If the wall/zone it would first reach was
already within one frame's travel of its spawn point — which happens
whenever the fire timer ticks over while the player is near an obstacle, a
routine timing coincidence, not a rare edge case — the bullet was consumed
(`spent = true`) before it was ever added to `state.bullets`, so it never
rendered even though it had genuinely fired and genuinely chipped the wall.
A throwaway repro script (`scripts/repro-bullet-bug.ts`, deleted once this
section captured its numbers) confirmed it: 1 same-frame kill out of 37
bullets fired in a single run. Fixed by splitting the bullet block so only
bullets that existed at the *start* of the frame move and resolve; freshly
fired bullets are pushed into `survivingBullets` untouched and start
resolving next frame — guaranteeing at least one rendered frame in flight
before a bullet can possibly be consumed. Re-running the repro after the fix
showed 0 same-frame kills across a much longer run, and the fix is now a
permanent regression test in `spec/game.test.ts` ("a freshly-fired bullet
always survives its own spawn frame") rather than a one-off check, so it
can't silently regress. No leftover `console.*` debugging was introduced
(checked before finishing) — there was none in `game.ts`/`main.ts`/`spec/`
to remove in the first place.

**What changed, before/after (the harder economy):**

- Fire rate: `BULLET_FIRE_INTERVAL` `0.45s` → `0.75s`, `RATE_BOOST_STEP`
  `0.06s` → `0.09s`, `MIN_FIRE_INTERVAL` `0.16s` → `0.32s` — landing the
  brief's requested 700-850ms start / 80-100ms-per-`RATE+` / 320ms floor
  exactly at the middle of each requested range.
- Walls: teaching `12, 20` → `24, 36, 48`; mid `48, 72, 96` → `90, 130, 180`;
  late `150, 220, 300` → `260, 360, 480`; finish gauntlet `400/650/900` →
  `600/850/1200`. `TRACK_LENGTH` shrank `15.25` → `9.7` (a slower gun needs a
  tighter level, not just bigger numbers, or the same `+N`/`×2` density stops
  being enough to keep pace) and every gate's strength was re-tuned to match.
- New `÷N` zone kind (`kind: "div"`): `applyModifierToBullet`/
  `applyModifierToPlayer` gain `Math.max(1, Math.floor(v / zone.value))`,
  applied to bullets *and* the player exactly like every other zone kind — a
  standing, reusable trap, not a one-time punishment. Three `÷2` gates are
  woven into the mid/late/finish-approach forks, always paired against a
  same-tier `+N`/`×2` benefit on the opposite lane so the level keeps its
  established "middle lane always safe, forks always paired risk/reward"
  shape from round three.
- A separate `applyProjectileModifier(value, { type, value })` adapter was
  added purely so the brief's literal five test calls
  (`{type: "add"|"multiply"|"subtract"|"divide", value}`) could be written
  verbatim against real exported code, without reshaping the `Zone`/
  `applyModifierTo*` machinery `step()` already depends on for actual
  gameplay. It's intentionally not wired into `step()` — one adapter for
  testability, one source of truth for the game.

**Validating the rebalance analytically before opening a browser, same
discipline as every prior round:** `scripts/balance-sim.ts` (deleted once
this section captured its findings) drove the real `OBSTACLES` along three
lane strategies:

- **Reasonable** (grabs every beneficial gate, dodges every `-N`/`÷2`,
  returns to lane 1 between forks): wins at `playerValue=956`, clearing even
  the hardest 1200 finish lane.
- A follow-up check on that finding: a maxed-out run turned out to clear
  *all three* finish lanes, not just the two lighter ones — an initial
  design-comment draft claimed otherwise before the sim was run against it,
  and was corrected in `game.ts`'s header comment once the numbers showed
  it was wrong. A single big bullet's chip damage is enough to satisfy
  `canBreakWall` against nearly any wall once the player's value passes
  roughly half the wall's — an inherent property of "bullet power = your
  current number," not a level-design gap. A weaker, buff-missing run still
  only clears the lighter finish lanes, so reading your own number against
  the three printed values still matters.
- **Careless** (never leaves the middle lane, touches no gate): loses at the
  *second* teaching wall (`36`, `worldX=2.5` of `9.7`) — passes the first
  wall only because of bullet chip damage plus the free `×2` gate that
  stands in lane 1 before any fork exists, then dies with nothing further to
  fall back on. Not an instant first-wall death, but not a free pass either.
- **First-attempt-ish** (misses one or two later buffs, takes everything
  else): still wins, at `playerValue=806` and `606` respectively — confirms
  a stranger who reads the screen but doesn't play perfectly can still clear
  the level inside a few short (~15-25s) attempts, matching the brief's
  actual "a stranger should still be able to clear it within about five
  minutes" bar rather than a first-try guarantee.

**A Playwright pass through the real dev build confirmed all three read the
same way on screen, not just in `state.status`** (screenshots at
`/tmp/vc-*.png` during this session): a full reasonable-path run wins with
the gold finish-punch digit and the `600` finish wall visible; a
careless-path run loses at the second teaching wall with the red
shatter-drain digit; bullets are visibly present in flight on almost every
polled frame rather than intermittently missing, confirming the fire-bug fix
holds on the actual render loop, not just in `step()`.

**Gate and wall visuals, redesigned per the brief's fourth and sixth asks:**
gates no longer render as a single flat cyan "glass panel" with only the
border tinted — `drawObstacle`'s zone branch now draws two kind-tinted
pylons framing a pulsing radial field and an operator ring, fully colored by
kind (green add, purple multiply, red subtract, orange divide — the same
`modifierColor` palette bullets now use), with a brightness pulse
(`gatePulse`, keyed by obstacle index) firing whenever a bullet *or* the
player passes through — since gates are still standing/reusable, that pulse
is the only "just triggered" feedback, not a disappearance. This also
surfaced two bugs the new `÷N` kind had introduced into rendering that
hadn't existed for the original three kinds: `modifierColor` had no `"div"`
branch (a divide gate would have rendered green, indistinguishable from an
add-buff) and `labelFor` had no `"div"` case (would have printed `+2`
instead of `÷2`) — both fixed as part of this pass, caught by re-reading the
render path before assuming the existing four-kind switch already covered
the new kind.

A bullet's own hit-flash went from a binary buff/debuff (couldn't
distinguish *which* operator touched it) to tracking each bullet's own
`resolvedUpTo` frame-to-frame — mirroring the diff already used for the
player a few lines above in `frame()`, just per-bullet — so the exact zone
kind that just modified a given bullet drives both a one-shot colored flash
ring and a persistent badge tint/scale for the rest of its flight.

Wall destruction went from an instant vanish (rendering nothing the frame hp
crossed to destroyed, while a separate particle burst played as an overlay
near where the wall used to be) to a `wallShatter`-timer-driven sequence in
`drawObstacle`: a full white flash for the first ~80ms, then the block
visibly splits into two halves that slide apart, tumble slightly, and fade
over the remaining ~220ms. Captured across three Playwright screenshots
timed around the exact frame a wall's hp first reached 0 — the split-and-fade
halves are visibly distinct mid-sequence, not a hard cut.

Both throwaway scripts used to validate this round
(`scripts/repro-bullet-bug.ts`, `scripts/balance-sim.ts`) and the four
Playwright visual-check scripts written to confirm the render-level fixes
are deleted once this section captured their findings, per the same
"verify, then discard the harness" pattern every prior round has followed.

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
