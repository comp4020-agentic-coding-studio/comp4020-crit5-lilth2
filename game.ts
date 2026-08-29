// Pure game logic for DIGIT CANNON RUN: no DOM, no canvas, no timers. main.ts
// wraps this in a render/input loop; spec/game.test.ts drives it directly.
//
// The one rule: your current number vs. the number on the wall in front of
// you. Big enough (>=) and you smash through and keep going; not big enough
// and you crash — game over. Everything else (the lane-runner shell, the
// finish gauntlet, the difficulty ramp) is built on that single comparison,
// repeated with bigger numbers.
//
// The player auto-fires digit bullets down their current lane, and every
// bullet's power equals playerValue *at the moment it was fired* — a bullet
// already in flight keeps that value even after playerValue changes again. A
// "zone" is a floating +N/×N/-N/RATE+ gate: it modifies playerValue if the
// player is in its lane when they reach it (exactly like the old item
// pickups did), and it *also* modifies any bullet that flies through it
// first — so a wall can already be partially chipped down (via wallHp,
// tracked per-wall alongside the static OBSTACLES data) before the player
// themselves ever arrives at it. A -N gate weakens (bullet or player) but
// floors at 1 rather than being a death trap; RATE+ has no bullet value to
// change, so it speeds up the player's own fire rate instead, floored at
// MIN_FIRE_INTERVAL. The win/loss comparison itself never changes:
// canBreakWall(playerValue, wallValue) still decides everything, it's just
// compared against the wall's current (possibly bullet-damaged) value
// instead of always its full one.

export type Lane = 0 | 1 | 2;
export type Status = "playing" | "won" | "lost";
export type ItemKind = "add" | "mul";
export type ZoneKind = "add" | "mul" | "rate" | "div";

export interface NumberItem {
  type: "item";
  /** World position, in track units travelled from the start. */
  atUnits: number;
  lane: Lane;
  kind: ItemKind;
  /** add: signed delta (e.g. +1, -3). mul: factor (e.g. 2 for x2). */
  value: number;
}

export interface Wall {
  type: "wall";
  atUnits: number;
  lane: Lane;
  /** The number you must meet or beat to smash through instead of crashing. */
  value: number;
  /** The finish gauntlet: breaking one of these wins the round outright. */
  isFinish?: boolean;
}

/**
 * A floating operator gate: +N / ×N / -N (a negative "add") / RATE+. Affects
 * the player if they're in its lane when they arrive, and affects any digit
 * bullet that flies through it in that lane first — the mechanic that lets a
 * bullet arrive at a wall already boosted (or weakened) by what it passed
 * through on the way. A "rate" zone has no bullet value to change, so it
 * speeds up the player's own fire rate instead, whichever of player or
 * bullet triggers it first.
 */
export interface Zone {
  type: "zone";
  atUnits: number;
  lane: Lane;
  kind: ZoneKind;
  value: number;
}

export type Obstacle = NumberItem | Wall | Zone;

/** A digit bullet, auto-fired down the lane the player was in at the moment
 * it was fired, carrying playerValue *at that moment* as its power. Travels
 * forward through the same track-unit space obstacles live in, faster than
 * the world scrolls, so it always reaches a given obstacle before the
 * player's own position does. */
export interface Bullet {
  /** Stable per-bullet identity, so a renderer can track "this exact bullet
   *  just got modified" across frames instead of only ever seeing the
   *  current value. */
  id: number;
  lane: Lane;
  value: number;
  /** value at the moment this bullet was fired — frozen, never changes —
   *  the baseline a renderer compares the live `value` against to decide
   *  "boosted" vs "weakened" styling. */
  spawnValue: number;
  atUnits: number;
  /** Mirrors GameState.resolvedUpTo, but per-bullet: which OBSTACLES index
   *  this bullet has already resolved past, so it doesn't re-trigger a zone
   *  or wall it's still within the hit window of. */
  resolvedUpTo: number;
}

