// Unit tests for core.js. Run with:  node test_core.js
const C = require('./core.js');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'expected equal') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'expected near') + ': got ' + a + ', want ' + b + ' ± ' + tol); }
function ok(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
const build = txt => { const m = C.parseModel(txt); if (!m.ok) throw new Error(JSON.stringify(m.errors)); return { m, cm: C.compileModel(m) }; };

const DEFAULT = '# A and B bind to form C\nJ1: A + B -> C; k1\n\nA = 100\nB = 100\nC = 0\nk1 = 0.001\n';

console.log('Parser');
test('valid models load', () => {
  const { m } = build(DEFAULT);
  eq(m.species.map(s => s.name).join(), 'A,B,C');
  eq(m.reactions.length, 1); eq(m.params[0].value, 0.001);
  ok(C.summarizeModel(m).includes('3 species'));
});
test('blank lines, comments, trailing semicolons ignored', () => {
  build('// hi\n\nJ1: A -> B; k # c\nA = 5;\nB = 0\nk = 1e-2;\n');
});
test('missing value names the symbol and the right line', () => {
  const m = C.parseModel('J1: A -> B; k3\nA = 1\nB = 0\n');
  eq(m.ok, false); eq(m.errors.length, 1);
  eq(m.errors[0].line, 1); ok(m.errors[0].message.includes('"k3"'));
  const m2 = C.parseModel('J1: A -> B; k\nk = 1\nA = 1\n');
  ok(m2.errors[0].message.includes('species "B"'));
});
test('syntax errors report the correct line number', () => {
  const t = 'A = 1\nB = 0\nk = 1\nthis is nonsense\nJ1: A -> B; k\n';
  const m = C.parseModel(t); eq(m.errors[0].line, 4);
  eq(C.parseModel('J1 A -> B; k').errors[0].line, 1);
  eq(C.parseModel('\n\nJ1: A -> B\nA=1\nB=1').errors[0].line, 3);
  ok(C.parseModel('J1: A <-> B; k').errors[0].message.includes('one-way'));
  ok(C.parseModel('J1: 0 A -> B; k').errors[0].message.includes('positive whole'));
  ok(C.parseModel('J1: A + B + C -> D; k').errors[0].message.includes('two reactant'));
  ok(C.parseModel('J1: A -> B; 0.5').errors[0].message.includes('not a number'));
  ok(C.parseModel('J1: A -> B; k*A*A*A').errors[0].message.includes('mass-action'));
});
test('duplicates, conflicts and bad values are caught', () => {
  ok(C.parseModel('J1: A -> B; k\nJ1: B -> A; k\nA=1\nB=0\nk=1').errors.some(e => e.line === 2));
  ok(C.parseModel('J1: A -> B; k\nA=1\nA=2\nB=0\nk=1').errors.some(e => e.line === 3));
  ok(C.parseModel('J1: A -> B; A\nA=1\nB=0').errors.length > 0);
  ok(C.parseModel('J1: A -> B; k\nA=1.5\nB=0\nk=1').errors.some(e => e.line === 2));
});

console.log('Propensities');
test('each of the four rate laws matches hand calculation', () => {
  const { cm } = build('J0: -> A; k0\nJ1: A -> ; k1\nJ2: A + B -> C; k2\nJ3: 2 A -> D; k3\nA=10\nB=4\nC=0\nD=0\nk0=2\nk1=0.5\nk2=0.1\nk3=0.2\n');
  const x = cm.init, a = cm.reactions.map(r => C.propensity(r, x));
  near(a[0], 2, 1e-12); near(a[1], 5, 1e-12); near(a[2], 4, 1e-12);
  near(a[3], 0.2 * 10 * 9 / 2, 1e-12); // 9
  eq(C.propensity(cm.reactions[3], Float64Array.from([1, 0, 0, 0])), 0, 'one molecule cannot dimerise');
});

console.log('Stoichiometry and boundary species');
test('each reaction changes the right counts', () => {
  const { cm } = build('J1: 2 A + -> B; k\nJ2: A + B -> 3 C; k\nA=4\nB=1\nC=0\nk=1\n'.replace('2 A + ->', '2 A ->'));
  const S = cm.stoich;
  eq(S[0].join(), '-2,-1'); eq(S[1].join(), '1,-1'); eq(S[2].join(), '0,3');
});
test('$ species appear in propensity but never change', () => {
  const { cm } = build('J1: $S + A -> B; k\nJ2: B -> $S + A; k2\nS=5\nA=3\nB=0\nk=1\nk2=1\n');
  eq(cm.boundary[0], 1);
  near(C.propensity(cm.reactions[0], cm.init), 15, 1e-12);
  const sim = new C.Simulation(cm, 7, 50);
  sim.advance(1000);
  eq(sim.x[0], 5, 'boundary species changed'); ok(sim.events > 0);
  eq(sim.x[1] + sim.x[2], 3, 'A + B conserved');
});

console.log('Gillespie / one run');
test('tiny model checks out by hand (A -> B, k = 1, A = 2)', () => {
  const { cm } = build('J1: A -> B; k\nA=2\nB=0\nk=1\n');
  const us = [1 - Math.exp(-1), 0.3, 1 - Math.exp(-2), 0.3]; let i = 0;
  const sim = new C.Simulation(cm, 0, 2, () => us[i++]);
  sim.step(); near(sim.t, 0.5, 1e-12); eq(sim.x[0], 1); eq(sim.x[1], 1);
  sim.step(); eq(sim.done, true, 'second event at t = 2.5 is past the end time'); near(sim.t, 0.5, 1e-12);
});
test('single-run CSV starts at t=0 and ends at the end time', () => {
  const { cm } = build(DEFAULT);
  const csv = C.csvSingle(cm, 1, 100).trim().split('\n');
  eq(csv[0], 'time,A,B,C'); eq(csv[1], '0,100,100,0');
  eq(csv[csv.length - 1].split(',')[0], '100');
});

console.log('Gridding');
test('known firing times, including one exactly on a grid time', () => {
  // x: 5 -> 4 at t=0.5, -> 3 at t=2 (exactly on grid), -> 2 at t=2.7
  const g = C.gridTrajectory([5], [{ t: 0.5, state: [4] }, { t: 2, state: [3] }, { t: 2.7, state: [2] }], Float64Array.from([0, 1, 2, 3, 4]));
  eq(g[0].join(), '5,4,3,2,2');
});
test('mean and SD of a tiny example, by hand', () => {
  const { cm } = build('J1: A -> B; k\nA=1\nB=0\nk=1\n');
  // fake runs via the Gridder outputs: values at one grid point 2,4,6 -> mean 4, SD 2
  const r = new C.EnsembleRunner(cm, { N: 3, grid: Float64Array.from([1]), seed: 1, tEnd: 1 });
  const outs = [2, 4, 6];
  for (const v of outs) { r.gridder = { out: Float64Array.from([v, 0]) }; r.sim = { x: [0, 0] }; r._accumulate(); r.i++; }
  const res = r.result();
  near(res.mean[0], 4, 1e-12); near(res.sd[0], 2, 1e-12);
});

console.log('Ensembles');
test('A -> nothing follows A0 exp(-kt)', () => {
  const { cm } = build('J1: A -> ; k\nA=100\nk=0.5\n');
  const grid = C.makeGrid(4, 1), N = 1000;
  const res = C.runToEnd(new C.EnsembleRunner(cm, { N, grid, seed: 11, tEnd: 4 })).result();
  for (let g = 0; g < grid.length; g++) {
    const expMean = 100 * Math.exp(-0.5 * grid[g]);
    const se = Math.sqrt(100 * Math.exp(-0.5 * grid[g]) * (1 - Math.exp(-0.5 * grid[g])) / N) + 1e-9;
    near(res.mean[g], expMean, 4.5 * se + 1e-9, 'mean at t=' + grid[g]);
  }
});

console.log('Antimony export');
test('exporting and reading back gives the same model', () => {
  for (const t of [DEFAULT, 'J0: -> $S; k0\nJ1: A + $S -> 3 B + C; k1\nJ3: 2 A -> D; k3\nJ2: B -> ; k2\nS=1\nA=7\nB=0\nC=2\nD=0\nk0=0.1\nk1=0.01\nk2=2\nk3=0.3\n']) {
    const { m } = build(t);
    const txt = C.exportAntimony(m);
    const m2 = C.parseModel(txt);
    ok(m2.ok, 'export failed to reload: ' + JSON.stringify(m2.errors));
    ok(C.modelsEqual(m, m2), 'models differ');
  }
  ok(C.exportAntimony(build(DEFAULT).m).includes('J1: A + B -> C; k1*A*B'));
  ok(C.exportAntimony(build('J: 2 A -> B; k\nA=3\nB=0\nk=1').m).includes('k*A*(A-1)/2'));
});

console.log('Random numbers');
test('uniform mean and variance; r1 is never 0', () => {
  const rng = C.makeRng(123), n = 400000; let s = 0, s2 = 0, minR1 = 1;
  for (let i = 0; i < n; i++) { const u = rng(); s += u; s2 += u * u; minR1 = Math.min(minR1, C.r1From(u)); ok(u >= 0 && u < 1); }
  const mean = s / n, v = s2 / n - mean * mean;
  near(mean, 0.5, 0.005); near(v, 1 / 12, 0.002); ok(minR1 > 0);
  eq(C.r1From(0), 1, 'u = 0 must map to r1 = 1, not 0');
  eq(C.makeRng(5)(), C.makeRng(5)()); ok(C.makeRng(5)() !== C.makeRng(6)());
});
test('seed parsing', () => {
  eq(C.parseSeed('').value, null); eq(C.parseSeed(' 42 ').value, 42);
  eq(C.parseSeed('abc').ok, false); eq(C.parseSeed('-1').ok, false); eq(C.parseSeed('4294967296').ok, false);
});

console.log('Validation checks');
const BD = 'J1: -> X; kb\nJ2: X -> ; kd\nX=0\nkb=10\nkd=0.1\n';
test('V1: birth-death steady state has variance/mean near 1', () => {
  const { cm } = build(BD);
  const r = C.runToEnd(new C.EnsembleRunner(cm, { N: 1000, grid: new Float64Array(0), seed: 3, tEnd: 100, keepFinals: true }));
  const v = C.v1Stats(cm, r.finals);
  near(v.rows[0].mean, 100, 3); near(v.rows[0].ratio, 1, 0.15); ok(v.rows[0].hist.counts.length > 5);
});
test('V1: conserved default model reports n/a, not a crash', () => {
  const { cm } = build(DEFAULT);
  const r = C.runToEnd(new C.EnsembleRunner(cm, { N: 20, grid: new Float64Array(0), seed: 3, tEnd: 500, keepFinals: true }));
  ok(['n/a', 'PASS', 'FAIL'].includes(C.v1Stats(cm, r.finals).rows[0].status));
});
test('V2: two independent runs of our simulator agree; a shifted file fails', () => {
  const { cm } = build(DEFAULT);
  const grid = C.makeGrid(60, 2);
  const a = C.runToEnd(new C.EnsembleRunner(cm, { N: 500, grid, seed: 1, tEnd: 60 })).result();
  const b = C.runToEnd(new C.EnsembleRunner(cm, { N: 500, grid, seed: 999, tEnd: 60 })).result();
  const parsed = C.parseEnsembleCSV(C.ensembleCSV(b));
  eq(parsed.times.length, grid.length);
  const good = C.compareEnsembles(a, parsed, 500, 500);
  ok(good.pass, 'independent runs should agree: frac ' + good.fracMean + ' / ' + good.fracSd + ' maxz ' + good.maxAbsZ);
  const shifted = JSON.parse(JSON.stringify(parsed));
  shifted.species.A.mean = shifted.species.A.mean.map(v => v + 3);
  ok(!C.compareEnsembles(a, shifted, 500, 500).pass, 'a shifted mean must fail');
  let threw = false; try { C.parseEnsembleCSV('a,b\n1,2'); } catch (e) { threw = true; }
  ok(threw);
});
test('V3: every seed check passes on the default model', () => {
  const { cm } = build(DEFAULT);
  for (const c of C.buildV3Checks(cm, { tEnd: 100, N: 8 })) { const r = c.run(); ok(r.pass, c.name + ' — ' + r.detail); }
});
test('V3: reports failure when the model never fires', () => {
  const { cm } = build('J1: A -> B; k\nA=0\nB=0\nk=1\n');
  ok(C.buildV3Checks(cm, { tEnd: 10, N: 4 }).some(c => !c.run().pass));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
