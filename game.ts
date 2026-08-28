// Pure game logic for DIGIT CANNON RUN: no DOM, no canvas, no timers. main.ts
// wraps this in a render/input loop; spec/game.test.ts drives it directly.
//
// The one rule: your current number vs. the number on the wall in front of
// you. Big enough (>=) and you smash through and keep going; not big enough
// and you crash — game over. A lane with no wall is always safe to pass
// through untouched. Everything else (the lane-runner shell, the finish
// gauntlet, the difficulty ramp) is built on that single comparison, repeated
// with bigger numbers.
//
// The player auto-fires digit bullets down their current lane. A "zone" is a
// floating +N/×N/-N gate: it modifies playerValue if the player is in its
// lane when they reach it (exactly like the old item pickups did), and it
// *also* modifies any bullet that flies through it first — so a wall can
// already be partially chipped down (via wallHp, tracked per-wall alongside
// the static OBSTACLES data) before the player themselves ever arrives at it.
// The win/loss comparison itself never changes: canBreakWall(playerValue,
// wallValue) still decides everything, it's just compared against the wall's
// current (possibly bullet-damaged) value instead of always its full one.

export type Lane = 0 | 1 | 2;
export type Status = "playing" | "won" | "lost";
export type ItemKind = "add" | "mul";

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
 * A floating operator gate: +N / ×N / -N (a negative "add"). Affects the
 * player if they're in its lane when they arrive, and affects any digit
 * bullet that flies through it in that lane first — the mechanic that lets a
 * bullet arrive at a wall already boosted (or weakened) by what it passed
 * through on the way.
 */
export interface Zone {
  type: "zone";
  atUnits: number;
  lane: Lane;
  kind: ItemKind;
  value: number;
}

export type Obstacle = NumberItem | Wall | Zone;

/** A digit bullet, auto-fired down the lane the player was in at the moment
 * it was fired. Travels forward through the same track-unit space obstacles
 * live in, faster than the world scrolls, so it always reaches a given
 * obstacle before the player's own position does. */
export interface Bullet {
  lane: Lane;
  value: number;
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
export const PLAYER_START_VALUE = 2;
export const LANE_ANIM_DURATION = 0.22; // seconds for a lane-change slide
// Raised again (~30% on top of the prior 0.32/0.44 pass, track compressed
// ~15%) after the reference-image playtest read the run as still too sedate
// next to the "number gun runner" games it was meant to match — see
// PROCESS.md for the before/after.
export const BASE_SPEED = 0.42; // track units/sec at the start
export const MAX_SPEED = 0.57; // track units/sec at the finish
export const TRACK_LENGTH = 7.65; // track units to the finish gauntlet
/** Half-width, in track units, of the window in which an obstacle resolves. */
export const HIT_HALF = 0.12;

/** Track units/sec a digit bullet travels — deliberately several times
 *  faster than MAX_SPEED, so a bullet fired this frame always reaches any
 *  obstacle ahead before the player's own worldX does. */
export const BULLET_SPEED = 3.0;
/** Seconds between auto-fired bullets. */
export const BULLET_FIRE_INTERVAL = 0.45;
/** Every bullet starts at this value; zones grow/shrink it from there. */
export const BULLET_BASE_VALUE = 1;
/** Bullets past this point are off the visible track and despawn. */
export const BULLET_MAX_REACH = TRACK_LENGTH + 0.5;

// Hand-authored level, in four segments plus a finish gauntlet. Every
// +N/×N/-N moment is now a "zone" (a floating gate), not a touch-only item:
// a zone modifies the player if they're in its lane when they arrive, *and*
// modifies any digit bullet that flies through it first, so a wall can
// already be chipped down before the player themselves gets there.
//
// 1. Teaching pair: two +1 zones dead ahead in the player's own starting
//    lane, then a wall (value 2) obviously smaller than the number the
//    player is now carrying — the first "I'm bigger, I can break this"
//    moment. The opening zone also grows the very first auto-fired bullet
//    on screen, so a stranger sees a bullet visibly get bigger before it
//    chips the first wall, without a word of explanation.
// 2. First fork: a red -3 zone sits off to one side, a green +4 zone off the
//    other; the middle lane stays clear, so touching the danger is a
//    choice, not a trap.
// 3. A ×2 zone followed by a heavier wall, escalating the same rule.
// 4. A bonus +5 zone, then two consecutive walls close together, needing
//    value banked in advance.
// 5. Finish gauntlet: three walls side by side, one per lane (16 / 32 / 64).
//    Whichever lane you're in when you arrive is the number you must beat —
//    smash through it and you win; anything else is a crash.
export const OBSTACLES: readonly Obstacle[] = [
  { type: "zone", atUnits: 0.34, lane: 1, kind: "add", value: 1 },
  { type: "zone", atUnits: 0.89, lane: 1, kind: "add", value: 1 },
  { type: "wall", atUnits: 1.53, lane: 1, value: 2 },

  { type: "zone", atUnits: 2.72, lane: 0, kind: "add", value: -3 },
  { type: "zone", atUnits: 2.72, lane: 2, kind: "add", value: 4 },

  { type: "zone", atUnits: 3.66, lane: 1, kind: "mul", value: 2 },
  { type: "wall", atUnits: 4.34, lane: 1, value: 6 },

  { type: "zone", atUnits: 5.27, lane: 2, kind: "add", value: 5 },
  { type: "wall", atUnits: 5.95, lane: 1, value: 10 },
  { type: "wall", atUnits: 6.63, lane: 1, value: 14 },

  { type: "wall", atUnits: 7.31, lane: 0, value: 16, isFinish: true },
  { type: "wall", atUnits: 7.31, lane: 1, value: 32, isFinish: true },
  { type: "wall", atUnits: 7.31, lane: 2, value: 64, isFinish: true },
];

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
    wallHp: OBSTACLES.map((ob) => (ob.type === "wall" ? ob.value : 0)),
  };
}

