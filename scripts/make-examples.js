#!/usr/bin/env node
'use strict';
// Rebuilds the example sets in examples/ with the command-line RAR from WinRAR.
// Not needed for the tests: the examples are already in the repository.
//
//   node scripts/make-examples.js [path to rar]
// The content is made up here: garden notes and two generated tables, nothing personal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAR = process.argv[2] || (process.platform === 'win32' ? 'C:/Program Files/WinRAR/Rar.exe' : 'rar');
const root = path.join(__dirname, '..', 'examples');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rar-examples-'));
const src = path.join(work, 'Garden plans');
fs.mkdirSync(src, { recursive: true });

const beds = ['Front bed', 'Back fence', 'Vegetable box', 'Herb pots', 'Rose arch'];
const rows = ['date,bed,litres,note'];
let day = new Date(Date.UTC(2026, 3, 1));
for (let i = 0; i < 330; i++) {
  const bed = beds[i % beds.length];
  const litres = 2 + ((i * 7) % 9);
  const note = i % 11 === 0 ? 'rain in the evening' : i % 7 === 0 ? 'mulch topped up' : '';
  rows.push(`${day.toISOString().slice(0, 10)},${bed},${litres},${note}`);
  if (i % beds.length === beds.length - 1) day = new Date(day.getTime() + 86400000);
}
fs.writeFileSync(path.join(src, 'Watering log.csv'), rows.join('\r\n') + '\r\n');

const plants = ['tulip', 'daffodil', 'lavender', 'sweet pea', 'tomato', 'basil', 'lettuce', 'radish', 'rosemary', 'mint'];
const cal = ['plant,sow indoors,plant out,harvest or bloom'];
for (let i = 0; i < 160; i++) {
  const p = plants[i % plants.length];
  const m = (k) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(i + k) % 12];
  cal.push(`${p} (bed ${1 + (i % 8)}),${m(1)},${m(3)},${m(6)}`);
}
fs.writeFileSync(path.join(src, 'Seed calendar.csv'), cal.join('\r\n') + '\r\n');
fs.writeFileSync(path.join(src, 'Shopping.txt'), [
  'Garden shopping', '', '- 3 bags of compost', '- seed packets (basil, lettuce, radish)', '- 12 tulip bulbs',
  '- new watering can', '- gloves', ''].join('\r\n'));

function build(dir, name, extra) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // -m0 store, -v5k volumes of 5120 bytes, -ep1 paths start at "Garden plans/", -tl/-tsm- fixed times off
  execFileSync(RAR, ['a', '-r', '-ep1', '-m0', '-v5k', '-idq', '-tsm-', '-tsc-', '-tsa-', ...extra,
    path.join(dir, name), src], { cwd: work });
}

build(path.join(root, 'complete'), 'Garden plans.rar', []);
build(path.join(root, 'old-style'), 'Garden plans.rar', ['-ma4', '-vn']);

const parts = fs.readdirSync(path.join(root, 'complete')).sort();
for (const [dirName, change] of [
  ['missing-part', (dir) => fs.rmSync(path.join(dir, parts[1]))],
  ['cut-download', (dir) => {
    const f = path.join(dir, parts[1]);
    fs.writeFileSync(f, fs.readFileSync(f).subarray(0, 2600));
  }],
]) {
  const dir = path.join(root, dirName);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const p of parts) fs.copyFileSync(path.join(root, 'complete', p), path.join(dir, p));
  change(dir);
}
fs.rmSync(work, { recursive: true, force: true });
for (const d of ['complete', 'old-style', 'missing-part', 'cut-download']) {
  console.log(d.padEnd(13), fs.readdirSync(path.join(root, d)).join(', '));
}
