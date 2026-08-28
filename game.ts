// Pure game logic for THRESHOLD: no DOM, no canvas, no timers. main.ts wraps
// this in a render/input loop; spec/game.test.ts drives it directly.
//
// The one mechanic: flip which rail the ball rides (top or bottom). A spike
// juts from whichever rail it's attached to, so the ball only survives it by
// being on the *other* rail when it passes. Reaching the end of the track
// wins; touching a spike loses. Nothing else.

export type Side = "top" | "bottom";
export type Status = "ready" | "playing" | "won" | "lost";

export interface Obstacle {
  /** World position, in screen-widths travelled from the start. */
  atScreens: number;
  /** Which rail the spike juts from — the ball must be on the other one. */
  side: Side;
}

export interface Ball {
  /** The rail the ball is flipping toward (or already resting on). */
  target: Side;
  /** Current vertical position, as a fraction of canvas height (0 = top of canvas). */
  y: number;
  /** y the flip animation started from. */
  animFrom: number;
  /** Seconds elapsed since the current flip animation began. */
  animT: number;
}

export interface GameState {
  status: Status;
  /** Distance travelled, in screen-widths. */
  worldX: number;
  ball: Ball;
}

export interface CanvasSize {
  width: number;
  height: number;
}

// --- Tunables, all resolution-independent (fractions of canvas W/H, or of
// screen-widths for horizontal distance) so the track plays the same at a
// phone portrait viewport and a desktop one. ---
export const TRACK_LENGTH = 15.8; // screens to the finish gate
export const BASE_SPEED = 0.5; // screens/sec at the start
export const MAX_SPEED = 0.92; // screens/sec at the finish
export const FLIP_DURATION = 0.16; // seconds for the flip animation
export const BALL_X = 0.16; // fixed screen-x, fraction of canvas width
export const BALL_RADIUS = 0.032; // fraction of canvas height
export const TOP_Y = 0.24; // top rail, fraction of canvas height
export const BOTTOM_Y = 0.76; // bottom rail, fraction of canvas height
export const SPIKE_REACH = 0.3; // how far a spike protrudes from its rail (fraction of canvas height)
export const SPIKE_WIDTH = 0.05; // fraction of canvas width

// Hand-authored track: a short teaching pair, then patterns that get denser
// and faster, one rapid double, a breather, and a tight run to the gate.
//
// The first spike sits at 0.55 screens — close enough that it's inside the
// canvas (BALL_X + atScreens < 1) while the ball is still frozen at worldX 0,
// so it's visible at rest, not just once the world starts scrolling. Playtesting
// caught this: the original first spike (1.35 screens out) rendered entirely
// off-canvas until the world had already started moving, so the opening frame
// showed a lone ball with nothing to react to.
export const OBSTACLES: readonly Obstacle[] = [
  { atScreens: 0.55, side: "bottom" },
  { atScreens: 1.75, side: "top" },
  { atScreens: 3.05, side: "bottom" },
  { atScreens: 4.05, side: "top" },
  { atScreens: 5.2, side: "bottom" },
  { atScreens: 5.55, side: "top" }, // quick double
  { atScreens: 6.8, side: "bottom" },
  { atScreens: 8.1, side: "top" },
  { atScreens: 9.8, side: "bottom" }, // breather before this
  { atScreens: 11.1, side: "top" },
  { atScreens: 11.4, side: "bottom" }, // quick double
  { atScreens: 12.5, side: "top" },
  { atScreens: 13.15, side: "bottom" },
  { atScreens: 13.8, side: "top" },
  { atScreens: 14.45, side: "bottom" },
];

function railY(side: Side): number {
  return side === "top" ? TOP_Y : BOTTOM_Y;
}

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
    status: "ready",
    worldX: 0,
    ball: { target: "bottom", y: BOTTOM_Y, animFrom: BOTTOM_Y, animT: FLIP_DURATION },
  };
}

/** Circle-vs-axis-aligned-rect overlap test, all args in the same pixel space. */
export function circleHitsRect(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  const nearestX = clamp(cx, rx, rx + rw);
  const nearestY = clamp(cy, ry, ry + rh);
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy < r * r;
}

/** The obstacle's hitbox in pixels, for a given world scroll and canvas size. */
export function obstacleRect(ob: Obstacle, worldX: number, size: CanvasSize) {
  const centerX = (BALL_X + (ob.atScreens - worldX)) * size.width;
  const w = SPIKE_WIDTH * size.width;
  const reach = SPIKE_REACH * size.height;
  const y = ob.side === "top" ? 0 : size.height - reach;
  return { x: centerX - w / 2, y, width: w, height: reach };
}

/** True if the ball (at its current rendered position) is touching this obstacle. */
export function ballHitsObstacle(ball: Ball, ob: Obstacle, worldX: number, size: CanvasSize): boolean {
  const rect = obstacleRect(ob, worldX, size);
  // Cheap reject: obstacles more than ~1.5 screens away can't overlap the ball.
  if (Math.abs(ob.atScreens - worldX) > 1.5) return false;
  return circleHitsRect(
    BALL_X * size.width,
    ball.y * size.height,
    BALL_RADIUS * size.height,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  );
}

/**
 * Advance the simulation by `dt` seconds. `flip` is true on the frame the
 * player pressed/tapped/clicked. Pure: returns a new state, never mutates.
 * Won/lost states are frozen here — main.ts decides when to reset.
 */
export function step(state: GameState, dt: number, flip: boolean, size: CanvasSize): GameState {
  if (state.status === "won" || state.status === "lost") {
    return state;
  }

  let status = state.status;
  let ball = state.ball;

  if (flip) {
    if (status === "ready") status = "playing";
    const target: Side = ball.target === "bottom" ? "top" : "bottom";
    ball = { ...ball, target, animFrom: ball.y, animT: 0 };
  }

  const animT = Math.min(FLIP_DURATION, ball.animT + dt);
  const eased = easeOutQuad(animT / FLIP_DURATION);
  const y = ball.animFrom + (railY(ball.target) - ball.animFrom) * eased;
  ball = { ...ball, animT, y };

  if (status !== "playing") {
    return { ...state, ball, status };
  }

  const progress = state.worldX / TRACK_LENGTH;
  const worldX = state.worldX + speedAt(progress) * dt;

  for (const ob of OBSTACLES) {
    if (ballHitsObstacle(ball, ob, worldX, size)) {
      return { ...state, ball, worldX, status: "lost" };
    }
  }

  if (worldX >= TRACK_LENGTH) {
    return { ...state, ball, worldX: TRACK_LENGTH, status: "won" };
  }

  return { ...state, ball, worldX, status: "playing" };
}