/** Applies a pickup's effect to the player's number. Pure, no side effects. */
export function collectItem(playerValue: number, item: NumberItem): number {
  return item.kind === "mul" ? playerValue * item.value : playerValue + item.value;
}

/** Applies a zone's effect to a digit bullet flying through it. */
export function applyModifierToBullet(bulletValue: number, zone: Zone): number {
  return zone.kind === "mul" ? bulletValue * zone.value : bulletValue + zone.value;
}

/** Applies a zone's effect to the player's number (same shape as collectItem). */
export function applyModifierToPlayer(playerValue: number, zone: Zone): number {
  return zone.kind === "mul" ? playerValue * zone.value : playerValue + zone.value;
}

/** A bullet chipping a wall: the wall's hp drops by the bullet's value, floored at 0. */
export function resolveWallHit(wallValue: number, bulletValue: number): number {
  return Math.max(0, wallValue - bulletValue);
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
  // before the player-obstacle loop below ever runs for this frame. ---
  const wallHp = working.wallHp.slice();
  let bulletTimer = working.bulletTimer - dt;
  const firedBullets: Bullet[] = working.bullets.map((b) => ({ ...b }));
  while (bulletTimer <= 0) {
    firedBullets.push({
      lane: working.lane,
      value: BULLET_BASE_VALUE,
      atUnits: worldX,
      resolvedUpTo: working.resolvedUpTo,
    });
    bulletTimer += BULLET_FIRE_INTERVAL;
  }

  const survivingBullets: Bullet[] = [];
  for (const fired of firedBullets) {
    let bullet: Bullet = { ...fired, atUnits: fired.atUnits + BULLET_SPEED * dt };
    let spent = false;
    while (
      bullet.resolvedUpTo < OBSTACLES.length &&
      bullet.atUnits >= OBSTACLES[bullet.resolvedUpTo].atUnits
    ) {
      const ob = OBSTACLES[bullet.resolvedUpTo];
      if (ob.lane === bullet.lane) {
        if (ob.type === "zone") {
          bullet = { ...bullet, value: applyModifierToBullet(bullet.value, ob) };
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
  working = { ...working, wallHp, bulletTimer, bullets: survivingBullets };

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
