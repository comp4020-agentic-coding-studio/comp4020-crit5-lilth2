// Rendering + input for DIGIT CANNON RUN. All game rules live in game.ts
// (pure, tested); this file only projects a pseudo-3D lane-runner from that
// state and turns keyboard/pointer input into the single "which lane do I
// want to be in" intent the rules understand.
import {
  BULLET_FIRE_INTERVAL,
  LANES,
  MIN_FIRE_INTERVAL,
  OBSTACLES,
  TRACK_LENGTH,
  createInitialState,
  isWallDestroyed,
  step,
  type Bullet,
  type CanvasSize,
  type GameState,
  type Lane,
  type Obstacle,
  type Wall,
  type ZoneKind,
} from "./game";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) throw new Error("missing #game canvas");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d canvas context unavailable");

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  r: number;
  /** "circle" (default): a soft dot. "rect": a spinning confetti chip. "glyph":
   *  a scattering fragment of an actual digit character, for wall-break hits. */
  shape?: "circle" | "rect" | "glyph";
  glyph?: string;
  rot?: number;
  vrot?: number;
}

/** A transient color/scale reaction on the player's digit body, set whenever
 *  a zone or item changes playerValue, and decayed away in draw(). */
interface PlayerFx {
  kind: "gain" | "mult" | "loss" | "rate";
  t: number;
}

/** A bullet's own operator kind, distinguished so a hit reads as one of four
 *  specific things (grow-green, multiply-purple, shrink-red, divide-orange)
 *  instead of a generic buff/debuff — matches the zone/gate palette below. */
type BulletModKind = "add" | "mul" | "sub" | "div";

/** One-shot flash on a bullet's own badge when a zone changes its value —
 *  keyed by Bullet.id so it survives across frames until it decays, keyed
 *  by identity rather than array position (bullets are added/removed every
 *  frame). */
interface BulletFx {
  kind: BulletModKind;
  t: number;
}

// --- Perspective tunables, all fractions of canvas W/H so the road looks the
// same shape on a phone and a desktop. Retuned for the 9:16 portrait stage
// (styles.css) so the track fills most of the frame vertically instead of
// leaving a wide, empty landscape band. ---
const HORIZON_Y = 0.2;
const NEAR_Y = 0.94;
const HORIZON_HALF_ROAD = 0.04;
const NEAR_HALF_ROAD = 0.48;
const DEPTH_POW = 1.7;
const VIEW_DISTANCE = 3.6; // track units ahead visible at once — several walls receding into the distance
const FADE_TAIL = 0.25; // track units of fade-out after passing the player

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Darkens (amt<0) or lightens (amt>0) a "#rrggbb" color, for extrusion faces. */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 0xff) + Math.round(255 * amt), 0, 255);
  const g = clamp(((n >> 8) & 0xff) + Math.round(255 * amt), 0, 255);
  const b = clamp((n & 0xff) + Math.round(255 * amt), 0, 255);
  return `rgb(${r},${g},${b})`;
}

/** Linear-interpolates between two "#rrggbb" colors — used to drain the lost
 *  player's digit from red toward gray over the punch, instead of a flat
 *  red-only loss color. */
function mixHex(a: string, b: string, t: number): string {
  const na = parseInt(a.slice(1), 16);
  const nb = parseInt(b.slice(1), 16);
  const mix = (shift: number) => Math.round(((na >> shift) & 0xff) * (1 - t) + ((nb >> shift) & 0xff) * t);
  return `rgb(${mix(16)},${mix(8)},${mix(0)})`;
}

const dpr = Math.max(1, window.devicePixelRatio || 1);
let size: CanvasSize = { width: 0, height: 0 };

function resize(): void {
  const parent = canvas!.parentElement;
  const rect = (parent ?? canvas!).getBoundingClientRect();
  size = { width: rect.width, height: rect.height };
  canvas!.width = Math.max(1, Math.round(size.width * dpr));
  canvas!.height = Math.max(1, Math.round(size.height * dpr));
  canvas!.style.width = `${size.width}px`;
  canvas!.style.height = `${size.height}px`;
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

let state: GameState = createInitialState();
let desiredLane: Lane = state.lane;
let best = 0;
let resultAt: number | null = null;
let idleT = 0;
let particles: Particle[] = [];
let playerFx: PlayerFx | null = null;
let now = performance.now();
// Time since the player's own cannon last actually fired a new bullet (null =
// no recent shot) — drives the muzzle-flash flare in drawPlayerDigit. Tracked
// by the highest Bullet.id seen so far rather than array length, since a
// bullet leaving the array (resolved/off-screen) must not itself look like a
// new shot.
let muzzleFlash: number | null = null;
let lastFiredBulletId = -1;

// Bullet-id -> last-seen resolvedUpTo, so advancing past a zone can be
// diffed frame to frame (mirroring the player's own prevResolvedUpTo diff
// below) and turned into a one-shot flash + persistent tint keyed by
// identity, distinguishing exactly which of the four operators hit it.
let prevBulletResolvedUpTo = new Map<number, number>();
let bulletFx = new Map<number, BulletFx>();
let bulletLastKind = new Map<number, BulletModKind>();
// Obstacle index -> time since last hit, for the brief per-wall "recoil"
// punch (a small squash/offset) that a fade-only crack effect doesn't give.
let wallRecoil = new Map<number, number>();
// Obstacle index -> time since a bullet or the player last passed through a
// standing zone gate, for a brief brightness pulse (gates never disappear —
// they're reusable — so this is the only "you just triggered me" feedback).
let gatePulse = new Map<number, number>();
// Obstacle index -> time since a wall's hp crossed to destroyed, driving the
// flash -> split -> fade shatter sequence in drawObstacle instead of an
// instant vanish.
let wallShatter = new Map<number, number>();

// Playtest report: the result screen used to auto-restart on its own after
// this many ms, with no way to tell "did I lose, or did the game just move
// on?" — Crit 5 requires the game to visibly end, so the run now holds here
// forever; nothing but an explicit tap/click/keypress (see restartReady())
// moves past it. Kept only as the timing reference for the flash-in tint and
// banner fades below, not as an auto-restart deadline.
const RESULT_HOLD_MS = 1300;
// Shared by the player digit AND every obstacle draw during a win/loss hold:
// ramps 1 -> 0 over the first RESULT_FADE_MS of the hold. Obstacles need this
// too, not just the player — a playtest found the untouched finish-lane walls
// (the two lanes the player didn't drive through) just sit there with their
// hp labels clumped at the bottom of the screen for the entire 1300ms hold,
// since only the player digit used to fade at all.
const RESULT_FADE_MS = 500;
function resultFade(): number {
  if (state.status !== "won" && state.status !== "lost") return 1;
  if (resultAt === null) return 1;
  return clamp(1 - (now - resultAt) / RESULT_FADE_MS, 0, 1);
}

function requestLane(lane: number): void {
  desiredLane = clamp(lane, 0, LANES - 1) as Lane;
}

// --- Input: keyboard (arrows / A-D) and pointer (drag to slide, or tap the
// left/right third to step one lane). No on-screen labels — the opening
// frame's own idle slide is the only teaching aid. ---
let pointerDown = false;
let dragStartX = 0;
let dragStartLane: Lane = 1;
let dragged = false;
let lastPointerX = 0;
const DRAG_THRESHOLD_PX = 14;

canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  pointerDown = true;
  dragged = false;
  dragStartX = e.clientX;
  lastPointerX = e.clientX;
  dragStartLane = desiredLane;
});
window.addEventListener("pointermove", (e) => {
  if (!pointerDown) return;
  lastPointerX = e.clientX;
  const deltaX = e.clientX - dragStartX;
  if (!dragged && Math.abs(deltaX) > DRAG_THRESHOLD_PX) dragged = true;
  if (dragged) {
    const laneUnitPx = Math.max(46, size.width / 6.5);
    requestLane(dragStartLane + Math.round(deltaX / laneUnitPx));
  }
});
window.addEventListener("pointerup", () => {
  if (pointerDown && !dragged) {
    const rect = canvas!.getBoundingClientRect();
    const relX = (lastPointerX - rect.left) / rect.width;
    if (relX < 0.4) requestLane(dragStartLane - 1);
    else if (relX > 0.6) requestLane(dragStartLane + 1);
  }
  pointerDown = false;
});
window.addEventListener(
  "keydown",
  (e) => {
    if (restartReady()) {
      e.preventDefault();
      restartNow();
      return;
    }
    if (e.code === "ArrowLeft" || e.code === "KeyA") {
      e.preventDefault();
      requestLane(desiredLane - 1);
    } else if (e.code === "ArrowRight" || e.code === "KeyD") {
      e.preventDefault();
      requestLane(desiredLane + 1);
    }
  },
  { passive: false },
);
canvas.style.touchAction = "none";

