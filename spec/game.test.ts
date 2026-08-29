import { describe, expect, it } from "vitest";
import {
  BULLET_FIRE_INTERVAL,
  BULLET_MAX_REACH,
  HIT_HALF,
  LANE_ANIM_DURATION,
  MIN_FIRE_INTERVAL,
  OBSTACLES,
  TRACK_LENGTH,
  applyModifierToBullet,
  applyModifierToPlayer,
  applyProjectileModifier,
  applyRateBoost,
  canBreakWall,
  checkEndCondition,
  collectItem,
  createInitialState,
  isWallDestroyed,
  resolveCollision,
  resolveWallHit,
  spawnBullet,
  step,
  type GameState,
  type ProjectileModifier,
  type Wall,
  type Zone,
} from "../game";

// Which physical lane (0 or 2) carries the beneficial zone varies per fork
// (see game.ts's FORK_BUFF_LANE) instead of always being lane 2 — so a
// "reasonable run" test has to look up, per fork, which lane is actually
// beneficial from the real OBSTACLES data rather than assuming one side.
function beneficialForkVisits(): { at: number; lane: 0 | 1 | 2 }[] {
  const byAt = new Map<number, Zone[]>();
  for (const ob of OBSTACLES) {
    if (ob.type !== "zone" || ob.lane === 1) continue; // skip the always-safe lane-1 teaching gate
    const list = byAt.get(ob.atUnits) ?? [];
    list.push(ob);
    byAt.set(ob.atUnits, list);
  }
  const visits: { at: number; lane: 0 | 1 | 2 }[] = [];
  for (const [at, zones] of byAt) {
    const beneficial = zones.find((z) => z.kind === "mul" || z.kind === "rate" || (z.kind === "add" && z.value > 0));
    if (beneficial) visits.push({ at, lane: beneficial.lane });
  }
  return visits.sort((a, b) => a.at - b.at);
}

// The core rule under test: your number vs. the wall's number. Big enough
// and you smash through; not big enough and the round ends in a loss. A wall
// in a lane you're not in never touches you at all — it's a dodge, not a
// wall.

const wall: Wall = { type: "wall", atUnits: 5, lane: 1, value: 10 };

function stateInLane(lane: 0 | 1 | 2, playerValue: number): GameState {
  return {
    status: "playing",
    worldX: 0,
    playerValue,
    lane,
    laneX: lane,
    laneFrom: lane,
    laneAnimT: LANE_ANIM_DURATION,
    resolvedUpTo: 0,
    bullets: [],
    bulletTimer: 999,
    fireRate: BULLET_FIRE_INTERVAL,
    nextBulletId: 0,
    wallHp: [],
  };
}

describe("canBreakWall: the one comparison the whole game rests on", () => {
  it("breaks through when the player's number meets or beats the wall's", () => {
    expect(canBreakWall(10, 10)).toBe(true);
    expect(canBreakWall(11, 10)).toBe(true);
  });

  it("fails to break through when the player's number is short", () => {
    expect(canBreakWall(9, 10)).toBe(false);
  });
});

describe("resolveCollision against a wall", () => {
  it("crashes (loses) when in the wall's lane without enough value", () => {
    const next = resolveCollision(stateInLane(1, 4), wall);
    expect(next.status).toBe("lost");
  });

  it("passes through unharmed, value unchanged, when strong enough", () => {
    const next = resolveCollision(stateInLane(1, 12), wall);
    expect(next.status).toBe("playing");
    expect(next.playerValue).toBe(12);
  });

  it("has no effect at all from a lane the wall isn't in — a dodge", () => {
    const next = resolveCollision(stateInLane(0, 1), wall);
    expect(next.status).toBe("playing");
    expect(next.playerValue).toBe(1);
  });

  it("winning the round requires breaking a wall flagged as the finish", () => {
    const finishWall: Wall = { ...wall, isFinish: true };
    const next = resolveCollision(stateInLane(1, 12), finishWall);
    expect(next.status).toBe("won");
  });
});

describe("collectItem", () => {
  it("adds a signed delta", () => {
    expect(collectItem(5, { type: "item", atUnits: 0, lane: 0, kind: "add", value: 3 })).toBe(8);
    expect(collectItem(5, { type: "item", atUnits: 0, lane: 0, kind: "add", value: -3 })).toBe(2);
  });

  it("multiplies", () => {
    expect(collectItem(5, { type: "item", atUnits: 0, lane: 0, kind: "mul", value: 2 })).toBe(10);
  });
});

