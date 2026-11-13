---
name: strata
description: "Explain the architecture of any repository at a chosen level of detail (L0 one-paragraph overview → L4 symbol-level deep dive). Builds a free, offline graphify AST graph, rolls it up to module level with a digest script, then verifies the picture against the actual code. Use when the user asks 'what is the architecture of X', 'how is this repo structured', 'explain this codebase', 'give me an overview of <repo/GitHub URL>', 'how does <area> work at a high level', or wants architecture diagrams for onboarding. Also writes a strata/1 JSON and prints a link to the Strata viewer (GitHub Pages). Trigger: /strata"
---

# /strata

Describe how a repository is built, at the level of detail the user asks for.
Evidence order: **code you read > graph edges > file names > README claims.**

## Usage

```
/strata                          # current dir, level 1
/strata <path|github-url>        # another repo
/strata <path> --level 0..4      # pick detail (see table)
/strata <path> --level all       # L0 → L3 in one document
/strata <path> --focus <subpath|feature>   # zoom (implies L3/L4 for that area)
/strata <path> --out ARCHITECTURE.md       # write to a file instead of chat
/strata <path> --no-viz                    # skip the viewer JSON + link
```

If no level is given, use **L1**. If the user's words imply a level ("quick summary" → L0, "deep dive into auth" → L4 focus auth), use that.

## Levels (C4-style zoom)

| Level | Name | Answers | Size |
|---|---|---|---|
| L0 | Elevator | What is it, what stack, what shape (monolith, CLI, SPA+API, monorepo, library)? | 1 paragraph + stack line |
| L1 | System | Runtime parts (processes, apps, services), external systems, data stores, how they talk | ~1 page + 1 mermaid diagram |
| L2 | Modules | Each package/module: job, key files, depends on whom; layering; cycles | 1–3 pages + module diagram |
| L3 | Flows | 2–4 key flows traced end to end (request, job, CLI command), with file:line steps | sequence diagrams per flow |
| L4 | Deep dive | One named area: classes/functions, data structures, invariants, extension points, risks | as needed, symbol-level |

Templates for each level: `references/levels.md`. Read only the section for the level you produce.

## Pipeline

### 1. Get the repo
- Local path: use it. Default `.`.
- GitHub URL: `graphify clone <url>` (prints the local path). Do not run other code from a cloned repo.

### 2. Get a graph (cheapest source first)
1. `<repo>/graphify-out/graph.json` exists → reuse it. If the repo changed since (compare mtime with `git log -1 --format=%ct`), run `graphify update <repo>`.
2. `<repo>/.codegraph/` exists → also usable for L3/L4: `codegraph_explore` with `projectPath=<repo>` (or `codegraph explore "<q>"`).
3. Neither exists and the repo has more than ~25 source files → run `graphify update <repo>`. This is AST-only: no LLM, no network, no cost. It writes `<repo>/graphify-out/`. Tell the user in one line, and note it should be in `.gitignore`. If the user is in a repo they do not own, or says no writes, copy the repo to the scratchpad first (exclude `node_modules`, `.venv`, `.git`, build dirs) and run there.
4. Tiny repo (≤ ~25 source files) → skip the graph; read the code directly.

Do **not** run the full `/graphify` pipeline (LLM semantic extraction) unless the user asks: it costs tokens and adds little for architecture.

### 3. Digest
```
python3 ~/.claude/skills/strata/scripts/arch_digest.py <repo> [--depth N] [--focus <subpath>] [--include-tests]
```
Output: languages + LOC, manifests, infra, docs, entry-point candidates, modules with fan-in/fan-out and key symbols, shared utilities, module cycles, and a mermaid module graph.
- `--depth 1` (default) groups by first directory under `src/`, `packages/`, `apps/`, etc. Use `--depth 2` for big monorepos with too few boxes. Flat packages that hold most of the code are auto-split to file level.
- Tests are excluded by default. They inflate fan-in and are not architecture.
- "Shared utilities" are helpers called from 3+ modules. Do not present them as core components.