function spawnBurst(x: number, y: number, color: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const speed = 70 + Math.random() * 200;
    const life = 0.4 + Math.random() * 0.5;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 40,
      life,
      maxLife: life,
      color,
      r: 2.5 + Math.random() * 2.5,
    });
  }
}

/** Scatters fragments of the wall's own printed digits — the "digit
 *  fragments" hit-feedback the reference games use instead of plain sparks. */
function spawnDigitFragments(x: number, y: number, value: number | string, color: string): void {
  const chars = String(value).split("");
  for (const ch of chars) {
    for (let i = 0; i < 3; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 90 + Math.random() * 180;
      const life = 0.45 + Math.random() * 0.4;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        life,
        maxLife: life,
        color,
        r: 11 + Math.random() * 6,
        shape: "glyph",
        glyph: ch,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 10,
      });
    }
  }
}

/** Colorful confetti chips for the win burst — distinct from the plain
 *  circular sparks used for smaller in-run feedback. */
function spawnConfetti(x: number, y: number, count: number): void {
  const palette = ["#ffb648", "#57e0a0", "#7fd7ff", "#ff8fd6", "#ffe27a"];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 120 + Math.random() * 260;
    const life = 0.7 + Math.random() * 0.6;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 160,
      life,
      maxLife: life,
      color: palette[i % palette.length],
      r: 4 + Math.random() * 4,
      shape: "rect",
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 12,
    });
  }
}

/** Angular red/gray debris for the player's own loss shatter. Deliberately
 *  NOT spawnDigitFragments (which scatters an obstacle's printed value as
 *  flying digit glyphs) — doing that with the player's own current value
 *  reads as "your digits are being peeled off one at a time," implying a
 *  per-digit-removal mechanic the game doesn't actually have. This is plain
 *  shatter debris instead, same visual family as a destroyed wall's glass
 *  shards but tinted for "you," not "the obstacle." */
function spawnLossShards(x: number, y: number, count: number): void {
  const palette = ["#ff5064", "#ffb0ba", "#8891a1"];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 110 + Math.random() * 260;
    const life = 0.5 + Math.random() * 0.5;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 100,
      life,
      maxLife: life,
      color: palette[i % palette.length],
      r: 4 + Math.random() * 6,
      shape: "rect",
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 14,
    });
  }
}

/** Bigger, paler shard debris for the moment a wall is actually destroyed —
 *  distinct from the small blue chip-hit sparks used for a non-lethal hit. */
function spawnGlassShards(x: number, y: number, count: number): void {
  const palette = ["#eaffff", "#8fd0ff", "#ffffff"];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 140 + Math.random() * 320;
    const life = 0.5 + Math.random() * 0.5;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 120,
      life,
      maxLife: life,
      color: palette[i % palette.length],
      r: 5 + Math.random() * 7,
      shape: "rect",
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 16,
    });
  }
}

// --- Screen shake: a small transient offset applied to the whole draw pass,
// triggered by a bullet chipping a wall or the player hitting one. Decays
// automatically in frame(). ---
let shake = 0;
function triggerShake(amount: number): void {
  shake = Math.min(1, shake + amount);
}

// --- Perspective projection: depth 0 = at the horizon (just appeared), 1 =
// at the player's fixed collision plane. ---
function depthOf(distanceAhead: number): number {
  return clamp(1 - distanceAhead / VIEW_DISTANCE, 0, 1);
}
function visibleAt(distanceAhead: number): boolean {
  return distanceAhead <= VIEW_DISTANCE && distanceAhead > -FADE_TAIL;
}
function fadeAlpha(distanceAhead: number): number {
  return distanceAhead >= 0 ? 1 : clamp(1 + distanceAhead / FADE_TAIL, 0, 1);
}
function yAt(d: number, H: number): number {
  const e = Math.pow(clamp(d, 0, 1), DEPTH_POW);
  return (HORIZON_Y + (NEAR_Y - HORIZON_Y) * e) * H;
}
function roadHalfWidthAt(d: number, W: number): number {
  const e = Math.pow(clamp(d, 0, 1), DEPTH_POW);
  return (HORIZON_HALF_ROAD + (NEAR_HALF_ROAD - HORIZON_HALF_ROAD) * e) * W;
}
function laneCenterX(laneX: number, d: number, W: number): number {
  const roadWidth = roadHalfWidthAt(d, W) * 2;
  return W / 2 + (laneX - 1) * (roadWidth / LANES);
}

function drawSky(W: number, H: number): void {
  const bg = ctx!.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#7fe6df");
  bg.addColorStop(0.55, "#c3f4ee");
  bg.addColorStop(1, "#eefdf9");
  ctx!.fillStyle = bg;
  ctx!.fillRect(0, 0, W, H * (HORIZON_Y + 0.02));

  // a few soft drifting clouds, independent of game state, so the opening
  // frame reads as alive before any input
  ctx!.fillStyle = "rgba(255,255,255,0.85)";
  for (let i = 0; i < 5; i++) {
    const sx = (((i * 0.31 + 0.1) * W - idleT * (6 + i * 2)) % (W + 200)) - 100;
    const sy = H * (0.08 + 0.09 * ((i * 53) % 5));
    ctx!.beginPath();
    ctx!.ellipse(sx, sy, 46, 16, 0, 0, Math.PI * 2);
    ctx!.fill();
  }
}

// Segmented gray/light-purple-gray "platform" bands, scrolling toward the
// viewer, instead of one flat fill — the segment lines are what sell "this
// is a track made of plates rushing past" rather than a static road.
const ROAD_TONE_A = "#c7c6d8";
const ROAD_TONE_B = "#dcdae8";
const BAND_FREQ = 3.4; // bands per track unit

function drawRoad(W: number, H: number): void {
  const nearHalf = roadHalfWidthAt(1, W);
  const farHalf = roadHalfWidthAt(0, W);
  const nearY = yAt(1, H);
  const farY = yAt(0, H);
  const cx = W / 2;

  const STEPS = 44;
  for (let i = 0; i < STEPS; i++) {
    const d0 = 1 - i / STEPS;
    const d1 = 1 - (i + 1) / STEPS;
    const y0 = yAt(d0, H);
    const y1 = yAt(d1, H);
    const h0 = roadHalfWidthAt(d0, W);
    const h1 = roadHalfWidthAt(d1, W);
    const bandDistance = state.worldX + (1 - d0) * VIEW_DISTANCE;
    const bandIndex = Math.floor(bandDistance * BAND_FREQ);
    ctx!.fillStyle = bandIndex % 2 === 0 ? ROAD_TONE_A : ROAD_TONE_B;
    ctx!.beginPath();
    ctx!.moveTo(cx - h0, y0);
    ctx!.lineTo(cx + h0, y0);
    ctx!.lineTo(cx + h1, y1);
    ctx!.lineTo(cx - h1, y1);
    ctx!.closePath();
    ctx!.fill();
  }

  // lane dividers (2 interior lines for 3 lanes), scrolling for a sense of speed
  ctx!.strokeStyle = "rgba(255, 255, 255, 0.55)";
  const dashOffset = ((idleT * 40 + state.worldX * 260) % 40) - 40;
  for (const boundary of [-1 / 3, 1 / 3]) {
    ctx!.setLineDash([14, 14]);
    ctx!.lineDashOffset = dashOffset;
    ctx!.lineWidth = 2;
    ctx!.beginPath();
    ctx!.moveTo(cx + boundary * farHalf * 2 * 1.0, farY);
    ctx!.lineTo(cx + boundary * nearHalf * 2, nearY);
    ctx!.stroke();
  }
  ctx!.setLineDash([]);

  // guardrails: a solid pale rail plus evenly spaced posts along both edges
  ctx!.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx!.shadowColor = "rgba(140, 200, 255, 0.55)";
  ctx!.shadowBlur = 8;
  ctx!.lineWidth = 3;
  ctx!.beginPath();
  ctx!.moveTo(cx - farHalf, farY);
  ctx!.lineTo(cx - nearHalf, nearY);
  ctx!.moveTo(cx + farHalf, farY);
  ctx!.lineTo(cx + nearHalf, nearY);
  ctx!.stroke();
  ctx!.shadowBlur = 0;

  ctx!.fillStyle = "rgba(140, 150, 175, 0.8)";
  for (let i = 0; i < 10; i++) {
    const d = Math.pow(i / 10, 1.4);
    const y = yAt(d, H);
    const half = roadHalfWidthAt(d, W);
    const postW = Math.max(1.5, 4 * (0.2 + 0.8 * d));
    const postH = Math.max(4, 14 * (0.2 + 0.8 * d));
    ctx!.fillRect(cx - half - postW * 0.5, y - postH, postW, postH);
    ctx!.fillRect(cx + half - postW * 0.5, y - postH, postW, postH);
  }
}