describe("zones: the operator gates that modify bullets and the player alike", () => {
  const addFour: Zone = { type: "zone", atUnits: 0, lane: 0, kind: "add", value: 4 };
  const timesTwo: Zone = { type: "zone", atUnits: 0, lane: 0, kind: "mul", value: 2 };
  const minusThree: Zone = { type: "zone", atUnits: 0, lane: 0, kind: "add", value: -3 };

  it("applyModifierToBullet: a bullet worth 1 through a +4 zone becomes 5", () => {
    expect(applyModifierToBullet(1, addFour)).toBe(5);
  });

  it("applyModifierToBullet: a bullet worth 2 through a x2 zone becomes 4", () => {
    expect(applyModifierToBullet(2, timesTwo)).toBe(4);
  });

  it("applyModifierToBullet: a bullet worth 5 through a -3 zone becomes 2", () => {
    expect(applyModifierToBullet(5, minusThree)).toBe(2);
  });

  it("applyModifierToPlayer mirrors collectItem's add/multiply shape", () => {
    expect(applyModifierToPlayer(5, addFour)).toBe(9);
    expect(applyModifierToPlayer(5, timesTwo)).toBe(10);
  });

  it("a -N zone floors at 1 instead of zeroing or negating the value it hits", () => {
    const bigMinus: Zone = { type: "zone", atUnits: 0, lane: 0, kind: "add", value: -50 };
    expect(applyModifierToBullet(5, bigMinus)).toBe(1);
    expect(applyModifierToPlayer(5, bigMinus)).toBe(1);
  });

  it("resolveCollision applies a zone to the player when touched", () => {
    const next = resolveCollision(stateInLane(0, 5), addFour);
    expect(next.playerValue).toBe(9);
    expect(next.status).toBe("playing");
  });

  it("resolveCollision applies a RATE+ zone to fireRate instead of playerValue", () => {
    const rateZone: Zone = { type: "zone", atUnits: 0, lane: 0, kind: "rate", value: 0 };
    const next = resolveCollision(stateInLane(0, 5), rateZone);
    expect(next.playerValue).toBe(5);
    expect(next.fireRate).toBe(applyRateBoost(BULLET_FIRE_INTERVAL));
  });

  const divideByTwo: Zone = { type: "zone", atUnits: 0, lane: 0, kind: "div", value: 2 };

  it("applyModifierToBullet: a ÷2 zone halves and floors a bullet's value", () => {
    expect(applyModifierToBullet(9, divideByTwo)).toBe(4);
    expect(applyModifierToBullet(10, divideByTwo)).toBe(5);
  });

  it("applyModifierToPlayer: a ÷2 zone halves and floors the player's value the same way", () => {
    expect(applyModifierToPlayer(9, divideByTwo)).toBe(4);
  });

  it("a ÷N zone floors at 1 instead of ever reaching 0", () => {
    const divideByFifty: Zone = { type: "zone", atUnits: 0, lane: 0, kind: "div", value: 50 };
    expect(applyModifierToBullet(5, divideByFifty)).toBe(1);
    expect(applyModifierToPlayer(5, divideByFifty)).toBe(1);
  });
});

describe("spawnBullet: bullet power is the player's current number, not a fixed constant", () => {
  it("a bullet fired while the player is 4 carries power 4", () => {
    const bullet = spawnBullet(4, 1, 0, 0, 0);
    expect(bullet.value).toBe(4);
    expect(bullet.spawnValue).toBe(4);
  });

  it("spawnBullet(8, ...) produces a bullet with power equal to the player's current value (8)", () => {
    const bullet = spawnBullet(8, 1, 0, 0, 0);
    expect(bullet.value).toBe(8);
    expect(bullet.spawnValue).toBe(8);
  });

  it("a bullet fired later, once the player has grown, carries the bigger value", () => {
    const bullet = spawnBullet(96, 1, 3, 0, 7);
    expect(bullet.value).toBe(96);
  });
});