export interface GameState {
  status: Status;
  /** Distance travelled, in track units. */
  worldX: number;
  playerValue: number;
  /** The lane the player is steering toward (or already resting in). */
  lane: Lane;
  /** Current animated lane position, 0..2 (fractional mid-slide). */
  laneX: number;
  /** laneX the current slide animation started from. */
  laneFrom: number;
  /** Seconds elapsed since the current slide animation began. */
  laneAnimT: number;
  /**
   * How many obstacles (in track order) have already been resolved. worldX
   * only ever increases, so once an obstacle's position has been reached it
   * resolves exactly once — without this, a pickup the player lingers next
   * to (or simply travels slowly past) would re-apply itself every frame it
   * stays inside the hit window.
   */
  resolvedUpTo: number;
  /** Live digit bullets, auto-fired down the player's current lane. */
  bullets: Bullet[];
  /** Seconds until the next auto-fired bullet. */
  bulletTimer: number;
  /** Current interval (seconds) between auto-fired bullets — starts at
   *  BULLET_FIRE_INTERVAL and only ever decreases, via RATE+ gates, floored
   *  at MIN_FIRE_INTERVAL. Persists for the rest of the run. */
  fireRate: number;
  /** Monotonic counter handed out as the next bullet's `id`. */
  nextBulletId: number;
  /** Current (possibly bullet-damaged) hp for every OBSTACLES entry, indexed
   *  the same way; only meaningful where OBSTACLES[i].type === "wall". */
  wallHp: number[];
}

export interface CanvasSize {
  width: number;
  height: number;
}

// --- Tunables, all in resolution-independent track units / seconds, so the
// level plays out identically regardless of canvas size. ---
export const LANES = 3;
// 4, not 2: the opening frame is the whole tutorial. Player fires 4s, the
// first wall (12) takes exactly three of them, then a x2 gate turns
// player/bullets into 8 — the rule ("bullet power = your current number")
// has to be legible from that sequence alone, with no on-screen text.
export const PLAYER_START_VALUE = 4;
export const LANE_ANIM_DURATION = 0.22; // seconds for a lane-change slide
// Raised again (~30% on top of the prior 0.32/0.44 pass, track compressed
// ~15%) after the reference-image playtest read the run as still too sedate
// next to the "number gun runner" games it was meant to match — see
// PROCESS.md for the before/after.
export const BASE_SPEED = 0.42; // track units/sec at the start
export const MAX_SPEED = 0.57; // track units/sec at the finish
export const TRACK_LENGTH = 9.7; // track units to the finish gauntlet
/** Half-width, in track units, of the window in which an obstacle resolves. */
export const HIT_HALF = 0.12;

/** Track units/sec a digit bullet travels — deliberately several times
 *  faster than MAX_SPEED, so a bullet fired this frame always reaches any
 *  obstacle ahead before the player's own worldX does. */
export const BULLET_SPEED = 3.0;
/** Starting seconds between auto-fired bullets — GameState.fireRate begins
 *  here and only ever drops, via RATE+ gates. Round five's real-playtest
 *  reports ("walls are everywhere, can't dodge them") traced back to this
 *  being tuned so hard toward "route decisions matter" that missing more than
 *  one fork made the rest of the run unwinnable even with perfect lane
 *  choices afterward — eased from 0.75s back down toward round three's 0.6s
 *  so passive bullet chip carries a fairer share of the load again. See
 *  PROCESS.md's round five balance write-up. */
export const BULLET_FIRE_INTERVAL = 0.6;
/** RATE+ shaves this many seconds off the fire interval per gate passed. */
export const RATE_BOOST_STEP = 0.09;
/** Fire interval can never drop below this, however many RATE+ gates a run
 *  collects — the cap that keeps the fire-rate gate from trivializing pacing. */
export const MIN_FIRE_INTERVAL = 0.28;
/** Bullets past this point are off the visible track and despawn. */
export const BULLET_MAX_REACH = TRACK_LENGTH + 0.5;
/** A freshly-fired bullet spawns this far ahead of the player's own position
 *  — just enough that it doesn't render exactly on top of the player digit
 *  on its very first frame. Purely cosmetic; resolution timing is unaffected
 *  since bullets travel far faster than this offset. */
