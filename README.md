# Strata

Architecture of any repository, one layer at a time.

Strata has two parts:

1. **`/strata` skill for Claude Code** (`skill/`). It reads a repository and explains it at a chosen level of detail. It builds an offline AST graph with [graphify](https://pypi.org/project/graphifyy/), rolls the graph up to modules, and then checks the picture against the real code (HTTP calls, queues, stores, process boundaries).
2. **Viewer** (`docs/`, served at **https://kushshriv.github.io/strata/**). A static page that draws the skill's JSON output as hand-drawn, zoomable sketches (dagre layout + rough.js). It uses the same colours, type and theme switch as [kushshriv.github.io](https://kushshriv.github.io/), and the theme choice carries over between the two sites.

| Level | View in the viewer |
|---|---|
| L0 Overview | Shape, summary, stack, languages, systems, entry points |
| L1 System | Graph of runtime parts grouped by system; edges coloured by protocol |
| L2 Modules | Module graph grouped by owning component; edge width = references |
| L3 Flows | Sequence diagram + step table per flow |
| L4 Deep dive | Rendered notes on one area |

## Maps

| Project | Interactive map | Report |
|---|---|---|
| Distributed Load Testing System | [kushshriv.github.io/strata/?map=distributed-load-testing](https://kushshriv.github.io/strata/?map=distributed-load-testing) | [ARCHITECTURE.md](analyses/distributed-load-testing/ARCHITECTURE.md) |
| Vercel Clone for React Projects | [kushshriv.github.io/strata/?map=vercel-clone](https://kushshriv.github.io/strata/?map=vercel-clone) | [ARCHITECTURE.md](analyses/vercel-clone/ARCHITECTURE.md) |

Every claim carries `path:line` evidence. With `repo.url` set, evidence links open the file on GitHub at the analysed commit.

## Install

```sh
./install.sh          # symlinks skill/ to ~/.claude/skills/strata
```

Needs `python3`. `graphify` is optional (used for repos with more than ~25 source files).

## Use

```
/strata                         # current repo, L1
/strata path/to/repo --level all
/strata https://github.com/owner/repo --level 2
/strata . --focus src/auth      # L3/L4 on one area
```

The skill prints its answer and a line like `Open in Strata: https://kushshriv.github.io/strata/#d=…`. Each run is merged into `~/.strata/<repo>.json`, so zooming in adds to the same map.

## Privacy

- The viewer is static. It has no backend and no analytics.
- A share link carries the whole map inside the URL **fragment** (`#d=…`, deflate + base64url). Browsers do not send the fragment to the server. Anyone who has the link can still read the map, so treat links to private repos as private.
- You can also open the viewer and drop the JSON file in. The file is read locally.
- `?src=https://…` loads a JSON from a URL (for example, a raw gist).

## Security

The viewer treats every input as untrusted. Diagram text and page text are set with `textContent`; raw HTML in markdown is escaped, then sanitised with DOMPurify. A strict CSP blocks inline scripts, and pinned CDN scripts load with SRI.

## Layout

```
skill/            Claude Code skill (SKILL.md, references/, scripts/)
  scripts/arch_digest.py   repo recon + module roll-up of a graphify graph
  scripts/strata_pack.py   validate, merge, save, make the viewer link
docs/             GitHub Pages viewer (no build step)
  examples/       published maps (strata/1 JSON) + index.json for the gallery
analyses/         Markdown reports rendered from the same maps
```

Develop the viewer locally with `python3 -m http.server 8765 --directory docs`. Set `STRATA_VIEWER=http://localhost:8765/` so the pack script prints local links.
