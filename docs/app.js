/* Strata viewer. All input is untrusted: text goes in via textContent,
   markdown goes through DOMPurify, mermaid runs with securityLevel "strict". */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const LEVELS = [0, 1, 2, 3, 4];
  const MAX_BYTES = 8 * 1024 * 1024;
  let data = null, level = 1, cy = null, flowIdx = 0, diveIdx = 0, rawJson = '';

  if (window.cytoscape && window.cytoscapeDagre) cytoscape.use(cytoscapeDagre);
  // Raw HTML in markdown is shown as text, never parsed. DOMPurify stays as a second layer.
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (window.marked) marked.use({ renderer: { html: h => escHtml(typeof h === 'object' ? h.text : h) } });
  if (window.mermaid) mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default', sequence: { useMaxWidth: true, mirrorActors: false } });

  /* ---------- helpers ---------- */
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  const arr = v => Array.isArray(v) ? v : [];
  const str = v => (v == null ? '' : String(v));
  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200); }
  function showError(msg) { const e = $('err'); e.textContent = msg; e.hidden = false; }

  // Evidence "path:line" -> GitHub blob link when repo.url is a plain github.com repo.
  function evidence(ev) {
    const s = str(ev);
    const m = /^(.+?)(?::L?(\d+)(?:-L?(\d+))?)?$/.exec(s);
    const url = str(data?.repo?.url).replace(/\/+$/, '');
    const ok = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url) && m && !m[1].includes('..') && !/^\w+:/.test(m[1]);
    if (!ok) return el('span', { class: 'ev', text: s });
    const ref = encodeURIComponent(str(data.repo.commit) || 'HEAD');
    const path = m[1].split('/').map(encodeURIComponent).join('/');
    const anchor = m[2] ? `#L${m[2]}${m[3] ? '-L' + m[3] : ''}` : '';
    return el('a', { class: 'ev', href: `${url}/blob/${ref}/${path}${anchor}`, target: '_blank', rel: 'noopener noreferrer', text: s });
  }

  /* ---------- loading ---------- */
  function b64urlToBytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
  }
  function bytesToB64url(b) {
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error('Decoded data is too large');
    return new TextDecoder().decode(buf);
  }
  async function deflate(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function validate(d) {
    const errs = [];
    if (!d || typeof d !== 'object' || Array.isArray(d)) return ['Not a JSON object'];
    if (d.schema !== 'strata/1') errs.push('schema must be "strata/1"');
    if (!d.repo || !d.repo.name) errs.push('repo.name is missing');
    if (!d.l0 || !d.l0.summary) errs.push('l0.summary is missing');
    return errs;
  }

  function load(text, { fromHash = false } = {}) {
    let d;
    try { d = JSON.parse(text); } catch (e) { return showError('That is not valid JSON: ' + e.message); }
    const errs = validate(d);
    if (errs.length) return showError('Not a Strata file:\n• ' + errs.join('\n• '));
    data = d; rawJson = text;
    if (!fromHash) history.replaceState(null, '', location.pathname + location.search);
    $('err').hidden = true; $('empty').hidden = true; $('app').hidden = false;
    for (const id of ['repo', 'levels', 'actions']) $(id).hidden = false;
    renderHeader();
    const avail = available();
    const q = new URLSearchParams(location.search).get('level');
    const want = q === null ? NaN : Number(q);
    setLevel(avail.includes(want) ? want : avail.includes(1) ? 1 : 0);
  }

  async function boot() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const map = new URLSearchParams(location.search).get('map');
    let src = new URLSearchParams(location.search).get('src');
    if (map) { if (!/^[a-z0-9-]+$/.test(map)) return showError('Unknown map name'); src = `examples/${map}.json`; }
    try {
      if (hash.get('d')) return load(await inflate(b64urlToBytes(hash.get('d'))), { fromHash: true });
      if (src) {
        const u = new URL(src, location.href);
        if (u.protocol !== 'https:' && u.origin !== location.origin) throw new Error('Only https sources are allowed');
        const r = await fetch(u, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!r.ok) throw new Error(`Could not fetch ${u} (${r.status})`);
        return load(await r.text(), { fromHash: true });
      }
    } catch (e) { showError(e.message); }
  }

  /* ---------- header ---------- */
  function available() {
    const lv = arr(data.repo.levels).filter(n => LEVELS.includes(n));
    if (lv.length) return lv;
    const has = [true, data.components, data.modules, data.flows, data.deep_dives].map(x => x === true || arr(x).length > 0);
    return LEVELS.filter(n => has[n]);
  }
  function renderHeader() {
    const a = $('repo-name'); a.textContent = data.repo.name;
    const url = str(data.repo.url);
    if (/^https:\/\//.test(url)) a.href = url; else a.removeAttribute('href');
    $('repo-meta').textContent = [data.repo.commit && '@' + data.repo.commit, data.repo.generated].filter(Boolean).join(' · ');
    const c = data.confidence, conf = $('conf');
    if (c && c.score != null) {
      const s = Number(c.score);
      conf.textContent = `${c.label || (s >= 80 ? 'High' : s >= 50 ? 'Med' : 'Low')} ${s}`;
      conf.className = 'conf ' + (s >= 80 ? 'high' : s >= 50 ? 'med' : 'low');
      conf.title = str(c.basis);
      conf.hidden = false;
    } else conf.hidden = true;
    const avail = available();
    for (const b of $('levels').querySelectorAll('button')) {
      const l = Number(b.dataset.l);
      b.disabled = !avail.includes(l);
      b.title = b.disabled ? `Level ${l} not in this file — run /strata --level ${l}` : b.title;
    }
    document.title = `${data.repo.name} — Strata`;
  }

  function setLevel(l) {
    level = l;
    for (const b of $('levels').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.l) === l);
    for (const v of document.querySelectorAll('.view')) v.hidden = true;
    $('btn-png').hidden = !(l === 1 || l === 2);
    const q = new URLSearchParams(location.search); q.set('level', l);
    history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
    if (!available().includes(l)) return renderMissing(l);
    if (l === 0) renderL0();
    else if (l === 1) renderGraph(1);
    else if (l === 2) renderGraph(2);
    else if (l === 3) renderFlows();
    else renderDives();
  }

  /* ---------- panel ---------- */
  function panelDefault() {
    const p = $('panel'); p.replaceChildren();
    const names = ['Overview', 'System map', 'Module graph', 'Flows', 'Deep dives'];
    p.append(el('h2', { text: names[level] }));
    const tips = ['What it is and how it is built.', 'Runtime parts and how they talk. Click a box or a line.', 'Code modules, grouped by the component that owns them. Line width = cross-module references.', 'Key paths through the system, step by step.', 'Symbol-level notes on one area.'];
    p.append(el('p', { class: 'muted', text: tips[level] }));
    if (data.confidence) {
      p.append(el('h4', { text: 'Confidence' }), el('p', {}, el('strong', { text: `${str(data.confidence.label)} ${str(data.confidence.score)}`.trim() + ' ' }), str(data.confidence.basis)));
    }
    if (arr(data.blind_spots).length) p.append(el('h4', { text: 'Not visible from code' }), el('ul', {}, data.blind_spots.map(s => el('li', { text: s }))));
    if (arr(data.next_zoom).length) p.append(el('h4', { text: 'Next zoom' }), el('ul', {}, data.next_zoom.map(s => el('li', { text: s }))));
  }
  const comp = id => arr(data.components).find(c => c.id === id);
  const mod = id => arr(data.modules).find(m => m.id === id);
  const sys = id => arr(data.systems).find(s => s.id === id);
  const nameOf = id => comp(id)?.name || mod(id)?.name || id;

  function kv(pairs) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of pairs) if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) dl.append(el('dt', { text: k }), el('dd', {}, v));
    return dl;
  }
  function evList(list) { return el('ul', { class: 'plain' }, arr(list).map(e => el('li', {}, evidence(e)))); }

  function panelComponent(c) {
    const p = $('panel'); p.replaceChildren();
    const s = sys(c.system);
    p.append(el('div', {}, el('span', { class: 'tag', text: str(c.kind || 'component') }), s ? el('span', { class: 'pill ' + (s.status || 'unknown'), text: s.name }) : null));
    p.append(el('h2', { text: c.name || c.id }));
    if (c.summary) p.append(el('p', { text: c.summary }));
    p.append(kv([['Tech', str(c.tech)], ['Entry', c.entry ? evidence(c.entry) : ''], ['Paths', arr(c.paths).join(', ')]]));
    const out = arr(data.links).filter(l => l.from === c.id), inc = arr(data.links).filter(l => l.to === c.id);
    const row = (l, other) => el('li', { class: 'linkrow' }, el('span', { class: 'tag', text: str(l.protocol || 'link') }), el('span', {}, `${nameOf(other)}${l.label ? ' — ' + l.label : ''}`), l.inferred ? el('span', { class: 'inferred', text: 'inferred' }) : null);
    if (out.length) p.append(el('h4', { text: 'Calls / writes' }), el('ul', { class: 'plain' }, out.map(l => row(l, l.to))));
    if (inc.length) p.append(el('h4', { text: 'Called by' }), el('ul', { class: 'plain' }, inc.map(l => row(l, l.from))));
    if (arr(c.evidence).length) p.append(el('h4', { text: 'Evidence' }), evList(c.evidence));
    const mods = arr(data.modules).filter(m => m.component === c.id);
    if (mods.length) p.append(el('h4', { text: `Modules (${mods.length})` }), el('ul', { class: 'plain' }, mods.map(m => el('li', { class: 'mono', text: m.name }))));
  }
  function panelSystem(s) {
    const p = $('panel'); p.replaceChildren();
    p.append(el('span', { class: 'pill ' + (s.status || 'unknown'), text: s.status || 'unknown' }), el('h2', { text: s.name }));
    if (s.summary) p.append(el('p', { text: s.summary }));
    p.append(kv([['Launcher', str(s.launcher)], ['Status basis', str(s.status_basis)]]));
    const cs = arr(data.components).filter(c => c.system === s.id);
    if (cs.length) p.append(el('h4', { text: 'Components' }), el('ul', { class: 'plain' }, cs.map(c => el('li', {}, el('a', { href: '#', onclick: e => { e.preventDefault(); select(c.id); }, text: c.name })))));
  }
  function panelModule(m) {
    const p = $('panel'); p.replaceChildren();
    p.append(el('span', { class: 'tag', text: 'module' }), el('h2', { class: 'mono', text: m.name || m.id }));
    if (m.summary) p.append(el('p', { text: m.summary }));
    p.append(kv([['Component', m.component ? nameOf(m.component) : ''], ['Symbols', m.symbols], ['Fan in', m.fan_in], ['Fan out', m.fan_out]]));
    if (arr(m.key_symbols).length) p.append(el('h4', { text: 'Key symbols' }), el('ul', { class: 'plain' }, m.key_symbols.map(k => el('li', { class: 'ev', text: k }))));
    const out = arr(data.module_links).filter(l => l.from === m.id), inc = arr(data.module_links).filter(l => l.to === m.id);
    if (out.length) p.append(el('h4', { text: 'Depends on' }), el('ul', { class: 'plain' }, out.map(l => el('li', { class: 'mono', text: `${l.to}  ×${l.weight}` }))));
    if (inc.length) p.append(el('h4', { text: 'Used by' }), el('ul', { class: 'plain' }, inc.map(l => el('li', { class: 'mono', text: `${l.from}  ×${l.weight}` }))));
  }
  function panelLink(l, isModule) {
    const p = $('panel'); p.replaceChildren();
    p.append(el('span', { class: 'tag', text: isModule ? 'module dependency' : str(l.protocol || 'link') }), el('h2', { text: `${nameOf(l.from)} → ${nameOf(l.to)}` }));
    if (l.label) p.append(el('p', { text: l.label }));
    if (isModule) p.append(el('p', { class: 'muted', text: `${l.weight} cross-module references` }));
    if (l.inferred) p.append(el('p', { class: 'inferred', text: 'Inferred — no direct evidence in code.' }));
    if (arr(l.evidence).length) p.append(el('h4', { text: 'Evidence' }), evList(l.evidence));
  }

  /* ---------- L0 ---------- */
  function renderL0() {
    const v = $('view-0'); v.hidden = false; v.replaceChildren();
    const l0 = data.l0;
    if (l0.shape) v.append(el('p', { class: 'shape', text: l0.shape }));
    v.append(el('p', { class: 'summary', text: l0.summary }));
    if (arr(l0.stack).length) v.append(el('div', { class: 'chips' }, l0.stack.map(s => el('span', { class: 'chip', text: s }))));
    const cards = el('div', { class: 'cards' });
    const langs = arr(data.repo.languages);
    if (langs.length) {
      const total = langs.reduce((a, l) => a + (Number(l.lines) || 0), 0) || 1;
      const pal = ['--http', '--active', '--legacy', '--alternative', '--db', '--queue', '--rpc', '--unknown'];
      const bar = el('div', { class: 'langbar' }), list = el('ul');
      langs.forEach((l, i) => {
        const pct = (Number(l.lines) || 0) / total * 100, color = css(pal[i % pal.length]);
        bar.append(Object.assign(el('i'), { style: `width:${pct}%;background:${color}` }));
        list.append(el('li', { class: 'legend-row' }, Object.assign(el('span', { class: 'dot' }), { style: `background:${color}` }), `${l.lang}`, el('span', { class: 'muted', text: ` ${l.files} files · ${l.lines} lines` })));
      });
      cards.append(el('div', { class: 'card' }, el('h3', { text: 'Languages' }), bar, list));
    }
    if (arr(data.systems).length) cards.append(el('div', { class: 'card' }, el('h3', { text: 'Systems' }), el('ul', {}, data.systems.map(s => el('li', {}, el('div', {}, el('strong', { text: s.name + ' ' }), el('span', { class: 'pill ' + (s.status || 'unknown'), text: s.status || 'unknown' })), s.summary ? el('div', { class: 'muted', text: s.summary }) : null)))));
    if (arr(l0.entry_points).length) cards.append(el('div', { class: 'card' }, el('h3', { text: 'Entry points' }), el('ul', {}, l0.entry_points.map(e => el('li', {}, evidence(e.path), e.role ? el('div', { class: 'muted', text: e.role }) : null)))));
    if (cards.children.length) v.append(cards);
    panelDefault();
  }

  /* ---------- L1 / L2 graph ---------- */
  const SHAPES = { store: 'barrel', queue: 'tag', external: 'hexagon', frontend: 'round-rectangle', infra: 'cut-rectangle', library: 'rectangle', cli: 'round-tag', job: 'round-octagon', worker: 'round-rectangle', service: 'round-rectangle' };
  function elementsL1() {
    const els = [];
    for (const s of arr(data.systems)) els.push({ data: { id: 'sys:' + s.id, label: s.name, kind: 'system', status: s.status || 'unknown' } });
    for (const c of arr(data.components)) {
      els.push({ data: { id: c.id, label: c.name + (c.tech ? '\n' + c.tech : ''), kind: c.kind || 'service', parent: c.system && sys(c.system) ? 'sys:' + c.system : undefined } });
    }
    const ids = new Set(arr(data.components).map(c => c.id));
    arr(data.links).forEach((l, i) => {
      if (!ids.has(l.from) || !ids.has(l.to)) return;
      els.push({ data: { id: 'l' + i, source: l.from, target: l.to, idx: i, label: clip(str(l.label || l.protocol), 30), protocol: str(l.protocol || 'other'), inferred: l.inferred ? 1 : 0 } });
    });
    return els;
  }
  function elementsL2() {
    const els = [], used = new Set(arr(data.modules).map(m => m.component).filter(Boolean));
    for (const c of arr(data.components)) if (used.has(c.id)) els.push({ data: { id: 'c:' + c.id, label: c.name, kind: 'group' } });
    const ids = new Set();
    for (const m of arr(data.modules)) { ids.add(m.id); els.push({ data: { id: 'm:' + m.id, mid: m.id, label: m.name, kind: 'module', size: Number(m.symbols) || 1, parent: m.component && used.has(m.component) ? 'c:' + m.component : undefined } }); }
    const maxW = Math.max(1, ...arr(data.module_links).map(l => Number(l.weight) || 1));
    arr(data.module_links).forEach((l, i) => {
      if (!ids.has(l.from) || !ids.has(l.to)) return;
      els.push({ data: { id: 'ml' + i, idx: i, source: 'm:' + l.from, target: 'm:' + l.to, w: 1 + 5 * (Number(l.weight) || 1) / maxW, label: String(l.weight ?? '') } });
    });
    return els;
  }
  function graphStyle() {
    const c = n => css(n);
    const proto = ['http', 'queue', 'db', 'storage', 'exec', 'rpc', 'import', 'other'];
    return [
      { selector: 'node', style: { 'label': 'data(label)', 'text-wrap': 'wrap', 'text-max-width': 150, 'font-family': 'Inter, sans-serif', 'font-size': 13, 'color': c('--text'), 'text-valign': 'center', 'text-halign': 'center', 'background-color': c('--surface'), 'border-width': 1.5, 'border-color': c('--line'), 'shape': 'round-rectangle', 'width': 'label', 'height': 'label', 'padding': 12 } },
      ...Object.entries(SHAPES).map(([k, s]) => ({ selector: `node[kind = "${k}"]`, style: { shape: s } })),
      { selector: 'node[kind = "frontend"]', style: { 'border-color': c('--http') } },
      { selector: 'node[kind = "store"], node[kind = "queue"]', style: { 'background-color': c('--surface-2'), 'border-color': c('--db') } },
      { selector: 'node[kind = "external"]', style: { 'border-style': 'dashed' } },
      { selector: 'node[kind = "module"]', style: { 'font-family': 'JetBrains Mono, monospace', 'font-size': 11, 'padding': 9 } },
      { selector: ':parent', style: { 'text-valign': 'top', 'text-halign': 'center', 'font-weight': 600, 'font-size': 13, 'text-margin-y': -6, 'background-opacity': .55, 'background-color': c('--surface-2'), 'border-style': 'solid', 'border-width': 1.5, 'padding': 22, 'shape': 'round-rectangle', 'color': c('--muted') } },
      ...['active', 'legacy', 'alternative', 'unknown'].map(s => ({ selector: `node[kind = "system"][status = "${s}"]`, style: { 'border-color': c('--' + s), 'color': c('--' + s) } })),
      { selector: 'node[kind = "system"][status = "legacy"]', style: { 'border-style': 'dashed' } },
      { selector: 'edge', style: { 'width': 'data(w)', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': .9, 'line-color': c('--import'), 'target-arrow-color': c('--import'), 'label': 'data(label)', 'font-size': 10, 'color': c('--muted'), 'text-background-color': c('--bg'), 'text-background-opacity': .9, 'text-background-padding': 2, 'text-rotation': 'autorotate', 'font-family': 'JetBrains Mono, monospace' } },
      { selector: 'edge[!w]', style: { 'width': 1.8 } },
      ...proto.map(p => ({ selector: `edge[protocol = "${p}"]`, style: { 'line-color': c('--' + p), 'target-arrow-color': c('--' + p) } })),
      { selector: 'edge[inferred = 1]', style: { 'line-style': 'dashed' } },
      { selector: ':selected', style: { 'border-color': c('--accent'), 'border-width': 3, 'line-color': c('--accent'), 'target-arrow-color': c('--accent') } },
      { selector: '.faded', style: { 'opacity': .18 } },
    ];
  }
  function renderGraph(l) {
    const v = $('view-graph'); v.hidden = false;
    if (cy) { cy.destroy(); cy = null; }
    const elements = l === 1 ? elementsL1() : elementsL2();
    $('graph-hint').textContent = 'Scroll to zoom · drag to pan · click for details';
    cy = cytoscape({ container: $('cy'), elements, style: graphStyle(), minZoom: .15, maxZoom: 3,
      layout: { name: window.cytoscapeDagre ? 'dagre' : 'cose', rankDir: 'LR', nodeSep: 40, rankSep: 110, edgeSep: 16, padding: 30, spacingFactor: 1.05, nodeDimensionsIncludeLabels: true, animate: false } });
    cy.on('tap', 'node', e => {
      const d = e.target.data();
      focus(e.target);
      if (d.kind === 'system') panelSystem(sys(d.id.slice(4)));
      else if (d.kind === 'group') panelComponent(comp(d.id.slice(2)));
      else if (d.kind === 'module') panelModule(mod(d.mid));
      else panelComponent(comp(d.id));
    });
    cy.on('tap', 'edge', e => { const d = e.target.data(); focus(e.target); panelLink(l === 1 ? data.links[d.idx] : data.module_links[d.idx], l === 2); });
    cy.on('tap', e => { if (e.target === cy) { cy.elements().removeClass('faded'); panelDefault(); } });
    renderLegend(l);
    panelDefault();
  }
  function focus(t) {
    cy.elements().addClass('faded');
    const keep = t.isNode() ? t.closedNeighborhood().union(t.ancestors()).union(t.descendants()) : t.connectedNodes().union(t);
    keep.union(keep.ancestors ? keep.ancestors() : []).removeClass('faded');
    cy.nodes(':parent').removeClass('faded');
  }
  function renderLegend(l) {
    const lg = $('legend'); lg.replaceChildren();
    if (l === 2) { lg.append(el('span', { class: 'muted', text: 'Boxes = components · line width = references' })); return; }
    const used = new Set(arr(data.links).map(x => x.protocol || 'other'));
    for (const p of used) { const i = el('i'); i.style.background = css('--' + (p in { http: 1, queue: 1, db: 1, storage: 1, exec: 1, rpc: 1, import: 1 } ? p : 'other')); lg.append(el('span', {}, i, p)); }
    if (arr(data.links).some(x => x.inferred)) lg.append(el('span', { class: 'muted', text: '- - inferred' }));
  }
  function select(id) {
    if (level !== 1) setLevel(1);
    const n = cy && cy.getElementById(id);
    if (n && n.length) { cy.elements().unselect(); n.select(); focus(n); cy.animate({ center: { eles: n } }, { duration: 250 }); }
    const c = comp(id); if (c) panelComponent(c);
  }

  /* ---------- L3 flows ---------- */
  const mmd = s => str(s).replace(/[\r\n]+/g, ' ').replace(/[;#<>{}%`]/g, ' ').replace(/-->>|->>|--|>>/g, '–').trim() || ' ';
  function renderFlows() {
    const v = $('view-3'); v.hidden = false;
    const flows = arr(data.flows), list = $('flow-list'); list.replaceChildren();
    flowIdx = Math.min(flowIdx, flows.length - 1);
    flows.forEach((f, i) => list.append(el('button', { class: i === flowIdx ? 'on' : '', onclick: () => { flowIdx = i; renderFlows(); } }, f.name || f.id, f.trigger ? el('small', { text: f.trigger }) : null)));
    drawFlow(flows[flowIdx]);
    panelDefault();
    const f = flows[flowIdx], p = $('panel');
    if (f) { p.prepend(el('h2', { text: f.name || f.id }), el('p', { class: 'muted', text: [f.trigger, f.system && sys(f.system)?.name].filter(Boolean).join(' · ') })); p.querySelector('h2:nth-of-type(2)')?.remove(); }
  }
  async function drawFlow(f) {
    const seq = $('seq'), tbl = $('steps'); seq.replaceChildren(); tbl.replaceChildren();
    if (!f) return;
    const parts = [], alias = new Map();
    for (const s of arr(f.steps)) for (const p of [s.from, s.to]) if (!alias.has(p)) { alias.set(p, 'P' + alias.size); parts.push(p); }
    const lines = ['sequenceDiagram', 'autonumber'];
    for (const p of parts) lines.push(`participant ${alias.get(p)} as ${mmd(nameOf(p))}`);
    for (const s of arr(f.steps)) lines.push(`${alias.get(s.from)}${s.reply ? '-->>' : '->>'}${alias.get(s.to)}: ${mmd(s.action)}`);
    try {
      const { svg } = await mermaid.render('seq' + Date.now(), lines.join('\n'));
      seq.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'] });
    } catch (e) { seq.append(el('p', { class: 'err', text: 'Could not draw this flow: ' + e.message })); }
    tbl.append(el('tr', {}, el('th', { text: '#' }), el('th', { text: 'From → To' }), el('th', { text: 'Action' }), el('th', { text: 'Evidence' })));
    arr(f.steps).forEach((s, i) => tbl.append(el('tr', {}, el('td', { class: 'n', text: i + 1 }), el('td', { text: `${nameOf(s.from)} → ${nameOf(s.to)}` }), el('td', { text: str(s.action) }), el('td', {}, s.evidence ? evidence(s.evidence) : el('span', { class: 'inferred', text: 'inferred' })))));
  }

  /* ---------- L4 dives ---------- */
  function renderDives() {
    const v = $('view-4'); v.hidden = false;
    const dives = arr(data.deep_dives), list = $('dive-list'); list.replaceChildren();
    diveIdx = Math.min(diveIdx, dives.length - 1);
    dives.forEach((d, i) => list.append(el('button', { class: i === diveIdx ? 'on' : '', onclick: () => { diveIdx = i; renderDives(); } }, d.title || d.id, d.target ? el('small', { text: nameOf(d.target) }) : null)));
    const d = dives[diveIdx], art = $('dive');
    const html = d ? marked.parse(str(d.markdown), { mangle: false, headerIds: false }) : '';
    art.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] });
    for (const a of art.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    panelDefault();
  }

  function renderMissing(l) {
    const v = $('view-missing'); v.hidden = false; v.replaceChildren();
    v.append(el('div', { class: 'box' }, el('h2', { text: `Level ${l} is not in this file yet` }), el('p', { class: 'muted', text: 'Run the skill again at this level. The pack step merges it into the same file.' }), el('code', { text: `/strata ${data.repo.name} --level ${l}` })));
    panelDefault();
  }

  /* ---------- actions ---------- */
  async function share() {
    try {
      let url = location.href;
      if (!new URLSearchParams(location.hash.slice(1)).get('d')) {
        url = `${location.origin}${location.pathname}?level=${level}#d=${bytesToB64url(await deflate(rawJson))}`;
        if (url.length > 60000) return toast('Too large for a link — share the JSON file instead');
      }
      await navigator.clipboard.writeText(url);
      toast('Link copied — the map is inside the link, not on a server');
    } catch (e) { toast('Could not copy: ' + e.message); }
  }
  function png() {
    if (!cy) return;
    const a = el('a', { href: cy.png({ full: true, scale: 2, bg: css('--bg') }), download: `${data.repo.name}-L${level}.png` });
    document.body.append(a); a.click(); a.remove();
  }
  function reset() {
    data = null; if (cy) { cy.destroy(); cy = null; }
    history.replaceState(null, '', location.pathname);
    $('app').hidden = true; $('empty').hidden = false;
    for (const id of ['repo', 'levels', 'actions']) $(id).hidden = true;
    document.title = 'Strata — Architecture Viewer';
  }
  function readFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) return showError('File is larger than 8 MB');
    file.text().then(t => load(t));
  }

  $('levels').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) setLevel(Number(b.dataset.l)); });
  $('btn-share').onclick = share;
  $('btn-png').onclick = png;
  $('btn-open').onclick = reset;
  $('file').onchange = e => readFile(e.target.files[0]);
  $('btn-paste').onclick = () => { $('paste-box').hidden = false; $('paste').focus(); };
  $('btn-paste-go').onclick = () => load($('paste').value);
  async function gallery() {
    try {
      const list = await (await fetch('examples/index.json')).json();
      const g = $('gallery');
      for (const m of arr(list)) {
        if (!/^[a-z0-9-]+$/.test(str(m.map))) continue;
        g.append(el('a', { class: 'gcard', href: `?map=${m.map}` },
          el('strong', { text: m.title }), el('span', { class: 'muted', text: m.blurb }),
          el('span', { class: 'chips' }, arr(m.tags).map(t => el('span', { class: 'chip', text: t })))));
      }
    } catch { $('gallery').closest('section').hidden = true; }
  }
  gallery();
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', e => { if ($('empty').hidden) reset(); readFile(e.dataTransfer.files[0]); });
  document.addEventListener('keydown', e => {
    if (!data || e.target.closest('input, textarea') || e.metaKey || e.ctrlKey) return;
    const n = Number(e.key);
    if (LEVELS.includes(n) && available().includes(n) && e.key !== ' ') setLevel(n);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (window.mermaid) mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default' });
    if (data) setLevel(level);
  });
  window.addEventListener('hashchange', () => { if (new URLSearchParams(location.hash.slice(1)).get('d')) boot(); });
  boot();
})();