export const SPAWN_AHEAD = 0.03;

// Hand-authored level, in four segments plus a finish gauntlet — re-tuned for
// round four's much slower fire rate and much bigger walls (see PROCESS.md
// for the balance pass this took). Every +N/×N/-N/÷N/RATE+ moment is a
// "zone" (a floating gate): it modifies the player if they're in its lane
// when they arrive, *and* modifies any digit bullet that flies through it
// first, so a wall can already be chipped down before the player themselves
// gets there. Zones are standing/reusable — passing through never removes
// or one-time-consumes a gate.
//
// 1. Teaching: a free ×2 gate sits in the middle lane before the very first
//    wall (24) — no side-trip needed, so "a gate changes your number" is
//    legible before a single fork choice exists. From there every wall in
//    the level lives in the middle lane, and every fork offers a beneficial
//    zone on one side and a punishing one on the other — the middle lane
//    itself is always a safe (if unhelped) way through a fork. Which *side*
//    (lane 0 or lane 2) carries the beneficial zone is deliberately varied
//    per fork (FORK_BUFF_LANE below) rather than fixed to one lane for the
//    whole level — a run that learns "lane 2 is always the good one" would
//    stop reading the gates at all, which defeats the point of them.
// 2. Mid tier (90, 130, 190) introduces the first ÷2 "weaken" gates as the
//    trap side of a fork — mechanically identical to a -N gate (floors at
//    1) but reads and behaves as a division, not a subtraction.
// 3. Late tier (260, 340) raises the stakes further: two more ÷2 traps
//    guard the segment, alongside a RATE+ gate for players leaning on bullet
//    chip rather than raw value.
// 4. Finish approach feeds one last pair of forks (including a final ÷2
//    trap) into the finish gauntlet: three walls side by side, one per lane
//    (380 / 560 / 850). Whichever lane you're in when you arrive is the
//    number you must beat — smash through it and you win; anything else is
//    a crash. A weaker (buff-missing) run only clears the lighter lanes, and
//    even a fully-optimized clean run only clears the hardest lane with a
//    modest margin, so reading your own number against the three printed
//    values still matters throughout, not just early on.
interface ForkTier {
  atUnits: number;
  wallAtUnits?: number;
  /** The lane-1 (neutral/duck-back) wall's value — unchanged by the round eight multi-lane change below. */
  wallValue?: number;
  /** The wall a run that commits to (and stays in) the beneficial lane faces — softer than wallValue. */
  wallGoodValue?: number;
  /** The wall a run that commits to (and stays in) the punishing lane faces — harsher than wallValue. */
  wallBadValue?: number;
  good: { kind: ZoneKind; value: number };
  bad: { kind: ZoneKind; value: number };
}

