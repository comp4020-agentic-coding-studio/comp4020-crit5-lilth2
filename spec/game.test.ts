import { describe, expect, it } from "vitest";
import {
  HIT_HALF,
  LANE_ANIM_DURATION,
  OBSTACLES,
  TRACK_LENGTH,
  applyModifierToBullet,
  applyModifierToPlayer,
  canBreakWall,
  checkEndCondition,
  collectItem,
  createInitialState,
  resolveCollision,
  resolveWallHit,
  step,
  type GameState,
  type Wall,
  type Zone,
} from "../game";

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

  it("resolveCollision applies a zone to the player when touched", () => {
    const next = resolveCollision(stateInLane(0, 5), addFour);
    expect(next.playerValue).toBe(9);
    expect(next.status).toBe("playing");
  });
});

describe("resolveWallHit: a digit bullet chipping a wall", () => {
  it("subtracts the bullet's value from the wall's remaining hp", () => {
    expect(resolveWallHit(10, 4)).toBe(6);
  });

  it("floors at zero rather than going negative", () => {
    expect(resolveWallHit(3, 10)).toBe(0);
  });
});

describe("step(): bullets chip walls ahead of the player", () => {
  it("a bullet that grows through a +4 zone then hits a wall reduces that wall's hp", () => {
    // A minimal two-obstacle track segment. BULLET_SPEED is fast enough
    // that within a couple of seconds the auto-fired bullet has already
    // crossed the zone and reached the wall well before the (much slower)
    // player does.
    let state = createInitialState();
    state = { ...state, status: "playing", lane: 1, laneX: 1, laneFrom: 1 };
    const dt = 1 / 60;
    for (let i = 0; i < 90 && state.worldX < 1.5; i++) {
      state = step(state, dt, 1);
    }
    // The player hasn't reached the wall (at atUnits 1.53) yet, but a bullet
    // should have: the wall's live hp must be lower than its authored value.
    const wallIndex = OBSTACLES.findIndex((ob) => ob.type === "wall" && ob.atUnits === 1.53);
    expect(state.wallHp[wallIndex]).toBeLessThan(2);
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
  // used to validate the level's balance before ever opening a browser.
  function drivePath(laneAt: (worldX: number) => 0 | 1 | 2): GameState {
    let state = createInitialState();
    state = { ...state, status: "playing" };
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 60 && state.status === "playing"; i++) {
      state = step(state, dt, laneAt(state.worldX));
    }
    return state;
  }

  it("wins by collecting every visible bonus and choosing the beatable finish lane", () => {
    const final = drivePath((worldX) => {
      if (worldX < 2.55) return 1; // ride the teaching pair and first wall
      if (worldX < 3.53) return 2; // grab the +4, skip the -3
      if (worldX < 7.14) return 1; // back to the middle for x2 and the mid walls
      return 0; // finish: player value (16) only clears the lane-0 wall (16)
    });
    expect(final.status).toBe("won");
  });

  it("loses at one of the late walls by never leaving the middle lane (skips every side bonus)", () => {
    const final = drivePath(() => 1);
    expect(final.status).toBe("lost");
    // The player's own auto-fired bullets chip away at wall10/wall14 along
    // the way (a side effect of always firing down your own lane), so
    // exactly which of the two lets 8 through and which doesn't can shift —
    // but skipping every side zone still isn't enough value to survive to
    // the finish gauntlet.
    expect(final.worldX).toBeLessThan(7.31);
  });

  it("loses after taking the danger zone at the fork", () => {
    const final = drivePath((worldX) => {
      if (worldX < 2.55) return 1;
      if (worldX < 3.53) return 0; // takes the -3 instead of the +4
      return 1;
    });
    expect(final.status).toBe("lost");
  });

  it("a clean run stays within the tightened pacing target", () => {
    let state = createInitialState();
    state = { ...state, status: "playing" };
    const dt = 1 / 60;
    let seconds = 0;
    for (; state.status === "playing" && seconds < 90; seconds += dt) {
      const lane = state.worldX < 2.55 ? 1 : state.worldX < 3.53 ? 2 : state.worldX < 7.14 ? 1 : 0;
      state = step(state, dt, lane);
    }
    expect(state.status).toBe("won");
    expect(seconds).toBeGreaterThan(12);
    expect(seconds).toBeLessThan(40);
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
