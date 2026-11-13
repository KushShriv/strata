#!/usr/bin/env python3
"""Compact architecture digest of a repository.

Combines a cheap file-system recon with an optional graphify graph.json and
rolls the symbol graph up to module level, so an LLM can describe the
architecture without reading every file.

Usage:
  arch_digest.py <repo> [--graph PATH] [--depth N] [--focus SUBPATH] [--json]

Stdlib only. Read-only: it never writes into <repo>.
"""
import argparse
import collections
import json
import os
import subprocess
import sys

IGNORE_DIRS = {
    ".git", "node_modules", ".venv", "venv", "env", "__pycache__", "dist",
    "build", ".next", ".nuxt", "target", "vendor", ".idea", ".vscode",
    "graphify-out", ".codegraph", "coverage", ".pytest_cache", ".mypy_cache",
    ".tox", "out", ".turbo", ".cache", "Pods", "DerivedData", ".gradle",
}
CODE_EXT = {
    ".py": "Python", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript",
    ".ts": "TypeScript", ".tsx": "TypeScript", ".go": "Go", ".rs": "Rust",
    ".java": "Java", ".kt": "Kotlin", ".swift": "Swift", ".m": "Objective-C",
    ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".c": "C", ".h": "C/C++",
    ".cpp": "C++", ".cc": "C++", ".hpp": "C++", ".scala": "Scala",
    ".ex": "Elixir", ".exs": "Elixir", ".dart": "Dart", ".lua": "Lua",
    ".sql": "SQL", ".sh": "Shell", ".vue": "Vue", ".svelte": "Svelte",
}
MANIFESTS = {
    "package.json", "pyproject.toml", "setup.py", "requirements.txt", "go.mod",
    "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile",
    "composer.json", "Package.swift", "pubspec.yaml", "mix.exs", "*.csproj",
    "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml",
    "Makefile", "Procfile", "serverless.yml", "vercel.json", "netlify.toml",
    "fly.toml", "app.yaml", "wrangler.toml", "turbo.json", "pnpm-workspace.yaml",
    "nx.json", "lerna.json", "CMakeLists.txt", "Podfile",
}
ENTRY_NAMES = {
    "main", "index", "app", "server", "cli", "__main__", "manage", "wsgi",
    "asgi", "program", "startup", "entry", "run",
}
INFRA_HINTS = {
    "Dockerfile": "container", ".github/workflows": "CI (GitHub Actions)",
    ".gitlab-ci.yml": "CI (GitLab)", "terraform": "IaC (Terraform)",
    "k8s": "Kubernetes", "helm": "Helm", "migrations": "DB migrations",
    "prisma": "Prisma ORM", "alembic": "Alembic migrations",
}


def list_files(repo):
    """Prefer git's view of the tree; fall back to a filtered walk."""
    try:
        out = subprocess.run(
            ["git", "-C", repo, "ls-files", "--cached", "--others", "--exclude-standard"],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout.splitlines()
        files = [f for f in out if not any(p in IGNORE_DIRS for p in f.split("/"))]
        if files:
            return files
    except Exception:
        pass
    ignore = set(IGNORE_DIRS)
    try:  # honour simple top-level .gitignore names when git is unavailable
        for line in open(os.path.join(repo, ".gitignore")):
            line = line.strip().strip("/")
            if line and not line.startswith("#") and not any(c in line for c in "*?[!/"):
                ignore.add(line)
    except OSError:
        pass
    files = []
    for root, dirs, names in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in ignore and (not d.startswith(".") or d == ".github")]
        for n in names:
            files.append(os.path.relpath(os.path.join(root, n), repo))
    return files


TEST_DIRS = {"test", "tests", "__tests__", "spec", "specs", "e2e", "testdata", "fixtures"}


def is_test(path):
    parts = path.split("/")
    stem = os.path.splitext(parts[-1])[0]
    return (any(p in TEST_DIRS for p in parts[:-1]) or stem.startswith("test_")
            or stem.endswith(("_test", ".test", ".spec", "Test", "Tests")))


EXPAND = set()  # modules shown at file granularity (filled in by auto_expand)


def module_of(path, depth):
    parts = path.split("/")[:-1]
    d = "/".join(parts)
    if d in EXPAND or (not parts and "(root)" in EXPAND):
        return os.path.splitext(path)[0]
    # Skip a conventional wrapper dir so "src/api/x.ts" groups as "src/api".
    take = depth + (1 if parts and parts[0] in ("src", "lib", "app", "packages", "apps",
                                                 "services", "internal", "pkg", "cmd") else 0)
    return "/".join(parts[:take]) or "(root)"