// Faint streak lines scrolling from the horizon toward the viewer, to sell
// the faster pace without any new heavy assets.
function drawSpeedLines(W: number, H: number): void {
  const cx = W / 2;
  const speed = 0.6 + state.worldX * 0.05;
  ctx!.save();
  for (let i = 0; i < 14; i++) {
    const t = (i / 14 + idleT * speed) % 1;
    const d = t * t; // ease so streaks accelerate as they near the viewer
    const y = yAt(d, H);
    const half = roadHalfWidthAt(d, W);
    const laneIdx = i % LANES;
    const x = cx + (laneIdx - 1) * ((half * 2) / LANES) * 0.72;
    const len = 4 + 22 * d;
    const alpha = 0.22 * d;
    if (alpha <= 0.01) continue;
    ctx!.globalAlpha = alpha;
    ctx!.strokeStyle = "rgba(255,255,255,0.9)";
    ctx!.lineWidth = Math.max(1, 2 * d);
    ctx!.beginPath();
    ctx!.moveTo(x, y);
    ctx!.lineTo(x, y - len);
    ctx!.stroke();
  }
  ctx!.restore();
}

// Self-teaching color convention, shared by items, zones, and digit bullets:
// green = add-positive, purple = multiply, red = add-negative, orange =
// divide, yellow electric = the fire-rate gate (no text explanation, per
// the brief).
function modifierColor(kind: ZoneKind, value: number): { fill: string; glow: string } {
  if (kind === "rate") return { fill: "#ffe066", glow: "rgba(255,224,102,0.9)" };
  if (kind === "mul") return { fill: "#b98bff", glow: "rgba(185,139,255,0.9)" };
  if (kind === "div") return { fill: "#ff9d42", glow: "rgba(255,157,66,0.9)" };
  return value >= 0 ? { fill: "#57e0a0", glow: "rgba(87,224,160,0.9)" } : { fill: "#ff6b7a", glow: "rgba(255,107,122,0.9)" };
}

function labelFor(ob: Obstacle): string {
  if (ob.type === "wall") return String(ob.value);
  if (ob.kind === "rate") return "⚡";
  if (ob.kind === "mul") return `×${ob.value}`;
  if (ob.kind === "div") return `÷${ob.value}`;
  return ob.value >= 0 ? `+${ob.value}` : String(ob.value);
}

// Lanes converge toward a single point at the horizon, so two obstacles in
// different lanes (a wall's hp label and a neighbouring zone's operator
// label, say) can sit almost on top of each other on screen while they're
// still far away — the exact "598"+"50" merging into "59850" glyph-soup a
// playtest turned up. Below this scale (lanes are still narrow on screen),
// obstacles render as their plain glowing shape only — still enough to read
// "buff" vs "trap" by color from a distance — and the numeric label pops in
// once the obstacle is close enough that adjacent lanes are actually spaced
// apart on screen.
const LABEL_REVEAL_SCALE = 0.5;

function drawObstacle(ob: Obstacle, index: number, W: number, H: number): void {
  const distanceAhead = ob.atUnits - state.worldX;
  if (!visibleAt(distanceAhead)) return;
  const d = depthOf(distanceAhead);
  const alpha = fadeAlpha(distanceAhead) * resultFade();
  if (alpha <= 0.01) return;
  const x = laneCenterX(ob.lane, d, W);
  const y = yAt(d, H);
  const roadWidth = roadHalfWidthAt(d, W) * 2;
  const laneWidth = roadWidth / LANES;
  const scale = 0.16 + 0.84 * d;
  const showLabel = scale >= LABEL_REVEAL_SCALE;

  ctx!.save();
  ctx!.globalAlpha = alpha;

  if (ob.type === "wall") {
    // Walls render their *live* hp (state.wallHp), not the authored value —
    // digit bullets may have already chipped it down before the player gets
    // here, and that has to be visible on the wall itself. Rendered as a
    // cyan glass / white-edged block rather than a solid slab, so several
    // stacked ahead read as "gates in a tunnel," not opaque obstacles.
    const hp = state.wallHp[index] ?? ob.value;
    if (isWallDestroyed(hp)) {
      const shatterT = wallShatter.get(index);
      // Once the shatter animation has fully played (or was never started,
      // e.g. a wall already destroyed on load), the wall is truly gone.
      if (shatterT === undefined) {
        ctx!.restore();
        return;
      }
      drawWallShatter(ob, index, x, y, alpha, scale, laneWidth, shatterT);
      ctx!.restore();
      return;
    }
    const isFinish = ob.isFinish === true;
    const cracked = hp < ob.value;
    const w = laneWidth * 0.82;
    // A brief squash-and-sink "recoil" punch on the frame(s) right after a
    // hit — the visible flinch a chip-only crack effect didn't have.
    const recoilT = wallRecoil.get(index);
    const recoil = recoilT !== undefined ? clamp(1 - recoilT / 0.12, 0, 1) : 0;
    const h = Math.max(12, 52 * scale) * (1 - 0.16 * recoil);
    const pulse = isFinish ? 0.6 + 0.4 * Math.sin(idleT * 4) : 1;
    const glassFill = isFinish ? "rgba(255,196,90,0.35)" : "rgba(80,225,220,0.3)";
    const glassEdge = isFinish ? "rgba(255,196,90,0.95)" : "rgba(255,255,255,0.9)";
    const rx = x - w / 2;
    const ry = y - h + 6 * scale * recoil;
    const r = Math.min(12, w * 0.14);

    ctx!.fillStyle = glassFill;
    ctx!.shadowColor = isFinish ? "rgba(255,196,90,0.85)" : "rgba(90,220,210,0.6)";
    ctx!.shadowBlur = 16 * pulse;
    roundRect(rx, ry, w, h, r);
    ctx!.fill();

    ctx!.shadowBlur = 0;
    ctx!.strokeStyle = glassEdge;
    ctx!.lineWidth = Math.max(1.5, 2.4 * scale);
    roundRect(rx, ry, w, h, r);
    ctx!.stroke();

    // a soft diagonal highlight, so the block reads as glass, not paint
    ctx!.save();
    ctx!.beginPath();
    roundRect(rx, ry, w, h, r);
    ctx!.clip();
    ctx!.fillStyle = "rgba(255,255,255,0.22)";
    ctx!.beginPath();
    ctx!.moveTo(rx, ry);
    ctx!.lineTo(rx + w * 0.4, ry);
    ctx!.lineTo(rx + w * 0.15, ry + h);
    ctx!.lineTo(rx, ry + h);
    ctx!.closePath();
    ctx!.fill();
    ctx!.restore();

    if (cracked) {
      ctx!.strokeStyle = "rgba(255,255,255,0.95)";
      ctx!.lineWidth = Math.max(1, 2 * scale);
      ctx!.beginPath();
      ctx!.moveTo(x - w * 0.16, ry + h * 0.12);
      ctx!.lineTo(x + w * 0.06, ry + h * 0.48);
      ctx!.lineTo(x - w * 0.1, ry + h * 0.88);
      ctx!.stroke();
    }

    if (showLabel) {
      ctx!.fillStyle = "#0e2a3a";
      ctx!.strokeStyle = "rgba(255,255,255,0.9)";
      ctx!.lineWidth = Math.max(1, 3 * scale);
      ctx!.font = `800 ${Math.max(11, 23 * scale)}px system-ui, sans-serif`;
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      ctx!.strokeText(String(hp), x, y - h / 2);
      ctx!.fillText(String(hp), x, y - h / 2);
    }
  } else if (ob.type === "zone") {
    // An "energy gate" — two tinted pylons framing a pulsing field, fully
    // colored by operator kind (fill/glow/border, not just a thin border on
    // a generic cyan panel) — reads as a portal/field to pass through, not a
    // pickup or a block. Never removed/consumed: a brief brightness pulse
    // (gatePulse, keyed by obstacle index) is the only "just triggered"
    // feedback, fired whenever a bullet or the player passes through.
    const tint = modifierColor(ob.kind, ob.value);
    const gateW = laneWidth * 0.74;
    const gateH = Math.max(28, 90 * scale);
    const cy = y - gateH * 0.52;
    const idlePulse = 0.65 + 0.35 * Math.sin(idleT * 3 + ob.atUnits * 5);
    const hitT = gatePulse.get(index);
    const hitPulse = hitT !== undefined ? clamp(1 - hitT / 0.45, 0, 1) : 0;
    const pulse = Math.min(1.7, idlePulse + hitPulse * 1.1);
    const pylonW = Math.max(4, gateW * 0.1);
    const leftX = x - gateW / 2;
    const rightX = x + gateW / 2;
    const topY = cy - gateH / 2;

    ctx!.fillStyle = shade(tint.fill, -0.2);
    ctx!.shadowColor = tint.glow;
    ctx!.shadowBlur = 14 * scale * pulse;
    roundRect(leftX - pylonW / 2, topY, pylonW, gateH, pylonW * 0.4);
    ctx!.fill();
    roundRect(rightX - pylonW / 2, topY, pylonW, gateH, pylonW * 0.4);
    ctx!.fill();
    ctx!.shadowBlur = 0;
    ctx!.strokeStyle = "rgba(255,255,255,0.75)";
    ctx!.lineWidth = Math.max(1, 1.4 * scale);
    roundRect(leftX - pylonW / 2, topY, pylonW, gateH, pylonW * 0.4);
    ctx!.stroke();
    roundRect(rightX - pylonW / 2, topY, pylonW, gateH, pylonW * 0.4);
    ctx!.stroke();

    // pulsing radial field between the pylons
    ctx!.save();
    ctx!.globalAlpha = alpha * (0.5 + 0.4 * pulse);
    const grad = ctx!.createRadialGradient(x, cy, 0, x, cy, gateW * 0.55);
    grad.addColorStop(0, tint.glow);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx!.fillStyle = grad;
    ctx!.beginPath();
    ctx!.ellipse(x, cy, gateW * 0.5, gateH * 0.48, 0, 0, Math.PI * 2);
    ctx!.fill();
    ctx!.restore();

    // an operator ring floating at the gate's center, brightening on a pulse
    ctx!.strokeStyle = tint.fill;
    ctx!.lineWidth = Math.max(2, 3 * scale) * (0.75 + 0.4 * pulse);
    ctx!.shadowColor = tint.glow;
    ctx!.shadowBlur = 10 * scale * pulse;
    ctx!.beginPath();
    ctx!.ellipse(x, cy, gateW * 0.4, gateH * 0.4, 0, 0, Math.PI * 2);
    ctx!.stroke();
    ctx!.shadowBlur = 0;

    if (showLabel) {
      ctx!.fillStyle = "#0e2a3a";
      ctx!.strokeStyle = "rgba(255,255,255,0.95)";
      ctx!.lineWidth = Math.max(1.5, 3.4 * scale);
      ctx!.font = `800 ${Math.max(13, 24 * scale)}px system-ui, sans-serif`;
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      ctx!.strokeText(labelFor(ob), x, cy);
      ctx!.fillText(labelFor(ob), x, cy);
    }
  } else {
    const colors = modifierColor(ob.kind, ob.value);
    const size2 = laneWidth * 0.42;
    const bob = Math.sin(idleT * 3 + ob.atUnits * 4) * 4 * scale;
    ctx!.fillStyle = colors.fill;
    ctx!.shadowColor = colors.glow;
    ctx!.shadowBlur = 16 * scale;
    roundRect(x - size2 / 2, y - size2 - 10 * scale + bob, size2, size2, size2 * 0.28);
    ctx!.fill();

    ctx!.shadowBlur = 0;
    if (showLabel) {
      ctx!.fillStyle = "#0c1420";
      ctx!.font = `700 ${Math.max(10, 18 * scale)}px system-ui, sans-serif`;
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      ctx!.fillText(labelFor(ob), x, y - size2 / 2 - 10 * scale + bob);
    }
  }

  ctx!.restore();
}

