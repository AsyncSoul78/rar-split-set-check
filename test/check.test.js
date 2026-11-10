'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readRar } = require('../scripts/rar-headers');
const { nameInfo, collect, checkSet } = require('../scripts/check-set');

const ex = (...p) => path.join(__dirname, '..', 'examples', ...p);
const run = (dir) => collect(dir).sets.map(([k, parts]) => checkSet(k, parts, collect(dir).unfinished));

function copySet(from, edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rarset-'));
  for (const f of fs.readdirSync(ex(from))) fs.copyFileSync(ex(from, f), path.join(dir, f));
  edit(dir);
  return dir;
}

test('names: partN, old .rNN style and a plain .rar', () => {
  assert.deepStrictEqual(nameInfo('Trip.part03.rar'), { set: 'Trip', number: 3, style: 'partN', digits: 2 });
  assert.strictEqual(nameInfo('Trip.r00').number, 2);
  assert.strictEqual(nameInfo('Trip.r11').number, 13);
  assert.strictEqual(nameInfo('Trip.rar').number, 1);
  assert.strictEqual(nameInfo('notes.txt'), null);
});

test('RAR5 headers: first part, numbers and the "goes on" flag', () => {
  const p1 = readRar(ex('complete', 'Garden plans.part1.rar'));
  const p3 = readRar(ex('complete', 'Garden plans.part3.rar'));
  assert.strictEqual(p1.format, 'RAR5');
  assert.strictEqual(p1.first, true);
  assert.strictEqual(p1.continues, true);
  assert.strictEqual(p3.number, 3);
  assert.strictEqual(p3.continues, false);
});

test('RAR4 old-style set reads the same way', () => {
  const [r] = run(ex('old-style'));
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.openFirst, 'Garden plans.rar');
  assert.deepStrictEqual(r.parts.map((p) => p.headerNumber), [1, 2, 3]);
});

test('complete set: open part1', () => {
  const [r] = run(ex('complete'));
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.openFirst, 'Garden plans.part1.rar');
});

test('missing middle part: names it and lists what can still be taken out', () => {
  const [r] = run(ex('missing-part'));
  assert.strictEqual(r.complete, false);
  assert.ok(r.problems.includes('missing part: 2'));
  assert.ok(r.files.some((f) => f.complete && f.name.endsWith('Shopping.txt')));
  assert.ok(r.files.some((f) => !f.complete && f.name.endsWith('Watering log.csv')));
});

test('cut-off part: no end record and smaller than the others', () => {
  const [r] = run(ex('cut-download'));
  assert.strictEqual(r.complete, false);
  assert.ok(r.problems.some((p) => p.includes('no end-of-archive record')));
  assert.ok(r.problems.some((p) => p.includes('2600 bytes')));
});

test('missing last part is caught by the "goes on" flag', () => {
  const dir = copySet('complete', (d) => fs.rmSync(path.join(d, 'Garden plans.part3.rar')));
  const [r] = run(dir);
  assert.ok(r.problems.some((p) => p.includes('at least part 3 is missing')));
});

test('renamed part, web page saved as .rar, unfinished download', () => {
  const dir = copySet('complete', (d) => {
    fs.renameSync(path.join(d, 'Garden plans.part3.rar'), path.join(d, 'Garden plans.part4.rar'));
    fs.writeFileSync(path.join(d, 'Garden plans.part3.rar'), '<!DOCTYPE html><html><body>Sign in</body></html>');
    fs.writeFileSync(path.join(d, 'Garden plans.part5.rar.crdownload'), 'x');
  });
  const [r] = run(dir);
  const all = r.problems.join('\n');
  assert.match(all, /part4\.rar: the header says this is part 3, the name says 4/);
  assert.match(all, /part3\.rar: not a RAR file: it is a web page/);
  assert.match(all, /part5\.rar\.crdownload: still downloading/);
});