describe("applyProjectileModifier: the brief's literal type/value modifier shape", () => {
  it("add: 8 + 4 = 12", () => {
    const mod: ProjectileModifier = { type: "add", value: 4 };
    expect(applyProjectileModifier(8, mod)).toBe(12);
  });

  it("multiply: 8 x 2 = 16", () => {
    const mod: ProjectileModifier = { type: "multiply", value: 2 };
    expect(applyProjectileModifier(8, mod)).toBe(16);
  });

  it("subtract: 8 - 10 floors at 1, not 0 or negative", () => {
    const mod: ProjectileModifier = { type: "subtract", value: 10 };
    expect(applyProjectileModifier(8, mod)).toBe(1);
  });

  it("divide: floor(9 / 2) = 4", () => {
    const mod: ProjectileModifier = { type: "divide", value: 2 };
    expect(applyProjectileModifier(9, mod)).toBe(4);
  });
});

describe("applyRateBoost: RATE+ speeds up fire rate, floored so it can't run away", () => {
  it("shaves RATE_BOOST_STEP off the current interval", () => {
    expect(applyRateBoost(0.75)).toBeCloseTo(0.66);
  });

  it("never drops the interval below MIN_FIRE_INTERVAL, however many times it's applied", () => {
    let interval = BULLET_FIRE_INTERVAL;
    for (let i = 0; i < 20; i++) interval = applyRateBoost(interval);
    expect(interval).toBe(MIN_FIRE_INTERVAL);
  });
});

describe("resolveWallHit: a digit bullet chipping a wall", () => {
  it("subtracts the bullet's value from the wall's remaining hp", () => {
    expect(resolveWallHit(10, 4)).toBe(6);
    expect(resolveWallHit(20, 8)).toBe(12);
  });

  it("resolveWallHit(24, 8) leaves 16 remaining", () => {
    expect(resolveWallHit(24, 8)).toBe(16);
  });

  it("floors at zero rather than going negative", () => {
    expect(resolveWallHit(3, 10)).toBe(0);
  });
});

describe("isWallDestroyed: the single check the renderer and tests both use", () => {
  it("a wall chipped down to exactly 0 is destroyed", () => {
    expect(isWallDestroyed(resolveWallHit(8, 8))).toBe(true);
  });

  it("a wall with hp remaining is not destroyed", () => {
    expect(isWallDestroyed(resolveWallHit(20, 8))).toBe(false);
  });
});

describe("step(): bullets chip walls ahead of the player", () => {
  it("bullets fired while in lane 1, boosted by the free ×2 gate, chip the first wall (14) before the player arrives", () => {
    // BULLET_SPEED is fast enough that, staying in lane 1 the whole way, the
    // auto-fired bullets reach the first wall (atUnits 1.7, value 14) well
    // before the (much slower) player's own worldX does.
    let state = createInitialState();
    state = { ...state, status: "playing", lane: 1, laneX: 1, laneFrom: 1 };
    const dt = 1 / 60;
    for (let i = 0; i < 200 && state.worldX < 1.7; i++) {
      state = step(state, dt, 1);
    }
    const wallIndex = OBSTACLES.findIndex((ob) => ob.type === "wall" && ob.atUnits === 1.7);
    expect(state.wallHp[wallIndex]).toBeLessThan(14);
  });

  it("a wall chipped down to 0 (the effective obstacle step() builds from wallHp) lets even a very weak player through", () => {
    // This is the exact mechanism step() relies on: canBreakWall/resolveCollision
    // never change, they're just handed a wall whose value reflects live,
    // bullet-damaged hp instead of its authored one.
    const choppedWall: Wall = { type: "wall", atUnits: 0, lane: 1, value: 0 };
    const next = resolveCollision(stateInLane(1, 0.5), choppedWall);
    expect(next.status).toBe("playing");
  });
});

describe("step(): a freshly-fired bullet always survives its own spawn frame", () => {
  // Regression test for "有时子弹发射不出去": a bullet used to be advanced and
  // resolved against obstacles in the very same step() call it was spawned
  // in, so a bullet fired just as the player reached a wall/zone could be
  // created and consumed before it was ever added to a rendered frame. Fixed
  // by only running the move+resolve loop over bullets that existed at the
  // start of the frame — freshly-fired bullets are pushed straight into
  // state.bullets untouched, so this asserts zero same-frame kills across a
  // full run through the real level.
  it("never resolves a newly-spawned bullet against a wall/zone before it appears in state.bullets", () => {
    let state = createInitialState();
    state = { ...state, status: "playing", lane: 1, laneX: 1, laneFrom: 1 };
    const dt = 1 / 60;
    let totalFired = 0;
    let sameFrameKills = 0;
    for (let i = 0; i < 3000 && state.status === "playing"; i++) {
      const beforeNextId = state.nextBulletId;
      const next = step(state, dt, 1);
      totalFired += next.nextBulletId - beforeNextId;
      for (let id = beforeNextId; id < next.nextBulletId; id++) {
        if (!next.bullets.some((b) => b.id === id)) sameFrameKills++;
      }
      state = next;
    }
    expect(totalFired).toBeGreaterThan(0);
    expect(sameFrameKills).toBe(0);
  });

  it("spawns a fresh bullet ahead of the player's own position, not on top of or behind it", () => {
    let state = createInitialState();
    state = { ...state, status: "playing", lane: 1, laneX: 1, laneFrom: 1, bulletTimer: 0 };
    const next = step(state, 1 / 60, 1);
    expect(next.bullets.length).toBeGreaterThan(0);
    for (const bullet of next.bullets) {
      expect(bullet.atUnits).toBeGreaterThan(next.worldX);
    }
  });
});