const WALL_SHATTER_DURATION = 0.3;
const WALL_SHATTER_FLASH = 0.08;

/** Replaces the instant vanish-on-destroy: a full white flash for the first
 *  ~80ms, then the block visibly splits into two halves that slide apart,
 *  tumble slightly, and fade over the remaining ~220ms — "the wall itself
 *  breaks apart" instead of "the wall disappears near where debris appears." */
function drawWallShatter(
  ob: Wall,
  index: number,
  x: number,
  y: number,
  alpha: number,
  scale: number,
  laneWidth: number,
  t: number,
): void {
  const w = laneWidth * 0.82;
  const h = Math.max(12, 52 * scale);
  const topY = y - h;
  const r = Math.min(12, w * 0.14);
  const isFinish = ob.isFinish === true;
  const glassFill = isFinish ? "rgba(255,196,90,0.35)" : "rgba(80,225,220,0.3)";
  const glassEdge = isFinish ? "rgba(255,196,90,0.95)" : "rgba(255,255,255,0.9)";

  const flashT = clamp(1 - t / WALL_SHATTER_FLASH, 0, 1);
  const spreadT = clamp((t - WALL_SHATTER_FLASH) / (WALL_SHATTER_DURATION - WALL_SHATTER_FLASH), 0, 1);
  const fade = 1 - spreadT;
  const halfW = w / 2;
  const shrunkH = h * (1 - 0.35 * spreadT);
  const slide = spreadT * w * 0.55;
  const drop = spreadT * h * 0.35;

  if (fade > 0) {
    for (const side of [-1, 1] as const) {
      const cx = x + (side * w) / 4;
      ctx!.save();
      ctx!.globalAlpha = alpha * fade;
      ctx!.translate(cx + side * slide, topY + h / 2 + drop);
      ctx!.rotate(side * 0.28 * spreadT);
      ctx!.fillStyle = glassFill;
      roundRect(-halfW / 2, -shrunkH / 2, halfW, shrunkH, r);
      ctx!.fill();
      ctx!.strokeStyle = glassEdge;
      ctx!.lineWidth = Math.max(1.5, 2.4 * scale);
      roundRect(-halfW / 2, -shrunkH / 2, halfW, shrunkH, r);
      ctx!.stroke();
      ctx!.restore();
    }
  }

  if (flashT > 0) {
    ctx!.save();
    ctx!.globalAlpha = alpha * flashT;
    ctx!.fillStyle = "#ffffff";
    ctx!.shadowColor = "rgba(255,255,255,0.95)";
    ctx!.shadowBlur = 30 * scale;
    roundRect(x - halfW, topY, w, h, r);
    ctx!.fill();
    ctx!.restore();
  }
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx!.beginPath();
  ctx!.moveTo(x + r, y);
  ctx!.arcTo(x + w, y, x + w, y + h, r);
  ctx!.arcTo(x + w, y + h, x, y + h, r);
  ctx!.arcTo(x, y + h, x, y, r);
  ctx!.arcTo(x, y, x + w, y, r);
  ctx!.closePath();
}

function cannonPos(W: number, H: number): { x: number; y: number } {
  return { x: laneCenterX(state.laneX, 1, W), y: yAt(1, H) };
}

const PLAYER_BLUE = "#3b82f6";