// Round five rebalance: walls and "bad" zone penalties eased down (bad zones
// now floor no worse than a rough halving even at the harshest late tiers),
// after real-playtest reports that missing even one or two forks made every
// later wall unbeatable regardless of lane choice — see PROCESS.md.
// Round seven: that fix over-corrected — a clean or near-clean run's
// compounding buffs left mid/late walls and the finish gauntlet trivial (a
// clean run ended at playerValue ~956 against a 620 hardest finish wall).
// Raised the mid/late tier walls (60-230 -> 90-340) and the finish gauntlet
// (300/420/620 -> 380/560/850) so a strong run still wins but without the
// same overkill margin, while leaving the early tiers (14/18/24/40) and the
// bad-zone penalties/fire-rate untouched, since simulation showed those are
// what made an early-fork miss survivable — see PROCESS.md.
// Round eight: two more playtest reports. (1) Ducking into the beneficial
// lane just long enough to grab its zone, then always returning to lane 1
// before the wall, made lane 1 a totally free escape from every wall in the
// level — reported as "walls should cover multiple lanes." wallGoodValue/
// wallBadValue below extend every existing wall to the side lanes too (same
// atUnits, same pattern the finish gauntlet already used), so staying in
// whichever lane you picked now means facing a real (softer-but-real, or
// harsher) number there instead of a guaranteed dodge. Lane 1's own value
// (wallValue) is untouched, so the early-fork-miss/passive-play protection
// simulated in round six still holds exactly as before — that path never
// visits the new side-lane walls at all. (2) A further difficulty raise was
// requested on top of round seven's; mid/late lane-1 walls (5,6,7,8,10) and
// the finish gauntlet are raised again (~15%), early tiers (1-4) again left
// untouched for the same reason. All of this re-verified via
// spec/_tmp_sim.test.ts before shipping — see PROCESS.md.
const FORK_TIERS: readonly ForkTier[] = [
  {
    atUnits: 1.35,
    wallAtUnits: 1.7,
    wallValue: 14,
    wallGoodValue: 8,
    wallBadValue: 21,
    good: { kind: "add", value: 18 },
    bad: { kind: "add", value: -3 },
  },
  {
    atUnits: 2.1,
    wallAtUnits: 2.5,
    wallValue: 18,
    wallGoodValue: 10,
    wallBadValue: 27,
    good: { kind: "add", value: 14 },
    bad: { kind: "add", value: -4 },
  },
  {
    atUnits: 2.9,
    wallAtUnits: 3.3,
    wallValue: 24,
    wallGoodValue: 13,
    wallBadValue: 36,
    good: { kind: "add", value: 14 },
    bad: { kind: "add", value: -5 },
  },
  {
    atUnits: 3.7,
    wallAtUnits: 4.1,
    wallValue: 40,
    wallGoodValue: 22,
    wallBadValue: 60,
    good: { kind: "add", value: 40 },
    bad: { kind: "add", value: -8 },
  },
  {
    atUnits: 4.5,
    wallAtUnits: 4.9,
    wallValue: 105,
    wallGoodValue: 58,
    wallBadValue: 158,
    good: { kind: "mul", value: 2 },
    bad: { kind: "div", value: 2 },
  },
  {
    atUnits: 5.3,
    wallAtUnits: 5.7,
    wallValue: 150,
    wallGoodValue: 83,
    wallBadValue: 225,
    good: { kind: "add", value: 30 },
    bad: { kind: "add", value: -15 },
  },
  {
    atUnits: 6.1,
    wallAtUnits: 6.5,
    wallValue: 220,
    wallGoodValue: 121,
    wallBadValue: 330,
    good: { kind: "add", value: 60 },
    bad: { kind: "add", value: -20 },
  },
  {
    atUnits: 6.9,
    wallAtUnits: 7.3,
    wallValue: 300,
    wallGoodValue: 165,
    wallBadValue: 450,
    good: { kind: "add", value: 100 },
    bad: { kind: "add", value: -25 },
  },
  { atUnits: 7.7, good: { kind: "mul", value: 2 }, bad: { kind: "div", value: 2 } },
  {
    atUnits: 8.1,
    wallAtUnits: 8.5,
    wallValue: 390,
    wallGoodValue: 215,
    wallBadValue: 585,
    good: { kind: "rate", value: 0 },
    bad: { kind: "add", value: -40 },
  },
  { atUnits: 8.9, good: { kind: "add", value: 150 }, bad: { kind: "add", value: -50 } },
  { atUnits: 9.3, good: { kind: "add", value: 50 }, bad: { kind: "div", value: 2 } },
];

// Which lane (0 or 2) gets the beneficial zone at each fork tier above, in
// order — hand-picked to mix sides (no more than two forks in a row favour
// the same lane) rather than randomized at runtime, so the level stays a
// fixed, testable, reproducible track like the rest of OBSTACLES.
const FORK_BUFF_LANE: readonly (0 | 2)[] = [2, 0, 2, 0, 0, 2, 0, 2, 2, 0, 0, 2];

