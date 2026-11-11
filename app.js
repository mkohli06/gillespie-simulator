/* app.js — interface layer. All simulation logic lives in core.js. */
(function () {
  'use strict';
  const C = window.GillespieCore;
  const $ = id => document.getElementById(id);

  const DEFAULT_MODEL = '# A and B bind to form C\nJ1: A + B -> C; k1\n\nA = 100\nB = 100\nC = 0\nk1 = 0.001\n';
  const BD_MODEL = '# Birth-death: steady state is Poisson with mean kb/kd = 100\nJ1: -> X; kb\nJ2: X -> ; kd\n\nX = 0\nkb = 10\nkd = 0.1\n';
  const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4b5563', '#65a30d', '#0d9488'];

  const store = new C.SeedStore((function () {
    try { window.localStorage.setItem('__t', '1'); window.localStorage.removeItem('__t'); return window.localStorage; }
    catch (e) { return C.memoryStorage(); }
  })());

  const state = { single: null, ens: null, lastRun: null, cancel: false, busy: false, hidden: new Set(), dtEdited: false };
  const plot = new StepPlot($('plotCanvas'));
  plot.setData(null);

  /* ---------------- helpers ---------------- */
  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) for (const k in props) { if (k === 'text') e.textContent = props[k]; else if (k === 'class') e.className = props[k]; else e.setAttribute(k, props[k]); }
    (children || []).forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const tick = () => new Promise(r => setTimeout(r, 0));
  function setMsg(node, text, cls) { node.className = 'msg ' + (cls || ''); node.textContent = text; }
  function fmtNum(v) { if (!isFinite(v)) return String(v); const a = Math.abs(v); return (a !== 0 && (a >= 1e6 || a < 1e-3)) ? v.toExponential(3) : String(+v.toPrecision(5)); }

  // Runs a runner in small chunks so the page stays responsive; resolves false if cancelled.
  async function drive(runner, prog, label) {
    state.cancel = false;
    prog.hidden = false; prog.value = 0;
    for (;;) {
      const done = runner.advance(20000);
      prog.value = runner.progress();
      if (label) label.textContent = Math.round(runner.progress() * 100) + '%';
      if (done) { prog.hidden = true; if (label) label.textContent = ''; return true; }
      if (state.cancel) { prog.hidden = true; if (label) label.textContent = ''; return false; }
      await tick();
    }
  }

  /* ---------------- editor ---------------- */
  const ta = $('modelText'), gutter = $('gutter');
  let errLines = new Set();
  function renderGutter() {
    const n = ta.value.split('\n').length;
    gutter.innerHTML = '';
    for (let i = 1; i <= n; i++) gutter.appendChild(el('div', { class: errLines.has(i) ? 'err' : '', text: String(i) }));
    gutter.scrollTop = ta.scrollTop;
  }
  ta.addEventListener('input', () => { errLines = new Set(); renderGutter(); });
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  ta.value = DEFAULT_MODEL; renderGutter();

  function showCheck(model) {
    const out = $('checkOut');
    out.innerHTML = '';
    errLines = new Set(model.errors.filter(e => e.line).map(e => e.line));
    renderGutter();
    if (model.ok) {
      out.className = 'msg ok';
      out.appendChild(el('div', { text: 'Model OK — ' + C.summarizeModel(model) }));
      if (model.warnings.length) {
        const ul = el('ul', { class: 'warn' });
        model.warnings.forEach(w => ul.appendChild(el('li', { text: 'Line ' + w.line + ': ' + w.message })));
        out.appendChild(ul);
      }
    } else {
      out.className = 'msg bad';
      out.appendChild(el('div', { text: model.errors.length + (model.errors.length === 1 ? ' error' : ' errors') + ' found:' }));
      const ul = el('ul');
      model.errors.forEach(e => {
        const li = el('li');
        li.appendChild(document.createTextNode((e.line ? 'Line ' + e.line + ': ' : '') + e.message));
        if (e.text) { li.appendChild(document.createTextNode(' — ')); li.appendChild(el('code', { text: e.text })); }
        ul.appendChild(li);
      });
      out.appendChild(ul);
    }
  }

  function checkOnly() { const m = C.parseModel(ta.value); showCheck(m); return m; }

  $('btnCheck').onclick = checkOnly;
  $('btnSaveModel').onclick = () => download('model.txt', ta.value);
  $('loadFile').onchange = ev => {
    const f = ev.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { ta.value = String(r.result); errLines = new Set(); renderGutter(); $('checkOut').textContent = ''; setMsg($('runMsg'), 'Loaded ' + f.name + '. Press “Check model” or Run.', ''); };
    r.readAsText(f);
    ev.target.value = '';
  };

  let antimony = '';
  $('btnExport').onclick = () => {
    const m = checkOnly();
    if (!m.ok) return;
    antimony = C.exportAntimony(m);
    $('antimonyText').textContent = antimony;
    $('antimonyPanel').hidden = false;
    download('model.ant', antimony);
  };
  $('btnAntDownload').onclick = () => download('model.ant', antimony);
  $('btnAntCopy').onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText(antimony); };

  /* ---------------- ensemble settings ---------------- */
  const nRuns = $('nRuns'), nSlider = $('nRunsSlider'), dtInput = $('gridDt'), gSlider = $('gridPoints');
  nSlider.oninput = () => { nRuns.value = nSlider.value; };
  nRuns.oninput = () => { nSlider.value = Math.min(1000, Math.max(2, Number(nRuns.value) || 2)); };
  function endTime() { const t = Number($('endTime').value); return t > 0 && isFinite(t) ? t : null; }
  function autoDt() { const t = endTime(); return t ? t / Number(gSlider.value) : null; }
  function refreshGridLabel() {
    const t = endTime(); if (!t) { $('gridPointsLabel').textContent = ''; return; }
    const dt = Number(dtInput.value) > 0 ? Number(dtInput.value) : autoDt();
    dtInput.placeholder = 'auto = ' + fmtNum(autoDt() || 0);
    $('gridPointsLabel').textContent = '≈ ' + (Math.floor(t / dt + 1e-9) + 1) + ' grid points';
  }
  gSlider.oninput = () => { const t = endTime(); if (t) dtInput.value = fmtNum(t / Number(gSlider.value)); refreshGridLabel(); };
  dtInput.oninput = () => { const t = endTime(), dt = Number(dtInput.value); if (t && dt > 0) gSlider.value = Math.min(1000, Math.max(10, Math.round(t / dt))); refreshGridLabel(); };
  $('endTime').oninput = () => { if (!dtInput.value) refreshGridLabel(); else refreshGridLabel(); updateV2Cmd(); };
  refreshGridLabel();

  /* ---------------- preparing a run ---------------- */
  function prepare(msgNode) {
    const model = checkOnly();
    if (!model.ok) { setMsg(msgNode, 'Fix the model errors first: a model with errors is never run.', 'bad'); return null; }
    const tEnd = endTime();
    if (!tEnd) { setMsg(msgNode, 'The end time must be a number greater than 0.', 'bad'); return null; }
    const sd = C.parseSeed($('seedInput').value);
    if (!sd.ok) { setMsg(msgNode, sd.error, 'bad'); return null; }
    const seed = sd.value === null ? C.randomSeed() : sd.value;
    return { model, cm: C.compileModel(model), tEnd, seed };
  }

  function setBusy(b) {
    state.busy = b;
    ['btnRun', 'btnRunEns', 'btnV1', 'btnV2', 'btnV3'].forEach(id => { $(id).disabled = b; });
    $('btnCancel').hidden = !b;
  }
  $('btnCancel').onclick = () => { state.cancel = true; };
  $('btnClearSeed').onclick = () => { $('seedInput').value = ''; };

  function afterRun(kind, p, extra) {
    $('seedInput').value = String(p.seed);
    state.lastRun = { kind, seed: p.seed, settings: Object.assign({ modelText: ta.value, endTime: p.tEnd }, extra || {}) };
    $('saveSeedText').textContent = 'Seed used: ' + p.seed;
    $('btnSaveSeed').textContent = 'Save seed'; $('btnSaveSeed').disabled = false;
    $('saveSeedRow').hidden = false;
  }

  /* ---------------- single run ---------------- */
  $('btnRun').onclick = async () => {
    const msg = $('runMsg'); setMsg(msg, '', '');
    const p = prepare(msg); if (!p) return;
    setBusy(true);
    try {
      const runner = new C.SingleRunner(p.cm, p.seed, p.tEnd);
      const ok = await drive(runner, $('progress'), $('progressText'));
      if (!ok) { setMsg(msg, 'Run cancelled.', 'warn'); return; }
      const log = runner.log;
      state.single = {
        names: p.cm.names, boundary: p.cm.boundary, seed: p.seed, tEnd: p.tEnd, date: C.dateStamp(),
        t: log.t.subarray(0, log.n), cols: p.cm.names.map((_, s) => log.column(s)), log, events: runner.sim.events
      };
      afterRun('single', p);
      $('btnCsv').disabled = false;
      document.querySelector('input[name=plotMode][value=single]').checked = true;
      renderPlot();
      setMsg(msg, runner.truncated ? 'Stopped early: this run reached the limit of 2,000,000 events at t = ' + fmtNum(runner.sim.t) + '. Shorten the end time or use an ensemble.' : 'Done: ' + runner.sim.events + ' reactions fired.', runner.truncated ? 'warn' : 'ok');
    } catch (e) { setMsg(msg, 'Error: ' + e.message, 'bad'); }
    finally { setBusy(false); }
  };

  /* ---------------- ensemble ---------------- */
  $('btnRunEns').onclick = async () => {
    const msg = $('runMsg'); setMsg(msg, '', '');
    const p = prepare(msg); if (!p) return;
    const N = Math.floor(Number(nRuns.value));
    if (!(N >= 2)) { setMsg(msg, 'The number of runs must be a whole number, 2 or more.', 'bad'); return; }
    const dt = Number(dtInput.value) > 0 ? Number(dtInput.value) : autoDt();
    let grid;
    try { grid = C.makeGrid(p.tEnd, dt); } catch (e) { setMsg(msg, e.message, 'bad'); return; }
    setBusy(true);
    try {
      const runner = new C.EnsembleRunner(p.cm, { N, grid, seed: p.seed, tEnd: p.tEnd, keepRuns: 20 });
      const ok = await drive(runner, $('progress'), $('progressText'));
      if (!ok) { setMsg(msg, 'Ensemble cancelled after ' + runner.i + ' of ' + N + ' runs; nothing was plotted.', 'warn'); return; }
      state.ens = { res: runner.result(), boundary: p.cm.boundary, seed: p.seed, tEnd: p.tEnd, date: C.dateStamp(), N, dt };
      afterRun('ensemble', p, { N, gridSpacing: dt });
      $('btnEnsCsv').disabled = false;
      document.querySelector('input[name=plotMode][value=ensemble]').checked = true;
      renderPlot();
      setMsg(msg, 'Done: ' + N + ' runs on ' + grid.length + ' grid points.', 'ok');
    } catch (e) { setMsg(msg, 'Error: ' + e.message, 'bad'); }
    finally { setBusy(false); }
  };

  /* ---------------- plotting ---------------- */
  function mode() { return document.querySelector('input[name=plotMode]:checked').value; }
  function currentNames() { const s = mode() === 'single' ? state.single : state.ens; return s ? (s.names || s.res.names) : []; }
  function buildToggles() {
    const box = $('speciesToggles'); box.innerHTML = '';
    const src = mode() === 'single' ? state.single : state.ens;
    if (!src) return;
    const names = currentNames(), bnd = src.boundary;
    names.forEach((n, i) => {
      const id = 'sp_' + i;
      const cb = el('input', { type: 'checkbox', id });
      cb.checked = !state.hidden.has(n) && !(bnd[i] && !state.seenBoundary.has(n));
      if (bnd[i]) state.seenBoundary.add(n);
      cb.onchange = () => { if (cb.checked) state.hidden.delete(n); else state.hidden.add(n); renderPlot(true); };
      const lab = el('label', { for: id }, [el('span', { class: 'swatch', style: 'background:' + PALETTE[i % PALETTE.length] }), cb, document.createTextNode(n + (bnd[i] ? ' ($ boundary)' : ''))]);
      box.appendChild(lab);
    });
  }
  state.seenBoundary = new Set();

  function visible(i, names, bnd) {
    const cb = $('sp_' + i);
    return cb ? cb.checked : !bnd[i];
  }

  function renderPlot(keepView) {
    const m = mode(), src = m === 'single' ? state.single : state.ens;
    if (!src) { plot.setData(null); $('speciesToggles').innerHTML = ''; return; }
    if (!keepView) buildToggles();
    const names = currentNames(), bnd = src.boundary, series = [];
    if (m === 'single') {
      names.forEach((n, i) => {
        if (!visible(i, names, bnd)) return;
        series.push({ name: n, color: PALETTE[i % PALETTE.length], x: src.t, y: src.cols[i] });
      });
      plot.setData({ title: 'Single run (seed ' + src.seed + ')', xLabel: 'time', yLabel: 'molecules', series }, keepView);
      $('plotInfo').textContent = 'Step plot of every reaction event. Drag a box to zoom, scroll to zoom, double-click to reset.';
    } else {
      const res = src.res, G = res.G;
      if ($('chkOverlay').checked) {
        names.forEach((n, i) => {
          if (!visible(i, names, bnd)) return;
          res.runs.forEach(r => series.push({ color: PALETTE[i % PALETTE.length], x: res.times, y: r.subarray(i * G, (i + 1) * G), width: 1, alpha: 0.25, legend: false }));
        });
      }
      names.forEach((n, i) => {
        if (!visible(i, names, bnd)) return;
        const mean = res.mean.subarray(i * G, (i + 1) * G), sd = res.sd.subarray(i * G, (i + 1) * G);
        const lo = new Float64Array(G), hi = new Float64Array(G);
        for (let g = 0; g < G; g++) { lo[g] = Math.max(0, mean[g] - sd[g]); hi[g] = mean[g] + sd[g]; }
        series.push({ name: n + ' mean ±1 SD', color: PALETTE[i % PALETTE.length], x: res.times, y: mean, lo, hi, width: 2 });
      });
      plot.setData({ title: 'Ensemble of ' + res.n + ' runs (seed ' + src.seed + ')', xLabel: 'time', yLabel: 'molecules', series }, keepView);
      $('plotInfo').textContent = 'Mean (line) with a shaded ±1 SD band, on a grid of ' + G + ' time points. Standard deviation uses N−1.';
    }
  }
  document.querySelectorAll('input[name=plotMode]').forEach(r => { r.onchange = () => renderPlot(); });
  $('chkOverlay').onchange = () => renderPlot(true);
  $('btnResetZoom').onclick = () => plot.resetView();
  $('btnPng').onclick = () => plot.toBlob(b => { if (!b) return; const a = el('a', { href: URL.createObjectURL(b), download: 'plot.png' }); document.body.appendChild(a); a.click(); a.remove(); });
  $('btnCsv').onclick = () => { const s = state.single; if (s) download('gillespie_run_seed' + s.seed + '_' + s.date + '.csv', C.singleRunCSV(s.names, s.log), 'text/csv'); };
  $('btnEnsCsv').onclick = () => { const s = state.ens; if (s) download('gillespie_ensemble_seed' + s.seed + '_' + s.date + '.csv', C.ensembleCSV(s.res), 'text/csv'); };

  /* ---------------- saved seeds ---------------- */
  $('btnSaveSeed').onclick = () => {
    if (!state.lastRun) return;
    store.add(JSON.parse(JSON.stringify(state.lastRun)));
    $('btnSaveSeed').textContent = 'Saved ✓'; $('btnSaveSeed').disabled = true;
    renderSeeds();
  };
  function renderSeeds() {
    const list = $('seedList'); list.innerHTML = '';
    const items = store.list();
    $('seedsEmpty').hidden = items.length > 0;
    items.forEach(e => {
      const s = e.settings || {};
      const when = new Date(e.savedAt).toLocaleString();
      const detail = (e.kind === 'ensemble' ? 'Ensemble' : 'Single run') + ' · end time ' + s.endTime + (e.kind === 'ensemble' ? ' · N = ' + s.N + ' · grid ' + fmtNum(s.gridSpacing) : '');
      const btn = el('button', { class: 'entry', type: 'button', title: 'Restore these settings' }, [document.createTextNode('Seed ' + e.seed), el('small', { text: when + ' · ' + detail })]);
      btn.onclick = () => {
        ta.value = s.modelText || ta.value; errLines = new Set(); renderGutter();
        $('endTime').value = s.endTime; $('seedInput').value = String(e.seed);
        if (e.kind === 'ensemble') { nRuns.value = s.N; nSlider.value = Math.min(1000, s.N); dtInput.value = fmtNum(s.gridSpacing); dtInput.oninput(); }
        refreshGridLabel(); updateV2Cmd();
        setMsg($('runMsg'), 'Restored the settings for seed ' + e.seed + '. Press ' + (e.kind === 'ensemble' ? '“Run ensemble”' : '“Run”') + ' to reproduce it exactly.', 'ok');
      };
      const del = el('button', { class: 'btn', type: 'button', title: 'Delete this saved seed', 'aria-label': 'Delete saved seed', text: '✕' });
      del.onclick = () => { store.remove(e.id); renderSeeds(); };
      list.appendChild(el('li', null, [btn, del]));
    });
  }
  renderSeeds();

  /* ---------------- tabs ---------------- */
  function showTab(which) {
    $('viewSim').hidden = which !== 'sim'; $('viewVal').hidden = which !== 'val';
    $('tabSim').setAttribute('aria-selected', which === 'sim'); $('tabVal').setAttribute('aria-selected', which === 'val');
    if (which === 'sim') plot.draw(); else updateV2Cmd();
  }
  $('tabSim').onclick = () => showTab('sim'); $('tabVal').onclick = () => showTab('val');

  /* ---------------- validation ---------------- */
  function badge(status) { return el('span', { class: 'badge ' + (status === 'N/A' || status === 'n/a' ? 'NA' : status), text: status }); }

  $('btnV1Example').onclick = () => { ta.value = BD_MODEL; errLines = new Set(); renderGutter(); $('endTime').value = 100; $('v1End').value = 100; refreshGridLabel(); $('checkOut').textContent = ''; $('v1Out').textContent = 'Birth–death example loaded into the model box.'; };

  $('btnV1').onclick = async () => {
    const out = $('v1Out'); out.textContent = '';
    const model = checkOnly();
    if (!model.ok) { out.appendChild(el('div', { class: 'msg bad', text: 'The model has errors (see the Simulate tab); fix them first.' })); return; }
    const tEnd = Number($('v1End').value);
    if (!(tEnd > 0)) { out.appendChild(el('div', { class: 'msg bad', text: 'The end time must be greater than 0.' })); return; }
    const cm = C.compileModel(model), seed = C.randomSeed();
    setBusy(true);
    try {
      const runner = new C.EnsembleRunner(cm, { N: 1000, grid: new Float64Array(0), seed, tEnd, keepFinals: true });
      const ok = await drive(runner, $('v1Prog'));
      if (!ok) { out.textContent = 'Cancelled.'; return; }
      const v = C.v1Stats(cm, runner.finals);
      out.appendChild(el('p', null, [document.createTextNode('Overall: '), badge(v.overall), document.createTextNode('  (1000 runs, end time ' + tEnd + ', seed ' + seed + ')')]));
      const tbl = el('table', { class: 'res' });
      tbl.appendChild(el('tr', null, ['Species', 'Mean', 'Variance', 'Variance ÷ mean', 'Result'].map(h => el('th', { text: h }))));
      v.rows.forEach(r => { const tr = el('tr'); [r.species, fmtNum(r.mean), fmtNum(r.variance), isNaN(r.ratio) ? 'n/a (mean 0)' : fmtNum(r.ratio)].forEach(t => tr.appendChild(el('td', { text: t }))); const td = el('td'); td.appendChild(badge(r.status)); tr.appendChild(td); tbl.appendChild(tr); });
      out.appendChild(tbl);
      if (v.overall === 'N/A') out.appendChild(el('p', { class: 'hint', text: 'Every species ended at 0, so the variance ÷ mean ratio is undefined. V1 is meaningful for models with a non-zero steady state, such as the birth–death example.' }));
      const figs = el('div', { class: 'figs' }); out.appendChild(figs);
      v.rows.forEach(r => { const c = el('canvas'); figs.appendChild(c); drawHistogram(c, r.hist, r.species + ': final values', r.mean); });
    } catch (e) { out.textContent = 'Error: ' + e.message; }
    finally { setBusy(false); }
  };

  function updateV2Cmd() {
    const t = endTime() || 100, dt = Number(dtInput.value) > 0 ? Number(dtInput.value) : (t / 100);
    $('v2Cmd').textContent = 'python tellurium_ensemble.py model.ant --end ' + fmtNum(t) + ' --step ' + fmtNum(dt) + ' --runs 500 --out tellurium_results.csv';
  }
  dtInput.addEventListener('input', updateV2Cmd); gSlider.addEventListener('input', updateV2Cmd);
  updateV2Cmd();

  $('btnV2').onclick = async () => {
    const out = $('v2Out'); out.textContent = '';
    const bad = t => out.appendChild(el('div', { class: 'msg bad', text: t }));
    const model = checkOnly();
    if (!model.ok) return bad('The model has errors (see the Simulate tab); fix them first.');
    const file = $('v2File').files[0];
    if (!file) return bad('Choose the Tellurium results file first.');
    const nT = Math.floor(Number($('v2N').value));
    if (!(nT >= 2)) return bad('“Runs in that file” must be 2 or more.');
    let theirs;
    try { theirs = C.parseEnsembleCSV(await file.text()); } catch (e) { return bad('Could not read that file: ' + e.message); }
    const cm = C.compileModel(model);
    const common = theirs.names.filter(n => cm.names.includes(n));
    if (!common.length) return bad('None of the species in the file (' + theirs.names.join(', ') + ') match this model’s species (' + cm.names.join(', ') + ').');
    const grid = Float64Array.from(theirs.times);
    const tEnd = grid[grid.length - 1];
    if (!(tEnd > 0)) return bad('The time column in the file must end after 0.');
    const seed = C.randomSeed();
    setBusy(true);
    try {
      const runner = new C.EnsembleRunner(cm, { N: 500, grid, seed, tEnd });
      const ok = await drive(runner, $('v2Prog'));
      if (!ok) { out.textContent = 'Cancelled.'; return; }
      const ours = runner.result();
      const cmp = C.compareEnsembles(ours, theirs, 500, nT);
      out.appendChild(el('p', null, [document.createTextNode('Overall: '), badge(cmp.pass ? 'PASS' : 'FAIL'), document.createTextNode('  (our simulator: 500 runs, seed ' + seed + '; Tellurium file: ' + nT + ' runs)')]));
      const tbl = el('table', { class: 'res' });
      tbl.appendChild(el('tr', null, ['Check', 'Result', 'Limit'].map(h => el('th', { text: h }))));
      const row = (a, b, c) => tbl.appendChild(el('tr', null, [a, b, c].map(t => el('td', { text: t }))));
      row('Mean comparisons with |z| > 3', cmp.exceed + ' of ' + cmp.total + ' (' + (100 * cmp.fracMean).toFixed(2) + '%)', '≤ 1%');
      row('Largest |z| for the means', fmtNum(cmp.maxAbsZ), '—');
      row('SD comparisons with |z| > 3', cmp.sdExceed + ' of ' + cmp.total + ' (' + (100 * cmp.fracSd).toFixed(2) + '%)', '≤ 2%');
      cmp.perSpecies.forEach(p => row('Average z, species ' + p.name + ' (drift)', fmtNum(p.meanZ), '|z̄| ≤ 1'));
      out.appendChild(tbl);
      const skipped = theirs.names.filter(n => !cm.names.includes(n));
      if (skipped.length) out.appendChild(el('p', { class: 'hint', text: 'Ignored columns not in this model: ' + skipped.join(', ') }));
      const figs = el('div', { class: 'figs wide' }); out.appendChild(figs);
      common.forEach(n => {
        const i = cm.names.indexOf(n), G = ours.G, c = el('canvas'); figs.appendChild(c);
        const om = ours.mean.subarray(i * G, (i + 1) * G), os = ours.sd.subarray(i * G, (i + 1) * G);
        const tm = Float64Array.from(theirs.species[n].mean), ts = Float64Array.from(theirs.species[n].sd);
        const band = (m, s, sign) => { const a = new Float64Array(G); for (let g = 0; g < G; g++) a[g] = Math.max(0, m[g] + sign * s[g]); return a; };
        const p = new StepPlot(c);
        p.setData({
          title: n + ': simulator vs Tellurium', xLabel: 'time', yLabel: 'molecules',
          series: [
            { name: 'Simulator mean ±1 SD', color: '#2563eb', x: grid, y: om, lo: band(om, os, -1), hi: band(om, os, 1), width: 2 },
            { name: 'Tellurium mean ±1 SD', color: '#d97706', x: grid, y: tm, lo: band(tm, ts, -1), hi: band(tm, ts, 1), width: 2 }
          ]
        });
      });
    } catch (e) { out.textContent = 'Error: ' + e.message; }
    finally { setBusy(false); }
  };

  $('btnV3').onclick = async () => {
    const out = $('v3Out'); out.textContent = '';
    const model = checkOnly();
    if (!model.ok) { out.appendChild(el('div', { class: 'msg bad', text: 'The model has errors (see the Simulate tab); fix them first.' })); return; }
    const tEnd = endTime();
    if (!tEnd) { out.appendChild(el('div', { class: 'msg bad', text: 'Set a valid end time on the Simulate tab first.' })); return; }
    const cm = C.compileModel(model);
    setBusy(true);
    try {
      const checks = C.buildV3Checks(cm, { tEnd, N: 10, store });
      let allPass = true;
      const list = el('div'); out.appendChild(list);
      for (const c of checks) {
        out.firstChild.appendChild(el('div', { class: 'check', text: 'Running: ' + c.name + '…' }));
        await tick();
        const r = c.run();
        list.lastChild.remove();
        allPass = allPass && r.pass;
        list.appendChild(el('div', { class: 'check ' + (r.pass ? 'pass' : 'fail') }, [el('span', { class: 'tick', text: r.pass ? '✓' : '✗' }), document.createTextNode(c.name + ' '), el('small', { text: '— ' + r.detail })]));
      }
      out.insertBefore(el('p', null, [document.createTextNode('Overall: '), badge(allPass ? 'PASS' : 'FAIL')]), list);
    } catch (e) { out.textContent = 'Error: ' + e.message; }
    finally { setBusy(false); }
  };
})();