// The player's body IS their number: a large extruded-3D blue digit — no
// separate block/turret shape. It reacts to what just happened to
// playerValue (scale-up + blue/green flash on a gain, rapid expansion +
// afterimage on a multiply, red shake on a loss) via the decaying
// `playerFx` set in frame().
function drawPlayerDigit(W: number, H: number): void {
  const inResult = state.status === "won" || state.status === "lost";
  // On win/lost the digit doesn't just vanish: it holds the moment of impact
  // (smashing bigger through a won finish wall, jolting on a lost one) then
  // fades over the first ~0.5s of RESULT_HOLD_MS, rather than cutting to the
  // walls/flash-tint with nothing marking where the player was.
  if (inResult && resultAt === null) return;
  const fade = resultFade();
  if (inResult && fade <= 0) return;
  const { x, y } = cannonPos(W, H);
  const bob = inResult ? 0 : Math.sin(idleT * 2.6) * 3;
  const laneWidth = (roadHalfWidthAt(1, W) * 2) / LANES;
  const fontSize = laneWidth * 0.66;

  let face = PLAYER_BLUE;
  let glow = "rgba(120,190,255,0.85)";
  let scale = 1;
  let tilt = inResult ? 0 : Math.sin(idleT * 1.7) * 0.05;
  let afterimage = false;
  let electric = false;

  if (inResult) {
    const punch = 1 - fade;
    if (state.status === "won") {
      face = "#ffd76a";
      glow = `rgba(255,182,72,${0.5 + 0.5 * fade})`;
      scale = 1 + 0.4 * punch;
    } else {
      // Loss reads as one combined beat — shatter, then drain toward gray —
      // rather than staying red for the whole hold.
      const grayness = clamp(punch * 1.4, 0, 1);
      face = mixHex("#ff5064", "#8891a1", grayness);
      glow = `rgba(255,80,100,${0.5 * (1 - grayness) + 0.15})`;
      scale = 1 - 0.35 * punch;
      tilt = Math.sin(idleT * 50) * 0.09 * punch;
    }
  } else if (playerFx) {
    const decay = clamp(1 - playerFx.t / 0.5, 0, 1);
    if (playerFx.kind === "gain") {
      face = "#57e0a0";
      glow = `rgba(87,224,160,${0.55 + 0.45 * decay})`;
      scale = 1 + 0.16 * decay;
    } else if (playerFx.kind === "mult") {
      face = "#b98bff";
      glow = `rgba(185,139,255,${0.55 + 0.45 * decay})`;
      scale = 1 + 0.5 * decay; // rapid expansion, per the x2-boost spec
      afterimage = decay > 0.1;
    } else if (playerFx.kind === "loss") {
      face = "#ff5064";
      glow = `rgba(255,107,122,${0.55 + 0.45 * decay})`;
      scale = 1 - 0.1 * decay;
      tilt += Math.sin(idleT * 40) * 0.05 * decay;
    } else if (playerFx.kind === "rate") {
      face = "#ffe066";
      glow = `rgba(255,224,102,${0.55 + 0.45 * decay})`;
      scale = 1 + 0.08 * decay;
      electric = decay > 0.05;
    }
  }

  const label = String(state.playerValue);
  const dark = shade(face, -0.55);

  ctx!.save();
  ctx!.globalAlpha = fade;
  ctx!.translate(x, y - fontSize * 0.42 + bob);
  ctx!.rotate(tilt);
  ctx!.scale(scale, scale);

  // ground shadow: small and non-dominant, just anchors the digit to the road
  ctx!.save();
  ctx!.globalAlpha = 0.22;
  ctx!.fillStyle = "#123";
  ctx!.beginPath();
  ctx!.ellipse(0, fontSize * 0.56, fontSize * 0.3, fontSize * 0.09, 0, 0, Math.PI * 2);
  ctx!.fill();
  ctx!.restore();

  ctx!.font = `800 ${Math.max(20, fontSize)}px system-ui, sans-serif`;
  ctx!.textAlign = "center";
  ctx!.textBaseline = "middle";

  if (afterimage) {
    ctx!.save();
    ctx!.globalAlpha = 0.3;
    ctx!.fillStyle = "#b98bff";
    ctx!.fillText(label, -9, -9);
    ctx!.restore();
  }

  // extruded thickness: several stacked, progressively darker copies offset
  // down-right, so the digit reads as a thick 3D block instead of flat text.
  const EXTRUDE_STEPS = 7;
  for (let i = EXTRUDE_STEPS; i >= 1; i--) {
    ctx!.fillStyle = dark;
    ctx!.fillText(label, i * 0.85, i * 0.85);
  }

  // top face: bright color, white outline, soft glow
  ctx!.shadowColor = glow;
  ctx!.shadowBlur = 26;
  ctx!.lineWidth = Math.max(2, fontSize * 0.045);
  ctx!.strokeStyle = "rgba(255,255,255,0.95)";
  ctx!.strokeText(label, 0, 0);
  ctx!.fillStyle = face;
  ctx!.fillText(label, 0, 0);
  ctx!.shadowBlur = 0;

  // Muzzle glow at the digit's base: sells "the number is shooting." Used to
  // sit at one constant brightness forever, with nothing distinguishing the
  // instant a shot actually left from any other frame — a playtest read that
  // as "bullets don't fire" even though they were spawning on schedule the
  // whole time. Now it flares bright white and swells for a beat right when
  // muzzleFlash is (re)armed in frame() (a new bullet id was just seen),
  // decaying back to the steady cyan glow over ~180ms.
  const flareT = muzzleFlash !== null ? clamp(1 - muzzleFlash / 0.18, 0, 1) : 0;
  ctx!.fillStyle = flareT > 0.02 ? mixHex("#b4f0ff", "#ffffff", flareT) : "rgba(180,240,255,0.9)";
  ctx!.shadowColor = "rgba(200,245,255,0.95)";
  ctx!.shadowBlur = 10 + 26 * flareT;
  ctx!.beginPath();
  ctx!.ellipse(
    0,
    fontSize * 0.4,
    fontSize * (0.08 + 0.14 * flareT),
    fontSize * (0.04 + 0.07 * flareT),
    0,
    0,
    Math.PI * 2,
  );
  ctx!.fill();

  // RATE+ pickup: a couple of jagged electric bolts flashed around the digit,
  // instead of the smooth glow every other pickup gets — reads as "speed",
  // not "value".
  if (electric) {
    ctx!.strokeStyle = "rgba(255,224,102,0.95)";
    ctx!.lineWidth = Math.max(1.5, fontSize * 0.03);
    ctx!.shadowColor = "rgba(255,224,102,0.9)";
    ctx!.shadowBlur = 12;
    for (const side of [-1, 1]) {
      const bx = side * fontSize * 0.55;
      ctx!.beginPath();
      ctx!.moveTo(bx, -fontSize * 0.4);
      ctx!.lineTo(bx + side * fontSize * 0.12, -fontSize * 0.1);
      ctx!.lineTo(bx - side * fontSize * 0.08, fontSize * 0.1);
      ctx!.lineTo(bx + side * fontSize * 0.14, fontSize * 0.4);
      ctx!.stroke();
    }
    ctx!.shadowBlur = 0;
  }

  ctx!.restore();
}

// The player's number is the core readout the whole game rests on, so it gets
// a fixed HUD position (top-center, under the progress bar) rather than
// floating above the cannon in world-space: an approaching item's badge
// converges toward that same on-road spot right as it's collected, and a
// world-space number there would fight it for legibility at exactly the
// moment both need to be read.
function drawPlayerHud(W: number): void {
  if (state.status === "won" || state.status === "lost") return;
  ctx!.save();
  ctx!.fillStyle = "#123";
  ctx!.shadowColor = "rgba(120,190,255,0.85)";
  ctx!.shadowBlur = 20;
  ctx!.font = `800 ${Math.max(28, W * 0.032)}px system-ui, sans-serif`;
  ctx!.textAlign = "center";
  ctx!.textBaseline = "middle";
  ctx!.fillText(String(state.playerValue), W / 2, 58);
  ctx!.restore();
}

// Minimal fire-rate indicator: a row of pips filling in as RATE+ gates are
// collected, no label or text — the brief is explicit that this stays
// unexplained, taught only by bullets visibly firing faster.
const FIRE_RATE_PIPS = 5;
function drawFireRateHud(W: number): void {
  if (state.status === "won" || state.status === "lost") return;
  const frac = clamp((BULLET_FIRE_INTERVAL - state.fireRate) / (BULLET_FIRE_INTERVAL - MIN_FIRE_INTERVAL), 0, 1);
  const filled = Math.round(frac * FIRE_RATE_PIPS);
  if (filled <= 0) return;
  const pipR = 3.5;
  const gap = 10;
  const totalW = (FIRE_RATE_PIPS - 1) * gap;
  const cx = W / 2;
  const y = 34;
  ctx!.save();
  for (let i = 0; i < FIRE_RATE_PIPS; i++) {
    const px = cx - totalW / 2 + i * gap;
    const lit = i < filled;
    ctx!.fillStyle = lit ? "#ffe066" : "rgba(20,40,70,0.18)";
    if (lit) {
      ctx!.shadowColor = "rgba(255,224,102,0.9)";
      ctx!.shadowBlur = 8;
    } else {
      ctx!.shadowBlur = 0;
    }
    ctx!.beginPath();
    ctx!.arc(px, y, pipR, 0, Math.PI * 2);
    ctx!.fill();
  }
  ctx!.restore();
}

// Digit bullets are real state (state.bullets, owned by game.ts's step()) —
// this just projects them, as a white paper-plane/arrow with a trail plus a
// blue digit badge riding just behind it. A bullet's *own* fired-at value
// (spawnValue) is the baseline for "boosted vs weakened," not a global
// constant — two bullets fired seconds apart at different player values both
// read as "unchanged" until a zone actually touches them since then. The
// badge is persistently tinted by the last operator that touched it
// (bulletLastKind, set the instant its resolvedUpTo crosses a zone) so a
// grown/multiplied/shrunk/halved bullet stays visibly distinct in flight,
// not just for the one-shot flash.
function bulletBadgeStyle(b: Bullet): { badge: string; glow: string; scale: number } {
  const grow = b.value > b.spawnValue ? 1.3 : b.value < b.spawnValue ? 0.82 : 1;
  const kind = bulletLastKind.get(b.id);
  if (kind === "mul") return { badge: "#b98bff", glow: "rgba(185,139,255,0.95)", scale: Math.max(grow, 1.3) };
  if (kind === "div") return { badge: "#ff9d42", glow: "rgba(255,157,66,0.9)", scale: Math.min(grow, 0.82) };
  if (kind === "sub") return { badge: "#ff6b7a", glow: "rgba(255,107,122,0.9)", scale: Math.min(grow, 0.82) };
  if (kind === "add") return { badge: "#57e0a0", glow: "rgba(87,224,160,0.9)", scale: Math.max(grow, 1.05) };
  return { badge: "#3b82f6", glow: "rgba(120,190,255,0.85)", scale: 1 };
}

