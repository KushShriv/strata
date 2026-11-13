#!/usr/bin/env python3
"""Validate a strata/1 architecture JSON, merge in digest modules and earlier
runs, save it, and print a self-contained viewer link.

Usage:
  strata_pack.py <architecture.json> [--digest DIGEST.json] [--out FILE]
                 [--viewer URL] [--no-merge] [--md FILE]

- --digest: output of `arch_digest.py <repo> --json`. Fills `modules` and
  `module_links` when the input has none, and assigns each module to the
  component whose `paths` prefix matches it.
- --out: where to save (default ~/.strata/<repo.name>.json). If that file
  exists, flows and deep_dives are merged by id and other fields are replaced,
  so each zoom adds to the same picture.
- --md: also render the merged map as a Markdown report (mermaid diagrams).
- The link carries the JSON in the URL fragment (#d=, raw-deflate +
  base64url). The fragment never reaches the server.

Stdlib only.
"""
import argparse
import base64
import datetime
import json
import os
import re
import sys
import zlib

VIEWER = os.environ.get("STRATA_VIEWER", "https://kushshriv.github.io/strata/")
KINDS = {"frontend", "service", "worker", "cli", "job", "library", "store", "queue",
         "external", "infra"}
STATUS = {"active", "legacy", "alternative", "unknown"}
LINK_MAX = 60000


def fail(errors):
    print("strata_pack: invalid architecture JSON:", file=sys.stderr)
    for e in errors:
        print("  - " + e, file=sys.stderr)
    sys.exit(1)


BANDS = (("High", 80, 100), ("Med", 50, 79), ("Low", 0, 49))


def band(score):
    return next(name for name, lo, hi in BANDS if lo <= score <= hi)


def check_confidence(d, errs, warns):
    """Rubric lives in SKILL.md. Here: shape, band/score agreement, and a sanity
    check against the share of claims that carry no evidence."""
    c = d.get("confidence")
    if not isinstance(c, dict) or c.get("score") is None:
        errs.append("confidence.score is required (0-100; see the rubric in SKILL.md)")
        return
    try:
        score = c["score"] = int(c["score"])
    except (TypeError, ValueError):
        errs.append("confidence.score must be a whole number 0-100")
        return
    if not 0 <= score <= 100:
        errs.append("confidence.score must be between 0 and 100")
        return
    label = c.get("label") or band(score)
    if label not in {b[0] for b in BANDS}:
        errs.append(f"confidence.label must be High, Med or Low (got {label!r})")
    elif label != band(score):
        errs.append(f"confidence.label {label} does not match score {score} (expected {band(score)})")
    c["label"] = label
    if not str(c.get("basis") or "").strip():
        errs.append("confidence.basis is required: say what was read and what was inferred")
    claims = list(d.get("links", [])) + [s for f in d.get("flows", []) for s in f.get("steps", [])]
    if claims:
        unbacked = sum(1 for x in claims if x.get("inferred") or not x.get("evidence"))
        share = unbacked / len(claims)
        if score >= 80 and share > 0.2:
            warns.append(f"confidence {score} (High) but {unbacked}/{len(claims)} links and flow steps have no evidence; "
                         "High needs every material claim read in code")
        elif score >= 50 and share > 0.5:
            warns.append(f"confidence {score} (Med) but over half the links and flow steps have no evidence; consider Low")


def validate(d):
    errs, warns = [], []
    if d.get("schema") != "strata/1":
        errs.append('schema must be "strata/1"')
    if not (d.get("repo") or {}).get("name"):
        errs.append("repo.name is required")
    if not isinstance(d.get("l0"), dict) or not d["l0"].get("summary"):
        errs.append("l0.summary is required")
    check_confidence(d, errs, warns)
    sys_ids = {s.get("id") for s in d.get("systems", [])}
    for s in d.get("systems", []):
        if s.get("status", "unknown") not in STATUS:
            errs.append(f"system {s.get('id')}: status must be one of {sorted(STATUS)}")
    comp_ids = set()
    for c in d.get("components", []):
        if not c.get("id"):
            errs.append(f"component without id: {c.get('name')}")
            continue
        if c["id"] in comp_ids:
            errs.append(f"duplicate component id {c['id']}")
        comp_ids.add(c["id"])
        if c.get("kind") and c["kind"] not in KINDS:
            errs.append(f"component {c['id']}: kind {c['kind']} not in {sorted(KINDS)}")
        if c.get("system") and c["system"] not in sys_ids:
            errs.append(f"component {c['id']}: unknown system {c['system']}")
    mod_ids = {m.get("id") for m in d.get("modules", [])}
    for l in d.get("links", []):
        for end in ("from", "to"):
            if l.get(end) not in comp_ids:
                errs.append(f"link {l.get('from')}->{l.get('to')}: unknown component {l.get(end)}")
        if not l.get("evidence") and not l.get("inferred"):
            warns.append(f"link {l.get('from')}->{l.get('to')} has no evidence; mark inferred")
    for f in d.get("flows", []):
        for i, st in enumerate(f.get("steps", [])):
            for end in ("from", "to"):
                if st.get(end) not in comp_ids | mod_ids:
                    errs.append(f"flow {f.get('id')} step {i + 1}: unknown participant {st.get(end)}")
    for ml in d.get("module_links", []):
        if mod_ids and (ml.get("from") not in mod_ids or ml.get("to") not in mod_ids):
            warns.append(f"module_link {ml.get('from')}->{ml.get('to')} references unknown module")
    return errs, warns


