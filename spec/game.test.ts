import { describe, expect, it } from "vitest";
import {
  BALL_RADIUS,
  BOTTOM_Y,
  FLIP_DURATION,
  OBSTACLES,
  TOP_Y,
  TRACK_LENGTH,
  step,
  type GameState,
} from "../game";

// The core rule under test: a spike on the rail you're riding ends the round
// in a loss, but the same spike is harmless from the other rail. This is the
// one mechanic the whole game rests on — everything else (score, the finish
// gate, difficulty ramp) is built on top of it.

const SIZE = { width: 960, height: 540 };

function stateApproaching(ob: (typeof OBSTACLES)[number], side: "top" | "bottom"): GameState {
  const y = side === "top" ? TOP_Y : BOTTOM_Y;
  return {
    status: "playing",
    // Close enough that one small step puts the ball's x inside the spike's
    // width, but not already overlapping — the step itself must trigger it.
    worldX: ob.atScreens - 0.02,
    ball: { target: side, y, animFrom: y, animT: FLIP_DURATION },
  };
}

describe("colliding with a spike on your rail ends the round in a loss", () => {
  const obstacle = OBSTACLES[0];

  it("dies when riding the rail the spike juts from", () => {
    const state = stateApproaching(obstacle, obstacle.side);
    const next = step(state, 1 / 60, false, SIZE);
    expect(next.status).toBe("lost");
  });

  it("survives the same spike from the opposite rail", () => {
    const safeSide = obstacle.side === "top" ? "bottom" : "top";
    const state = stateApproaching(obstacle, safeSide);
    const next = step(state, 1 / 60, false, SIZE);
    expect(next.status).toBe("playing");
  });
});

describe("reaching the end of the track ends the round in a win", () => {
  it("wins once travelled distance reaches the track length", () => {
    const state: GameState = {
      status: "playing",
      worldX: TRACK_LENGTH - 0.001,
      ball: { target: "bottom", y: BOTTOM_Y, animFrom: BOTTOM_Y, animT: FLIP_DURATION },
    };
    const next = step(state, 1 / 30, false, SIZE);
    expect(next.status).toBe("won");
  });

  it("keeps playing right before the gate", () => {
    const state: GameState = {
      status: "playing",
      worldX: TRACK_LENGTH - 2,
      ball: { target: "bottom", y: BOTTOM_Y, animFrom: BOTTOM_Y, animT: FLIP_DURATION },
    };
    const next = step(state, 1 / 30, false, SIZE);
    expect(next.status).toBe("playing");
  });
});

describe("a frozen round ignores further input", () => {
  it("a lost round doesn't un-lose on the next step", () => {
    const state: GameState = {
      status: "lost",
      worldX: 3,
      ball: { target: "bottom", y: BOTTOM_Y, animFrom: BOTTOM_Y, animT: FLIP_DURATION },
    };
    const next = step(state, 1 / 60, true, SIZE);
    expect(next.status).toBe("lost");
    expect(next.worldX).toBe(3);
  });
});

it("the ball radius is small relative to the gap between rails, so a well-timed flip has room to clear", () => {
  expect(BALL_RADIUS).toBeLessThan((BOTTOM_Y - TOP_Y) / 2);
});