function drawArrow(x: number, y: number, r: number, alpha: number): void {
  ctx!.save();
  ctx!.globalAlpha = alpha;
  ctx!.fillStyle = "#ffffff";
  ctx!.strokeStyle = "rgba(90,140,200,0.9)";
  ctx!.lineWidth = Math.max(0.75, r * 0.08);
  ctx!.beginPath();
  ctx!.moveTo(x, y - r * 1.35);
  ctx!.lineTo(x - r * 0.62, y + r * 0.5);
  ctx!.lineTo(x, y + r * 0.12);
  ctx!.lineTo(x + r * 0.62, y + r * 0.5);
  ctx!.closePath();
  ctx!.fill();
  ctx!.stroke();
  ctx!.restore();
}

function drawBullets(W: number, H: number): void {
  for (const b of state.bullets) {
    const style = bulletBadgeStyle(b);

    // fading trail stamps (the plane's own past positions)
    for (const trailBack of [0.16, 0.09]) {
      const distanceAhead = b.atUnits - trailBack - state.worldX;
      if (!visibleAt(distanceAhead)) continue;
      const d = depthOf(distanceAhead);
      const alpha = fadeAlpha(distanceAhead) * 0.28;
      const x = laneCenterX(b.lane, d, W);
      const y = yAt(d, H);
      const scale = 0.16 + 0.84 * d;
      drawArrow(x, y, Math.max(6, 12 * scale), alpha);
    }

    const distanceAhead = b.atUnits - state.worldX;
    if (!visibleAt(distanceAhead)) continue;
    const d = depthOf(distanceAhead);
    const alpha = fadeAlpha(distanceAhead);
    const x = laneCenterX(b.lane, d, W);
    const y = yAt(d, H);
    const scale = 0.16 + 0.84 * d;
    const r = Math.max(9, 16 * scale);

    ctx!.save();
    ctx!.globalAlpha = alpha;
    ctx!.shadowColor = "rgba(255,255,255,0.6)";
    ctx!.shadowBlur = 6 * scale;
    drawArrow(x, y, r, 1);
    ctx!.restore();

    // the carried digit: a small blue badge beside/behind the arrowhead
    const badgeR = Math.max(7, 11 * scale) * style.scale;
    const bx = x;
    const by = y + r * 0.95;
    ctx!.save();
    ctx!.globalAlpha = alpha;
    ctx!.fillStyle = style.badge;
    ctx!.shadowColor = style.glow;
    ctx!.shadowBlur = 12 * scale * style.scale;
    ctx!.beginPath();
    ctx!.ellipse(bx, by, badgeR, badgeR * 0.86, 0, 0, Math.PI * 2);
    ctx!.fill();
    ctx!.shadowBlur = 0;
    ctx!.strokeStyle = "rgba(255,255,255,0.9)";
    ctx!.lineWidth = Math.max(1, scale);
    ctx!.stroke();
    ctx!.fillStyle = "#fff";
    ctx!.font = `800 ${Math.max(9, 13 * scale * style.scale)}px system-ui, sans-serif`;
    ctx!.textAlign = "center";
    ctx!.textBaseline = "middle";
    ctx!.fillText(String(b.value), bx, by);
    ctx!.restore();

    // one-shot flash ring the moment a zone just changed this specific
    // bullet's value — green (add), purple (multiply), red (subtract),
    // orange (divide) — keyed by Bullet.id so it tracks this bullet across
    // frames, not a badge index.
    const fx = bulletFx.get(b.id);
    if (fx) {
      const decay = clamp(1 - fx.t / 0.35, 0, 1);
      const ringColor =
        fx.kind === "mul"
          ? "rgba(185,139,255,0.95)"
          : fx.kind === "div"
            ? "rgba(255,157,66,0.95)"
            : fx.kind === "sub"
              ? "rgba(255,107,122,0.95)"
              : "rgba(87,224,160,0.95)";
      ctx!.save();
      ctx!.globalAlpha = alpha * decay;
      ctx!.strokeStyle = ringColor;
      ctx!.lineWidth = Math.max(1.5, 2.2 * scale);
      ctx!.beginPath();
      ctx!.ellipse(bx, by, badgeR * (1 + 0.9 * (1 - decay)), badgeR * 0.86 * (1 + 0.9 * (1 - decay)), 0, 0, Math.PI * 2);
      ctx!.stroke();
      ctx!.restore();
    }
  }
}

// A backdrop cluster of large pale 3D digits near the horizon, behind the
// finish gauntlet — echoes the stacked digit crowd at the end of the
// reference games instead of the gauntlet arriving as three bare walls.
const FINISH_UNITS = Math.max(...OBSTACLES.filter((o) => o.type === "wall" && o.isFinish === true).map((o) => o.atUnits));
// A back row of smaller/higher digits and a front row of larger/lower ones —
// a deliberate stacked-pyramid layout (not scattered) so none of the six
// glyphs overlap another at any canvas width.
const FINISH_CLUSTER = [
  { dx: -0.42, dy: -0.06, digit: "3", size: 0.75 },
  { dx: 0.0, dy: -0.09, digit: "6", size: 0.9 },
  { dx: 0.42, dy: -0.06, digit: "4", size: 0.75 },
  { dx: -0.26, dy: 0.05, digit: "1", size: 1.1 },
  { dx: 0.26, dy: 0.05, digit: "2", size: 1.1 },
  { dx: 0.0, dy: 0.12, digit: "6", size: 1.35 },
];

function drawFinishCluster(W: number, H: number): void {
  const distanceAhead = FINISH_UNITS - state.worldX;
  if (distanceAhead > VIEW_DISTANCE || distanceAhead < -0.4) return;
  // Same resultFade() as every other on-screen element during a win/loss
  // hold — this decorative digit-cloud has its own distanceAhead-only alpha
  // and, missing that multiplier, was the actual source of a playtest's
  // "stray numbers stuck in the sky over the CLEARED!/CRASHED banner"
  // report: distanceAhead sits near 0 right at the finish, so the cluster
  // stayed at ~full brightness for the whole result hold with nothing to
  // fade it out alongside the obstacles and particles.
  const alpha = clamp(1 - Math.max(distanceAhead, 0) / VIEW_DISTANCE, 0, 1) * 0.85 * resultFade();
  if (alpha <= 0.01) return;
  const y = yAt(0, H) - H * 0.015;
  const cx = W / 2;
  ctx!.save();
  ctx!.globalAlpha = alpha;
  ctx!.fillStyle = "rgba(255,255,255,0.9)";
  ctx!.strokeStyle = "rgba(120,190,255,0.5)";
  ctx!.textAlign = "center";
  ctx!.textBaseline = "middle";
  for (const f of FINISH_CLUSTER) {
    const fontSize = H * 0.05 * f.size;
    ctx!.font = `800 ${fontSize}px system-ui, sans-serif`;
    const bob = Math.sin(idleT * 2 + f.dx * 10) * 3;
    ctx!.lineWidth = Math.max(1, fontSize * 0.05);
    ctx!.strokeText(f.digit, cx + f.dx * W * 0.55, y + f.dy * H * 0.5 + bob);
    ctx!.fillText(f.digit, cx + f.dx * W * 0.55, y + f.dy * H * 0.5 + bob);
  }
  ctx!.restore();
}