function buildLevel(): Obstacle[] {
  const obstacles: Obstacle[] = [{ type: "zone", atUnits: 1.0, lane: 1, kind: "mul", value: 2 }];
  FORK_TIERS.forEach((tier, i) => {
    const goodLane = FORK_BUFF_LANE[i];
    const badLane = goodLane === 0 ? 2 : 0;
    obstacles.push({ type: "zone", atUnits: tier.atUnits, lane: goodLane, ...tier.good });
    obstacles.push({ type: "zone", atUnits: tier.atUnits, lane: badLane, ...tier.bad });
    if (tier.wallAtUnits !== undefined && tier.wallValue !== undefined) {
      obstacles.push({ type: "wall", atUnits: tier.wallAtUnits, lane: 1, value: tier.wallValue });
      if (tier.wallGoodValue !== undefined) {
        obstacles.push({ type: "wall", atUnits: tier.wallAtUnits, lane: goodLane, value: tier.wallGoodValue });
      }
      if (tier.wallBadValue !== undefined) {
        obstacles.push({ type: "wall", atUnits: tier.wallAtUnits, lane: badLane, value: tier.wallBadValue });
      }
    }
  });
  obstacles.push({ type: "wall", atUnits: 9.7, lane: 0, value: 440, isFinish: true });
  obstacles.push({ type: "wall", atUnits: 9.7, lane: 1, value: 650, isFinish: true });
  obstacles.push({ type: "wall", atUnits: 9.7, lane: 2, value: 980, isFinish: true });
  return obstacles;
}

export const OBSTACLES: readonly Obstacle[] = buildLevel();

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function speedAt(progress: number): number {
  return BASE_SPEED + (MAX_SPEED - BASE_SPEED) * clamp(progress, 0, 1);
}

export function createInitialState(): GameState {
  return {
    status: "playing",
    worldX: 0,
    playerValue: PLAYER_START_VALUE,
    lane: 1,
    laneX: 1,
    laneFrom: 1,
    laneAnimT: LANE_ANIM_DURATION,
    resolvedUpTo: 0,
    bullets: [],
    bulletTimer: 0.15,
    fireRate: BULLET_FIRE_INTERVAL,
    nextBulletId: 0,
    wallHp: OBSTACLES.map((ob) => (ob.type === "wall" ? ob.value : 0)),
  };
}

/** Applies a pickup's effect to the player's number. Pure, no side effects. */
export function collectItem(playerValue: number, item: NumberItem): number {
  return item.kind === "mul" ? playerValue * item.value : playerValue + item.value;
}

/** Applies a zone's effect to a digit bullet flying through it. A "-N" (add,
 *  negative value) floors at 1 rather than being able to zero or negate a
 *  bullet outright; "div" floors the same way, at 1. "rate" zones have no
 *  bullet-side effect (see applyRateBoost) so callers should special-case
 *  that kind before reaching here. */
export function applyModifierToBullet(bulletValue: number, zone: Zone): number {
  if (zone.kind === "mul") return bulletValue * zone.value;
  if (zone.kind === "div") return Math.max(1, Math.floor(bulletValue / zone.value));
  return Math.max(1, bulletValue + zone.value);
}

/** Applies a zone's effect to the player's number (same shape as
 *  applyModifierToBullet, including the same "floors at 1" clamps). */
export function applyModifierToPlayer(playerValue: number, zone: Zone): number {
  if (zone.kind === "mul") return playerValue * zone.value;
  if (zone.kind === "div") return Math.max(1, Math.floor(playerValue / zone.value));
  return Math.max(1, playerValue + zone.value);
}

/** A projectile modifier in the brief's literal `{ type, value }` shape —
 *  kept as a small standalone adapter (not wired into `step()`, which stays
 *  on the `Zone`/`applyModifierTo*` path above) purely so it can be tested
 *  verbatim against the four operator names the brief specifies. "subtract"
 *  here is the same "floors at 1" clamp as a negative-value "add" zone. */