// Regression coverage for the "站在中间车道时子弹看起来没发射/射程不够" playtest
// report: verifies, at the level of pure functions and a real step() run,
// that a middle-lane (lane 1) bullet is created correctly, reliably reaches
// as far as the level's walls, and chips exactly the hp its value says it
// should — see PROCESS.md for the corresponding playtest note.
describe("middle-lane bullet spawn/reach/collision (playtest regression coverage)", () => {
  it("spawnBullet always puts the bullet in the requesting lane at the player's exact current value", () => {
    const bullet = spawnBullet(8, 1, 2, 0, 0);
    expect(bullet.lane).toBe(1);
    expect(bullet.value).toBe(8);
  });

  it("BULLET_MAX_REACH comfortably covers the distance from the start to the first visible wall", () => {
    const firstWall = OBSTACLES.find((ob) => ob.type === "wall");
    expect(firstWall).toBeDefined();
    expect(BULLET_MAX_REACH).toBeGreaterThan(firstWall!.atUnits);
    // Not just "greater than" by a hair — it covers the whole track, so a
    // bullet fired anywhere on the run can still reach anything ahead of it.
    expect(BULLET_MAX_REACH).toBeGreaterThanOrEqual(TRACK_LENGTH);
  });

  it("a lane-1 bullet reaching a lane-1 wall reduces wallHp by exactly the bullet's value", () => {
    // Start just past the free ×2 gate (atUnits 1.0) and the first wall
    // (atUnits 1.7), so the only lane-1 obstacle left ahead is the second
    // wall (atUnits 2.5, value 18) — no zone in between to change the
    // bullet's value in flight, so it hits carrying exactly playerValue.
    const startX = 1.8;
    const resolvedUpTo = OBSTACLES.filter((ob) => ob.atUnits <= startX).length;
    const playerValue = 5;
    let state: GameState = {
      status: "playing",
      worldX: startX,
      playerValue,
      lane: 1,
      laneX: 1,
      laneFrom: 1,
      laneAnimT: LANE_ANIM_DURATION,
      resolvedUpTo,
      bullets: [],
      bulletTimer: 0,
      fireRate: BULLET_FIRE_INTERVAL,
      nextBulletId: 0,
      wallHp: OBSTACLES.map((ob) => (ob.type === "wall" ? ob.value : 0)),
    };
    const wallIndex = OBSTACLES.findIndex((ob) => ob.type === "wall" && ob.atUnits === 2.5);
    const wall = OBSTACLES[wallIndex] as Wall;
    const dt = 1 / 60;
    for (let i = 0; i < 200 && state.wallHp[wallIndex] === wall.value; i++) {
      state = step(state, dt, 1);
    }
    expect(state.wallHp[wallIndex]).toBe(wall.value - playerValue);
  });
});

describe("checkEndCondition", () => {
  it("a player number at or below zero can never beat another wall, so the round is already lost", () => {
    expect(checkEndCondition(stateInLane(1, 0))).toBe("lost");
    expect(checkEndCondition(stateInLane(1, -2))).toBe("lost");
  });

  it("stays playing above zero", () => {
    expect(checkEndCondition(stateInLane(1, 1))).toBe("playing");
  });

  it("a round that's already won or lost doesn't get re-evaluated", () => {
    const wonState = { ...stateInLane(1, -5), status: "won" as const };
    expect(checkEndCondition(wonState)).toBe("won");
  });
});

describe("a frozen round ignores further input", () => {
  it("a lost round doesn't un-lose on the next step", () => {
    const state: GameState = { ...stateInLane(1, 3), status: "lost", worldX: 3 };
    const next = step(state, 1 / 60, 2);
    expect(next.status).toBe("lost");
    expect(next.worldX).toBe(3);
  });
});

