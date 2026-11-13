# strata/1 — architecture JSON for the viewer

Write one JSON object. Every field except `schema`, `repo.name` and `l0` is optional: include only what the level you produced supports. Do not invent data to fill fields.

`evidence` values are strings `"path"` or `"path:line"` (or `"path:Lstart-Lend"`), relative to the repo root.

```jsonc
{
  "schema": "strata/1",
  "repo": {
    "name": "vercel-clone",                    // required
    "url": "https://github.com/owner/repo",    // optional; enables clickable evidence links
    "commit": "abc1234",                       // optional; `git rev-parse --short HEAD`
    "generated": "2026-11-13",                 // date of this analysis
    "levels": [0, 1]                           // levels this file covers (pack script fills it)
  },
  "confidence": { "score": 85, "label": "High", "basis": "read all entry points and boundary calls" },

  "l0": {                                      // required
    "shape": "Two separate systems: 3 Express services on Redis/S3, and a local Docker build service",
    "summary": "One paragraph: what it is and how it is built.",
    "stack": ["TypeScript", "Express", "Redis", "S3", "Docker"],
    "entry_points": [{ "path": "start.sh", "role": "launches local-service" }]
  },

  "systems": [                                 // connected sets of runtime parts (see multiple-systems check)
    { "id": "legacy", "name": "Legacy pipeline", "status": "legacy",   // active | legacy | alternative | unknown
      "summary": "...", "launcher": "none", "status_basis": "inference: start.sh starts only B" }
  ],

  "components": [                              // L1 runtime parts, stores and external systems
    { "id": "upload", "name": "Upload service", "system": "legacy",    // system: null for shared/external
      "kind": "service",   // frontend | service | worker | cli | job | library | store | queue | external | infra
      "tech": "Express :3000",
      "summary": "Clones the repo, uploads files to S3, queues a build.",
      "paths": ["vercel-upload-service/"],     // code roots; used to attach L2 modules
      "entry": "vercel-upload-service/src/index.ts:19",
      "evidence": ["vercel-upload-service/src/index.ts:22"] }
  ],

  "links": [                                   // L1 runtime links between components
    { "from": "upload", "to": "redis", "protocol": "queue",   // http | queue | db | storage | exec | rpc | import | other
      "label": "lPush build-queue", "evidence": ["vercel-upload-service/src/index.ts:32"] }
  ],

  "modules": [                                 // L2; pack script can fill these from the digest
    { "id": "signals/engine", "name": "signals/engine", "component": "api",
      "summary": "...", "symbols": 19, "fan_in": 30, "fan_out": 27,
      "key_symbols": ["decision_pipeline() (signals/engine.py:L356)"] }
  ],
  "module_links": [{ "from": "signals/server", "to": "signals/engine", "weight": 12 }],

  "flows": [                                   // L3
    { "id": "deploy", "name": "Deploy a repo (legacy)", "trigger": "POST /deploy", "system": "legacy",
      "steps": [
        { "from": "frontend", "to": "upload", "action": "POST /deploy {repoUrl}", "evidence": "frontend/src/components/landing.tsx:45" }
      ] }
  ],

  "deep_dives": [                              // L4; markdown body (rendered sanitised)
    { "id": "sandbox", "target": "worker", "title": "Docker build sandbox", "markdown": "## ..." }
  ],

  "blind_spots": ["Graph cannot see Redis/S3 links; found by grep."],
  "next_zoom": ["L3: trace POST /api/jobs through runWorker"]
}
```

Rules:
- `id`s are short, unique, lowercase, `[a-z0-9_-/.]`. Flow step `from`/`to` must be component ids (or module ids).
- Every link and flow step should carry evidence. Without evidence, put `"inferred": true` on it.
- Keep `summary` fields to 1–2 sentences. Long text goes in `deep_dives`.