def recon(repo, files, depth):
    langs = collections.Counter()
    loc = collections.Counter()
    manifests, entries, infra, docs = [], [], set(), []
    mod_files = collections.Counter()
    for f in files:
        base = os.path.basename(f)
        stem, ext = os.path.splitext(base)
        if ext in CODE_EXT:
            langs[CODE_EXT[ext]] += 1
            mod_files[module_of(f, depth)] += 1
            try:
                with open(os.path.join(repo, f), "rb") as fh:
                    loc[CODE_EXT[ext]] += sum(1 for _ in fh)
            except OSError:
                pass
            if stem.lower() in ENTRY_NAMES or f.startswith(("cmd/", "bin/")):
                entries.append(f)
        if base in MANIFESTS or base.endswith(".csproj"):
            manifests.append(f)
        if ext.lower() in (".md", ".mdx", ".rst") and f.count("/") <= 2:
            docs.append(f)
        for hint, label in INFRA_HINTS.items():
            if hint in f:
                infra.add(label)
    return {
        "files_total": len(files),
        "languages": [{"lang": k, "files": v, "lines": loc[k]} for k, v in langs.most_common(8)],
        "manifests": sorted(manifests)[:40],
        "entry_point_candidates": sorted(entries, key=lambda p: (p.count("/"), p))[:25],
        "infra": sorted(infra),
        "docs": sorted(docs, key=lambda p: (p.count("/"), p))[:20],
        "modules_by_file_count": mod_files.most_common(40),
    }


def noise(n):
    """File-level nodes and config keys (tsconfig, package.json) are not components."""
    f, label = n["source_file"], n["label"]
    return (f.endswith(label) or os.path.splitext(f)[1] not in CODE_EXT)


def auto_expand(code, depth):
    """A flat package that holds most of the code says nothing as one box.
    Show any directory with >40% of symbols and <=40 files at file level."""
    by_dir = collections.Counter(os.path.dirname(n["source_file"]) for n in code.values())
    files = collections.defaultdict(set)
    for n in code.values():
        files[os.path.dirname(n["source_file"])].add(n["source_file"])
    total = sum(by_dir.values()) or 1
    for d, c in by_dir.items():
        if c / total > 0.4 and len(files[d]) <= 40 and len(files[d]) > 1:
            EXPAND.add(d or "(root)")


def digest_graph(graph_path, depth, focus, include_tests=False):
    g = json.load(open(graph_path))
    nodes = {n["id"]: n for n in g.get("nodes", [])}
    code = {i: n for i, n in nodes.items()
            if n.get("file_type") == "code" and n.get("source_file")
            and (include_tests or not is_test(n["source_file"]))}
    auto_expand(code, depth)
    deg = collections.Counter()
    mod_edges = collections.Counter()
    mod_in_from = collections.defaultdict(set)
    sym_callers_mods = collections.defaultdict(set)
    for l in g.get("links", []):
        s, t = code.get(l["source"]), code.get(l["target"])
        if not s or not t or l.get("relation") == "contains":
            continue
        deg[l["source"]] += 1
        deg[l["target"]] += 1
        ms, mt = module_of(s["source_file"], depth), module_of(t["source_file"], depth)
        if ms != mt:
            mod_edges[(ms, mt)] += 1
            mod_in_from[mt].add(ms)
            sym_callers_mods[l["target"]].add(ms)

    mods = collections.defaultdict(list)
    for i, n in code.items():
        mods[module_of(n["source_file"], depth)].append(i)

    def sym(i):
        n = code[i]
        return f'{n["label"]} ({n["source_file"]}:{n.get("source_location", "")})'

    # Shared utilities: used from many modules but call little themselves.
    utilities = [sym(i) for i, ms in sorted(sym_callers_mods.items(), key=lambda x: -len(x[1]))
                 if len(ms) >= 3
                 and not noise(code[i])][:12]
    util_ids = {i for i, ms in sym_callers_mods.items() if len(ms) >= 3}

    module_rows = []
    for m, ids in mods.items():
        if focus and not m.startswith(focus):
            continue
        fan_out = sum(c for (a, _), c in mod_edges.items() if a == m)
        fan_in = sum(c for (_, b), c in mod_edges.items() if b == m)
        core = sorted((i for i in ids if i not in util_ids and not noise(code[i])),
                      key=lambda i: -deg[i])[:6]
        module_rows.append({
            "module": m, "symbols": len(ids), "fan_in": fan_in, "fan_out": fan_out,
            "used_by": sorted(mod_in_from[m])[:8],
            "key_symbols": [sym(i) for i in core],
        })
    module_rows.sort(key=lambda r: -(r["fan_in"] + r["fan_out"] + r["symbols"]))

    # Simple 2-cycles between modules (A->B and B->A).
    cycles = sorted({tuple(sorted((a, b))) for (a, b) in mod_edges if (b, a) in mod_edges})

    communities = collections.Counter(
        n.get("community_name") for n in code.values() if n.get("community_name"))
    return {
        "graph_stats": {"nodes": len(nodes), "code_nodes": len(code), "links": len(g.get("links", []))},
        "modules": module_rows[:30],
        "module_edges": [{"from": a, "to": b, "weight": c}
                         for (a, b), c in mod_edges.most_common(40)
                         if not focus or a.startswith(focus) or b.startswith(focus)],
        "module_cycles": cycles[:15],
        "shared_utilities": utilities,
        "communities": communities.most_common(15),
    }