def from_digest(d, digest):
    g = digest.get("graph") or {}
    comps = [(p.rstrip("/"), c["id"]) for c in d.get("components", []) for p in c.get("paths", [])]
    comps.sort(key=lambda x: -len(x[0]))

    def owner(mod):
        for p, cid in comps:
            if mod == p or mod.startswith(p + "/") or p in ("", "."):
                return cid
        return None

    d["modules"] = [{
        "id": m["module"], "name": m["module"], "component": owner(m["module"]),
        "symbols": m["symbols"], "fan_in": m["fan_in"], "fan_out": m["fan_out"],
        "key_symbols": m["key_symbols"],
    } for m in g.get("modules", [])]
    ids = {m["id"] for m in d["modules"]}
    d["module_links"] = [e for e in g.get("module_edges", []) if e["from"] in ids and e["to"] in ids]
    if not d.get("repo", {}).get("languages"):
        d.setdefault("repo", {})["languages"] = (digest.get("recon") or {}).get("languages", [])


def merge(old, new):
    out = dict(old)
    for k, v in new.items():
        if k in ("flows", "deep_dives") and isinstance(v, list):
            by_id = {x.get("id"): x for x in old.get(k, [])}
            by_id.update({x.get("id"): x for x in v})
            out[k] = list(by_id.values())
        elif v not in (None, [], {}, ""):
            out[k] = v
    return out


def _mm(s):
    return re.sub(r"[\r\n;#<>{}%`\"]+", " ", str(s)).strip() or " "


def render_md(d, link=None):
    """Markdown report of the map. Same content as the viewer, for GitHub."""
    name = {c["id"]: c.get("name", c["id"]) for c in d.get("components", [])}
    name.update({m["id"]: m.get("name", m["id"]) for m in d.get("modules", [])})
    r, out = d["repo"], []
    w = out.append
    w(f"# {r['name']} — architecture\n")
    meta = [f"[{r['url']}]({r['url']})" if r.get("url") else None,
            f"commit `{r['commit']}`" if r.get("commit") else None, r.get("generated")]
    w(" · ".join(x for x in meta if x) + "\n")
    if link:
        w(f"**Interactive map:** {link}\n")
    c = d.get("confidence")
    if c:
        w(f"**Confidence {c.get('score', '')}%** ({c.get('label', '')}) — {c.get('basis', '')}  \n"
          "_How likely the map matches the code. High 80–100 = read in code; Med 50–79 = some inference; Low < 50 = mostly unverified._\n")
    l0 = d["l0"]
    w("## L0 — Overview\n")
    if l0.get("shape"):
        w(f"**{l0['shape']}**\n")
    w(l0["summary"] + "\n")
    if l0.get("stack"):
        w("Stack: " + " · ".join(l0["stack"]) + "\n")
    if l0.get("entry_points"):
        w("| Entry point | Role |\n|---|---|")
        for e in l0["entry_points"]:
            w(f"| `{e['path']}` | {e.get('role', '')} |")
        w("")
    if d.get("components"):
        w("## L1 — System\n")
        for s in d.get("systems", []):
            w(f"- **{s['name']}** ({s.get('status', 'unknown')}): {s.get('summary', '')}"
              + (f" _Status basis: {s['status_basis']}._" if s.get("status_basis") else ""))
        w("\n```mermaid\nflowchart LR")
        sysd = {}
        for comp in d["components"]:
            sysd.setdefault(comp.get("system"), []).append(comp)
        ids = {cid: f"n{i}" for i, cid in enumerate(name)}
        for sid, comps in sysd.items():
            sname = next((s["name"] for s in d.get("systems", []) if s["id"] == sid), None)
            if sname:
                w(f'  subgraph s_{ids.get(comps[0]["id"])}["{_mm(sname)}"]')
            for comp in comps:
                w(f'    {ids[comp["id"]]}["{_mm(comp["name"])}"]')
            if sname:
                w("  end")
        for l in d.get("links", []):
            arrow = "-.->" if l.get("inferred") else "-->"
            w(f'  {ids[l["from"]]} {arrow}|{_mm(l.get("label") or l.get("protocol", ""))[:40]}| {ids[l["to"]]}')
        w("```\n")
        w("| Component | Kind | Tech | Job | Entry |\n|---|---|---|---|---|")
        for comp in d["components"]:
            w(f"| {comp['name']} | {comp.get('kind', '')} | {comp.get('tech', '')} | {comp.get('summary', '')} | "
              + (f"`{comp['entry']}`" if comp.get("entry") else "") + " |")
        w("")
    if d.get("modules"):
        w("## L2 — Modules\n")
        w("| Module | Component | Symbols | In | Out | Key symbols |\n|---|---|---|---|---|---|")
        for m in d["modules"]:
            ks = "<br>".join(f"`{k}`" for k in m.get("key_symbols", [])[:3])
            w(f"| `{m['name']}` | {name.get(m.get('component'), '')} | {m.get('symbols', '')} | "
              f"{m.get('fan_in', '')} | {m.get('fan_out', '')} | {ks} |")
        w("")
    if d.get("flows"):
        w("## L3 — Flows\n")
        for f in d["flows"]:
            w(f"### {f['name']}\nTrigger: `{f.get('trigger', '')}`\n")
            w("```mermaid\nsequenceDiagram\n  autonumber")
            alias = {}
            for st in f["steps"]:
                for pnt in (st["from"], st["to"]):
                    if pnt not in alias:
                        alias[pnt] = f"P{len(alias)}"
                        w(f"  participant {alias[pnt]} as {_mm(name.get(pnt, pnt))}")
            for st in f["steps"]:
                w(f"  {alias[st['from']]}{'-->>' if st.get('reply') else '->>'}{alias[st['to']]}: {_mm(st['action'])}")
            w("```\n")
            w("| # | Step | Evidence |\n|---|---|---|")
            for i, st in enumerate(f["steps"], 1):
                w(f"| {i} | {name.get(st['from'], st['from'])} → {name.get(st['to'], st['to'])}: {st['action']} | "
                  + (f"`{st['evidence']}`" if st.get("evidence") else "_inferred_") + " |")
            w("")
    if d.get("deep_dives"):
        w("## L4 — Deep dives\n")
        for dv in d["deep_dives"]:
            body = re.sub(r"^(#+)", r"\1##", dv.get("markdown", ""), flags=re.M)
            w(f"### {dv.get('title', dv['id'])}\n\n{body}\n")
    for title, key in (("Not visible from code", "blind_spots"), ("Next zoom", "next_zoom")):
        if d.get(key):
            w(f"## {title}\n")
            w("\n".join(f"- {x}" for x in d[key]) + "\n")
    w("---\nGenerated by [Strata](https://github.com/KushShriv/strata).")
    return "\n".join(out)


