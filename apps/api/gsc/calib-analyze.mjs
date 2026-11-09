// Analizador de iw4x-ranking-calib.txt — dump de CALIBRACIÓN del GSC v3.
//
// Uso: node gsc/calib-analyze.mjs "<raíz del juego>/userraw/scriptdata/iw4x-ranking-calib.txt"
//
// Los valores del dueño se MUEVEN mientras juega (sigue en partida), así que NO
// bastan igualdades exactas: por cada índice del dump construimos la HISTORIA de
// valores a lo largo de los ciclos (#cycle N guid=... name=...) y puntuamos
// candidatos por cercanía a los anclas conocidas (Barracks), patrón de
// crecimiento plausible y ausencia de ruido (floats/texto del buffer).
//
// SOLO LECTURA: este script no escribe nada.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('uso: node gsc/calib-analyze.mjs <calib.txt>'); process.exit(1); }

const text = readFileSync(file, 'utf8');

// ── Parse: bloques "#cycle n guid=g name=n" + líneas "index;valor" ───────────
const cycles = [];
let cur = null;
for (const line of text.split(/\r?\n/)) {
  const t = line.trim();
  if (t === '' || t.startsWith('#iw4x-ranking')) continue;
  if (t.startsWith('#cycle')) {
    const m = t.match(/^#cycle\s+(\d+)\s+guid=(\S+)\s+name=(.*)$/);
    cur = { n: m ? Number(m[1]) : cycles.length + 1, guid: m?.[2] ?? '?', name: m?.[3] ?? '?', values: new Map() };
    cycles.push(cur);
    continue;
  }
  const m = t.match(/^(\d+);(-?\d+)$/);
  if (m && cur) cur.values.set(Number(m[1]), Number(m[2]));
}

console.log(`ciclos: ${cycles.length}`);
for (const c of cycles) console.log(`  #${c.n} guid=${c.guid} name=${c.name} valores=${c.values.size}`);
if (cycles.length === 0) { console.error('sin ciclos'); process.exit(0); }

// Historia por índice (null = el ciclo no lo vio, p.ej. apareció a 0 después).
const indexes = new Set();
for (const c of cycles) for (const i of c.values.keys()) indexes.add(i);
const history = new Map();
for (const i of indexes) history.set(i, cycles.map((c) => (c.values.has(i) ? c.values.get(i) : null)));

// ── Anclas conocidas (Barracks del dueño al inicio de la sesión) ─────────────
const ANCHORS = [
  { field: 'XP total', target: 4840, tol: 2500, grow: 'fast' },
  { field: 'kills', target: 40, tol: 60, grow: 'slow' },
  { field: 'headshots', target: 5, tol: 15, grow: 'rare' },
  { field: 'score', target: 4000, tol: 5000, grow: 'fast' },
  { field: 'deaths', target: 1, tol: 5, grow: 'rare' },
  { field: 'wins', target: 1, tol: 2, grow: 'const' },
  { field: 'losses', target: 1, tol: 2, grow: 'const' },
];

function scoreIndex(idx) {
  const hist = history.get(idx);
  const defined = hist.filter((v) => v !== null);
  if (defined.length === 0) return [];
  const first = defined[0];
  const last = defined[defined.length - 1];
  const results = [];
  for (const a of ANCHORS) {
    let hit = null;
    for (let ci = 0; ci < hist.length; ci++) {
      const v = hist[ci];
      if (v !== null && Math.abs(v - a.target) <= a.tol) { hit = { cycle: cycles[ci].n, value: v }; break; }
    }
    if (hit === null) continue;
    const delta = last - first;
    const nonDecreasing = defined.every((v, k) => k === 0 || v >= defined[k - 1]);
    let growOk = true;
    if (a.grow === 'const') growOk = Math.abs(delta) <= 2;
    else if (a.grow === 'rare') growOk = delta >= 0 && delta <= Math.max(4, defined.length);
    else if (a.grow === 'slow') growOk = delta >= 0 && delta <= defined.length * 3;
    else if (a.grow === 'fast') growOk = delta >= 0;
    const noise = defined.some((v) => v > 100_000_000 || v < -100_000_000);
    results.push({ field: a.field, hit, delta, nonDecreasing, growOk, noise, n: defined.length });
  }
  return results;
}

const byField = new Map();
for (const idx of [...indexes].sort((x, y) => x - y)) {
  for (const r of scoreIndex(idx)) {
    if (!byField.has(r.field)) byField.set(r.field, []);
    byField.get(r.field).push({ idx, ...r });
  }
}

for (const [field, cands] of byField) {
  const a = ANCHORS.find((x) => x.field === field);
  cands.sort((p, q) => {
    const ps = (p.growOk ? 0 : 10) + (p.noise ? 5 : 0) + Math.abs(p.hit.value - a.target) / a.tol;
    const qs = (q.growOk ? 0 : 10) + (q.noise ? 5 : 0) + Math.abs(q.hit.value - a.target) / a.tol;
    return ps - qs;
  });
  console.log(`\n== ${field} (ancla ${a.target} ±${a.tol}) ==`);
  for (const c of cands.slice(0, 8)) {
    console.log(`  idx ${c.idx}: hit ciclo#${c.hit.cycle} valor=${c.hit.value} delta=${c.delta} noDecr=${c.nonDecreasing} growOk=${c.growOk} noise=${c.noise} muestras=${c.n} hist=[${history.get(c.idx).slice(0, 12).join(',')}]`);
  }
}

console.log('\n== búsqueda EXACTA (algún ciclo) ==');
for (const a of ANCHORS) {
  const hits = [];
  for (const idx of indexes) {
    const hist = history.get(idx);
    for (let ci = 0; ci < hist.length; ci++) {
      if (hist[ci] === a.target) { hits.push(`idx ${idx} ciclo#${cycles[ci].n}`); break; }
    }
  }
  console.log(`  ${a.target} (${a.field}): ${hits.length ? hits.join(', ') : 'SIN OCURRENCIA'}`);
}

console.log('\n== candidatos timePlayed (crece ~+1/ciclo desde 1..600) ==');
for (const idx of [...indexes].sort((x, y) => x - y)) {
  const hist = history.get(idx).filter((v) => v !== null);
  if (hist.length < 3 || hist[0] < 1 || hist[0] > 600) continue;
  const deltas = hist.slice(1).map((v, k) => v - hist[k]);
  if (deltas.every((d) => d >= 0 && d <= 2) && hist[hist.length - 1] > hist[0]) {
    console.log(`  idx ${idx}: ${hist.join(' → ')}`);
  }
}
