/* Strata viewer. All input is untrusted: text goes in via textContent,
   markdown raw HTML is escaped and the result sanitised with DOMPurify. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const LEVELS = [0, 1, 2, 3, 4];
  const MAX_BYTES = 8 * 1024 * 1024;
  const NAMES = ['Overview', 'System sketch', 'Module map', 'Flows', 'Deep dives'];
  const TIPS = [
    'What it is and how it is built.',
    'Runtime parts and how they talk. Click a box or a line for details; drag to move, scroll to zoom.',
    'Code modules inside the component that owns them. Thicker lines mean more references.',
    'Key paths through the system, step by step. Hover a step for its full text.',
    'Notes on one area, down to functions and checks.',
  ];
  let data = null, level = 1, ctrl = null, seqCtrl = null, flowIdx = 0, diveIdx = 0, rawJson = '';

  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (window.marked) marked.use({ renderer: { html: h => escHtml(typeof h === 'object' ? h.text : h) } });

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
  const arr = v => (Array.isArray(v) ? v : []);
  const str = v => (v == null ? '' : String(v));
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2400); }
  function showError(msg) { const e = $('err'); e.textContent = msg; e.hidden = false; }
  const PROTO = { http: '--focus', rpc: '--focus', queue: '--warn', db: '--accent', storage: '--accent', exec: '--exec', import: '--muted', other: '--muted' };
  const protoColor = p => css(PROTO[p] || '--muted');
  // Short box labels: drop parentheses and anything after a dash; module paths keep their last part.
  const shortName = s => str(s).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+[—-]\s+.*$/, '').trim() || str(s);
  const shortMod = s => { const p = str(s).split('/'); return p[p.length - 1] || str(s); };

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
  function b64urlToBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
  function bytesToB64url(b) { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  async function inflate(bytes) {
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error('Decoded data is too large');
    return new TextDecoder().decode(buf);
  }
  async function deflate(text) { return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); }

  function validate(d) {
    const errs = [];
    if (!d || typeof d !== 'object' || Array.isArray(d)) return ['Not a JSON object'];
    if (d.schema !== 'strata/1') errs.push('schema must be "strata/1"');
    if (!d.repo || !d.repo.name) errs.push('repo.name is missing');
    if (!d.l0 || !d.l0.summary) errs.push('l0.summary is missing');
    return errs;
  }

  async function load(text, { keepUrl = false } = {}) {
    let d;
    try { d = JSON.parse(text); } catch (e) { return showError('That is not valid JSON: ' + e.message); }
    const errs = validate(d);
    if (errs.length) return showError('Not a Strata file:\n• ' + errs.join('\n• '));
    data = d; rawJson = text;
    if (!keepUrl) history.replaceState(null, '', location.pathname);
    await StrataDraw.ready();
    $('err').hidden = true; $('empty').hidden = true; $('app').hidden = false; $('repo').hidden = false;
    document.body.classList.add('app-mode');
    renderHeader();
    const q = new URLSearchParams(location.search).get('level');
    const want = q === null ? NaN : Number(q), avail = available();
    setLevel(avail.includes(want) ? want : avail.includes(1) ? 1 : 0);
  }

  async function boot() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const qs = new URLSearchParams(location.search);
    let src = qs.get('src');
    const map = qs.get('map');
    try {
      if (hash.get('d')) return load(await inflate(b64urlToBytes(hash.get('d'))), { keepUrl: true });
      if (map) { if (!/^[a-z0-9-]+$/.test(map)) throw new Error('Unknown map name'); src = `examples/${map}.json`; }
      if (src) {
        const u = new URL(src, location.href);
        if (u.protocol !== 'https:' && u.origin !== location.origin) throw new Error('Only https sources are allowed');
        const r = await fetch(u, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!r.ok) throw new Error(`Could not fetch ${u.pathname} (${r.status})`);
        return load(await r.text(), { keepUrl: true });
      }
    } catch (e) { showError(e.message); }
  }

  /* ---------- header + levels ---------- */
  function available() {
    const lv = arr(data.repo.levels).filter(n => LEVELS.includes(n));
    if (lv.length) return lv;
    const has = [true, data.components, data.modules, data.flows, data.deep_dives].map(x => x === true || arr(x).length > 0);
    return LEVELS.filter(n => has[n]);
  }
  function renderHeader() {
    const a = $('repo-name'); a.textContent = data.repo.name;
    if (/^https:\/\//.test(str(data.repo.url))) a.href = data.repo.url; else a.removeAttribute('href');
    const c = data.confidence, conf = $('conf');
    if (c && c.score != null) {
      const s = Number(c.score);
      conf.textContent = `${c.label || (s >= 80 ? 'High' : s >= 50 ? 'Med' : 'Low')} ${s}`;
      conf.className = 'status ' + (s >= 80 ? 'high' : s >= 50 ? 'med' : 'low');
      conf.title = 'Confidence: ' + str(c.basis); conf.hidden = false;
    } else conf.hidden = true;
    const avail = available();
    for (const b of $('levels').querySelectorAll('button')) {
      const l = Number(b.dataset.l);
      b.disabled = !avail.includes(l);
      if (b.disabled) b.title = `Not in this map yet — run /strata --level ${l}`;
    }
    document.title = `${data.repo.name} — Strata`;
  }

  function setLevel(l) {
    level = l; ctrl = null; seqCtrl = null;
    for (const b of $('levels').querySelectorAll('button')) { const on = Number(b.dataset.l) === l; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    for (const v of document.querySelectorAll('.view')) v.hidden = true;
    $('btn-svg').hidden = !(l >= 1 && l <= 3);
    const q = new URLSearchParams(location.search); q.set('level', l);
    history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
    if (!available().includes(l)) return renderMissing(l);
    [renderL0, () => renderGraph(1), () => renderGraph(2), renderFlows, renderDives][l]();
  }

  /* ---------- panel ---------- */
  const comp = id => arr(data.components).find(c => c.id === id);
  const mod = id => arr(data.modules).find(m => m.id === id);
  const sys = id => arr(data.systems).find(s => s.id === id);
  const nameOf = id => comp(id)?.name || mod(id)?.name || id;

  function panelDefault(extra) {
    const p = $('panel'); p.replaceChildren();
    p.append(el('h2', { text: NAMES[level] }), el('p', { class: 'muted', text: TIPS[level] }));
    if (extra) p.append(extra);
    if (data.confidence) p.append(el('h4', { text: 'Confidence' }), el('p', {}, el('b', { text: `${str(data.confidence.label)} ${str(data.confidence.score)}`.trim() + '. ' }), str(data.confidence.basis)));
    if (arr(data.blind_spots).length) p.append(el('h4', { text: 'Not visible from code' }), el('ul', {}, data.blind_spots.map(s => el('li', { text: s }))));
    if (arr(data.next_zoom).length) p.append(el('h4', { text: 'Next zoom' }), el('ul', {}, data.next_zoom.map(s => el('li', { text: s }))));
  }
  function kv(pairs) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of pairs) if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) dl.append(el('dt', { text: k }), el('dd', {}, v));
    return dl;
  }
  const evList = list => el('ul', { class: 'plain' }, arr(list).map(e => el('li', {}, evidence(e))));
  const pill = s => el('span', { class: 'status ' + (s.status || 'unknown'), text: s.name || s.status || 'unknown' });

  function panelComponent(c) {
    if (!c) return panelDefault();
    const p = $('panel'); p.replaceChildren();
    const s = sys(c.system);
    p.append(el('div', { class: 'tags' }, el('span', { class: 'tag', text: str(c.kind || 'component') }), s ? pill(s) : null));
    p.append(el('h2', { text: c.name || c.id }));
    if (c.summary) p.append(el('p', { text: c.summary }));
    p.append(kv([['Tech', str(c.tech)], ['Entry', c.entry ? evidence(c.entry) : ''], ['Code', arr(c.paths).join(', ')]]));
    const out = arr(data.links).filter(l => l.from === c.id), inc = arr(data.links).filter(l => l.to === c.id);
    const row = (l, other) => el('li', { class: 'linkrow' }, el('span', { class: 'tag', text: str(l.protocol || 'link') }), el('span', {}, `${nameOf(other)}${l.label ? ' — ' + l.label : ''}`), l.inferred ? el('span', { class: 'inferred', text: 'inferred' }) : null);
    if (out.length) p.append(el('h4', { text: 'Talks to' }), el('ul', { class: 'plain' }, out.map(l => row(l, l.to))));
    if (inc.length) p.append(el('h4', { text: 'Used by' }), el('ul', { class: 'plain' }, inc.map(l => row(l, l.from))));
    if (arr(c.evidence).length) p.append(el('h4', { text: 'Evidence' }), evList(c.evidence));
    const mods = arr(data.modules).filter(m => m.component === c.id);
    if (mods.length) p.append(el('h4', { text: `Modules (${mods.length})` }), el('ul', { class: 'plain' }, mods.map(m => el('li', { class: 'ev', text: m.name }))));
  }
  function panelSystem(s) {
    if (!s) return panelDefault();
    const p = $('panel'); p.replaceChildren();
    p.append(el('span', { class: 'status ' + (s.status || 'unknown'), text: s.status || 'unknown' }), el('h2', { text: s.name }));
    if (s.summary) p.append(el('p', { text: s.summary }));
    p.append(kv([['Launcher', str(s.launcher)], ['Why this status', str(s.status_basis)]]));
    const cs = arr(data.components).filter(c => c.system === s.id);
    if (cs.length) p.append(el('h4', { text: 'Parts' }), el('ul', { class: 'plain' }, cs.map(c => el('li', {}, el('a', { href: '#', onclick: e => { e.preventDefault(); ctrl?.select(c.id); panelComponent(c); }, text: c.name })))));
  }
  function panelModule(m) {
    if (!m) return panelDefault();
    const p = $('panel'); p.replaceChildren();
    p.append(el('span', { class: 'tag', text: 'module' }), el('h2', { text: shortMod(m.name || m.id) }), el('p', { class: 'ev muted', text: m.name || m.id }));
    if (m.summary) p.append(el('p', { text: m.summary }));
    p.append(kv([['Component', m.component ? nameOf(m.component) : ''], ['Symbols', m.symbols], ['Used by (refs)', m.fan_in], ['Uses (refs)', m.fan_out]]));
    if (arr(m.key_symbols).length) p.append(el('h4', { text: 'Key symbols' }), el('ul', { class: 'plain' }, m.key_symbols.map(k => el('li', { class: 'ev', text: k }))));
    const out = arr(data.module_links).filter(l => l.from === m.id), inc = arr(data.module_links).filter(l => l.to === m.id);
    if (out.length) p.append(el('h4', { text: 'Depends on' }), el('ul', { class: 'plain' }, out.map(l => el('li', { class: 'ev', text: `${l.to} ×${l.weight}` }))));
    if (inc.length) p.append(el('h4', { text: 'Used by' }), el('ul', { class: 'plain' }, inc.map(l => el('li', { class: 'ev', text: `${l.from} ×${l.weight}` }))));
  }
  function panelLink(l, isModule) {
    if (!l) return panelDefault();
    const p = $('panel'); p.replaceChildren();
    p.append(el('span', { class: 'tag', text: isModule ? 'module dependency' : str(l.protocol || 'link') }), el('h2', { text: `${shortName(nameOf(l.from))} → ${shortName(nameOf(l.to))}` }));
    if (l.label) p.append(el('p', { text: l.label }));
    if (isModule) p.append(el('p', { class: 'muted', text: `${l.weight} references between these modules` }));
    if (l.inferred) p.append(el('p', { class: 'inferred', text: 'Inferred — no direct evidence in code.' }));
    if (arr(l.evidence).length) p.append(el('h4', { text: 'Evidence' }), evList(l.evidence));
  }

  /* ---------- L0 ---------- */
  function renderL0() {
    const v = $('view-0'); v.hidden = false; v.replaceChildren();
    const l0 = data.l0;
    if (l0.shape) v.append(el('p', { class: 'shape', text: l0.shape }));
    v.append(el('p', { class: 'summary', text: l0.summary }));
    if (arr(l0.stack).length) v.append(el('div', { class: 'tags' }, l0.stack.map(s => el('span', { class: 'tag', text: s }))));
    const cards = el('div', { class: 'grid2' });
    const langs = arr(data.repo.languages);
    if (langs.length) {
      const total = langs.reduce((a, l) => a + (Number(l.lines) || 0), 0) || 1;
      const pal = ['--accent', '--focus', '--warn', '--exec', '--muted'];
      const bar = el('div', { class: 'langbar' }), list = el('ul');
      langs.forEach((l, i) => {
        const color = css(pal[i % pal.length]), seg = el('i'), dot = el('span', { class: 'dot' });
        seg.style.width = `${((Number(l.lines) || 0) / total) * 100}%`; seg.style.background = color; dot.style.background = color;
        bar.append(seg);
        list.append(el('li', { class: 'legend-row' }, dot, str(l.lang), el('span', { class: 'muted', text: ` · ${l.files} files · ${l.lines} lines` })));
      });
      cards.append(el('div', { class: 'card' }, el('h3', { text: 'Languages' }), bar, list));
    }
    if (arr(data.systems).length) cards.append(el('div', { class: 'card' }, el('h3', { text: 'Systems' }), el('ul', {}, data.systems.map(s => el('li', {}, el('div', {}, el('b', { text: s.name + ' ' }), el('span', { class: 'status ' + (s.status || 'unknown'), text: s.status || 'unknown' })), s.summary ? el('div', { class: 'muted', text: s.summary }) : null)))));
    if (arr(l0.entry_points).length) cards.append(el('div', { class: 'card' }, el('h3', { text: 'Entry points' }), el('ul', {}, l0.entry_points.map(e => el('li', {}, evidence(e.path), e.role ? el('div', { class: 'muted', text: e.role }) : null)))));
    if (cards.children.length) v.append(cards);
    panelDefault();
  }

  /* ---------- L1 / L2 ---------- */
  function modelL1() {
    return {
      title: `${data.repo.name} system sketch`,
      clusters: arr(data.systems).map(s => ({ id: s.id, label: s.name, status: s.status })),
      nodes: arr(data.components).map(c => ({ id: c.id, label: shortName(c.name || c.id), kind: c.kind || 'service', parent: c.system })),
      edges: arr(data.links).map((l, i) => ({ id: 'l' + i, from: l.from, to: l.to, color: protoColor(l.protocol), dashed: !!l.inferred, title: `${l.protocol || 'link'}: ${str(l.label)}` })),
    };
  }
  function modelL2() {
    // Frame a component only when it owns two or more modules; a frame around one box is noise.
    const count = {};
    for (const m of arr(data.modules)) if (m.component) count[m.component] = (count[m.component] || 0) + 1;
    const used = new Set(Object.keys(count).filter(c => count[c] > 1));
    const maxW = Math.max(1, ...arr(data.module_links).map(l => Number(l.weight) || 1));
    return {
      title: `${data.repo.name} module map`,
      clusters: arr(data.components).filter(c => used.has(c.id)).map(c => ({ id: c.id, label: shortName(c.name), status: sys(c.system)?.status })),
      nodes: arr(data.modules).map(m => ({ id: m.id, label: shortMod(m.name || m.id), kind: 'service', parent: m.component })),
      edges: arr(data.module_links).map((l, i) => ({ id: 'ml' + i, from: l.from, to: l.to, color: css('--muted'), width: 1.2 + 3.5 * (Number(l.weight) || 1) / maxW, title: `${l.weight} references` })),
    };
  }
  function renderGraph(l) {
    $('view-graph').hidden = false;
    const model = l === 1 ? modelL1() : modelL2();
    ctrl = StrataDraw.graph($('canvas'), model, {
      onSelect(id, type) {
        if (type === 'cluster') return l === 1 ? panelSystem(sys(id.slice(4))) : panelComponent(comp(id.slice(4)));
        if (type === 'edge') { const i = Number(id.replace(/^m?l/, '')); return panelLink(l === 1 ? data.links[i] : data.module_links[i], l === 2); }
        if (l === 1) panelComponent(comp(id)); else panelModule(mod(id));
      },
      onClear: () => panelDefault(),
    });
    renderLegend(l, model);
    panelDefault();
  }
  function renderLegend(l, model) {
    const lg = $('legend'); lg.replaceChildren();
    if (l === 2) { lg.append(el('span', {}, StrataDraw.glyph('edge', css('--muted')), 'thicker = more references')); return; }
    const KN = { service: 'service', frontend: 'UI', worker: 'worker', store: 'store', queue: 'queue', external: 'external', cli: 'tool', library: 'library', infra: 'infra', job: 'job' };
    for (const k of new Set(model.nodes.map(n => n.kind))) lg.append(el('span', {}, StrataDraw.glyph(k), KN[k] || k));
    for (const p of new Set(arr(data.links).map(x => x.protocol || 'other'))) lg.append(el('span', {}, StrataDraw.glyph('edge', protoColor(p)), p));
    if (arr(data.links).some(x => x.inferred)) lg.append(el('span', {}, StrataDraw.glyph('dashed', css('--muted')), 'inferred'));
  }

  /* ---------- L3 ---------- */
  function renderFlows() {
    $('view-3').hidden = false;
    const flows = arr(data.flows), list = $('flow-list'); list.replaceChildren();
    flowIdx = Math.max(0, Math.min(flowIdx, flows.length - 1));
    flows.forEach((f, i) => list.append(el('button', { class: i === flowIdx ? 'on' : '', role: 'tab', 'aria-selected': i === flowIdx, onclick: () => { flowIdx = i; renderFlows(); } }, shortName(f.name || f.id))));
    const f = flows[flowIdx];
    const tbl = $('steps'); tbl.replaceChildren();
    if (f) {
      const parts = [];
      for (const s of arr(f.steps)) for (const p of [s.from, s.to]) if (!parts.includes(p)) parts.push(p);
      seqCtrl = StrataDraw.sequence($('seq'), {
        title: f.name,
        participants: parts.map(p => ({ id: p, label: shortName(nameOf(p)) })),
        steps: arr(f.steps).map(s => ({ from: s.from, to: s.to, text: str(s.action), reply: !!s.reply })),
      });
      tbl.append(el('tr', {}, el('th', { text: '#' }), el('th', { text: 'Step' }), el('th', { text: 'Evidence' })));
      arr(f.steps).forEach((s, i) => tbl.append(el('tr', {}, el('td', { class: 'n', text: i + 1 }), el('td', {}, el('b', { text: `${shortName(nameOf(s.from))} → ${shortName(nameOf(s.to))}` }), el('div', { text: str(s.action) })), el('td', {}, s.evidence ? evidence(s.evidence) : el('span', { class: 'inferred', text: 'inferred' })))));
    }
    const info = f ? el('div', {}, el('h4', { text: 'This flow' }), el('p', {}, el('b', { text: f.name || f.id })), kv([['Trigger', str(f.trigger)], ['System', f.system ? str(sys(f.system)?.name) : ''], ['Steps', arr(f.steps).length]])) : null;
    panelDefault(info);
  }

  /* ---------- L4 ---------- */
  function renderDives() {
    $('view-4').hidden = false;
    const dives = arr(data.deep_dives), list = $('dive-list'); list.replaceChildren();
    diveIdx = Math.max(0, Math.min(diveIdx, dives.length - 1));
    dives.forEach((d, i) => list.append(el('button', { class: i === diveIdx ? 'on' : '', role: 'tab', 'aria-selected': i === diveIdx, onclick: () => { diveIdx = i; renderDives(); } }, d.title || d.id)));
    const d = dives[diveIdx], art = $('dive');
    art.innerHTML = DOMPurify.sanitize(d ? marked.parse(str(d.markdown)) : '', { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] });
    for (const a of art.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    panelDefault(d && d.target ? kv([['About', nameOf(d.target)]]) : null);
  }

  function renderMissing(l) {
    const v = $('view-missing'); v.hidden = false; v.replaceChildren();
    v.append(el('div', {}, el('h2', { text: `Level ${l} is not in this map yet` }), el('p', { class: 'muted', text: 'Run the skill again at this level; the pack step merges it into the same file.' }), el('code', { text: `/strata ${data.repo.name} --level ${l}` })));
    panelDefault();
  }

  /* ---------- gallery ---------- */
  async function gallery() {
    const g = $('gallery');
    try {
      const list = await (await fetch('examples/index.json')).json();
      await StrataDraw.ready();
      for (const m of arr(list)) {
        if (!/^[a-z0-9-]+$/.test(str(m.map))) continue;
        const sketch = el('div', { class: 'sketch', 'aria-hidden': 'true' });
        g.append(el('a', { class: 'card gcard', href: `?map=${m.map}` }, sketch, el('h3', { text: m.title }), el('p', { text: m.blurb }),
          el('div', { class: 'tags' }, arr(m.tags).map(t => el('span', { class: 'tag', text: t }))), el('span', { class: 'go', text: 'Open map →' })));
        drawThumb(sketch, m.map);
      }
    } catch { g.closest('section').hidden = true; }
  }
  async function drawThumb(box, name) {
    try {
      const d = await (await fetch(`examples/${name}.json`)).json();
      const sysIds = new Set(arr(d.systems).map(s => s.id));
      StrataDraw.graph(box, {
        clusters: arr(d.systems).map(s => ({ id: s.id, label: s.name, status: s.status })),
        nodes: arr(d.components).filter(c => sysIds.has(c.system)).map(c => ({ id: c.id, label: shortName(c.name), kind: c.kind, parent: c.system })),
        edges: arr(d.links).map((l, i) => ({ id: 'l' + i, from: l.from, to: l.to, color: protoColor(l.protocol) })),
      }, { static: true });
    } catch { /* thumbnail is decoration */ }
  }

  /* ---------- actions ---------- */
  async function share() {
    try {
      let url = location.href;
      if (!new URLSearchParams(location.hash.slice(1)).get('d') && !new URLSearchParams(location.search).get('map')) {
        url = `${location.origin}${location.pathname}?level=${level}#d=${bytesToB64url(await deflate(rawJson))}`;
        if (url.length > 60000) return toast('Too large for a link — share the JSON file instead');
      }
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch (e) { toast('Could not copy: ' + e.message); }
  }
  function download() {
    const base = `${data.repo.name}-L${level}`;
    if (level === 3 && seqCtrl) seqCtrl.exportSVG(base + '.svg'); else if (ctrl) ctrl.exportSVG(base + '.svg');
  }
  function readFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) return showError('File is larger than 8 MB');
    file.text().then(t => load(t));
  }

  $('levels').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) setLevel(Number(b.dataset.l)); });
  $('btn-share').onclick = share;
  $('btn-svg').onclick = download;
  $('z-in').onclick = () => ctrl?.zoom(1.25);
  $('z-out').onclick = () => ctrl?.zoom(0.8);
  $('z-fit').onclick = () => ctrl?.fit();
  $('file').onchange = e => readFile(e.target.files[0]);
  $('btn-paste').onclick = () => { $('paste-box').hidden = false; $('paste').focus(); };
  $('btn-paste-go').onclick = () => load($('paste').value);
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', e => readFile(e.dataTransfer.files[0]));
  document.addEventListener('keydown', e => {
    if (!data || e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (e.key.length === 1 && LEVELS.includes(n) && available().includes(n)) setLevel(n);
  });
  document.addEventListener('themechange', () => {
    if (data) setLevel(level);
    else if ($('gallery').children.length) { $('gallery').replaceChildren(); gallery(); }
  });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => ctrl?.fit(), 150); });
  window.addEventListener('hashchange', () => { if (new URLSearchParams(location.hash.slice(1)).get('d')) boot(); });
  gallery();
  boot();
})();
