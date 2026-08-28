# Digit Cannon Run

A COMP4020 Crit 5 prototype: a static browser game built on plain
HTML/CSS/TypeScript with Vite, deployed to GitHub Pages. You are a number.
You auto-fire digit bullets down your lane; road zones (+N, x2, -N) grow or
shrink anything that touches them, bullets included, and each wall blocks a
lane until your number is big enough to break it.

## Quick start

```sh
mise install       # installs the pinned Node and pnpm
pnpm install
pnpm dev            # local dev server
pnpm check          # typecheck, build, and run all tests
pnpm check:evidence # process-evidence check (citations, reflections, CLAUDE.md)
pnpm build          # produce dist/ (what gets deployed)
```

`mise` is the course's recommended runtime manager; any manager works as long
as it matches the Node/pnpm versions pinned in `mise.toml`.

## Deploy

The repo builds with `base: "./"` (see `vite.config.ts`), so the built asset
paths are relative and work under any GitHub Pages project path. Once the repo
is public, `.github/workflows/checks.yml` builds and deploys on every push to
`main` and prints the live URL.

## What's here

- `game.ts` --- the game's rules: pure functions, no DOM or timers, driven
  directly by `spec/game.test.ts`.
- `main.ts`, `styles.css`, `index.html` --- rendering, input, and the page
  shell.
- `spec/` --- the shipped invariants (`invariants.test.ts`) plus this week's
  spec tests (`game.test.ts`).
- `PROCESS.md` --- how the work came together, with commit citations.
- `reflections/crit-5.md` --- the standing reflection prompts for this week.
- `CLAUDE.md` --- the carried-forward harness for whoever (human or agent)
  works in this repo next.
