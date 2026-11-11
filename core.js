/* core.js — UI-free core of the stochastic reaction simulator.
 * Works in the browser (window.GillespieCore) and in Node (require('./core.js')).
 *
 * Contents: line-numbered parser, compiler (stoichiometry + propensities),
 * seeded RNG, Gillespie direct method, step-function gridding, ensembles,
 * CSV writers, Antimony export, seed store, and the maths behind V1/V2/V3.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GillespieCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  /* ------------------------------------------------------------------ */
  /* Parser                                                              */
  /* ------------------------------------------------------------------ */

  function stripComment(line) {
    let i = line.indexOf('#');
    const j = line.indexOf('//');
    if (j >= 0 && (i < 0 || j < i)) i = j;
    return i >= 0 ? line.slice(0, i) : line;
  }

  // Parse one side of a reaction ("2 A + $B"). Calls bad(msg) for problems.
  function parseSide(text, bad) {
    const out = [];
    const s = text.trim();
    if (!s) return out; // blank side = noncontributing fixed species
    for (const part of s.split('+')) {
      const term = part.trim();
      if (!term) { bad('empty term (a stray "+")'); continue; }
      const m = /^(?:(\d+(?:\.\d+)?)\s*)?(\$)?\s*([A-Za-z_][A-Za-z0-9_]*)$/.exec(term);
      if (!m) { bad('cannot read "' + term + '" as a species (write e.g. A, 2 A or $A)'); continue; }
      let st = 1;
      if (m[1] !== undefined) {
        st = Number(m[1]);
        if (!Number.isInteger(st) || st < 1) {
          bad('stoichiometry "' + m[1] + '" must be a positive whole number');
          continue;
        }
      }
      const prev = out.find(o => o.name === m[3]);
      if (prev) { prev.stoich += st; prev.boundary = prev.boundary || !!m[2]; }
      else out.push({ name: m[3], stoich: st, boundary: !!m[2] });
    }
    return out;
  }

  // The explicit mass-action rate law written by the Antimony export.
  function massActionLaw(k, reactants) {
    const f = [k];
    for (const t of reactants) {
      if (t.stoich === 1) f.push(t.name);
      else f.push(t.name + '*(' + t.name + '-1)/2'); // stoich 2: X(X-1)/2
    }
    return f.join('*');
  }

  function parseModel(text) {
    const lines = String(text).split(/\r?\n/);
    const errors = [];
    const warnings = [];
    const fail = (ln, msg) => errors.push({ line: ln, text: (lines[ln - 1] || '').trim(), message: msg });
    const reactions = [];
    const assigns = new Map();
    const rxLine = new Map();

    lines.forEach((raw, i) => {
      const ln = i + 1;
      const code = stripComment(raw).trim();
      if (!code) return;

      if (/<->|<-|=>/.test(code)) {
        fail(ln, 'only one-way reactions with "->" are supported (write a reversible reaction as two lines)');
        return;
      }

      if (code.includes('->')) {
        const colon = code.indexOf(':');
        if (colon < 0 || code.indexOf('->') < colon) {
          fail(ln, 'reaction has no name; write it as "J1: A + B -> C; k1"');
          return;
        }
        const name = code.slice(0, colon).trim();
        if (!IDENT.test(name)) { fail(ln, 'invalid reaction name "' + name + '"'); return; }
        const rest = code.slice(colon + 1);
        const arrow = rest.indexOf('->');
        const lhs = rest.slice(0, arrow);
        const afterArrow = rest.slice(arrow + 2);
        const semi = afterArrow.indexOf(';');
        if (semi < 0) { fail(ln, 'missing ";" and a rate constant after the products'); return; }
        const rhs = afterArrow.slice(0, semi);
        let ratePart = afterArrow.slice(semi + 1).trim().replace(/;\s*$/, '').trim();
        if (!ratePart) { fail(ln, 'no rate constant given after ";"'); return; }

        let ok = true;
        const bad = (m) => { fail(ln, m); ok = false; };
        const reactants = parseSide(lhs, bad);
        const products = parseSide(rhs, bad);
        const total = reactants.reduce((a, t) => a + t.stoich, 0);
        if (ok && total > 2) bad('at most two reactant molecules per reaction (the reactant coefficients must sum to 2 or less)');
        if (rxLine.has(name)) bad('reaction name "' + name + '" already used on line ' + rxLine.get(name));

        let rate = null;
        if (IDENT.test(ratePart)) rate = ratePart;
        else if (NUMBER.test(ratePart)) bad('the rate constant must be a name such as k1, not a number; define it below, e.g. "k1 = 0.1"');
        else {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\*/.exec(ratePart);
          if (m && massActionLaw(m[1], reactants).replace(/\s+/g, '') === ratePart.replace(/\s+/g, '')) rate = m[1];
          else bad('only mass-action rate laws are supported: give the rate constant name (e.g. "k1"), or its explicit form "' +
            (m ? massActionLaw(m[1], reactants) : 'k*A*B') + '"');
        }
        if (!ok) return;
        rxLine.set(name, ln);
        reactions.push({ name, line: ln, reactants, products, rate });
        return;
      }

      const am = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*;?$/.exec(code);
      if (am) {
        const [, nm, val] = am;
        if (!NUMBER.test(val)) { fail(ln, 'the value of "' + nm + '" must be a plain number, found "' + val + '"'); return; }
        if (assigns.has(nm)) { fail(ln, '"' + nm + '" is given a value twice (first on line ' + assigns.get(nm).line + ')'); return; }
        assigns.set(nm, { value: Number(val), line: ln });
        return;
      }
      fail(ln, 'cannot understand this line; expected a reaction like "J1: A + B -> C; k1" or a value like "A = 100"');
    });

    // classify names as species or rate constants
    const speciesUse = new Map();
    const paramUse = new Map();
    for (const r of reactions) {
      for (const t of r.reactants.concat(r.products)) {
        if (paramUse.has(t.name)) {
          fail(r.line, '"' + t.name + '" is used as a rate constant on line ' + paramUse.get(t.name) + ' and as a species here');
          continue;
        }
        const u = speciesUse.get(t.name);
        if (!u) speciesUse.set(t.name, { line: r.line, boundary: t.boundary });
        else u.boundary = u.boundary || t.boundary;
      }
      if (speciesUse.has(r.rate)) {
        fail(r.line, '"' + r.rate + '" is used as a species on line ' + speciesUse.get(r.rate).line + ' and as a rate constant here');
        continue;
      }
      if (!paramUse.has(r.rate)) paramUse.set(r.rate, r.line);
    }

    for (const [nm, u] of speciesUse) {
      const a = assigns.get(nm);
      if (!a) fail(u.line, 'no initial value given for species "' + nm + '"');
      else if (!Number.isInteger(a.value) || a.value < 0) fail(a.line, 'initial value of species "' + nm + '" must be a whole number, 0 or more');
    }
    for (const [nm, ln] of paramUse) {
      const a = assigns.get(nm);
      if (!a) fail(ln, 'no value given for "' + nm + '"');
      else if (!isFinite(a.value) || a.value < 0) fail(a.line, 'rate constant "' + nm + '" must be 0 or more');
    }
    for (const [nm, a] of assigns) {
      if (!speciesUse.has(nm) && !paramUse.has(nm)) warnings.push({ line: a.line, message: '"' + nm + '" is given a value but never used in a reaction' });
    }
    if (reactions.length === 0 && errors.length === 0) errors.push({ line: null, text: '', message: 'the model has no reactions' });

    errors.sort((a, b) => (a.line === null) - (b.line === null) || a.line - b.line);

    const species = [...speciesUse].map(([name, u]) => ({
      name, boundary: u.boundary, init: assigns.has(name) ? assigns.get(name).value : NaN, line: u.line
    }));
    const params = [...paramUse].map(([name, line]) => ({ name, value: assigns.has(name) ? assigns.get(name).value : NaN, line }));
    return { ok: errors.length === 0, errors, warnings, species, params, reactions };
  }

  function summarizeModel(m) {
    const nb = m.species.filter(s => s.boundary).length;
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    return m.species.length + ' species' + (nb ? ' (' + nb + ' boundary)' : '') + ', ' +
      plural(m.reactions.length, 'reaction') + ', ' + plural(m.params.length, 'rate constant');
  }

  /* ------------------------------------------------------------------ */
  /* Compiler: stoichiometry and propensities                            */
  /* ------------------------------------------------------------------ */

  function compileModel(model) {
    const idx = new Map(model.species.map((s, i) => [s.name, i]));
    const kval = new Map(model.params.map(p => [p.name, p.value]));
    const nS = model.species.length;
    const reactions = model.reactions.map(r => {
      const delta = new Map();
      for (const t of r.reactants) { const i = idx.get(t.name); delta.set(i, (delta.get(i) || 0) - t.stoich); }
      for (const t of r.products) { const i = idx.get(t.name); delta.set(i, (delta.get(i) || 0) + t.stoich); }
      const dIdx = [], dVal = [];
      for (const [i, d] of delta) if (d !== 0 && !model.species[i].boundary) { dIdx.push(i); dVal.push(d); }
      return {
        name: r.name,
        c: kval.get(r.rate),
        rIdx: r.reactants.map(t => idx.get(t.name)),
        rSt: r.reactants.map(t => t.stoich),
        dIdx: Int32Array.from(dIdx),
        dVal: Float64Array.from(dVal)
      };
    });
    // stoichiometry matrix S[species][reaction]
    const stoich = model.species.map(() => reactions.map(() => 0));
    reactions.forEach((r, j) => r.dIdx.forEach((i, k) => { stoich[i][j] = r.dVal[k]; }));
    return {
      nS,
      names: model.species.map(s => s.name),
      boundary: Uint8Array.from(model.species.map(s => (s.boundary ? 1 : 0))),
      init: Float64Array.from(model.species.map(s => s.init)),
      reactions,
      stoich
    };
  }

  // a = c * h, h = prod_i C(X_i, s_i) for s_i in {1, 2}
  function propensity(rx, x) {
    let h = 1;
    for (let j = 0; j < rx.rIdx.length; j++) {
      const X = x[rx.rIdx[j]];
      h *= rx.rSt[j] === 1 ? X : X * (X - 1) / 2;
    }
    return rx.c * h;
  }

  /* ------------------------------------------------------------------ */
  /* Seeded random numbers                                               */
  /* ------------------------------------------------------------------ */

  function splitmix32(a) {
    return function () {
      a |= 0; a = (a + 0x9e3779b9) | 0;
      let t = a ^ (a >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      return (t = t ^ (t >>> 15)) >>> 0;
    };
  }

  // sfc32 seeded through splitmix32. Returns uniform numbers in [0, 1).
  function makeRng(seed) {
    const sm = splitmix32(seed >>> 0);
    let a = sm(), b = sm(), c = sm(), d = sm();
    const next = function () {
      a |= 0; b |= 0; c |= 0; d |= 0;
      let t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 12; i++) next();
    return next;
  }

  // r1 = 1 - u lies in (0, 1], so it is never 0 and ln(r1) is always finite.
  const r1From = u => 1 - u;

  function deriveSeed(master, i) {
    return splitmix32(((master >>> 0) ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0)() >>> 0;
  }

  function randomSeed() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
    return Math.floor(Math.random() * 4294967296);
  }

  // Seed box text -> {ok, value|null (blank), error}
  function parseSeed(str) {
    const s = String(str === undefined || str === null ? '' : str).trim();
    if (s === '') return { ok: true, value: null };
    if (!/^\d+$/.test(s) || Number(s) > 4294967295) return { ok: false, error: 'The seed must be a whole number from 0 to 4294967295 (or left blank).' };
    return { ok: true, value: Number(s) };
  }

  /* ------------------------------------------------------------------ */
  /* Gillespie direct method                                             */
  /* ------------------------------------------------------------------ */

  class Simulation {
    constructor(cm, seed, tEnd, rngOverride) {
      this.cm = cm;
      this.x = Float64Array.from(cm.init);
      this.t = 0;
      this.tEnd = tEnd;
      this.rng = rngOverride || makeRng(seed);
      this.a = new Float64Array(cm.reactions.length);
      this.done = false;
      this.events = 0;
      this.lastSteps = 0;
      this.observer = null;
    }
    step() {
      if (this.done) return;
      const rxs = this.cm.reactions, a = this.a, n = rxs.length;
      let a0 = 0;
      for (let i = 0; i < n; i++) { a[i] = propensity(rxs[i], this.x); a0 += a[i]; }
      if (!(a0 > 0)) { this.done = true; return; }
      const r1 = r1From(this.rng()), r2 = this.rng();
      const tn = this.t + (-Math.log(r1) / a0);
      if (tn > this.tEnd) { this.done = true; return; }
      let target = r2 * a0, acc = 0, j = 0;
      for (; j < n; j++) { acc += a[j]; if (target < acc) break; }
      if (j >= n) { j = n - 1; while (j > 0 && !(a[j] > 0)) j--; }
      const obs = this.observer;
      if (obs && obs.before) obs.before(tn, this.x);
      const rx = rxs[j];
      for (let k = 0; k < rx.dIdx.length; k++) this.x[rx.dIdx[k]] += rx.dVal[k];
      this.t = tn;
      this.events++;
      if (obs && obs.after) obs.after(tn, this.x, j);
    }
    advance(maxSteps) {
      let k = 0;
      while (!this.done && k < maxSteps) { this.step(); k++; }
      this.lastSteps = k;
      return this.done;
    }
  }

  class EventLog {
    constructor(nS) { this.nS = nS; this.cap = 1024; this.n = 0; this.t = new Float64Array(this.cap); this.x = new Float64Array(this.cap * nS); }
    push(t, x) {
      if (this.n === this.cap) {
        this.cap *= 2;
        const t2 = new Float64Array(this.cap); t2.set(this.t); this.t = t2;
        const x2 = new Float64Array(this.cap * this.nS); x2.set(this.x); this.x = x2;
      }
      this.t[this.n] = t;
      this.x.set(x, this.n * this.nS);
      this.n++;
    }
    column(s) {
      const out = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) out[i] = this.x[i * this.nS + s];
      return out;
    }
  }

  // One run that records every event.
  class SingleRunner {
    constructor(cm, seed, tEnd, opts) {
      opts = opts || {};
      this.cm = cm; this.seed = seed; this.tEnd = tEnd;
      this.maxEvents = opts.maxEvents || 2000000;
      this.sim = new Simulation(cm, seed, tEnd, opts.rng);
      this.log = new EventLog(cm.nS);
      this.log.push(0, this.sim.x);
      this.truncated = false;
      this.finished = false;
      const self = this;
      this.sim.observer = { after(t, x) { self.log.push(t, x); } };
    }
    advance(maxSteps) {
      if (this.finished) return true;
      this.sim.advance(maxSteps);
      if (!this.sim.done && this.log.n >= this.maxEvents) { this.truncated = true; this.sim.done = true; }
      if (this.sim.done) {
        this.log.push(this.truncated ? this.sim.t : this.tEnd, this.sim.x);
        this.finished = true;
      }
      return this.finished;
    }
    progress() { return this.finished ? 1 : Math.min(1, this.sim.t / this.tEnd); }
  }

  /* ------------------------------------------------------------------ */
  /* Gridding (last reaction at or before each grid time)                */
  /* ------------------------------------------------------------------ */

  function makeGrid(tEnd, dt) {
    if (!(dt > 0) || !(tEnd > 0)) throw new Error('end time and grid spacing must be positive');
    const n = Math.floor(tEnd / dt + 1e-9);
    if (n > 200000) throw new Error('grid spacing is too small: that would be more than 200000 grid points');
    const g = [];
    for (let k = 0; k <= n; k++) g.push(k * dt);
    if (tEnd - g[g.length - 1] > 1e-9 * tEnd) g.push(tEnd);
    return Float64Array.from(g);
  }

  // A grid point g takes the state after the last event with time <= g.
  class Gridder {
    constructor(grid, nS) {
      this.grid = grid; this.nS = nS; this.G = grid.length; this.idx = 0;
      this.out = new Float64Array(nS * this.G);
    }
    _fill(x) {
      for (let s = 0; s < this.nS; s++) this.out[s * this.G + this.idx] = x[s];
      this.idx++;
    }
    before(tn, xOld) { while (this.idx < this.G && this.grid[this.idx] < tn) this._fill(xOld); }
    finish(x) { while (this.idx < this.G) this._fill(x); }
  }

  // Helper for tests: events = [{t, state:[...]}] with the state AFTER the event.
  function gridTrajectory(initState, events, grid) {
    const g = new Gridder(grid, initState.length);
    let x = Float64Array.from(initState);
    for (const e of events) { g.before(e.t, x); x = Float64Array.from(e.state); }
    g.finish(x);
    return Array.from({ length: initState.length }, (_, s) => Array.from(g.out.subarray(s * g.G, (s + 1) * g.G)));
  }

  /* ------------------------------------------------------------------ */
  /* Ensembles                                                           */
  /* ------------------------------------------------------------------ */

  class EnsembleRunner {
    constructor(cm, opts) {
      this.cm = cm;
      this.N = opts.N; this.grid = opts.grid || new Float64Array(0);
      this.seed = opts.seed; this.tEnd = opts.tEnd;
      this.keepRuns = opts.keepRuns || 0; this.keepFinals = !!opts.keepFinals;
      const size = cm.nS * this.grid.length;
      this.mean = new Float64Array(size);
      this.m2 = new Float64Array(size);
      this.runs = []; this.finals = [];
      this.i = 0; this.sim = null; this.gridder = null;
    }
    _accumulate() {
      const out = this.gridder.out, n = this.i + 1;
      for (let k = 0; k < out.length; k++) {
        const d = out[k] - this.mean[k];
        this.mean[k] += d / n;
        this.m2[k] += d * (out[k] - this.mean[k]);
      }
      if (this.runs.length < this.keepRuns) this.runs.push(out);
      if (this.keepFinals) this.finals.push(Float64Array.from(this.sim.x));
    }
    advance(maxSteps) {
      let budget = maxSteps;
      while (budget > 0 && this.i < this.N) {
        if (!this.sim) {
          this.sim = new Simulation(this.cm, deriveSeed(this.seed, this.i), this.tEnd);
          this.gridder = new Gridder(this.grid, this.cm.nS);
          this.sim.observer = this.gridder;
        }
        this.sim.advance(budget);
        budget -= Math.max(1, this.sim.lastSteps);
        if (this.sim.done) {
          this.gridder.finish(this.sim.x);
          this._accumulate();
          this.sim = null; this.i++;
        }
      }
      return this.i >= this.N;
    }
    progress() { return Math.min(1, (this.i + (this.sim ? Math.min(1, this.sim.t / this.tEnd) : 0)) / this.N); }
    result() {
      const n = this.i, sd = new Float64Array(this.m2.length);
      if (n > 1) for (let k = 0; k < sd.length; k++) sd[k] = Math.sqrt(Math.max(0, this.m2[k]) / (n - 1));
      return { names: this.cm.names, nS: this.cm.nS, times: this.grid, G: this.grid.length, mean: this.mean, sd, n, runs: this.runs, finals: this.finals };
    }
  }

  function runToEnd(runner, chunk) {
    while (!runner.advance(chunk || 100000)) { /* keep going */ }
    return runner;
  }

  /* ------------------------------------------------------------------ */
  /* CSV                                                                 */
  /* ------------------------------------------------------------------ */

  function singleRunCSV(names, log) {
    const rows = ['time,' + names.join(',')];
    for (let i = 0; i < log.n; i++) {
      const r = [String(log.t[i])];
      for (let s = 0; s < log.nS; s++) r.push(String(log.x[i * log.nS + s]));
      rows.push(r.join(','));
    }
    return rows.join('\n') + '\n';
  }

  function ensembleCSV(res) {
    const head = ['time'];
    res.names.forEach(n => { head.push(n + '_mean', n + '_sd'); });
    const rows = [head.join(',')];
    for (let g = 0; g < res.G; g++) {
      const r = [String(res.times[g])];
      for (let s = 0; s < res.nS; s++) r.push(String(res.mean[s * res.G + g]), String(res.sd[s * res.G + g]));
      rows.push(r.join(','));
    }
    return rows.join('\n') + '\n';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateStamp(d) { d = d || new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  /* ------------------------------------------------------------------ */
  /* Antimony export                                                     */
  /* ------------------------------------------------------------------ */

  function fmtTerm(t, boundarySet) {
    return (t.stoich > 1 ? t.stoich + ' ' : '') + (boundarySet.has(t.name) ? '$' : '') + t.name;
  }

  function exportAntimony(model) {
    const bset = new Set(model.species.filter(s => s.boundary).map(s => s.name));
    const out = ['// Exported by the stochastic reaction simulator (mass-action rate laws written out)'];
    for (const r of model.reactions) {
      const lhs = r.reactants.map(t => fmtTerm(t, bset)).join(' + ');
      const rhs = r.products.map(t => fmtTerm(t, bset)).join(' + ');
      out.push(r.name + ': ' + lhs + ' -> ' + rhs + '; ' + massActionLaw(r.rate, r.reactants));
    }
    out.push('');
    for (const s of model.species) out.push(s.name + ' = ' + s.init);
    for (const p of model.params) out.push(p.name + ' = ' + p.value);
    return out.join('\n') + '\n';
  }

  function modelsEqual(a, b) {
    const sig = m => JSON.stringify({
      s: m.species.map(s => [s.name, s.boundary, s.init]),
      p: m.params.map(p => [p.name, p.value]),
      r: m.reactions.map(r => [r.name, r.reactants.map(t => [t.name, t.stoich]), r.products.map(t => [t.name, t.stoich]), r.rate])
    });
    return sig(a) === sig(b);
  }

  /* ------------------------------------------------------------------ */
  /* Saved seeds                                                         */
  /* ------------------------------------------------------------------ */

  function memoryStorage() {
    const d = {};
    return { getItem: k => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); } };
  }

  class SeedStore {
    constructor(storage, key) { this.storage = storage; this.key = key || 'gillespie.savedSeeds'; }
    list() { try { return JSON.parse(this.storage.getItem(this.key) || '[]'); } catch (e) { return []; } }
    _save(a) { try { this.storage.setItem(this.key, JSON.stringify(a)); } catch (e) { /* storage unavailable */ } }
    add(entry) {
      const e = Object.assign({}, entry, { id: Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36), savedAt: new Date().toISOString() });
      const a = this.list(); a.unshift(e); this._save(a); return e;
    }
    get(id) { return this.list().find(e => e.id === id) || null; }
    remove(id) { this._save(this.list().filter(e => e.id !== id)); }
    clear() { this._save([]); }
  }

  /* ------------------------------------------------------------------ */
  /* Validation maths                                                    */
  /* ------------------------------------------------------------------ */

  function histogram(values) {
    let min = Infinity, max = -Infinity, allInt = true;
    for (const v of values) { if (v < min) min = v; if (v > max) max = v; if (!Number.isInteger(v)) allInt = false; }
    if (!values.length) return { edges: [0, 1], counts: [0] };
    if (allInt && max - min <= 60) {
      const counts = new Array(max - min + 1).fill(0);
      for (const v of values) counts[v - min]++;
      return { edges: Array.from({ length: counts.length + 1 }, (_, i) => min - 0.5 + i), counts };
    }
    if (min === max) return { edges: [min - 0.5, max + 0.5], counts: [values.length] };
    const nb = 30, w = (max - min) / nb, counts = new Array(nb).fill(0);
    for (const v of values) counts[Math.min(nb - 1, Math.floor((v - min) / w))]++;
    return { edges: Array.from({ length: nb + 1 }, (_, i) => min + i * w), counts };
  }

  // V1: mean, variance, variance/mean of final values; pass if ratio within 10% of 1.
  function v1Stats(cm, finals, tol) {
    tol = tol === undefined ? 0.10 : tol;
    const rows = [];
    for (let s = 0; s < cm.nS; s++) {
      if (cm.boundary[s]) continue;
      const vals = finals.map(f => f[s]), n = vals.length;
      const mean = vals.reduce((a, b) => a + b, 0) / n;
      const variance = n > 1 ? vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
      const ratio = mean > 0 ? variance / mean : NaN;
      const status = Number.isNaN(ratio) ? 'n/a' : (Math.abs(ratio - 1) <= tol ? 'PASS' : 'FAIL');
      rows.push({ species: cm.names[s], mean, variance, ratio, status, hist: histogram(vals) });
    }
    const defined = rows.filter(r => r.status !== 'n/a');
    const overall = defined.length === 0 ? 'N/A' : (defined.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL');
    return { rows, overall, n: finals.length };
  }

  // Parse the gridded-ensemble CSV (same format the platform and the Tellurium script write).
  function parseEnsembleCSV(text) {
    const lines = String(text).split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) throw new Error('The file has no data rows.');
    const head = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const ti = head.findIndex(h => /^\[?time\]?$/i.test(h));
    if (ti < 0) throw new Error('No "time" column found in the header.');
    const species = {};
    head.forEach((h, i) => {
      const m = /^(.+)_(mean|sd)$/.exec(h);
      if (m) { (species[m[1]] = species[m[1]] || {})[m[2] + 'Col'] = i; }
    });
    const names = Object.keys(species).filter(n => species[n].meanCol !== undefined && species[n].sdCol !== undefined);
    if (!names.length) throw new Error('No "<species>_mean" and "<species>_sd" column pairs found in the header.');
    const times = [], out = {};
    names.forEach(n => { out[n] = { mean: [], sd: [] }; });
    for (let r = 1; r < lines.length; r++) {
      const c = lines[r].split(',');
      const t = Number(c[ti]);
      if (!isFinite(t)) throw new Error('Row ' + (r + 1) + ': time is not a number.');
      times.push(t);
      for (const n of names) {
        const m = Number(c[species[n].meanCol]), s = Number(c[species[n].sdCol]);
        if (!isFinite(m) || !isFinite(s)) throw new Error('Row ' + (r + 1) + ': a value for "' + n + '" is not a number.');
        out[n].mean.push(m); out[n].sd.push(s);
      }
    }
    return { times, names, species: out };
  }

  // V2: z-scores of the means (and of the SDs) between two ensembles.
  function compareEnsembles(ours, theirs, nOurs, nTheirs, opts) {
    opts = opts || {};
    const zLimit = opts.zLimit || 3, fracLimit = opts.fracLimit || 0.01, sdFracLimit = opts.sdFracLimit || 0.02, driftLimit = opts.driftLimit || 1;
    const perSpecies = [];
    let total = 0, exceed = 0, sdExceed = 0, maxAbs = 0;
    for (const name of theirs.names) {
      const s = ours.names.indexOf(name);
      if (s < 0) continue;
      const z = [], zsd = [];
      for (let g = 0; g < ours.G; g++) {
        const m1 = ours.mean[s * ours.G + g], s1 = ours.sd[s * ours.G + g];
        const m2 = theirs.species[name].mean[g], s2 = theirs.species[name].sd[g];
        const se = Math.sqrt(s1 * s1 / nOurs + s2 * s2 / nTheirs);
        const zz = se > 0 ? (m1 - m2) / se : (Math.abs(m1 - m2) < 1e-12 ? 0 : Infinity);
        const sese = Math.sqrt(s1 * s1 / (2 * (nOurs - 1)) + s2 * s2 / (2 * (nTheirs - 1)));
        const zs = sese > 0 ? (s1 - s2) / sese : (Math.abs(s1 - s2) < 1e-12 ? 0 : Infinity);
        z.push(zz); zsd.push(zs);
        total++;
        if (Math.abs(zz) > zLimit) exceed++;
        if (Math.abs(zs) > zLimit) sdExceed++;
        if (Math.abs(zz) > maxAbs) maxAbs = Math.abs(zz);
      }
      const meanZ = z.reduce((a, b) => a + b, 0) / z.length;
      perSpecies.push({ name, z, zsd, meanZ, drift: Math.abs(meanZ) > driftLimit });
    }
    const fracMean = total ? exceed / total : 0, fracSd = total ? sdExceed / total : 0;
    const pass = total > 0 && fracMean <= fracLimit && fracSd <= sdFracLimit && !perSpecies.some(p => p.drift);
    return { perSpecies, total, exceed, sdExceed, fracMean, fracSd, maxAbsZ: maxAbs, pass };
  }

  /* ------------------------------------------------------------------ */
  /* V3: seed test                                                       */
  /* ------------------------------------------------------------------ */

  function csvSingle(cm, seed, tEnd) {
    const r = runToEnd(new SingleRunner(cm, seed, tEnd));
    return singleRunCSV(cm.names, r.log);
  }
  function csvEnsemble(cm, seed, tEnd, N, grid) {
    const r = runToEnd(new EnsembleRunner(cm, { N, grid, seed, tEnd }));
    return ensembleCSV(r.result());
  }

  // Returns a list of checks; each has run() -> {pass, detail}.
  function buildV3Checks(cm, opts) {
    const tEnd = opts.tEnd, N = opts.N || 10;
    const grid = opts.grid || makeGrid(tEnd, tEnd / 50);
    const store = opts.store || new SeedStore(memoryStorage());
    const s1 = opts.seed === undefined || opts.seed === null ? randomSeed() : opts.seed;
    const s2 = (s1 + 1) >>> 0;
    const same = (a, b) => ({ pass: a === b, detail: a === b ? 'files are byte-for-byte identical' : 'files differ' });
    const differ = (a, b) => ({ pass: a !== b, detail: a !== b ? 'files differ, as required' : 'files are identical (the model may fire no reactions, so seeds cannot be told apart)' });
    return [
      { name: 'Single run: same seed twice gives identical CSV', run: () => same(csvSingle(cm, s1, tEnd), csvSingle(cm, s1, tEnd)) },
      { name: 'Single run: different seeds give different CSV', run: () => differ(csvSingle(cm, s1, tEnd), csvSingle(cm, s2, tEnd)) },
      { name: 'Ensemble: same seed twice gives identical CSV', run: () => same(csvEnsemble(cm, s1, tEnd, N, grid), csvEnsemble(cm, s1, tEnd, N, grid)) },
      { name: 'Ensemble: different seeds give different CSV', run: () => differ(csvEnsemble(cm, s1, tEnd, N, grid), csvEnsemble(cm, s2, tEnd, N, grid)) },
      {
        name: 'A displayed random seed, typed back in, reproduces the run',
        run: () => {
          const shown = randomSeed();
          const typed = parseSeed(String(shown));
          if (!typed.ok || typed.value !== shown) return { pass: false, detail: 'seed text did not parse back to the same number' };
          return same(csvSingle(cm, shown, tEnd), csvSingle(cm, typed.value, tEnd));
        }
      },
      {
        name: 'Re-run from a saved seed reproduces the original CSV (single and ensemble)',
        run: () => {
          const origS = csvSingle(cm, s1, tEnd), origE = csvEnsemble(cm, s1, tEnd, N, grid);
          const eS = store.add({ seed: s1, kind: 'single', settings: { endTime: tEnd } });
          const eE = store.add({ seed: s1, kind: 'ensemble', settings: { endTime: tEnd, N } });
          const gotS = store.get(eS.id), gotE = store.get(eE.id);
          store.remove(eS.id); store.remove(eE.id);
          if (!gotS || !gotE) return { pass: false, detail: 'saved seed could not be read back' };
          const a = same(origS, csvSingle(cm, gotS.seed, gotS.settings.endTime));
          const b = same(origE, csvEnsemble(cm, gotE.seed, gotE.settings.endTime, gotE.settings.N, grid));
          return { pass: a.pass && b.pass, detail: a.pass && b.pass ? 'both reproduced exactly' : 'a re-run from a saved seed differed' };
        }
      }
    ];
  }

  return {
    parseModel, summarizeModel, compileModel, propensity, massActionLaw,
    makeRng, r1From, deriveSeed, randomSeed, parseSeed,
    Simulation, SingleRunner, EventLog, Gridder, gridTrajectory, makeGrid, EnsembleRunner, runToEnd,
    singleRunCSV, ensembleCSV, dateStamp,
    exportAntimony, modelsEqual,
    SeedStore, memoryStorage,
    histogram, v1Stats, parseEnsembleCSV, compareEnsembles, buildV3Checks, csvSingle, csvEnsemble
  };
});
