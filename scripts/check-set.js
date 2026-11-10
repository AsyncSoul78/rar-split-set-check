#!/usr/bin/env node
'use strict';
// Checks split RAR sets in a folder (or the set a given part belongs to):
// which parts are there, which are missing or cut off, which file to open first,
// and which stored files can still be taken out if the set is not complete.
//
//   node scripts/check-set.js <folder | any part of the set> [--json]
// Exit code: 0 every set is complete, 1 something is missing or broken, 2 usage error.

const fs = require('fs');
const path = require('path');
const { readRar } = require('./rar-headers');

const UNFINISHED = /\.(crdownload|part|partial|download|opdownload|tmp)$/i;

// "Trip.part03.rar" -> {set: "Trip", number: 3, style: "partN"}
// "Trip.rar" -> {set: "Trip", number: 1, style: "rNN?"}; "Trip.r00" -> number 2, "Trip.r01" -> 3
function nameInfo(file) {
  const base = path.basename(file);
  let m = base.match(/^(.*)\.part(\d+)\.rar$/i);
  if (m) return { set: m[1], number: parseInt(m[2], 10), style: 'partN', digits: m[2].length };
  m = base.match(/^(.*)\.r(\d\d)$/i);
  if (m) return { set: m[1], number: parseInt(m[2], 10) + 2, style: 'rNN' };
  m = base.match(/^(.*)\.rar$/i);
  if (m) return { set: m[1], number: 1, style: 'rar' };
  return null;
}

function collect(target) {
  const stat = fs.statSync(target);
  const dir = stat.isDirectory() ? target : path.dirname(target);
  const names = fs.readdirSync(dir).sort();
  const sets = new Map();
  const unfinished = [];
  for (const n of names) {
    const full = path.join(dir, n);
    if (!fs.statSync(full).isFile()) continue;
    if (UNFINISHED.test(n)) { unfinished.push(n); continue; }
    const info = nameInfo(n);
    if (!info) continue;
    if (!sets.has(info.set)) sets.set(info.set, []);
    sets.get(info.set).push({ ...info, file: full, name: n });
  }
  // A lone "name.rar" next to "name.r00" belongs to the old-style set; "name.rar" next to "name.partN.rar" does not.
  for (const [key, parts] of sets) {
    const styles = new Set(parts.map((p) => p.style));
    if (styles.has('partN') && styles.has('rar')) {
      const lone = parts.filter((p) => p.style === 'rar');
      sets.set(key, parts.filter((p) => p.style !== 'rar'));
      sets.set(`${key} (single file)`, lone);
    }
  }
  let chosen = [...sets.entries()];
  if (!stat.isDirectory()) {
    const own = nameInfo(target);
    chosen = chosen.filter(([k]) => own && k === own.set);
  }
  return { dir, sets: chosen, unfinished };
}

