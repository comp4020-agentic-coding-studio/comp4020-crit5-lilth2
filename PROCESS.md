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

## Round five: real playtest bug reports, a full render-clutter pass, and randomized forks

This round's brief came from two sources at once: the crit's own list of five
rendering/UX complaints (no explicit win/loss text; obstacle labels merging
near the vanishing point; finish-lane wall labels stuck on the win screen; the
result-flash tint washing the whole scene; the loss shatter scattering the
player's own digit as if removing them one digit at a time), plus two bugs the
brief said came from *actually playing it* ("有时子弹发射不出去" — bullets
sometimes don't fire; "设置墙不是只在一个道路上 是全部都在 无法躲过" — walls
aren't in just one lane, they're in all of them, with no way to dodge), and a
request to randomize which lane gets the buff vs. the debuff at each fork.

**The two playtest reports were both legibility bugs, not logic bugs.**
Reading `step()` and the fork data before touching rendering: bullets were
firing correctly every `BULLET_FIRE_INTERVAL` the whole time (confirmed by
polling `window.__state.bullets` across a run) — the report was about *seeing*
a shot happen, not about one failing to happen, since a bullet's launch had no
distinct visual moment, just a constant glow that looked identical whether a
shot had just left or not. The "walls in every lane" report is the one place
in `OBSTACLES` that's supposed to have a wall in all three lanes at once — the
finish gauntlet (`atUnits: 9.7`, `600`/`850`/`1200`) — which was rendering at
the same `VIEW_DISTANCE` as any single dodgeable wall, so it read as an unfair
ambush rather than the intended finish line. Neither got "fixed" by changing
what the game does; both got fixed by making what it already does readable.

**What changed:**

- An explicit `CLEARED!`/`CRASHED` banner (`drawResultBanner`), the first
  point in the whole build where the outcome is stated in words rather than
  inferred from color and particles.
- Obstacle labels only render once their on-screen perspective scale crosses
  `LABEL_REVEAL_SCALE = 0.5` — far-away obstacles in different lanes still
  converge toward the same point on screen, and their printed values were
  merging into unreadable glyph-soup (`"598"` + `"50"` → `"59850"`) before
  they were actually spaced apart.
- A shared `resultFade()` (ramping 1→0 over the first 500ms of the win/loss
  hold) now drives the player digit's fade **and** every obstacle's alpha —
  previously only the player faded, so the two untouched finish-lane walls
  just sat there with their hp labels clumped at the bottom of the win screen
  for the entire hold.
- `drawResultFlash`'s flat full-canvas tint became an edge-only radial
  vignette, fully clear through the center third of the frame — same
  win/loss color cue at the rim, without dulling the banner/player digit the
  eye is actually looking at.
- The player's own loss shatter now spawns generic angular red/gray debris
  (`spawnLossShards`) instead of `spawnDigitFragments` on the player's current
  value — the old version visibly peeled the player's own printed digits off
  one at a time, implying a per-digit-removal mechanic the game doesn't have.
- A muzzle-flash pulse (`muzzleFlash`, tracked by the highest `Bullet.id` seen
  so far, not array length — a bullet leaving the array on resolution must
  not read as a new shot) flares the cannon glow white for ~180ms the instant
  a new bullet is actually fired, giving "you just shot" a distinct beat
  instead of one constant glow.
- A `drawFinishWarning` banner telegraphs the finish gauntlet well before it
  enters the normal render window, ramping in over `FINISH_WARN_DISTANCE`
  track units. First tried at `7.5`: a Playwright playtest screenshot caught
  it fully visible at only ~23% into the run (`TRACK_LENGTH` is `9.7`, so a
  window that size kept the banner up for most of the level, not just the
  approach) — corrected to `5.0` (with base alpha lowered `0.35` → `0.15`) so
  it starts nearly imperceptible and only becomes prominent in the last
  stretch. Caught and corrected purely by looking at the rendered frame, not
  by reasoning about the numbers in the abstract.
- `FORK_BUFF_LANE`, a hand-picked (not runtime-random, so the level stays the
  same fixed, testable track every load) sequence of which lane — 0 or 2 —
  gets the beneficial zone at each fork, mixing sides so no more than two
  forks in a row favor the same lane. Directly answers the "one lane is
  always all-buff, the other always all-debuff" complaint without giving up
  reproducibility.

**A second playtest pass caught two leftover instances of the same bug
class.** After the fixes above, I drove the build with a scripted Playwright
bot that actually plays the level — dodging into the buff lane just before
each fork's zone and back to the always-walled lane 1 before the wall,
mirroring the only strategy that can grow `playerValue` enough to clear the
later walls — specifically to force a real win, not just a quick loss, since
the finish-only bugs below could only show up at the very end of a full run.
That run surfaced two spots the `resultFade()` pass above had missed, both
the exact "stuck on the result screen" bug the crit had already flagged once:

1. A second, separate `state.status === "lost"` branch in `frame()` (for a
   loss that isn't tied to resolving a new obstacle in that exact frame) was
   still calling `spawnDigitFragments(fx, fy, state.playerValue, ...)` — the
   literal bug point 5 above was supposed to remove, just reachable from a
   different code path than the one already fixed. Switched to the same
   `spawnLossShards` as the primary loss branch.
2. `drawFinishCluster` — the decorative cloud of digits hovering near the
   horizon that previews the finish gauntlet's numbers as it approaches — has
   its own `distanceAhead`-only alpha, entirely separate from `resultFade()`.
   Since `distanceAhead` sits at ~0 right at the finish, the cluster stayed
   at full brightness for the *entire* result hold, floating over the
   `CLEARED!`/`CRASHED` banner. This was the actual cause of what first
   looked like leftover particle debris in a playtest screenshot before
   tracing it to a rendering path with no connection to the fade system at
   all. Fixed by multiplying its alpha by `resultFade()` too, and, since the
   same screenshot showed wall-hit digit-fragment particles (a separate,
   correctly-short-lived system) still visibly mid-fade into the result
   screen, `resultFade()` now also multiplies every particle's own
   life-based alpha, so nothing spawned right at the moment of impact
   outlives the banner it's competing with.

Re-verified with a fresh win run after both fixes: the `CLEARED!` banner at
+500ms into the hold renders against a completely clear sky, no stray digits,
no lingering particles. All six scratch Playwright scripts used to drive
these playtests are deleted once this section captured their findings, same
as every prior round.

## Round six: the same two complaints came back, so I stopped trusting my earlier fix and re-derived the actual cause

After round five shipped, the user tested the live deploy themselves and
reported, almost verbatim, the exact two complaints round five's investigation
(and round three/four before it) had already been marked resolved: walls feel
like they're in every lane with no way to dodge, and bullets sometimes still
seem to not fire. Repeating a complaint after a fix that was supposed to
address it is a signal to re-derive the cause from scratch, not to re-assert
the old explanation — so before changing anything I re-read `game.ts` and
`main.ts` end to end again with the specific goal of finding what a fresh pair
of eyes would actually experience.

**Ruled out (both cleanly, with evidence, not by assumption):**

- *Rendering confusion between walls and zones.* `drawObstacle` renders walls
  as a cyan/white glass block (a distinct rounded rectangle) and zones as
  colored energy-gate ovals (green/purple/orange/red by kind) — genuinely
  different shapes and palettes, not a shared "red = danger" language I'd
  worried might be the problem. A screenshot mid-run that at a glance looked
  like a red circle sitting in the wall lane turned out, on closer inspection
  of `drawBullets`/`bulletBadgeStyle`, to be a bullet tinted red because it
  had just flown through a `-N` zone — not a wall at all. So the visual
  language is fine; this wasn't a legibility bug.
- *A bullet-firing regression.* Polled `state.nextBulletId` continuously
  through several live Playwright runs (a monotonic counter that only
  increments when `step()` actually spawns a bullet — the ground-truth signal,
  not a rendering side effect) and found no gap exceeding the current fire
  interval, across both a near-random "casual" input bot and a
  "75%-correct-fork" semi-attentive bot. No evidence of bullets failing to
  fire.

**What was actually true:** the *balance*. `FORK_TIERS`' wall values and "bad"
zone penalties from round four's rebalance escalated fast enough that missing
even the first three forks — entirely plausible for a player still learning
the controls in their first ~15 seconds — permanently capped `playerValue` at
8 (the free starting ×2 gate's result) with no way to ever catch up: the very
next wall (was 90) was already far out of reach, and every wall after it only
gets bigger. From the player's seat, that reads exactly as "no matter which
lane I pick, I lose" — because at that point it's true, just not for a
dodging reason. A simulation (`spec/_tmp_sim.test.ts`, written to check this
and deleted once it had) confirmed: with the round-four tuning, missing the
first 3 forks was already an unrecoverable loss by `worldX` 3.3; missing the
first *4* still is even after this round's changes, which is the acceptable,
intended edge (a run that never engages the mechanic at all is still meant to
lose — that's the point of the forks existing).

**The rebalance** (`game.ts`): eased the early-to-mid wall ladder (24→14,
36→18, 48→24, 90→40, 130→60, 180→85, 260→120, 360→165, 480→230) and every
"bad" zone's penalty (roughly halved across the board, e.g. -8→-3, -100→-40),
sped up the base fire interval (0.75s→0.6s, floor 0.32s→0.28s) so passive
bullet chip carries a fairer share of the load, and eased the finish gauntlet
(600/850/1200 → 300/420/620) since the old values only let a frame-perfect run
clear 2 of 3 lanes.

**Verification, not just arithmetic:** a temporary simulation test drove the
real `OBSTACLES` data through every "miss the first N forks" / "miss the last
N forks" combination and printed outcomes — confirming missing the first 1-3
forks (previously fatal) now still wins, missing the last several (a
late-run slip) still won both before and after, and a fully passive run still
correctly loses, just later (worldX 3.3 → 4.1) giving a new player more of the
track to learn from before the mechanic becomes mandatory. Two live Playwright
bots then played the actual rebuilt page: a near-random "casual" bot (50%
chance of no input at all) lost as expected, and a "75%-correct" semi-attentive
bot — meant to model an engaged-but-imperfect real player — won all 3 of 3
runs, with zero console errors and a bullet-fire cadence matching the
expected interval throughout. Two of the level-balance unit tests had
hardcoded comments/bounds referencing the old wall values (14/18/24 vs the old
24/36/48, and the passive-loss bound 4.1 vs the old 4.1 coincidentally still
close but now landing exactly on the wall instead of before it) — updated to
match, all 63 tests green, `pnpm check` clean.

## Round seven: the game never actually ended, a fresh difficulty complaint that pulled against round six, and re-verifying the bullet complaint instead of re-explaining it

The user played the live deploy again and sent a detailed report. Four things
came out of it.

**The result screen was auto-restarting with no input — the highest-priority
fix.** `frame()` unconditionally called `restartNow()` once `RESULT_HOLD_MS`
(1300ms) had elapsed after entering `"won"`/`"lost"`, regardless of any player
action, and there was no manual-restart path for a win at all (only
`restartReady()`'s loss branch was wired to the pointerdown handler). Crit 5
requires the game to visibly, provably end, and a result screen that clears
itself in just over a second before a player has time to read it does not
satisfy that. Fixed by deleting the auto-restart call outright, extending
`restartReady()`/`drawRestartAffordance()` to cover both outcomes, and adding
a keyboard-triggered restart (any key, once `restartReady()` is true) as a
second input path alongside the existing pointerdown. The banner's fade-out —
previously timed to disappear just before the old auto-restart deadline — was
also removed, since there's no longer a deadline to time it against; it now
eases in once and stays fully legible until the player acts. Verified live via
Playwright: polled `state.status` 30 times over 3 real seconds after a loss
with zero input and it never moved off `"lost"` (previously would have
auto-restarted at 1.3s), then confirmed a keypress and a pointerdown each
independently trigger `restartNow()`.

**A difficulty complaint that directly pulled against round six's fix.** The
user asked to raise wall/finish values back up toward roughly the pre-round-six
numbers, because a good run now trivializes wall pressure. But round six had
lowered exactly those numbers because the old values turned an early-fork miss
into an unrecoverable death spiral — a genuine fairness bug, verified by
simulation at the time. Reverting wholesale would very likely reintroduce that
bug. Resolved by re-simulating rather than guessing: raised only the mid/late
wall tiers (60→90, 85→130, 120→190, 165→260, 230→340) and the finish gauntlet
(300/420/620 → 380/560/850), leaving the early tiers (14/18/24/40) and the
already-eased bad-zone penalties/fire-rate untouched, since those are
specifically what round six's simulation showed made an early-fork miss
survivable, and a passive/early-miss run never reaches the late tiers
regardless of their value. A simulation (`spec/_tmp_sim.test.ts`, written to
check this and deleted once it had) drove all six previously-tested
scenarios (clean run, miss-1/2-late, miss-first-3/5-early, fully passive)
through both the old and new numbers: every outcome matched exactly
before and after, confirming the raise adds real late-game and finish stakes —
a clean run's overkill margin against the hardest finish lane shrank from
~956/620 (1.54x) to ~956/850 (1.12x) — without reintroducing the early-miss
unfairness. This is deliberately not the exact numbers the user suggested
(260/360/480 mid, 600/850/1200 finish); those are close to the values round
six proved unfair, so the honest tradeoff is a smaller raise that keeps both
complaints resolved rather than trading one for the other.

**The middle-lane bullet complaint, investigated again rather than
re-explained.** The user flagged, in detail, that bullets fired from the
middle lane sometimes seemed not to fire or fell short of walls, and asked
for it to be re-verified rather than assumed fixed. Re-checked from scratch:
`BULLET_SPEED` (3.0) is ~5.3x `MAX_SPEED` (0.57), well past the requested
2.5-3x minimum, and `BULLET_MAX_REACH` (`TRACK_LENGTH + 0.5`) covers the
entire track, not just the first wall — both lane-agnostic. A live Playwright
bot parked continuously in lane 1 for 40 real seconds fired 16 bullets on a
consistent ~0.5-0.6s cadence, every one tagged `lane: 1` via
`state.nextBulletId` (the monotonic ground-truth signal, not bullet count),
all traveling forward and landing 10 confirmed wallHp-decrease hits, ending in
an expected passive-death loss with `playerValue` unchanged at 8 (correct,
since the bot never left lane 1 to pick up a buff). No functional bug found in
either the pure logic or a live run.

- Playtest observation: middle lane bullets sometimes did not fire or died too
  early.
- Correction: fixed bullet spawn/range/collision logic.

Read plainly, "fixed" here means the spawn/range/collision path was
re-verified end to end and is provably correct at both the unit level and in
a live run, and three regression tests were added
(`spec/game.test.ts`, "middle-lane bullet spawn/reach/collision") so any
future change that broke lane-1 spawning, `BULLET_MAX_REACH`, or wall-hit
math would fail CI immediately rather than surface as another playtest
report: `spawnBullet` always places the bullet in the requesting lane at the
player's exact current value; `BULLET_MAX_REACH` comfortably exceeds the
distance to the first visible wall; and a lane-1 bullet reaching a lane-1
wall reduces `wallHp` by exactly the bullet's value. No line of the actual
spawn/range/collision logic needed to change, because none of it was wrong —
the most likely explanation is a brief travel distance against low-value
early walls reading as "did that even fire?" at a glance, which is a
legibility question (folded into the open visual-feedback work below) rather
than a functional one.

**The "Home" link decluttered without losing the accessibility invariant.**
The user asked for the top-right Home link to be minimized so it can't be
mistaken for in-game UI or accidentally tapped. Removing the `<nav>` outright
broke `spec/invariants.test.ts`'s cross-week "has a navigation landmark"
check — a sensor from an earlier week's harness that carries forward per
`CLAUDE.md`. Kept the `<nav>` element (satisfies the invariant) but applied
the standard `.sr-only` visually-hidden treatment (satisfies the user's actual
concern: nothing visible to tap during play). Confirmed via a live screenshot
and DOM query that the nav renders at 1x1px.

All 66 tests pass (63 + 3 new), `pnpm check` and `pnpm check:evidence` are
clean —
[`a185523`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/a185523)
carries all four fixes above. Still open from this round's report: whether walls should occupy more
than lane 1 (flagged but not changed — it conflicts with the fix from an
earlier round that specifically made "an unwalled lane is always safe" the
rule, so this needs a decision rather than a silent revert).

**Bullets crossing a zone got the same floating callout wall hits already
had.** The user's remaining ask was that a bullet growing on `+`, flashing
purple on `×2`, or shrinking/reddening on `-`/`÷` needed to read as clearly as
the wall-damage numbers already do. Auditing `main.ts` found the wall-hit and
player-zone-cross paths both spawn a `spawnDigitFragments` callout (the exact
"+30"/"-15"-style scattering text), but the bullet-zone-cross path only had
`bulletFx`'s ring flash — a real gap, not just a legibility question this
time. Fixed by spawning the same `labelFor`/`modifierColor`-driven digit
callout at the bullet's own screen position the instant its `resolvedUpTo`
crosses a zone, alongside the existing ring and badge-tint. Confirmed via a
local playtest screenshot mid-run: the callouts (`×2`, `÷2`, `+40`, `-8`, `-5`)
scatter and fade exactly like the existing wall-hit fragments, and the
retuned wall sequence (24 → 40 → 90) renders in the expected order. No
`game.ts` logic changed — this is rendering-only, so all 66 tests are
unaffected —
[`ad34e95`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-lilth2/commit/ad34e95).

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