// The finish gauntlet (see game.ts: the one place all 3 lanes carry a
// simultaneous wall, by design) only became visible at the same VIEW_DISTANCE
// as any other single-lane wall — so a run that hadn't grown big enough yet
// had no more warning for "every lane is about to be blocked" than for a
// completely dodgeable single obstacle, which a playtest read as an unfair
// ambush rather than the intended finish line. This banner telegraphs it
// from much further out (FINISH_WARN_DISTANCE), pulsing more urgently as it
// closes, and steps aside once the gauntlet itself is close enough to read
// on its own.
// Only ~1.4 track units past the normal render horizon (VIEW_DISTANCE=3.6) —
// TRACK_LENGTH is 9.7 with forks spaced across nearly all of it, so any
// larger window would keep this banner up for most of the run instead of
// reading as "the finish specifically is coming up." Starts almost
// imperceptible (see the low base alpha below) and only becomes genuinely
// prominent in the last stretch, so it doesn't dominate the screen for the
// whole approach.
const FINISH_WARN_DISTANCE = 5.0;
const FINISH_WARN_NEAR_CUTOFF = 1.1;
function drawFinishWarning(W: number, H: number): void {
  if (state.status !== "playing") return;
  const distanceAhead = FINISH_UNITS - state.worldX;
  if (distanceAhead > FINISH_WARN_DISTANCE || distanceAhead < FINISH_WARN_NEAR_CUTOFF) return;
  const closeness = clamp(1 - (distanceAhead - FINISH_WARN_NEAR_CUTOFF) / (FINISH_WARN_DISTANCE - FINISH_WARN_NEAR_CUTOFF), 0, 1);
  const alpha = 0.15 + 0.55 * closeness;
  const pulse = 0.7 + 0.3 * Math.sin(idleT * (3 + closeness * 4));
  const y = H * 0.09;
  ctx!.save();
  ctx!.globalAlpha = alpha;
  ctx!.font = `800 ${Math.max(13, H * (0.024 + 0.012 * closeness))}px system-ui, sans-serif`;
  ctx!.textAlign = "center";
  ctx!.textBaseline = "middle";
  ctx!.lineWidth = Math.max(2, H * 0.005);
  ctx!.strokeStyle = "rgba(14,30,50,0.85)";
  ctx!.shadowColor = `rgba(255,196,90,${pulse})`;
  ctx!.shadowBlur = 14 * pulse;
  ctx!.strokeText("FINISH — ALL LANES BLOCKED", W / 2, y);
  ctx!.fillStyle = "#ffd76a";
  ctx!.fillText("FINISH — ALL LANES BLOCKED", W / 2, y);
  ctx!.restore();
}

function drawProgress(W: number): void {
  const barH = 4;
  const margin = 18;
  const trackW = W - margin * 2;
  const frac = Math.min(1, state.worldX / TRACK_LENGTH);
  ctx!.fillStyle = "rgba(20, 40, 70, 0.15)";
  ctx!.fillRect(margin, 10, trackW, barH);
  ctx!.fillStyle = "rgba(87, 224, 160, 0.9)";
  ctx!.fillRect(margin, 10, trackW * frac, barH);
  if (best > 0.001) {
    ctx!.fillStyle = "rgba(255, 176, 60, 0.9)";
    ctx!.fillRect(margin + trackW * best - 1, 6, 2, barH + 8);
  }
}

function drawResultFlash(W: number, H: number): void {
  if (state.status !== "won" && state.status !== "lost") return;
  if (resultAt === null) return;
  const t = Math.min(1, (now - resultAt) / RESULT_HOLD_MS);
  // A full-canvas flat tint (even at a reduced peak alpha) still washes the
  // pale road/sky toward pink or sepia across the whole frame, including
  // right behind the result banner and player digit where legibility matters
  // most. Switched to an edge-only vignette instead: fully clear through the
  // center third of the canvas, tinted only toward the rim — same "win/loss
  // mood" cue, without dulling the exact area the eye is looking at.
  const alpha = (1 - t) * 0.4;
  const color = state.status === "won" ? "255,182,72" : "255,80,100";
  const cx = W / 2;
  const cy = H * 0.55;
  const grad = ctx!.createRadialGradient(cx, cy, H * 0.22, cx, cy, H * 0.75);
  grad.addColorStop(0, `rgba(${color},0)`);
  grad.addColorStop(1, `rgba(${color},${alpha})`);
  ctx!.fillStyle = grad;
  ctx!.fillRect(0, 0, W, H);
}

// Explicit win/loss text — up to now the only "did I win or lose" signal was
// a color/particle shift, which a first-time player has no reason to already
// know how to read. Reveals just after the impact punch (not on top of it),
// stays fully legible through most of RESULT_HOLD_MS, and fades out just
// before the auto-restart — independent of resultFade()/RESULT_FADE_MS,
// which only governs how fast the *scene clutter* (player digit, obstacles)
// gets out of the banner's way.
const RESULT_BANNER_DELAY_MS = 150;
const RESULT_BANNER_FADE_MS = 220;
function drawResultBanner(W: number, H: number): void {
  if (state.status !== "won" && state.status !== "lost") return;
  if (resultAt === null) return;
  const elapsed = now - resultAt;
  // No easeOut anymore: the banner used to fade just before the auto-restart
  // deadline, but the run now holds here until the player acts, so it just
  // eases in once and stays fully legible indefinitely.
  const easeIn = clamp((elapsed - RESULT_BANNER_DELAY_MS) / RESULT_BANNER_FADE_MS, 0, 1);
  const alpha = easeIn;
  if (alpha <= 0.01) return;
  const label = state.status === "won" ? "CLEARED!" : "CRASHED";
  const face = state.status === "won" ? "#ffd76a" : "#ff5064";
  const punch = 1 + 0.3 * (1 - easeIn);

  ctx!.save();
  ctx!.globalAlpha = alpha;
  ctx!.translate(W / 2, H * 0.32);
  ctx!.scale(punch, punch);
  ctx!.font = `800 ${Math.max(26, W * 0.1)}px system-ui, sans-serif`;
  ctx!.textAlign = "center";
  ctx!.textBaseline = "middle";
  ctx!.lineWidth = Math.max(3, W * 0.012);
  ctx!.strokeStyle = "rgba(14,30,50,0.85)";
  ctx!.shadowColor = face;
  ctx!.shadowBlur = 24;
  ctx!.strokeText(label, 0, 0);
  ctx!.fillStyle = face;
  ctx!.fillText(label, 0, 0);
  ctx!.restore();
}

// Shown once the win/loss punch has had a moment to read, per the brief's
// "concise end state and a restart button" — this is now the ONLY way back
// into a fresh run, for both outcomes, since the result screen no longer
// auto-advances on its own.
const RESTART_SHOW_DELAY_MS = 300;
function restartReady(): boolean {
  return (
    (state.status === "lost" || state.status === "won") &&
    resultAt !== null &&
    now - resultAt >= RESTART_SHOW_DELAY_MS
  );
}
function drawRestartAffordance(W: number, H: number): void {
  if (!restartReady()) return;
  const y = H * 0.62;
  ctx!.save();
  ctx!.globalAlpha = clamp((now - (resultAt ?? 0) - RESTART_SHOW_DELAY_MS) / 250, 0, 1);
  ctx!.fillStyle = "rgba(20,30,50,0.55)";
  const w = Math.min(200, W * 0.5);
  const h = 46;
  roundRect(W / 2 - w / 2, y - h / 2, w, h, 12);
  ctx!.fill();
  ctx!.strokeStyle = "rgba(255,255,255,0.8)";
  ctx!.lineWidth = 2;
  roundRect(W / 2 - w / 2, y - h / 2, w, h, 12);
  ctx!.stroke();
  ctx!.fillStyle = "#fff";
  ctx!.font = `800 ${Math.max(16, W * 0.045)}px system-ui, sans-serif`;
  ctx!.textAlign = "center";
  ctx!.textBaseline = "middle";
  ctx!.fillText("RESTART", W / 2, y + 1);
  ctx!.restore();
}

function draw(): void {
  const { width: W, height: H } = size;
  if (W === 0 || H === 0) return;
  ctx!.clearRect(0, 0, W, H);

  ctx!.save();
  if (shake > 0.001) {
    const mag = 9 * shake;
    ctx!.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
  }

  drawSky(W, H);
  drawRoad(W, H);
  drawSpeedLines(W, H);
  drawFinishCluster(W, H);
  drawFinishWarning(W, H);
  for (let i = 0; i < OBSTACLES.length; i++) drawObstacle(OBSTACLES[i], i, W, H);
  drawBullets(W, H);
  drawPlayerDigit(W, H);
  drawProgress(W);
  drawPlayerHud(W);
  drawFireRateHud(W);

  // Same resultFade() used to declutter obstacles/player digit during a
  // win/loss hold applies here too — a playtest caught a wall-hit's digit
  // fragments (spawned right as the player crashed into it) still fading out
  // on their own natural ~0.5-0.85s lifetime well into the CRASHED/CLEARED
  // banner, floating in the sky and competing with it for attention.
  const particleFade = resultFade();
  for (const p of particles) {
    ctx!.save();
    ctx!.globalAlpha = Math.max(0, p.life / p.maxLife) * particleFade;
    if (p.shape === "glyph") {
      ctx!.translate(p.x, p.y);
      ctx!.rotate(p.rot ?? 0);
      ctx!.fillStyle = p.color;
      ctx!.font = `800 ${p.r * 1.8}px system-ui, sans-serif`;
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      ctx!.fillText(p.glyph ?? "", 0, 0);
    } else if (p.shape === "rect") {
      ctx!.translate(p.x, p.y);
      ctx!.rotate(p.rot ?? 0);
      ctx!.fillStyle = p.color;
      ctx!.fillRect(-p.r, -p.r * 0.5, p.r * 2, p.r);
    } else {
      ctx!.fillStyle = p.color;
      ctx!.beginPath();
      ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx!.fill();
    }
    ctx!.restore();
  }
  ctx!.globalAlpha = 1;

  drawResultFlash(W, H);
  drawResultBanner(W, H);
  drawRestartAffordance(W, H);
  ctx!.restore();
}