export interface ProjectileModifier {
  type: "add" | "multiply" | "subtract" | "divide";
  value: number;
}

export function applyProjectileModifier(value: number, mod: ProjectileModifier): number {
  switch (mod.type) {
    case "add":
      return Math.max(1, value + mod.value);
    case "subtract":
      return Math.max(1, value - mod.value);
    case "multiply":
      return value * mod.value;
    case "divide":
      return Math.max(1, Math.floor(value / mod.value));
  }
}

/** RATE+ gates shave a fixed amount off the fire interval, floored so the
 *  cadence can never get faster than MIN_FIRE_INTERVAL however many gates a
 *  run collects. */
export function applyRateBoost(currentFireInterval: number): number {
  return Math.max(MIN_FIRE_INTERVAL, currentFireInterval - RATE_BOOST_STEP);
}

/** A bullet chipping a wall: the wall's hp drops by the bullet's value, floored at 0. */
export function resolveWallHit(wallValue: number, bulletValue: number): number {
  return Math.max(0, wallValue - bulletValue);
}

/** A wall whose live hp has reached zero is destroyed — the single check the
 *  renderer and the tests both use, so "destroyed" always means one thing. */
export function isWallDestroyed(remainingValue: number): boolean {
  return remainingValue <= 0;
}

/** Builds a freshly auto-fired bullet: power is always playerValue *at the
 *  moment it's fired* — the core rule this whole update exists for. Once
 *  created, a bullet's `value` only changes by flying through a zone; it
 *  never re-syncs to a playerValue that's since moved on. */
export function spawnBullet(
  playerValue: number,
  lane: Lane,
  atUnits: number,
  resolvedUpTo: number,
  id: number,
): Bullet {
  return { id, lane, value: playerValue, spawnValue: playerValue, atUnits, resolvedUpTo };
}

/** The one rule the whole game rests on: big enough number, or you crash. */
export function canBreakWall(playerValue: number, wallValue: number): boolean {
  return playerValue >= wallValue;
}

/** True if the world has scrolled far enough for this obstacle to resolve. */
export function withinHitWindow(ob: Obstacle, worldX: number): boolean {
  return Math.abs(ob.atUnits - worldX) <= HIT_HALF;
}

/**
 * Resolves one obstacle against the current state. An obstacle in a lane the
 * player isn't in has no effect (it was safely dodged). Pure: returns a new
 * state, never mutates the one it was given.
 */
export function resolveCollision(state: GameState, obstacle: Obstacle): GameState {
  if (obstacle.lane !== state.lane) return state;

  if (obstacle.type === "item") {
    return { ...state, playerValue: collectItem(state.playerValue, obstacle) };
  }

  if (obstacle.type === "zone") {
    if (obstacle.kind === "rate") {
      return { ...state, fireRate: applyRateBoost(state.fireRate) };
    }
    return { ...state, playerValue: applyModifierToPlayer(state.playerValue, obstacle) };
  }

  if (canBreakWall(state.playerValue, obstacle.value)) {
    return obstacle.isFinish ? { ...state, status: "won" } : state;
  }
  return { ...state, status: "lost" };
}

/**
 * Checks for an end condition that isn't tied to a specific obstacle — here,
 * a player number that's dropped to zero or below (too many negatives) can
 * never beat any wall again, so the round is already over.
 */
export function checkEndCondition(state: GameState): Status {
  if (state.status !== "playing") return state.status;
  if (state.playerValue <= 0) return "lost";
  return "playing";
}

/**
 * Advance the simulation by `dt` seconds. `laneInput` is the lane the player
 * currently wants to be in (or null for "no change requested"). Won/lost
 * states are frozen here — main.ts decides when to reset.
 */