function mostCommon(values) {
  const count = new Map();
  for (const v of values) count.set(v, (count.get(v) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

function checkSet(key, parts, unfinished) {
  parts.sort((a, b) => a.number - b.number);
  const vols = parts.map((p) => { const head = readRar(p.file); return { ...p, size: head.size, head }; });
  const problems = [];
  const single = vols.length === 1 && vols[0].style === 'rar' && vols[0].head.volume === false;

  for (const v of vols) {
    if (v.head.problem) problems.push(`${v.name}: ${v.head.problem}`);
    else if (!v.head.volume && !single) problems.push(`${v.name}: not a part of a split archive`);
    if (v.head.number && v.head.number !== v.number) {
      problems.push(`${v.name}: the header says this is part ${v.head.number}, the name says ${v.number} (renamed?)`);
    }
  }
  const numbers = vols.map((v) => v.number);
  const top = Math.max(...numbers);
  const missing = [];
  for (let n = 1; n <= top; n++) if (!numbers.includes(n)) missing.push(n);
  const last = vols[vols.length - 1];
  const moreAfterLast = !single && last.head.continues === true;
  if (missing.length) problems.push(`missing part${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  if (moreAfterLast) problems.push(`${last.name} says the set goes on: at least part ${top + 1} is missing`);

  if (vols.length > 2) {
    const inner = vols.filter((v) => v !== last && v.head.continues !== false);
    const usual = mostCommon(inner.map((v) => v.size));
    for (const v of inner) {
      if (v.size < usual) problems.push(`${v.name}: ${v.size} bytes, the other parts have ${usual} (download cut off?)`);
    }
  }
  const stem = key.replace(/ \(single file\)$/, '');
  const pending = unfinished.filter((n) => n.toLowerCase().startsWith(stem.toLowerCase() + '.'));
  for (const n of pending) problems.push(`${n}: still downloading or an unfinished download`);

  // Which stored files sit completely inside parts we have, with no gap before them.
  const files = [];
  const open = new Map();
  for (const v of vols) {
    for (const e of v.head.entries) {
      if (!e.fromPrevious) open.set(e.name, { name: e.name, from: v.number, to: v.number });
      const f = open.get(e.name) || { name: e.name, from: null, to: v.number };
      f.to = v.number;
      if (!e.toNext) { files.push(f); open.delete(e.name); }
    }
  }
  for (const f of open.values()) files.push({ ...f, to: null });
  const broken = vols.some((v) => v.head.problem);
  const solid = vols.some((v) => v.head.solid);
  for (const f of files) {
    const span = [];
    for (let n = f.from; f.from && f.to && n <= f.to; n++) span.push(n);
    f.complete = !!(f.from && f.to) && span.every((n) => numbers.includes(n)
      && !vols.find((v) => v.number === n).head.problem);
    if (solid && missing.some((m) => m < (f.from || 0))) f.complete = false;
  }
  const first = vols.find((v) => v.number === 1);
  return {
    set: key, parts: vols.map((v) => ({
      name: v.name, number: v.number, size: v.size, format: v.head.format,
      continues: v.head.continues, headerNumber: v.head.number,
    })),
    complete: problems.length === 0,
    openFirst: first ? first.name : null,
    solid, encryptedHeaders: vols.some((v) => v.head.encryptedHeaders), broken,
    problems, files,
  };
}

function report(r) {
  const out = [];
  out.push(`Set "${r.set}": ${r.parts.length} file${r.parts.length > 1 ? 's' : ''}`);
  for (const p of r.parts) {
    const tail = p.continues === true ? 'goes on in the next part' : p.continues === false ? 'last part' : '';
    out.push(`  ${p.name.padEnd(28)} ${String(p.size).padStart(9)} bytes  ${p.format || '?'}  ${tail}`.trimEnd());
  }
  if (r.encryptedHeaders) out.push('  File names are encrypted: only the parts themselves were checked.');
  if (r.complete) {
    out.push(`Complete. Open ${r.openFirst} and keep the other parts in the same folder.`);
    return out.join('\n');
  }
  out.push('Not complete:');
  for (const p of r.problems) out.push(`  - ${p}`);
  if (r.files.length && !r.encryptedHeaders) {
    const ok = r.files.filter((f) => f.complete).map((f) => f.name);
    const bad = r.files.filter((f) => !f.complete).map((f) => f.name);
    if (r.solid && bad.length) out.push('Solid archive: every file after a gap depends on the missing data.');
    if (ok.length) out.push(`Can still be taken out: ${ok.join(', ')}`);
    if (bad.length) out.push(`Need the missing data: ${bad.join(', ')}`);
  }
  return out.join('\n');
}

function main(argv) {
  const target = argv.find((a) => !a.startsWith('--'));
  if (!target || !fs.existsSync(target)) {
    console.error('usage: node scripts/check-set.js <folder | part of a set> [--json]');
    return 2;
  }
  const { sets, unfinished } = collect(target);
  if (!sets.length) { console.error('no RAR files found'); return 2; }
  const results = sets.map(([k, parts]) => checkSet(k, parts, unfinished));
  if (argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else console.log(results.map(report).join('\n\n'));
  return results.every((r) => r.complete) ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { nameInfo, collect, checkSet, report, main };