function restartNow(): void {
  best = Math.max(best, state.worldX / TRACK_LENGTH);
  state = createInitialState();
  desiredLane = state.lane;
  resultAt = null;
  idleT = 0;
  prevBulletResolvedUpTo = new Map();
  bulletFx = new Map();
  bulletLastKind = new Map();
  wallRecoil = new Map();
  gatePulse = new Map();
  wallShatter = new Map();
  muzzleFlash = null;
  lastFiredBulletId = -1;
}

canvas.addEventListener("pointerdown", () => {
  if (restartReady()) restartNow();
});

let last = performance.now();

function frame(t: number): void {
  now = t;
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  idleT += dt;

  if (state.status === "won" || state.status === "lost") {
    if (resultAt === null) resultAt = t;
  } else {
    const prevResolvedUpTo = state.resolvedUpTo;
    const prevStatus = state.status;
    const prevWallHp = state.wallHp;
    state = step(state, dt, desiredLane);

    const { x: fx, y: fy } = cannonPos(size.width, size.height);

    if (state.bullets.length > 0) {
      const maxId = state.bullets.reduce((m, b) => Math.max(m, b.id), -1);
      if (maxId > lastFiredBulletId) {
        lastFiredBulletId = maxId;
        muzzleFlash = 0;
        spawnBurst(fx, fy, "rgba(255,255,255,0.95)", 5);
      }
    }

    for (let i = prevResolvedUpTo; i < state.resolvedUpTo; i++) {
      const ob = OBSTACLES[i];
      const isLastResolved = i === state.resolvedUpTo - 1;
      const touchedPlayer = ob.lane === state.lane;
      if ((ob.type === "zone" || ob.type === "item") && touchedPlayer) {
        const colors = modifierColor(ob.kind, ob.value);
        spawnBurst(fx, fy, colors.fill, 14);
        playerFx = {
          kind: ob.kind === "rate" ? "rate" : ob.kind === "mul" ? "mult" : ob.value >= 0 ? "gain" : "loss",
          t: 0,
        };
        if (ob.type === "zone") gatePulse.set(i, 0);
      } else if (isLastResolved && state.status === "lost") {
        spawnBurst(fx, fy, "#ff5064", 24);
        spawnLossShards(fx, fy, 20);
        playerFx = { kind: "loss", t: 0 };
        triggerShake(0.5);
      } else if (isLastResolved && state.status === "won") {
        spawnConfetti(fx, fy, 50);
        if (ob.type === "wall") spawnDigitFragments(fx, fy, ob.value, "#ffd76a");
        triggerShake(0.35);
      } else if (ob.type === "wall" && touchedPlayer) {
        spawnBurst(fx, fy, "#ffffff", 10);
        spawnDigitFragments(fx, fy, ob.value, "#8fd0ff");
        triggerShake(0.3);
      }
    }
    if (state.status === "lost" && prevStatus === "playing" && state.resolvedUpTo === prevResolvedUpTo) {
      spawnBurst(fx, fy, "#ff5064", 24);
      spawnLossShards(fx, fy, 20);
      playerFx = { kind: "loss", t: 0 };
      triggerShake(0.5);
    }

    // Bullet-vs-wall feedback: a white flash burst + scattering digit
    // fragments the instant a wall's live hp drops, plus a slight screen
    // shake — even while the player themselves is still well short of it.
    // A hit that crosses hp from >0 to <=0 is the killing blow: a distinctly
    // bigger, wider burst plus a stronger shake, not the same small chip fx.
    for (let i = 0; i < OBSTACLES.length; i++) {
      const ob = OBSTACLES[i];
      if (ob.type !== "wall") continue;
      const prevHp = prevWallHp[i] ?? ob.value;
      if (state.wallHp[i] < prevHp) {
        wallRecoil.set(i, 0);
        const distanceAhead = ob.atUnits - state.worldX;
        if (visibleAt(distanceAhead)) {
          const d = depthOf(distanceAhead);
          const wx = laneCenterX(ob.lane, d, size.width);
          const wy = yAt(d, size.height);
          const destroyed = prevHp > 0 && isWallDestroyed(state.wallHp[i]);
          if (destroyed) {
            spawnBurst(wx, wy, "#ffffff", 30);
            spawnGlassShards(wx, wy, 14);
            spawnDigitFragments(wx, wy, `-${prevHp - state.wallHp[i]}`, "#8fd0ff");
            triggerShake(0.4);
            wallShatter.set(i, 0);
          } else {
            spawnBurst(wx, wy, "#ffffff", 8);
            spawnDigitFragments(wx, wy, `-${prevHp - state.wallHp[i]}`, "#8fd0ff");
            triggerShake(0.12);
          }
        }
      }
    }
  }

  for (const [i, t] of wallRecoil) {
    const next = t + dt;
    if (next > 0.12) wallRecoil.delete(i);
    else wallRecoil.set(i, next);
  }

  for (const [i, t] of gatePulse) {
    const next = t + dt;
    if (next > 0.45) gatePulse.delete(i);
    else gatePulse.set(i, next);
  }

  for (const [i, t] of wallShatter) {
    const next = t + dt;
    if (next > WALL_SHATTER_DURATION) wallShatter.delete(i);
    else wallShatter.set(i, next);
  }

  if (muzzleFlash !== null) {
    const next = muzzleFlash + dt;
    muzzleFlash = next > 0.18 ? null : next;
  }

  for (const [id, fx] of bulletFx) {
    const next = { ...fx, t: fx.t + dt };
    if (next.t > 0.35) bulletFx.delete(id);
    else bulletFx.set(id, next);
  }

  {
    // Mirrors the player's own prevResolvedUpTo diff above, but per bullet:
    // whenever a bullet's resolvedUpTo advances past a zone in its own lane,
    // that zone's kind is exactly what just modified it — lets the flash and
    // the persistent badge tint distinguish all four operators, not just a
    // binary bigger/smaller.
    const seen = new Set<number>();
    for (const b of state.bullets) {
      seen.add(b.id);
      const prevRUT = prevBulletResolvedUpTo.get(b.id) ?? b.resolvedUpTo;
      for (let i = prevRUT; i < b.resolvedUpTo; i++) {
        const ob = OBSTACLES[i];
        if (ob.type !== "zone" || ob.lane !== b.lane || ob.kind === "rate") continue;
        const kind: BulletModKind = ob.kind === "mul" ? "mul" : ob.kind === "div" ? "div" : ob.value >= 0 ? "add" : "sub";
        bulletFx.set(b.id, { kind, t: 0 });
        bulletLastKind.set(b.id, kind);
        gatePulse.set(i, 0);
        // Playtest report: the ring flash alone read as too subtle to tell
        // "did that gate just do something to my bullet?" at a glance — the
        // same floating digit-fragment callout the wall hits already use
        // (labelFor/modifierColor: "+30" green, "×2" purple, "÷2" orange,
        // "-15" red) now fires at the bullet's own position too, not just the
        // player's.
        const distanceAhead = ob.atUnits - state.worldX;
        if (visibleAt(distanceAhead)) {
          const d = depthOf(distanceAhead);
          const bx = laneCenterX(b.lane, d, size.width);
          const by = yAt(d, size.height);
          spawnDigitFragments(bx, by, labelFor(ob), modifierColor(ob.kind, ob.value).fill);
        }
      }
      prevBulletResolvedUpTo.set(b.id, b.resolvedUpTo);
    }
    for (const id of prevBulletResolvedUpTo.keys()) {
      if (!seen.has(id)) {
        prevBulletResolvedUpTo.delete(id);
        bulletLastKind.delete(id);
      }
    }
  }

  if (playerFx) {
    playerFx = { ...playerFx, t: playerFx.t + dt };
    if (playerFx.t > 0.6) playerFx = null;
  }

  shake = Math.max(0, shake - dt * 3.2);

  particles = particles
    .map((p) => ({
      ...p,
      x: p.x + p.vx * dt,
      y: p.y + p.vy * dt,
      vy: p.vy + 260 * dt,
      life: p.life - dt,
      rot: p.rot !== undefined ? p.rot + (p.vrot ?? 0) * dt : p.rot,
    }))
    .filter((p) => p.life > 0);

  draw();
  (window as unknown as { __state?: GameState }).__state = state;
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