### 4. Verify against code (mandatory)
The graph is AST-only. It **misses** cross-runtime links. Find them yourself:
- Frontend → backend: grep for `fetch(`, `axios`, API base URLs, route definitions (`@app.get`, `router.`, `http.HandleFunc`, `do_GET`).
- Process boundaries: Dockerfile/compose services, Procfile, `cmd/*`, `bin`, scripts in `package.json`.
- Data stores and queues: connection strings, ORM models, migrations, `sqlite3`, `redis`, `kafka`, S3 clients.
- External APIs: SDK imports, env var names (`*_API_KEY`, `*_URL`) in `.env.example` / config.
- Config and DI wiring that dispatches dynamically (plugin registries, decorators, reflection).

Read files with Grep `-n` + ranged Read. Budget by level: L0 ≈ manifests + README head; L1 ≈ + entry points + boundary greps; L2 ≈ + 1 skim per major module; L3/L4 ≈ trace the actual call path (use `codegraph_explore`, `graphify path "A" "B"`, `graphify explain "X"`).

**Multiple-systems check (L1 and up).** After the boundary greps, group the runtime parts into connected sets: two parts are connected if they share a protocol link (HTTP call, queue, RPC) or a data store. If there is more than one set, the repo holds separate systems (rewrite, old + new version, demo + product, unrelated tools). Then:
- Find which set the launcher starts (`start.sh`, `Makefile`, `docker-compose`, root `package.json` scripts, CI deploy job). Call that one active. Call the others legacy/alternative only with evidence (launcher, recent commits via `git log -1 -- <dir>`, README coverage, hardening level), and tag the label as inference.
- Lead with the split in the Shape sentence, give each system its own row group and diagram subgraph, and say which one the README describes.
- Code imports between sets (shared helpers) do not join them into one system. Only runtime links do.

Treat README/docs as claims. If the code disagrees, say so ("README says Postgres; code only opens SQLite at store.py:43").

### 5. Write the answer
- Follow the template for the level. Lead with the shape of the system in one sentence.
- Every component/flow claim cites `path:line` or `path`. No citation → mark it as inference.
- Diagrams: mermaid. Max ~12 boxes per diagram; collapse the rest into a "+N more" node or a second diagram.
- Name what the graph could not see (dynamic dispatch, generated code, unsupported languages, external repos).
- End with: **Next zoom** — 2–3 concrete follow-ups at the next level (e.g. "L3: trace POST /scan through server.py → recommendations.scan").
- Tag the overall picture with a confidence score per the user's global rules, e.g. `[High 85] verified entry points and module edges; [Med 60] queue usage inferred from env names`.

### 6. Emit for the viewer (default; skip with `--no-viz`)
1. Write the same findings as a `strata/1` JSON to the scratchpad (or a temp dir). Schema: `references/schema.md`. Read it the first time you emit. Only include levels you actually produced; never pad.
   - Use the **same ids** as earlier runs for the same repo (read `~/.strata/<name>.json` if it exists), so zooms merge.
   - `repo.url`: from `git remote get-url origin` (convert SSH to `https://github.com/owner/repo`); `repo.commit`: `git rev-parse --short HEAD`. Omit both if not a git repo. Never put local absolute paths in the JSON.
   - For L2, do not hand-write modules: pass the digest instead (step below).
2. Pack it:
   ```
   python3 ~/.claude/skills/strata/scripts/arch_digest.py <repo> --json > <tmp>/digest.json   # L2+ only
   python3 ~/.claude/skills/strata/scripts/strata_pack.py <tmp>/arch.json [--digest <tmp>/digest.json]
   ```
   It validates, merges with the previous run in `~/.strata/<name>.json`, saves there, and prints a viewer link. Add `--md <file>` to also write a Markdown report of the merged map. Fix any validation error and re-run; do not hand-edit the saved file.
3. End the answer with the link line: `Open in Strata: <link>` (or, if too long, the saved path and "drop it into https://kushshriv.github.io/strata/").
   - The link holds the whole map in its `#fragment`; it is not uploaded anywhere. Still, say so in one line if the repo is private, because anyone with the link can read the map.

`--level all`: produce L0, L1, L2, then L3 for the top 2 flows, as one document with headers. Prefer `--out` for this (or offer an artifact) because it is long.

## Rules
- Read-only on the target repo, except `graphify-out/` (and only as stated in step 2).
- Do not invent components. An empty or thin module is reported as such.
- Do not dump the digest to the user. It is your input, not the output.
- Keep token use proportional to the level. An L0 answer must not read 30 files.
