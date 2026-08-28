// Rendering + input for THRESHOLD. All game rules live in game.ts (pure,
// tested); this file only draws frames and turns pointer/keyboard events into
// the single "flip" action the rules understand.
import {
  BALL_RADIUS,
  BALL_X,
  BOTTOM_Y,
  OBSTACLES,
  SPIKE_REACH,
  SPIKE_WIDTH,
  TOP_Y,
  TRACK_LENGTH,
  createInitialState,
  step,
  type CanvasSize,
  type GameState,
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
let best = 0;
let pendingFlip = false;
let resultAt: number | null = null;
let idleT = 0;
let particles: Particle[] = [];
let now = performance.now();

const RESULT_HOLD_MS = 1100;

function requestFlip(): void {
  pendingFlip = true;
}

canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  requestFlip();
});
window.addEventListener(
  "keydown",
  (e) => {
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
      e.preventDefault();
      requestFlip();
    }
  },
  { passive: false },
);
canvas.style.touchAction = "none";

function spawnBurst(x: number, y: number, color: string): void {
  const count = 28;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
    const speed = 90 + Math.random() * 170;
    const life = 0.5 + Math.random() * 0.45;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      color,
    });
  }
}

// A handful of dots drifting past at a fixed rate, independent of game
// state — the screen keeps breathing even before the first tap, so the
// opening frame reads as live rather than a static image.
const PARALLAX = Array.from({ length: 46 }, () => ({
  sx: Math.random(),
  sy: Math.random(),
  speed: 8 + Math.random() * 18,
  r: 0.6 + Math.random() * 1.4,
}));

function drawParallax(W: number, H: number): void {
  ctx!.fillStyle = "rgba(140, 170, 255, 0.35)";
  for (const dot of PARALLAX) {
    const x = (((dot.sx * W - idleT * dot.speed) % W) + W) % W;
    const y = dot.sy * H;
    ctx!.beginPath();
    ctx!.arc(x, y, dot.r, 0, Math.PI * 2);
    ctx!.fill();
  }
}

function drawRail(y: number, W: number): void {
  ctx!.save();
  ctx!.strokeStyle = "rgba(120, 170, 255, 0.55)";
  ctx!.shadowColor = "rgba(120, 170, 255, 0.9)";
  ctx!.shadowBlur = 10;
  ctx!.lineWidth = 2;
  ctx!.beginPath();
  ctx!.moveTo(0, y);
  ctx!.lineTo(W, y);
  ctx!.stroke();
  ctx!.restore();
}

function screenXFor(atScreens: number, W: number): number {
  return (BALL_X + (atScreens - state.worldX)) * W;
}

function drawObstacle(ob: Obstacle, W: number, H: number): void {
  const x = screenXFor(ob.atScreens, W);
  const halfW = (SPIKE_WIDTH * W) / 2;
  if (x < -halfW * 2 || x > W + halfW * 2) return;

  const reach = SPIKE_REACH * H;
  ctx!.save();
  ctx!.fillStyle = "rgba(255, 90, 110, 0.92)";
  ctx!.shadowColor = "rgba(255, 60, 90, 0.8)";
  ctx!.shadowBlur = 14;
  ctx!.beginPath();
  if (ob.side === "bottom") {
    ctx!.moveTo(x - halfW, H);
    ctx!.lineTo(x + halfW, H);
    ctx!.lineTo(x, H - reach);
  } else {
    ctx!.moveTo(x - halfW, 0);
    ctx!.lineTo(x + halfW, 0);
    ctx!.lineTo(x, reach);
  }
  ctx!.closePath();
  ctx!.fill();
  ctx!.restore();
}

function drawGate(W: number, H: number): void {
  const x = screenXFor(TRACK_LENGTH, W);
  if (x < -40 || x > W + 40) return;
  const pulse = 0.55 + 0.35 * Math.sin(idleT * 3.2);
  ctx!.save();
  ctx!.strokeStyle = `rgba(130, 255, 190, ${pulse})`;
  ctx!.shadowColor = "rgba(130, 255, 190, 0.9)";
  ctx!.shadowBlur = 22;
  ctx!.lineWidth = 6;
  ctx!.beginPath();
  ctx!.moveTo(x, H * TOP_Y - 30);
  ctx!.lineTo(x, H * BOTTOM_Y + 30);
  ctx!.stroke();
  ctx!.restore();
}