export function step(state: GameState, dt: number, laneInput: Lane | null): GameState {
  if (state.status === "won" || state.status === "lost") {
    return state;
  }

  let status = state.status;
  let lane = state.lane;
  let laneFrom = state.laneFrom;
  let laneAnimT = state.laneAnimT;

  if (laneInput !== null && laneInput !== lane) {
    laneFrom = state.laneX;
    lane = laneInput;
    laneAnimT = 0;
  }

  laneAnimT = Math.min(LANE_ANIM_DURATION, laneAnimT + dt);
  const eased = easeOutQuad(laneAnimT / LANE_ANIM_DURATION);
  const laneX = laneFrom + (lane - laneFrom) * eased;

  let working: GameState = { ...state, status, lane, laneX, laneFrom, laneAnimT };

  if (status !== "playing") {
    return working;
  }

  const progress = state.worldX / TRACK_LENGTH;
  const worldX = state.worldX + speedAt(progress) * dt;
  working = { ...working, worldX };

  // --- Digit bullets: auto-fire down the player's current lane, then race
  // ahead of the player through the same obstacle list, applying zone
  // modifiers to themselves and chipping wallHp when they hit a wall — all
  // before the player-obstacle loop below ever runs for this frame.
  //
  // Only bullets that already existed at the *start* of this frame move and
  // resolve now. A bullet freshly fired this frame is only ever spawned, never
  // advanced/resolved in the same step() call that creates it — otherwise a
  // bullet spawned right next to a wall/zone could be created and immediately
  // consumed before ever reaching a rendered frame, which is exactly what
  // made bullets sometimes appear to "not fire" at all. It gets its first
  // movement and resolution starting next frame, same as always. ---
  const wallHp = working.wallHp.slice();
  let bulletTimer = working.bulletTimer - dt;
  let fireRate = working.fireRate;
  let nextBulletId = working.nextBulletId;

  const survivingBullets: Bullet[] = [];
  for (const fired of working.bullets) {
    let bullet: Bullet = { ...fired, atUnits: fired.atUnits + BULLET_SPEED * dt };
    let spent = false;
    while (
      bullet.resolvedUpTo < OBSTACLES.length &&
      bullet.atUnits >= OBSTACLES[bullet.resolvedUpTo].atUnits
    ) {
      const ob = OBSTACLES[bullet.resolvedUpTo];
      if (ob.lane === bullet.lane) {
        if (ob.type === "zone") {
          if (ob.kind === "rate") {
            fireRate = applyRateBoost(fireRate);
          } else {
            bullet = { ...bullet, value: applyModifierToBullet(bullet.value, ob) };
          }
        } else if (ob.type === "wall") {
          wallHp[bullet.resolvedUpTo] = resolveWallHit(wallHp[bullet.resolvedUpTo], bullet.value);
          spent = true;
        }
      }
      bullet = { ...bullet, resolvedUpTo: bullet.resolvedUpTo + 1 };
      if (spent) break;
    }
    if (!spent && bullet.atUnits <= BULLET_MAX_REACH) {
      survivingBullets.push(bullet);
    }
  }
  while (bulletTimer <= 0) {
    survivingBullets.push(
      spawnBullet(working.playerValue, working.lane, worldX + SPAWN_AHEAD, working.resolvedUpTo, nextBulletId),
    );
    nextBulletId += 1;
    bulletTimer += fireRate;
  }
  working = { ...working, wallHp, bulletTimer, fireRate, nextBulletId, bullets: survivingBullets };

  let resolvedUpTo = working.resolvedUpTo;
  while (resolvedUpTo < OBSTACLES.length && worldX >= OBSTACLES[resolvedUpTo].atUnits) {
    const ob = OBSTACLES[resolvedUpTo];
    const effective: Obstacle = ob.type === "wall" ? { ...ob, value: wallHp[resolvedUpTo] } : ob;
    working = resolveCollision(working, effective);
    resolvedUpTo++;
    if (working.status !== "playing") {
      return { ...working, resolvedUpTo };
    }
  }
  working = { ...working, resolvedUpTo };

  const endStatus = checkEndCondition(working);
  if (endStatus !== "playing") working = { ...working, status: endStatus };

  return working;
}
