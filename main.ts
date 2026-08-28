// Rendering + input for DIGIT CANNON RUN. All game rules live in game.ts
// (pure, tested); this file only projects a pseudo-3D lane-runner from that
// state and turns keyboard/pointer input into the single "which lane do I
// want to be in" intent the rules understand.
import {
  BULLET_BASE_VALUE,
  LANES,
  OBSTACLES,
  TRACK_LENGTH,
  createInitialState,
  step,
  type CanvasSize,
  type GameState,
  type Lane,
  type Obstacle,
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
  kind: "gain" | "mult" | "loss";
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

const RESULT_HOLD_MS = 1300;

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
function spawnDigitFragments(x: number, y: number, value: number, color: string): void {
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
// green/blue = add-positive, purple = multiply, red = add-negative.
function modifierColor(kind: "add" | "mul", value: number): { fill: string; glow: string } {
  if (kind === "mul") return { fill: "#b98bff", glow: "rgba(185,139,255,0.9)" };
  return value >= 0 ? { fill: "#57e0a0", glow: "rgba(87,224,160,0.9)" } : { fill: "#ff6b7a", glow: "rgba(255,107,122,0.9)" };
}

function labelFor(ob: Obstacle): string {
  if (ob.type === "wall") return String(ob.value);
  if (ob.kind === "mul") return `×${ob.value}`;
  return ob.value >= 0 ? `+${ob.value}` : String(ob.value);
}

function drawObstacle(ob: Obstacle, index: number, W: number, H: number): void {
  const distanceAhead = ob.atUnits - state.worldX;
  if (!visibleAt(distanceAhead)) return;
  const d = depthOf(distanceAhead);
  const alpha = fadeAlpha(distanceAhead);
  const x = laneCenterX(ob.lane, d, W);
  const y = yAt(d, H);
  const roadWidth = roadHalfWidthAt(d, W) * 2;
  const laneWidth = roadWidth / LANES;
  const scale = 0.16 + 0.84 * d;

  ctx!.save();
  ctx!.globalAlpha = alpha;

  if (ob.type === "wall") {
    // Walls render their *live* hp (state.wallHp), not the authored value —
    // digit bullets may have already chipped it down before the player gets
    // here, and that has to be visible on the wall itself. Rendered as a
    // cyan glass / white-edged block rather than a solid slab, so several
    // stacked ahead read as "gates in a tunnel," not opaque obstacles.
    const hp = state.wallHp[index] ?? ob.value;
    const isFinish = ob.isFinish === true;
    const cracked = hp < ob.value && hp > 0;
    const shattered = hp <= 0;
    const w = laneWidth * 0.82;
    const h = Math.max(12, 52 * scale);
    const pulse = isFinish ? 0.6 + 0.4 * Math.sin(idleT * 4) : 1;
    const glassFill = isFinish ? "rgba(255,196,90,0.35)" : "rgba(80,225,220,0.3)";
    const glassEdge = isFinish ? "rgba(255,196,90,0.95)" : "rgba(255,255,255,0.9)";
    const rx = x - w / 2;
    const ry = y - h;
    const r = Math.min(12, w * 0.14);

    ctx!.fillStyle = shattered ? "rgba(160,190,210,0.14)" : glassFill;
    ctx!.shadowColor = isFinish ? "rgba(255,196,90,0.85)" : "rgba(90,220,210,0.6)";
    ctx!.shadowBlur = 16 * pulse;
    roundRect(rx, ry, w, h, r);
    ctx!.fill();

    ctx!.shadowBlur = 0;
    ctx!.strokeStyle = shattered ? "rgba(255,255,255,0.35)" : glassEdge;
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

    ctx!.fillStyle = shattered ? "rgba(255,255,255,0.5)" : "#0e2a3a";
    ctx!.strokeStyle = "rgba(255,255,255,0.9)";
    ctx!.lineWidth = Math.max(1, 3 * scale);
    ctx!.font = `800 ${Math.max(11, 23 * scale)}px system-ui, sans-serif`;
    ctx!.textAlign = "center";
    ctx!.textBaseline = "middle";
    ctx!.strokeText(String(hp), x, y - h / 2);
    ctx!.fillText(String(hp), x, y - h / 2);
  } else if (ob.type === "zone") {
    // A translucent cyan "glass" gate panel spanning most of the lane —
    // reads as a distinct operator gate, not a pickup or a wall.
    const tint = modifierColor(ob.kind, ob.value);
    const gateW = laneWidth * 0.74;
    const gateH = Math.max(24, 82 * scale);
    const cy = y - gateH * 0.52;
    const pulse = 0.7 + 0.3 * Math.sin(idleT * 3 + ob.atUnits * 5);
    const rx = x - gateW / 2;
    const ry = cy - gateH / 2;
    const r = Math.min(14, gateW * 0.18);

    ctx!.fillStyle = "rgba(110,230,225,0.28)";
    ctx!.shadowColor = "rgba(110,230,225,0.7)";
    ctx!.shadowBlur = 18 * scale * pulse;
    roundRect(rx, ry, gateW, gateH, r);
    ctx!.fill();

    ctx!.shadowBlur = 0;
    ctx!.strokeStyle = tint.fill;
    ctx!.lineWidth = Math.max(2, 3 * scale);
    roundRect(rx, ry, gateW, gateH, r);
    ctx!.stroke();
    ctx!.strokeStyle = "rgba(255,255,255,0.85)";
    ctx!.lineWidth = Math.max(1, 1.5 * scale);
    roundRect(rx + 2, ry + 2, gateW - 4, gateH - 4, Math.max(1, r - 2));
    ctx!.stroke();

    ctx!.fillStyle = "#0e2a3a";
    ctx!.strokeStyle = "rgba(255,255,255,0.95)";
    ctx!.lineWidth = Math.max(1.5, 3.4 * scale);
    ctx!.font = `800 ${Math.max(13, 24 * scale)}px system-ui, sans-serif`;
    ctx!.textAlign = "center";
    ctx!.textBaseline = "middle";
    ctx!.strokeText(labelFor(ob), x, cy);
    ctx!.fillText(labelFor(ob), x, cy);
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
    ctx!.fillStyle = "#0c1420";
    ctx!.font = `700 ${Math.max(10, 18 * scale)}px system-ui, sans-serif`;
    ctx!.textAlign = "center";
    ctx!.textBaseline = "middle";
    ctx!.fillText(labelFor(ob), x, y - size2 / 2 - 10 * scale + bob);
  }

  ctx!.restore();
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
  let resultFade = 1;
  if (inResult) {
    if (resultAt === null) return;
    resultFade = clamp(1 - (now - resultAt) / 500, 0, 1);
    if (resultFade <= 0) return;
  }
  const { x, y } = cannonPos(W, H);
  const bob = inResult ? 0 : Math.sin(idleT * 2.6) * 3;
  const laneWidth = (roadHalfWidthAt(1, W) * 2) / LANES;
  const fontSize = laneWidth * 0.66;

  let face = PLAYER_BLUE;
  let glow = "rgba(120,190,255,0.85)";
  let scale = 1;
  let tilt = inResult ? 0 : Math.sin(idleT * 1.7) * 0.05;
  let afterimage = false;

  if (inResult) {
    const punch = 1 - resultFade;
    if (state.status === "won") {
      face = "#ffd76a";
      glow = `rgba(255,182,72,${0.5 + 0.5 * resultFade})`;
      scale = 1 + 0.4 * punch;
    } else {
      face = "#ff5064";
      glow = `rgba(255,80,100,${0.5 + 0.5 * resultFade})`;
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
    }
  }

  const label = String(state.playerValue);
  const dark = shade(face, -0.55);

  ctx!.save();
  ctx!.globalAlpha = resultFade;
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

  // small muzzle glow at the digit's base: sells "the number is shooting"
  ctx!.fillStyle = "rgba(180,240,255,0.9)";
  ctx!.shadowColor = "rgba(180,240,255,0.9)";
  ctx!.shadowBlur = 10;
  ctx!.beginPath();
  ctx!.ellipse(0, fontSize * 0.4, fontSize * 0.08, fontSize * 0.04, 0, 0, Math.PI * 2);
  ctx!.fill();

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

// Digit bullets are real state (state.bullets, owned by game.ts's step()) —
// this just projects them, as a white paper-plane/arrow with a trail plus a
// blue digit badge riding just behind it. Boosted bullets (grown through a
// +N/x2 gate) grow and brighten; reduced ones shrink and dim.
function bulletBadgeStyle(value: number): { badge: string; glow: string; scale: number } {
  if (value > BULLET_BASE_VALUE) return { badge: "#3b82f6", glow: "rgba(255,214,106,0.95)", scale: 1.3 };
  if (value < BULLET_BASE_VALUE) return { badge: "#5f7a99", glow: "rgba(120,140,170,0.6)", scale: 0.82 };
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
    const style = bulletBadgeStyle(b.value);

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
  const alpha = clamp(1 - Math.max(distanceAhead, 0) / VIEW_DISTANCE, 0, 1) * 0.85;
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
  // Kept light (peak 0.16, was 0.32): a full-canvas tint strong enough to
  // read as "win/loss mood" but not so strong it drowns the road, walls, and
  // finish cluster in sepia/mauve — the payoff moment is exactly when the
  // scene most needs to stay legible.
  const alpha = (1 - t) * 0.16;
  ctx!.fillStyle = state.status === "won" ? `rgba(255,182,72,${alpha})` : `rgba(255,80,100,${alpha})`;
  ctx!.fillRect(0, 0, W, H);
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
  for (let i = 0; i < OBSTACLES.length; i++) drawObstacle(OBSTACLES[i], i, W, H);
  drawBullets(W, H);
  drawPlayerDigit(W, H);
  drawProgress(W);
  drawPlayerHud(W);

  for (const p of particles) {
    ctx!.save();
    ctx!.globalAlpha = Math.max(0, p.life / p.maxLife);
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
  ctx!.restore();
}

let last = performance.now();

function frame(t: number): void {
  now = t;
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  idleT += dt;

  if (state.status === "won" || state.status === "lost") {
    if (resultAt === null) resultAt = t;
    if (t - resultAt > RESULT_HOLD_MS) {
      best = Math.max(best, state.worldX / TRACK_LENGTH);
      state = createInitialState();
      desiredLane = state.lane;
      resultAt = null;
      idleT = 0;
    }
  } else {
    const prevResolvedUpTo = state.resolvedUpTo;
    const prevStatus = state.status;
    const prevWallHp = state.wallHp;
    state = step(state, dt, desiredLane);

    const { x: fx, y: fy } = cannonPos(size.width, size.height);
    for (let i = prevResolvedUpTo; i < state.resolvedUpTo; i++) {
      const ob = OBSTACLES[i];
      const isLastResolved = i === state.resolvedUpTo - 1;
      const touchedPlayer = ob.lane === state.lane;
      if ((ob.type === "zone" || ob.type === "item") && touchedPlayer) {
        const colors = modifierColor(ob.kind, ob.value);
        spawnBurst(fx, fy, colors.fill, 14);
        playerFx = { kind: ob.kind === "mul" ? "mult" : ob.value >= 0 ? "gain" : "loss", t: 0 };
      } else if (isLastResolved && state.status === "lost") {
        spawnBurst(fx, fy, "#ff5064", 24);
        spawnDigitFragments(fx, fy, state.playerValue, "#ff5064");
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
      spawnDigitFragments(fx, fy, state.playerValue, "#ff5064");
      playerFx = { kind: "loss", t: 0 };
      triggerShake(0.5);
    }

    // Bullet-vs-wall feedback: a white flash burst + scattering digit
    // fragments the instant a wall's live hp drops, plus a slight screen
    // shake — even while the player themselves is still well short of it.
    for (let i = 0; i < OBSTACLES.length; i++) {
      const ob = OBSTACLES[i];
      if (ob.type !== "wall") continue;
      const prevHp = prevWallHp[i] ?? ob.value;
      if (state.wallHp[i] < prevHp) {
        const distanceAhead = ob.atUnits - state.worldX;
        if (visibleAt(distanceAhead)) {
          const d = depthOf(distanceAhead);
          const wx = laneCenterX(ob.lane, d, size.width);
          const wy = yAt(d, size.height);
          spawnBurst(wx, wy, "#ffffff", 8);
          spawnDigitFragments(wx, wy, prevHp - state.wallHp[i], "#8fd0ff");
          triggerShake(0.12);
        }
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