function drawProgress(W: number): void {
  const barH = 4;
  const margin = 18;
  const trackW = W - margin * 2;
  const frac = Math.min(1, state.worldX / TRACK_LENGTH);
  ctx!.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx!.fillRect(margin, 10, trackW, barH);
  ctx!.fillStyle = "rgba(130, 255, 190, 0.85)";
  ctx!.fillRect(margin, 10, trackW * frac, barH);
  if (best > 0.001) {
    ctx!.fillStyle = "rgba(255, 210, 120, 0.9)";
    ctx!.fillRect(margin + trackW * best - 1, 6, 2, barH + 8);
  }
}

function drawBall(W: number, H: number): void {
  if (state.status === "won" || state.status === "lost") return;

  const x = BALL_X * W;
  let y = state.ball.y * H;
  let glow = 0.55;

  if (state.status === "ready") {
    y += Math.sin(idleT * 2.4) * H * 0.012;
    glow = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(idleT * 3.4));
  }

  const r = BALL_RADIUS * H;

  if (state.status === "ready") {
    const ringR = r + 6 + 4 * Math.sin(idleT * 3.4);
    ctx!.save();
    ctx!.strokeStyle = `rgba(255, 255, 255, ${0.18 + 0.12 * Math.sin(idleT * 3.4)})`;
    ctx!.lineWidth = 2;
    ctx!.beginPath();
    ctx!.arc(x, y, ringR, 0, Math.PI * 2);
    ctx!.stroke();
    ctx!.restore();
  }

  ctx!.save();
  ctx!.fillStyle = "#eaf2ff";
  ctx!.shadowColor = `rgba(180, 210, 255, ${glow})`;
  ctx!.shadowBlur = 22;
  ctx!.beginPath();
  ctx!.arc(x, y, r, 0, Math.PI * 2);
  ctx!.fill();
  ctx!.restore();
}

function drawResultFlash(W: number, H: number): void {
  if (state.status !== "won" && state.status !== "lost") return;
  if (resultAt === null) return;
  const t = Math.min(1, (now - resultAt) / RESULT_HOLD_MS);
  const alpha = (1 - t) * 0.32;
  ctx!.fillStyle = state.status === "won" ? `rgba(130,255,190,${alpha})` : `rgba(255,80,100,${alpha})`;
  ctx!.fillRect(0, 0, W, H);
}

function draw(): void {
  const { width: W, height: H } = size;
  if (W === 0 || H === 0) return;
  ctx!.clearRect(0, 0, W, H);

  const bg = ctx!.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0a0e18");
  bg.addColorStop(1, "#04060c");
  ctx!.fillStyle = bg;
  ctx!.fillRect(0, 0, W, H);

  drawParallax(W, H);
  drawRail(TOP_Y * H, W);
  drawRail(BOTTOM_Y * H, W);
  for (const ob of OBSTACLES) drawObstacle(ob, W, H);
  drawGate(W, H);
  drawProgress(W);
  drawBall(W, H);

  for (const p of particles) {
    ctx!.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx!.fillStyle = p.color;
    ctx!.beginPath();
    ctx!.arc(p.x, p.y, 3, 0, Math.PI * 2);
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

  const flip = pendingFlip;
  pendingFlip = false;
  const prevStatus = state.status;

  if (state.status === "won" || state.status === "lost") {
    if (resultAt === null) resultAt = t;
    if (t - resultAt > RESULT_HOLD_MS) {
      best = Math.max(best, state.worldX / TRACK_LENGTH);
      state = createInitialState();
      resultAt = null;
      idleT = 0;
    }
  } else {
    state = step(state, dt, flip, size);
    if (state.status !== prevStatus && (state.status === "won" || state.status === "lost")) {
      const color = state.status === "won" ? "#8affbe" : "#ff5064";
      spawnBurst(BALL_X * size.width, state.ball.y * size.height, color);
    }
  }

  particles = particles
    .map((p) => ({
      ...p,
      x: p.x + p.vx * dt,
      y: p.y + p.vy * dt,
      vy: p.vy + 280 * dt,
      life: p.life - dt,
    }))
    .filter((p) => p.life > 0);

  draw();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
