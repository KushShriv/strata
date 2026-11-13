/* Strata hand-drawn renderer: dagre for layout, rough.js for strokes, plain SVG.
   Every string reaches the DOM through textContent / setAttribute only. */
window.StrataDraw = (() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const FONT = '"Architects Daughter", "Segoe Print", "Comic Sans MS", cursive';
  const SIZE = 15;

  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    return n;
  };
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const seedOf = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 2147483646) + 1; };
  function rgba(color, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  let ctx;
  function measure(text, size = SIZE) {
    ctx = ctx || document.createElement('canvas').getContext('2d');
    ctx.font = `${size}px ${FONT}`;
    return ctx.measureText(text).width;
  }
  function fit(text, max, size = SIZE) {
    text = String(text);
    if (measure(text, size) <= max) return text;
    while (text.length > 1 && measure(text + '…', size) > max) text = text.slice(0, -1);
    return text.trimEnd() + '…';
  }
  function wrap(text, max, size = SIZE, maxLines = 2) {
    const words = String(text).split(/\s+/).filter(Boolean), lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (measure(next, size) <= max || !cur) cur = next;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = fit(lines[maxLines - 1] + ' …', max, size); }
    return lines.map(l => fit(l, max, size));
  }
  function text(parent, lines, x, y, { size = SIZE, fill, anchor = 'middle', weight } = {}) {
    const lh = size * 1.25, t = svgEl('text', { x, y: y - ((lines.length - 1) * lh) / 2, 'text-anchor': anchor, 'dominant-baseline': 'central', 'font-size': size, 'font-family': FONT, fill, 'font-weight': weight });
    lines.forEach((l, i) => { const s = svgEl('tspan', { x, dy: i ? lh : 0 }); s.textContent = l; t.append(s); });
    parent.append(t);
    return t;
  }
  function palette() {
    return { fg: css('--fg'), muted: css('--muted'), line: css('--line'), card: css('--card'), bg: css('--bg'), accent: css('--accent'), warn: css('--warn'), focus: css('--focus') };
  }
  function arrowHead(rc, p, q, color, seed, size = 11) {
    const a = Math.atan2(p.y - q.y, p.x - q.x);
    const pts = [[p.x, p.y], [p.x - size * Math.cos(a - 0.42), p.y - size * Math.sin(a - 0.42)], [p.x - size * Math.cos(a + 0.42), p.y - size * Math.sin(a + 0.42)]];
    return rc.polygon(pts, { fill: color, fillStyle: 'solid', stroke: color, strokeWidth: 1, roughness: 0.5, seed });
  }
  function downloadSVG(svg, w, h, name) {
    const c = svg.cloneNode(true), P = palette();
    c.setAttribute('xmlns', NS);
    c.setAttribute('width', w); c.setAttribute('height', h); c.setAttribute('viewBox', `0 0 ${w} ${h}`);
    c.querySelector('.vp')?.setAttribute('transform', '');
    c.querySelectorAll('.dim').forEach(n => n.classList.remove('dim'));
    c.querySelectorAll('.hit').forEach(n => n.remove());
    c.insertBefore(svgEl('rect', { width: w, height: h, fill: P.bg }), c.firstChild);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(c)], { type: 'image/svg+xml' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- node shapes ---------- */
  function drawNode(rc, g, n, box, P) {
    const { x, y, w, h } = box, seed = seedOf(n.id);
    const base = { seed, roughness: 1.15, bowing: 1.1, stroke: P.fg, strokeWidth: 1.5, fill: P.card, fillStyle: 'solid' };
    const add = node => g.append(node);
    switch (n.kind) {
      case 'store': {
        const ry = 7, x1 = x + w, y1 = y + h;
        add(rc.path(`M${x} ${y + ry} L${x} ${y1 - ry} A${w / 2} ${ry} 0 0 0 ${x1} ${y1 - ry} L${x1} ${y + ry} A${w / 2} ${ry} 0 0 0 ${x} ${y + ry} Z`, base));
        add(rc.path(`M${x} ${y + ry} A${w / 2} ${ry} 0 0 0 ${x1} ${y + ry}`, { ...base, fill: undefined }));
        break;
      }
      case 'queue': {
        add(rc.rectangle(x, y, w, h, base));
        for (let i = 1; i <= 3; i++) add(rc.line(x + w - 8 * i - 2, y + 7, x + w - 8 * i - 2, y + h - 7, { seed: seed + i, stroke: P.muted, strokeWidth: 1.2, roughness: 0.8 }));
        break;
      }
      case 'frontend': {
        add(rc.rectangle(x, y, w, h, base));
        add(rc.line(x, y + 11, x + w, y + 11, { seed: seed + 1, stroke: P.fg, strokeWidth: 1.2, roughness: 0.8 }));
        for (let i = 0; i < 3; i++) add(rc.circle(x + 8 + i * 7, y + 6, 3.5, { seed: seed + 2 + i, stroke: P.muted, strokeWidth: 1, roughness: 0.4 }));
        break;
      }
      case 'worker': {
        add(rc.rectangle(x + 6, y - 6, w, h, { ...base, stroke: P.muted, strokeWidth: 1.2, seed: seed + 7 }));
        add(rc.rectangle(x, y, w, h, base));
        break;
      }
      case 'external':
        add(rc.rectangle(x, y, w, h, { ...base, stroke: P.muted, fill: P.bg, strokeLineDash: [6, 5] }));
        break;
      case 'cli': case 'library': case 'infra': case 'job':
        add(rc.rectangle(x, y, w, h, { ...base, fill: rgba(P.accent, 0.35), fillStyle: 'hachure', hachureGap: 7, fillWeight: 0.8, hachureAngle: -41 }));
        break;
      case 'group':
        add(rc.rectangle(x, y, w, h, { ...base, stroke: P.muted, fill: rgba(P.accent, 0.06), strokeWidth: 1.2 }));
        break;
      default:
        add(rc.rectangle(x, y, w, h, base));
    }
  }
  const PAD = { store: [30, 34], queue: [52, 26], frontend: [30, 34], worker: [30, 26] };

  // Cluster frames are drawn taller than dagre's box (room for the title), so stacked
  // frames can touch. Push everything below an overlapping frame down by the gap needed.
  const frame = b => ({ x0: b.x - b.width / 2 - 8, x1: b.x + b.width / 2 + 8, y0: b.y - b.height / 2 - 34, y1: b.y + b.height / 2 + 8 });
  function separateClusters(g, clusters) {
    const ids = clusters.map(c => 'c:' + c.id).filter(id => g.node(id) && g.node(id).width);
    for (let pass = 0; pass < ids.length; pass++) {
      ids.sort((a, b) => frame(g.node(a)).y0 - frame(g.node(b)).y0);
      let moved = false;
      for (let i = 1; i < ids.length; i++) {
        const fi = frame(g.node(ids[i]));
        let need = 0;
        for (let j = 0; j < i; j++) {
          const fj = frame(g.node(ids[j]));
          if (fj.x1 > fi.x0 && fi.x1 > fj.x0) need = Math.max(need, fj.y1 + 22 - fi.y0);
        }
        if (need > 0) {
          const cut = fi.y0 + 1;
          for (const n of g.nodes()) { const v = g.node(n); if (v && v.y > cut) v.y += need; }
          for (const e of g.edges()) for (const p of g.edge(e).points) if (p.y > cut) p.y += need;
          g.graph().height += need; moved = true;
        }
      }
      if (!moved) break;
    }
  }

  /* ---------- graph ---------- */
  function graph(container, model, { onSelect, onClear, static: still = false } = {}) {
    container.replaceChildren();
    const P = palette();
    const svg = svgEl('svg', { class: 'draw', role: 'img', 'aria-label': model.title || 'Architecture diagram' });
    const vp = svgEl('g', { class: 'vp' });
    svg.append(vp); container.append(svg);
    const rc = rough.svg(svg);

    const clusterIds = new Set((model.clusters || []).map(c => c.id));
    const nodes = new Map();
    for (const n of model.nodes) {
      const [px, py] = PAD[n.kind] || [30, 26];
      const lines = wrap(n.label, 150);
      const w = Math.max(96, Math.max(...lines.map(l => measure(l))) + px);
      const h = lines.length * SIZE * 1.25 + py;
      nodes.set(n.id, { ...n, lines, w, h });
    }
    const edges = model.edges.filter(e => nodes.has(e.from) && nodes.has(e.to) && e.from !== e.to);
    // Boxes with no lines and no frame are laid out in a grid afterwards, not in one long dagre rank.
    const linked = new Set(edges.flatMap(e => [e.from, e.to]));
    const loose = [...nodes.keys()].filter(id => !linked.has(id) && !(nodes.get(id).parent && clusterIds.has(nodes.get(id).parent)));
    const packLoose = loose.length >= 3;
    function build(rankdir) {
      const gg = new dagre.graphlib.Graph({ compound: true, multigraph: true });
      gg.setGraph({ rankdir, nodesep: rankdir === 'LR' ? 80 : 64, ranksep: rankdir === 'LR' ? 90 : 80, edgesep: 20, marginx: 30, marginy: 46 });
      gg.setDefaultEdgeLabel(() => ({}));
      for (const id of clusterIds) gg.setNode('c:' + id, {});
      for (const [id, n] of nodes) {
        if (packLoose && loose.includes(id)) continue;
        gg.setNode(id, { width: n.w, height: n.h });
        if (n.parent && clusterIds.has(n.parent)) gg.setParent(id, 'c:' + n.parent);
      }
      edges.forEach(e => gg.setEdge(e.from, e.to, {}, e.id));
      dagre.layout(gg);
      separateClusters(gg, model.clusters || []);
      return gg;
    }
    // Left-to-right reads best, but sparse graphs collapse into one tall column; then go top-down.
    let g = build('LR');
    if (g.graph().height > g.graph().width * 1.4) { const tb = build('TB'); if (tb.graph().height < g.graph().height) g = tb; }
    if (packLoose) {
      const gr = g.graph(), hasMain = g.nodes().length > 0;
      const cw = Math.max(...loose.map(id => nodes.get(id).w)) + 36, ch = Math.max(...loose.map(id => nodes.get(id).h)) + 30;
      const cols = Math.max(2, Math.ceil(Math.sqrt(loose.length * 1.8)));
      const y0 = hasMain ? (gr.height || 0) : 46, x0 = 30;
      loose.forEach((id, i) => {
        const n = nodes.get(id);
        g.setNode(id, { x: x0 + (i % cols) * cw + cw / 2, y: y0 + Math.floor(i / cols) * ch + ch / 2, width: n.w, height: n.h });
      });
      gr.width = Math.max(hasMain ? gr.width : 0, x0 * 2 + Math.min(cols, loose.length) * cw);
      gr.height = y0 + Math.ceil(loose.length / cols) * ch + 30;
    }

    const layerC = svgEl('g'), layerE = svgEl('g'), layerN = svgEl('g');
    vp.append(layerC, layerE, layerN);

    for (const c of model.clusters || []) {
      const b = g.node('c:' + c.id);
      if (!b || !b.width) continue;
      const color = c.status === 'legacy' ? P.warn : c.status === 'active' ? P.accent : P.muted;
      const f = frame(b), x = f.x0, y = f.y0, w = f.x1 - f.x0, h = f.y1 - f.y0;
      const grp = svgEl('g', { class: 'cluster', 'data-id': 'sys:' + c.id });
      grp.append(rc.rectangle(x, y, w, h, { seed: seedOf(c.id), roughness: 1.6, bowing: 1.5, stroke: color, strokeWidth: 1.4, strokeLineDash: c.status === 'legacy' ? [9, 7] : undefined, fill: rgba(color, 0.07), fillStyle: 'solid' }));
      const t = text(grp, [fit(c.label, w - 110)], x + 14, y + 17, { size: 16, fill: color, anchor: 'start' });
      if (c.status) {
        const tw = measure(t.textContent, 16);
        text(grp, [c.status], x + 22 + tw, y + 18, { size: 12, fill: P.muted, anchor: 'start' });
      }
      const hit = svgEl('rect', { x, y, width: w, height: 30, fill: 'transparent', class: 'hit' });
      grp.append(hit);
      layerC.append(grp);
    }

    for (const e of edges) {
      const pts = g.edge(e.from, e.to, e.id).points;
      const color = e.color || P.muted, seed = seedOf(e.id);
      const grp = svgEl('g', { class: 'edge', 'data-id': e.id, 'data-from': e.from, 'data-to': e.to });
      const opts = { stroke: color, strokeWidth: e.width || 1.6, roughness: 0.9, bowing: 0.6, seed, strokeLineDash: e.dashed ? [7, 6] : undefined };
      grp.append(pts.length > 2 ? rc.curve(pts.map(p => [p.x, p.y]), opts) : rc.line(pts[0].x, pts[0].y, pts[1].x, pts[1].y, opts));
      grp.append(arrowHead(rc, pts[pts.length - 1], pts[pts.length - 2], color, seed + 3));
      const hit = svgEl('path', { d: 'M' + pts.map(p => `${p.x} ${p.y}`).join(' L'), class: 'hit', fill: 'none', stroke: 'transparent', 'stroke-width': 14 });
      if (e.title) { const tt = svgEl('title'); tt.textContent = e.title; hit.append(tt); }
      grp.append(hit);
      layerE.append(grp);
    }

    for (const [id, n] of nodes) {
      const b = g.node(id), box = { x: b.x - n.w / 2, y: b.y - n.h / 2, w: n.w, h: n.h };
      const grp = svgEl('g', { class: 'node', 'data-id': id, tabindex: 0, role: 'button', 'aria-label': n.label });
      drawNode(rc, grp, n, box, P);
      const dy = n.kind === 'store' ? 5 : n.kind === 'frontend' ? 6 : 0, dx = n.kind === 'queue' ? -12 : 0;
      text(grp, n.lines, b.x + dx, b.y + dy, { fill: P.fg });
      grp.append(svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h, fill: 'transparent', class: 'hit' }));
      layerN.append(grp);
    }

    /* select + dim */
    function select(id) {
      const keep = new Set([id]);
      for (const e of edges) if (e.from === id || e.to === id) { keep.add(e.from); keep.add(e.to); keep.add(e.id); }
      if (!nodes.has(id)) for (const e of edges) if (e.id === id) { keep.add(e.from); keep.add(e.to); }
      svg.querySelectorAll('.node, .edge').forEach(el => el.classList.toggle('dim', !keep.has(el.dataset.id)));
      svg.querySelectorAll('.sel').forEach(el => el.classList.remove('sel'));
      svg.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('sel');
    }
    function clear() { svg.querySelectorAll('.dim, .sel').forEach(el => el.classList.remove('dim', 'sel')); }

    /* pan + zoom */
    const W = g.graph().width || 1, H = g.graph().height || 1;
    let k = 1, tx = 0, ty = 0;
    const apply = () => vp.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`);
    function fitView() {
      const r = svg.getBoundingClientRect();
      const legend = container.parentElement?.querySelector('.legend');
      const bottom = still ? 0 : (legend ? legend.offsetHeight + 16 : 0), right = still ? 0 : 50;
      const aw = r.width - right, ah = r.height - bottom;
      k = Math.min(aw / W, ah / H, 1.3) * 0.96 || 1;
      tx = (aw - W * k) / 2; ty = (ah - H * k) / 2; apply();
    }
    function zoomAt(f, cx, cy) {
      const nk = Math.min(4, Math.max(0.2, k * f));
      tx = cx - (cx - tx) * (nk / k); ty = cy - (cy - ty) * (nk / k); k = nk; apply();
    }
    if (still) { svg.classList.add('still'); requestAnimationFrame(fitView); return { fit: fitView, select() {}, clear() {}, zoom() {}, exportSVG() {} }; }
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    const ptrs = new Map(); let moved = 0, pinch = null;
    svg.addEventListener('pointerdown', e => { ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); } });
    svg.addEventListener('pointermove', e => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2 && pinch) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), r = svg.getBoundingClientRect();
        zoomAt(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); pinch = d; moved += 10; return;
      }
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 4) { if (!svg.hasPointerCapture(e.pointerId)) svg.setPointerCapture(e.pointerId); tx += dx; ty += dy; apply(); svg.classList.add('panning'); }
    });
    const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; svg.classList.remove('panning'); };
    svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
    svg.addEventListener('click', e => {
      if (moved > 4) return;
      const t = e.target.closest('.node, .edge, .cluster');
      if (!t) { clear(); onClear && onClear(); return; }
      const id = t.dataset.id;
      if (!t.classList.contains('cluster')) select(id); else clear();
      onSelect && onSelect(id, t.classList.contains('node') ? 'node' : t.classList.contains('edge') ? 'edge' : 'cluster');
    });
    svg.addEventListener('keydown', e => {
      const t = e.target.closest?.('.node');
      if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(t.dataset.id); onSelect && onSelect(t.dataset.id, 'node'); }
    });
    requestAnimationFrame(fitView);
    return {
      fit: fitView, select, clear,
      zoom: f => { const r = svg.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); },
      exportSVG: name => downloadSVG(svg, Math.ceil(W), Math.ceil(H), name),
    };
  }

  /* ---------- sequence ---------- */
  function sequence(container, model) {
    container.replaceChildren();
    const P = palette();
    const parts = model.participants;
    const labelW = Math.max(...parts.map(p => Math.max(...wrap(p.label, 140).map(l => measure(l)))));
    const col = Math.max(150, Math.min(210, labelW + 44));
    const left = 24, top = 18, headH = 52, row = 54, first = top + headH + 40;
    const steps = model.steps;
    const W = left * 2 + col * parts.length + 60, H = first + steps.length * row + 10;
    const svg = svgEl('svg', { class: 'draw seqsvg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': model.title || 'Sequence diagram' });
    const vp = svgEl('g', { class: 'vp' }); svg.append(vp);
    container.append(svg);
    const rc = rough.svg(svg);
    const X = new Map(parts.map((p, i) => [p.id, left + col * i + col / 2]));

    parts.forEach((p, i) => {
      const cx = X.get(p.id), seed = seedOf(p.id);
      vp.append(rc.line(cx, top + headH, cx, H - 8, { stroke: P.line, strokeWidth: 1.4, strokeLineDash: [5, 6], roughness: 0.7, seed }));
      vp.append(rc.rectangle(cx - col / 2 + 10, top, col - 20, headH, { stroke: P.fg, strokeWidth: 1.5, fill: P.card, fillStyle: 'solid', roughness: 1.1, seed: seed + 1 }));
      text(vp, wrap(p.label, col - 36, 14), cx, top + headH / 2, { size: 14, fill: P.fg });
    });

    steps.forEach((s, i) => {
      const y = first + i * row, x1 = X.get(s.from), x2 = X.get(s.to), seed = seedOf(i + s.from + s.to);
      const color = s.reply ? P.muted : P.fg;
      const opts = { stroke: color, strokeWidth: 1.5, roughness: 0.9, bowing: 0.8, seed, strokeLineDash: s.reply ? [6, 5] : undefined };
      let labelX, labelMax, anchor = 'middle';
      if (x1 === x2) {
        const loop = 40;
        vp.append(rc.path(`M${x1} ${y - 10} C${x1 + loop} ${y - 14} ${x1 + loop} ${y + 14} ${x1 + 4} ${y + 10}`, opts));
        vp.append(arrowHead(rc, { x: x1 + 2, y: y + 10 }, { x: x1 + 14, y: y + 11 }, color, seed + 2, 9));
        labelX = x1 + loop + 8; labelMax = col - loop - 6; anchor = 'start';
        text(vp, [fit(s.text, labelMax, 13)], labelX, y, { size: 13, fill: P.fg, anchor });
      } else {
        vp.append(rc.line(x1, y, x2 - Math.sign(x2 - x1) * 2, y, opts));
        vp.append(arrowHead(rc, { x: x2, y }, { x: x1, y }, color, seed + 2, 10));
        labelX = (x1 + x2) / 2; labelMax = Math.abs(x2 - x1) - 34;
        text(vp, [fit(s.text, labelMax, 13)], labelX, y - 13, { size: 13, fill: P.fg });
      }
      vp.append(rc.circle(x1, y, 19, { fill: P.accent, fillStyle: 'solid', stroke: P.accent, roughness: 0.6, seed: seed + 5 }));
      text(vp, [String(i + 1)], x1, y + 0.5, { size: 11, fill: P.bg, weight: 700 });
      const hit = svgEl('rect', { x: Math.min(x1, x2) - 10, y: y - 26, width: Math.abs(x2 - x1) + (x1 === x2 ? col : 20), height: 36, fill: 'transparent', class: 'hit' });
      const tt = svgEl('title'); tt.textContent = `${i + 1}. ${s.text}`; hit.append(tt); vp.append(hit);
    });
    return { exportSVG: name => downloadSVG(svg, W, H, name) };
  }

  /* tiny legend glyphs */
  function glyph(kind, color) {
    const svg = svgEl('svg', { width: 30, height: 18, viewBox: '0 0 30 18', 'aria-hidden': 'true' });
    const rc = rough.svg(svg), P = palette();
    if (kind === 'edge') svg.append(rc.line(2, 9, 28, 9, { stroke: color, strokeWidth: 2, roughness: 1, seed: 3 }));
    else if (kind === 'dashed') svg.append(rc.line(2, 9, 28, 9, { stroke: color, strokeWidth: 2, roughness: 1, seed: 3, strokeLineDash: [5, 4] }));
    else drawNode(rc, svg, { id: kind, kind }, kind === 'store' ? { x: 6, y: 1, w: 18, h: 16 } : { x: 3, y: 3, w: 24, h: 13 }, P);
    return svg;
  }

  async function ready() {
    try { await Promise.race([document.fonts.load(`${SIZE}px "Architects Daughter"`), new Promise(r => setTimeout(r, 1500))]); } catch { /* fall back */ }
  }

  return { graph, sequence, glyph, ready };
})();
