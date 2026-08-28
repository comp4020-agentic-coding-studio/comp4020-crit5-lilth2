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
}

/** A transient color/scale reaction on the player's digit body, set whenever
 *  a zone or item changes playerValue, and decayed away in draw(). */
interface PlayerFx {
  kind: "gain" | "mult" | "loss";
  t: number;
}

// --- Perspective tunables, all fractions of canvas W/H so the road looks the
// same shape on a phone and a desktop. ---
const HORIZON_Y = 0.3;
const NEAR_Y = 0.9;
const HORIZON_HALF_ROAD = 0.045;
const NEAR_HALF_ROAD = 0.46;
const DEPTH_POW = 1.7;
const VIEW_DISTANCE = 3.0; // track units ahead that are visible at all
const FADE_TAIL = 0.25; // track units of fade-out after passing the player

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
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
  bg.addColorStop(0, "#bfe3ff");
  bg.addColorStop(0.55, "#eaf6ff");
  bg.addColorStop(1, "#f7fbff");
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

function drawRoad(W: number, H: number): void {
  const nearHalf = roadHalfWidthAt(1, W);
  const farHalf = roadHalfWidthAt(0, W);
  const nearY = yAt(1, H);
  const farY = yAt(0, H);
  const cx = W / 2;

  ctx!.fillStyle = "#eef2f8";
  ctx!.beginPath();
  ctx!.moveTo(cx - farHalf, farY);
  ctx!.lineTo(cx + farHalf, farY);
  ctx!.lineTo(cx + nearHalf, nearY);
  ctx!.lineTo(cx - nearHalf, nearY);
  ctx!.closePath();
  ctx!.fill();

  // lane dividers (2 interior lines for 3 lanes), scrolling for a sense of speed
  ctx!.strokeStyle = "rgba(120, 150, 200, 0.55)";
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

  // glowing outer edges
  ctx!.strokeStyle = "rgba(90, 170, 255, 0.65)";
  ctx!.shadowColor = "rgba(90, 170, 255, 0.7)";
  ctx!.shadowBlur = 10;
  ctx!.lineWidth = 3;
  ctx!.beginPath();
  ctx!.moveTo(cx - farHalf, farY);
  ctx!.lineTo(cx - nearHalf, nearY);
  ctx!.moveTo(cx + farHalf, farY);
  ctx!.lineTo(cx + nearHalf, nearY);
  ctx!.stroke();
  ctx!.shadowBlur = 0;
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
    // here, and that has to be visible on the wall itself.
    const hp = state.wallHp[index] ?? ob.value;
    const isFinish = ob.isFinish === true;
    const cracked = hp < ob.value && hp > 0;
    const shattered = hp <= 0;
    const w = laneWidth * 0.8;
    const h = Math.max(10, 46 * scale);
    const pulse = isFinish ? 0.6 + 0.4 * Math.sin(idleT * 4) : 1;
    ctx!.fillStyle = isFinish ? "#ffb648" : shattered ? "rgba(95,126,168,0.28)" : "#5f7ea8";
    ctx!.shadowColor = isFinish ? "rgba(255,182,72,0.9)" : "rgba(95,126,168,0.7)";
    ctx!.shadowBlur = 14 * pulse;
    const rx = x - w / 2;
    const ry = y - h;
    const r = Math.min(10, w * 0.12);
    roundRect(rx, ry, w, h, r);
    ctx!.fill();

    if (cracked) {
      ctx!.shadowBlur = 0;
      ctx!.strokeStyle = "rgba(255,255,255,0.9)";
      ctx!.lineWidth = Math.max(1, 2 * scale);
      ctx!.beginPath();
      ctx!.moveTo(x - w * 0.16, ry + h * 0.12);
      ctx!.lineTo(x + w * 0.06, ry + h * 0.48);
      ctx!.lineTo(x - w * 0.1, ry + h * 0.88);
      ctx!.stroke();
    }

    ctx!.shadowBlur = 0;
    ctx!.fillStyle = shattered ? "rgba(255,255,255,0.6)" : "#fff";
    ctx!.font = `700 ${Math.max(11, 22 * scale)}px system-ui, sans-serif`;
    ctx!.textAlign = "center";
    ctx!.textBaseline = "middle";
    ctx!.fillText(String(hp), x, y - h / 2);
  } else if (ob.type === "zone") {
    // A floating operator gate: a glowing ring, not a rounded rect — reads
    // distinctly from both walls and (legacy) item pickups.
    const colors = modifierColor(ob.kind, ob.value);
    const gateW = laneWidth * 0.6;
    const gateH = Math.max(20, 78 * scale);
    const cy = y - gateH * 0.5;
    const pulse = 0.7 + 0.3 * Math.sin(idleT * 3 + ob.atUnits * 5);
    ctx!.strokeStyle = colors.fill;
    ctx!.shadowColor = colors.glow;
    ctx!.shadowBlur = 18 * scale * pulse;
    ctx!.lineWidth = Math.max(2, 4 * scale);
    ctx!.beginPath();
    ctx!.ellipse(x, cy, gateW * 0.5, gateH * 0.5, 0, 0, Math.PI * 2);
    ctx!.stroke();

    ctx!.save();
    ctx!.globalAlpha *= 0.16;
    ctx!.fillStyle = colors.fill;
    ctx!.fill();
    ctx!.restore();

    ctx!.shadowBlur = 0;
    ctx!.fillStyle = colors.fill;
    ctx!.font = `800 ${Math.max(12, 21 * scale)}px system-ui, sans-serif`;
    ctx!.textAlign = "center";
    ctx!.textBaseline = "middle";
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

// The player's body IS their number: a large, glowing, slightly 3D digit —
// no separate cannon shape. It reacts to what just happened to playerValue
// (green pulse on a gain, purple flash + afterimage on a multiply, red
// shake on a loss) via the decaying `playerFx` set in frame().
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
  const fontSize = laneWidth * 0.6;

  let glow = "rgba(120,190,255,0.85)";
  let scale = 1;
  let tilt = inResult ? 0 : Math.sin(idleT * 1.7) * 0.05;
  let afterimage = false;

  if (inResult) {
    const punch = 1 - resultFade;
    if (state.status === "won") {
      glow = `rgba(255,182,72,${0.5 + 0.5 * resultFade})`;
      scale = 1 + 0.4 * punch;
    } else {
      glow = `rgba(255,80,100,${0.5 + 0.5 * resultFade})`;
      scale = 1 - 0.35 * punch;
      tilt = Math.sin(idleT * 50) * 0.09 * punch;
    }
  } else if (playerFx) {
    const decay = clamp(1 - playerFx.t / 0.5, 0, 1);
    if (playerFx.kind === "gain") {
      glow = `rgba(87,224,160,${0.55 + 0.45 * decay})`;
      scale = 1 + 0.16 * decay;
    } else if (playerFx.kind === "mult") {
      glow = `rgba(185,139,255,${0.55 + 0.45 * decay})`;
      scale = 1 + 0.3 * decay;
      afterimage = decay > 0.15;
    } else if (playerFx.kind === "loss") {
      glow = `rgba(255,107,122,${0.55 + 0.45 * decay})`;
      scale = 1 - 0.1 * decay;
      tilt += Math.sin(idleT * 40) * 0.05 * decay;
    }
  }

  const label = String(state.playerValue);

  ctx!.save();
  ctx!.globalAlpha = resultFade;
  ctx!.translate(x, y - fontSize * 0.42 + bob);
  ctx!.rotate(tilt);
  ctx!.scale(scale, scale);

  // ground shadow: anchors the digit to the road without becoming the focus
  ctx!.save();
  ctx!.globalAlpha = 0.22;
  ctx!.fillStyle = "#123";
  ctx!.beginPath();
  ctx!.ellipse(0, fontSize * 0.56, fontSize * 0.34, fontSize * 0.1, 0, 0, Math.PI * 2);
  ctx!.fill();
  ctx!.restore();

  ctx!.font = `800 ${Math.max(20, fontSize)}px system-ui, sans-serif`;
  ctx!.textAlign = "center";
  ctx!.textBaseline = "middle";

  if (afterimage) {
    ctx!.save();
    ctx!.globalAlpha = 0.32;
    ctx!.fillStyle = "#b98bff";
    ctx!.fillText(label, -7, -7);
    ctx!.restore();
  }

  // darker duplicate, offset for a pseudo-3D depth read
  ctx!.fillStyle = "rgba(15,30,55,0.4)";
  ctx!.fillText(label, 3, 4);

  ctx!.shadowColor = glow;
  ctx!.shadowBlur = 22;
  ctx!.fillStyle = "#0e1b30";
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
// this just projects them. Colored by whether they're currently boosted,
// multiplied, or reduced relative to their starting value, with a short
// fading trail (a couple of stamps behind the current position, no extra
// state needed) so they read as moving fast rather than teleporting.
function bulletColor(value: number): { fill: string; glow: string } {
  if (value > BULLET_BASE_VALUE) return { fill: "#57e0a0", glow: "rgba(87,224,160,0.9)" };
  if (value < BULLET_BASE_VALUE) return { fill: "#ff6b7a", glow: "rgba(255,107,122,0.9)" };
  return { fill: "#eaffff", glow: "rgba(180,240,255,0.9)" };
}

function drawBullets(W: number, H: number): void {
  for (const b of state.bullets) {
    const colors = bulletColor(b.value);
    for (const trailBack of [0.12, 0.06, 0]) {
      const distanceAhead = b.atUnits - trailBack - state.worldX;
      if (!visibleAt(distanceAhead)) continue;
      const d = depthOf(distanceAhead);
      const isHead = trailBack === 0;
      const alpha = fadeAlpha(distanceAhead) * (isHead ? 1 : 0.3);
      const x = laneCenterX(b.lane, d, W);
      const y = yAt(d, H);
      const scale = 0.16 + 0.84 * d;
      const r = Math.max(8, 15 * scale);

      ctx!.save();
      ctx!.globalAlpha = alpha;
      ctx!.fillStyle = colors.fill;
      ctx!.shadowColor = colors.glow;
      ctx!.shadowBlur = (isHead ? 10 : 4) * scale;
      ctx!.beginPath();
      ctx!.ellipse(x, y, r * 0.72, r * 0.5, 0, 0, Math.PI * 2);
      ctx!.fill();

      if (isHead) {
        ctx!.shadowBlur = 0;
        ctx!.fillStyle = "#0c1420";
        ctx!.font = `800 ${Math.max(9, 13 * scale)}px system-ui, sans-serif`;
        ctx!.textAlign = "center";
        ctx!.textBaseline = "middle";
        ctx!.fillText(String(b.value), x, y);
      }
      ctx!.restore();
    }
  }
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
  const alpha = (1 - t) * 0.32;
  ctx!.fillStyle = state.status === "won" ? `rgba(255,182,72,${alpha})` : `rgba(255,80,100,${alpha})`;
  ctx!.fillRect(0, 0, W, H);
}

function draw(): void {
  const { width: W, height: H } = size;
  if (W === 0 || H === 0) return;
  ctx!.clearRect(0, 0, W, H);

  drawSky(W, H);
  drawRoad(W, H);
  drawSpeedLines(W, H);
  for (let i = 0; i < OBSTACLES.length; i++) drawObstacle(OBSTACLES[i], i, W, H);
  drawBullets(W, H);
  drawPlayerDigit(W, H);
  drawProgress(W);
  drawPlayerHud(W);

  for (const p of particles) {
    ctx!.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx!.fillStyle = p.color;
    ctx!.beginPath();
    ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx!.fill();
  }
  ctx!.globalAlpha = 1;

  drawResultFlash(W, H);
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
        spawnBurst(fx, fy, "#ff5064", 36);
        playerFx = { kind: "loss", t: 0 };
      } else if (isLastResolved && state.status === "won") {
        spawnBurst(fx, fy, "#ffb648", 44);
      } else if (ob.type === "wall" && touchedPlayer) {
        spawnBurst(fx, fy, "#ffd76a", 18);
      }
    }
    if (state.status === "lost" && prevStatus === "playing" && state.resolvedUpTo === prevResolvedUpTo) {
      spawnBurst(fx, fy, "#ff5064", 36);
      playerFx = { kind: "loss", t: 0 };
    }

    // Bullet-vs-wall feedback: a small debris puff the instant a wall's live
    // hp drops, even while the player themselves is still well short of it.
    for (let i = 0; i < OBSTACLES.length; i++) {
      const ob = OBSTACLES[i];
      if (ob.type !== "wall") continue;
      if (state.wallHp[i] < (prevWallHp[i] ?? ob.value)) {
        const distanceAhead = ob.atUnits - state.worldX;
        if (visibleAt(distanceAhead)) {
          const d = depthOf(distanceAhead);
          const wx = laneCenterX(ob.lane, d, size.width);
          const wy = yAt(d, size.height);
          spawnBurst(wx, wy, "#8fd0ff", 6);
        }
      }
    }
  }

  if (playerFx) {
    playerFx = { ...playerFx, t: playerFx.t + dt };
    if (playerFx.t > 0.6) playerFx = null;
  }

  particles = particles
    .map((p) => ({
      ...p,
      x: p.x + p.vx * dt,
      y: p.y + p.vy * dt,
      vy: p.vy + 260 * dt,
      life: p.life - dt,
    }))
    .filter((p) => p.life > 0);

  draw();
  (window as unknown as { __state?: GameState }).__state = state;
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