def levels(d):
    lv = [0]
    if d.get("components"):
        lv.append(1)
    if d.get("modules"):
        lv.append(2)
    if d.get("flows"):
        lv.append(3)
    if d.get("deep_dives"):
        lv.append(4)
    return lv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--digest")
    ap.add_argument("--out")
    ap.add_argument("--viewer", default=VIEWER)
    ap.add_argument("--no-merge", action="store_true")
    ap.add_argument("--md", help="also write a Markdown report here")
    ap.add_argument("--link-base", help="viewer URL to put in the Markdown report (e.g. ...?src=examples/x.json)")
    a = ap.parse_args()

    d = json.load(open(a.input))
    if a.digest and not d.get("modules"):
        from_digest(d, json.load(open(a.digest)))
    name = re.sub(r"[^A-Za-z0-9_.-]+", "-", (d.get("repo") or {}).get("name", "repo"))
    out = a.out or os.path.expanduser(f"~/.strata/{name}.json")
    if not a.no_merge and os.path.exists(out) and os.path.abspath(out) != os.path.abspath(a.input):
        d = merge(json.load(open(out)), d)
    d.setdefault("repo", {}).setdefault("generated", datetime.date.today().isoformat())
    d["repo"]["levels"] = levels(d)

    errs, warns = validate(d)
    if errs:
        fail(errs)
    for w in warns:
        print("warning: " + w, file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    raw = json.dumps(d, separators=(",", ":"), ensure_ascii=False)
    with open(out, "w") as fh:
        json.dump(d, fh, indent=1, ensure_ascii=False)
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = base64.urlsafe_b64encode(co.compress(raw.encode()) + co.flush()).decode().rstrip("=")
    link = a.viewer.rstrip("#") + "#d=" + packed
    print(f"saved: {out}  ({len(raw)} bytes, levels {d['repo']['levels']})")
    if a.md:
        with open(a.md, "w") as fh:
            fh.write(render_md(d, a.link_base or (link if len(link) <= 2000 else None)))
        print(f"report: {a.md}")
    if len(link) > LINK_MAX:
        print(f"link too long ({len(link)} chars). Open {a.viewer} and drop the file in.")
    else:
        print(f"link: {link}")


if __name__ == "__main__":
    main()