def mermaid(edges, limit=25):
    lines = ["flowchart LR"]
    ids = {}
    for e in edges[:limit]:
        for m in (e["from"], e["to"]):
            ids.setdefault(m, f"m{len(ids)}")
        lines.append(f'  {ids[e["from"]]}["{e["from"]}"] -->|{e["weight"]}| {ids[e["to"]]}["{e["to"]}"]')
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("--graph", help="graph.json (default <repo>/graphify-out/graph.json if present)")
    ap.add_argument("--depth", type=int, default=1, help="path segments that define a module")
    ap.add_argument("--focus", help="limit module output to this path prefix")
    ap.add_argument("--include-tests", action="store_true", help="keep test code in the graph")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    repo = os.path.abspath(a.repo)
    files = list_files(repo)
    gp = a.graph or os.path.join(repo, "graphify-out", "graph.json")
    out = {"repo": repo}
    if os.path.exists(gp):
        out["graph"] = digest_graph(gp, a.depth, a.focus, a.include_tests)
    else:
        out["graph"] = None
    out["recon"] = recon(repo, files, a.depth)  # after graph so EXPAND applies
    if out["graph"]:
        out["graph"]["expanded_to_file_level"] = sorted(EXPAND)

    if a.json:
        json.dump(out, sys.stdout, indent=1)
        return
    r = out["recon"]
    print(f"# Architecture digest: {repo}\n")
    print(f"Files: {r['files_total']}")
    print("Languages: " + ", ".join(f"{l['lang']} {l['files']}f/{l['lines']}L" for l in r["languages"]))
    print("Manifests: " + (", ".join(r["manifests"]) or "none"))
    print("Infra: " + (", ".join(r["infra"]) or "none detected"))
    print("Docs: " + (", ".join(r["docs"]) or "none"))
    print("Entry-point candidates:\n  " + "\n  ".join(r["entry_point_candidates"] or ["none"]))
    print("\nModules by code-file count:")
    for m, c in r["modules_by_file_count"][:25]:
        print(f"  {c:4d}  {m}")
    g = out["graph"]
    if not g:
        print("\n(no graph.json: module dependencies not computed)")
        return
    print(f"\nGraph: {g['graph_stats']}  (tests excluded unless --include-tests)")
    if g["expanded_to_file_level"]:
        print("Shown at file level (flat dirs holding most code): " + ", ".join(g["expanded_to_file_level"]))
    print("\nModules (fan_in/fan_out = cross-module edges):")
    for m in g["modules"]:
        print(f"- {m['module']}  symbols={m['symbols']} in={m['fan_in']} out={m['fan_out']}"
              + (f"  used_by={m['used_by']}" if m["used_by"] else ""))
        for s in m["key_symbols"]:
            print(f"    · {s}")
    print("\nShared utilities (called from 3+ modules; not architecture):")
    for s in g["shared_utilities"] or ["none"]:
        print(f"  {s}")
    print("\nModule cycles: " + (", ".join(f"{a}<->{b}" for a, b in g["module_cycles"]) or "none"))
    print("\nModule dependency graph (edge label = number of cross-module references):")
    print("```mermaid\n" + mermaid(g["module_edges"]) + "\n```")


if __name__ == "__main__":
    main()
