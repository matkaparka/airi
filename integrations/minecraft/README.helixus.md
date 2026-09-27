# Helixus branch: Minecraft bot driven by an AITuberKit live page

This branch (`helixus` on `matkaparka/airi`) runs the AIRI Minecraft bot for Helixus, an AI VTuber built on
AITuberKit. The character decides what to do and talks about it on stream; this bot does the actual playing.
Only this module is used; the rest of the AIRI monorepo is not needed (sparse checkout is enough).

## What changed from upstream

| Area | Change |
| --- | --- |
| Host seam | New `CognitiveHost` interface (`src/cognitive/types`). The engine talks to a host instead of the AIRI client directly. `src/airi/airi-host.ts` wraps the upstream AIRI bridge and status service; `src/helixus/helixus-link.ts` is the new host. |
| Helixus link | `HELIXUS_LINK_PORT` set: no AIRI server; a loopback HTTP API for the page: `GET /status`, `GET /events?after=seq`, `GET /trace`, `POST /command {text}`, `POST /pause {paused}`, `POST /forget`. Browser origins are limited by `HELIXUS_ALLOWED_ORIGINS`. |
| Planner history | `BRAIN_HISTORY_MAX` / `BRAIN_HISTORY_KEEP`: cut the history back in one step instead of by two messages on every turn, so a local llama.cpp server (or provider prefix caching) can reuse the prompt cache. Unset = upstream behavior. |
| Version | `BOT_VERSION=auto` lets mineflayer pick the server version. |
| Install | Standalone npm install: concrete versions instead of `catalog:`, no `@proj-airi/server-sdk` (its dependency `@proj-airi/better-ws` is not on npm). The AIRI host is loaded only in AIRI mode. `scripts/apply-patches.mjs` applies `patches/mineflayer-pathfinder.patch` (pnpm did this upstream). `minecraft-data` is `^3.117.0` so mineflayer and prismarine-registry share one copy. |

## Setup (Windows)

```bat
cd integrations\minecraft
npm install --no-workspaces
copy helixus.env.example .env.local
```

`--no-workspaces` is required: the monorepo root `package.json` declares npm workspaces, and without it npm installs
the whole monorepo. Edit `.env.local` for the server address, bot name, master name, and planner LLM.

Run: `E:\aivup\start_minecraft_bot.bat`, or

```bat
node --no-node-snapshot --env-file=.env --env-file-if-exists=.env.local --import tsx src\main.ts
```

The planner LLM is any OpenAI-compatible endpoint. The Helixus setup uses a local llama-server with
Qwen3.6-35B-A3B (`E:\aivup\start_mc_llm.bat`: experts on the CPU, thinking off, one slot, no repetition penalties).

The server must accept offline accounts (`online-mode=false`) unless `BOT_AUTH=microsoft` is used with a real account.

## Checks

```bat
npm run typecheck --no-workspaces
node --no-node-snapshot node_modules\vitest\vitest.mjs run src/helixus
```

`typecheck` uses `tsconfig.helixus.json`, which leaves out `src/airi` (it needs the pnpm workspace). Some upstream
tests fail on a clean checkout of this module too (map renderer, rule engine timestamps, one brain timeout test).

## Tested (2026-09-27)

Against a flying-squid 1.21.4 test server: the bot joins, `/status` and `/events` report it, a page command reaches
the planner, the local model writes and runs actions (chat, queries, movement). The prompt cache held: each planner
call read 360–430 new tokens on top of a ~14k-token context. From the AITuberKit live page: Ctrl+Alt+M connects and
resumes the planner, a viewer request produced `[mc:...]` in Helixus's reply and it reached the bot, toggling off
paused the planner.