describe("the hand-authored level, driven end to end through the real level data", () => {
  // Runs the actual OBSTACLES track (not a synthetic wall) at a fixed
  // timestep, choosing a lane at each decision point. This is the same check
  // used to validate the level's balance before ever opening a browser (see
  // scripts/balance-sim.ts and the balance write-up in PROCESS.md).
  function drivePath(laneAt: (state: GameState) => 0 | 1 | 2): GameState {
    let state = createInitialState();
    state = { ...state, status: "playing" };
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 60 && state.status === "playing"; i++) {
      state = step(state, dt, laneAt(state));
    }
    return state;
  }

  // Every non-finish wall lives in lane 1 (see game.ts's header comment: "a
  // lane with no wall is always safe to pass through untouched") — so a
  // "reasonable" run doesn't abandon lane 1 forever after the first side
  // pickup, it detours out to a fork just long enough to grab the beneficial
  // zone (whichever lane that happens to be this fork — see
  // beneficialForkVisits above), then returns to lane 1 in time to face (or,
  // via its own bullets, pre-chip) the next wall.
  const FORK_VISITS = beneficialForkVisits();

  function zigzag(
    visits: { at: number; lane: 0 | 1 | 2 }[],
    finishLane: 0 | 1 | 2 = 1,
  ): (state: GameState) => 0 | 1 | 2 {
    return (state) => {
      const x = state.worldX;
      if (x >= TRACK_LENGTH - 0.25) return finishLane;
      for (const v of visits) {
        if (x >= v.at - 0.3 && x <= v.at + 0.05) return v.lane;
      }
      return 1;
    };
  }

  it("wins by collecting every visible bonus, dodging every danger zone, and beating the middle finish wall (560)", () => {
    const final = drivePath(zigzag(FORK_VISITS, 1));
    expect(final.status).toBe("won");
  });

  it("loses (not instantly, and well short of the mid tier) by never leaving the middle lane and skipping every bonus", () => {
    const final = drivePath((state) => 1);
    expect(final.status).toBe("lost");
    // Clears the first three walls (14/18/24) via the free ×2 gate plus
    // bullet chip alone — this isn't a first-wall instant-death build — but
    // dies in the teaching tier, right at the wall (40 at 4.1) that finally
    // outpaces what passive chip alone can keep up with.
    expect(final.worldX).toBeGreaterThan(1.7);
    expect(final.worldX).toBeLessThan(4.2);
  });

  it("a run that misses one or two later buffs (a realistic first attempt) still wins", () => {
    const missOne = drivePath(zigzag(FORK_VISITS.filter((v) => v.at !== 8.9), 1));
    expect(missOne.status).toBe("won");

    const missTwo = drivePath(zigzag(FORK_VISITS.filter((v) => v.at !== 8.9 && v.at !== 6.9), 1));
    expect(missTwo.status).toBe("won");
  });

  it("a clean run stays within the pacing target", () => {
    let state = createInitialState();
    state = { ...state, status: "playing" };
    const dt = 1 / 60;
    let seconds = 0;
    const laneAt = zigzag(FORK_VISITS, 1);
    for (; state.status === "playing" && seconds < 90; seconds += dt) {
      state = step(state, dt, laneAt(state));
    }
    expect(state.status).toBe("won");
    expect(seconds).toBeGreaterThan(10);
    expect(seconds).toBeLessThan(30);
  });
});

it("obstacles never overlap between lanes closely enough to double-resolve in one hit window", () => {
  // Sanity check on the hand-authored data: any two obstacles in the same
  // lane are spaced further apart than one hit window, so a single frame
  // can't resolve two of them at once.
  const byLane = new Map<number, number[]>();
  for (const ob of OBSTACLES) {
    const list = byLane.get(ob.lane) ?? [];
    list.push(ob.atUnits);
    byLane.set(ob.lane, list);
  }
  for (const positions of byLane.values()) {
    const sorted = [...positions].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThan(HIT_HALF * 2);
    }
  }
});

it("the track length reaches at least as far as the finish gauntlet", () => {
  const finishUnits = Math.max(...OBSTACLES.filter((o) => o.type === "wall" && o.isFinish).map((o) => o.atUnits));
  expect(TRACK_LENGTH).toBeGreaterThanOrEqual(finishUnits);
});
