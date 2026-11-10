'use strict';
// Reads the block headers of one RAR file (RAR4 or RAR5) without unpacking anything.
// Returns what matters for a split set: is it a volume, is it the first one, its number,
// does the set go on after it, and which stored files start or end in it.

const fs = require('fs');

const SIG5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const SIG4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

function readVint(buf, pos) {
  let value = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos + i >= buf.length) throw new Error('header cut short');
    const b = buf[pos + i];
    value += (b & 0x7f) * mul;
    mul *= 128;
    if (!(b & 0x80)) return { value, next: pos + i + 1 };
  }
  throw new Error('bad number in header');
}

function emptyInfo(file, size) {
  return {
    file, size, format: null, volume: false, first: null, number: null,
    continues: null, solid: false, encryptedHeaders: false, entries: [], problem: null,
  };
}

function parse5(buf, info) {
  let pos = SIG5.length;
  while (pos < buf.length) {
    const start = pos;
    let p = pos + 4; // header CRC32
    const size = readVint(buf, p); p = size.next;
    const headerEnd = p + size.value;
    if (headerEnd > buf.length) { info.problem = 'file ends inside a header (cut off?)'; return; }
    const type = readVint(buf, p); p = type.next;
    const flags = readVint(buf, p); p = flags.next;
    if (flags.value & 0x1) p = readVint(buf, p).next; // extra area size
    let dataSize = 0;
    if (flags.value & 0x2) { const d = readVint(buf, p); dataSize = d.value; p = d.next; }

    if (type.value === 1) {
      const af = readVint(buf, p); p = af.next;
      info.volume = !!(af.value & 0x1);
      info.solid = !!(af.value & 0x4);
      if (af.value & 0x2) { info.number = readVint(buf, p).value + 1; info.first = false; } else { info.number = 1; info.first = true; }
    } else if (type.value === 2) {
      const ff = readVint(buf, p); p = ff.next;
      p = readVint(buf, p).next; // unpacked size
      p = readVint(buf, p).next; // attributes
      if (ff.value & 0x2) p += 4;
      if (ff.value & 0x4) p += 4;
      p = readVint(buf, p).next; // compression info
      p = readVint(buf, p).next; // host OS
      const nl = readVint(buf, p); p = nl.next;
      const name = buf.toString('utf8', p, p + nl.value);
      if (!(ff.value & 0x1)) {
        info.entries.push({
          name, fromPrevious: !!(flags.value & 0x8), toNext: !!(flags.value & 0x10),
        });
      }
    } else if (type.value === 4) {
      info.encryptedHeaders = true;
      return;
    } else if (type.value === 5) {
      const ef = readVint(buf, p);
      info.continues = !!(ef.value & 0x1);
      return;
    }
    pos = headerEnd + dataSize;
    if (pos <= start) { info.problem = 'broken header chain'; return; }
  }
  info.problem = 'no end-of-archive record (file cut off?)';
}

function parse4(buf, info) {
  let pos = SIG4.length;
  while (pos + 7 <= buf.length) {
    const type = buf[pos + 2];
    const flags = buf.readUInt16LE(pos + 3);
    const headSize = buf.readUInt16LE(pos + 5);
    if (headSize < 7) { info.problem = 'broken header chain'; return; }
    if (pos + headSize > buf.length) { info.problem = 'file ends inside a header (cut off?)'; return; }
    let addSize = 0;
    if (flags & 0x8000) addSize = buf.readUInt32LE(pos + 7);

    if (type === 0x73) {
      info.volume = !!(flags & 0x1);
      info.solid = !!(flags & 0x8);
      info.encryptedHeaders = !!(flags & 0x80);
      info.newNaming = !!(flags & 0x10);
      if (flags & 0x100) { info.first = true; info.number = 1; } else if (info.volume) { info.first = false; }
      if (info.encryptedHeaders) return;
    } else if (type === 0x74) {
      let high = 0;
      if (flags & 0x100) high = buf.readUInt32LE(pos + 32);
      addSize = buf.readUInt32LE(pos + 7) + high * 0x100000000;
      const nameSize = buf.readUInt16LE(pos + 26);
      const nameAt = pos + 32 + ((flags & 0x100) ? 8 : 0);
      let raw = buf.subarray(nameAt, nameAt + nameSize);
      const zero = raw.indexOf(0);
      if (zero >= 0) raw = raw.subarray(0, zero);
      const name = (flags & 0x200) ? raw.toString('utf8') : raw.toString('latin1');
      if ((flags & 0xe0) !== 0xe0) { // 0xe0 = directory
        info.entries.push({ name: name.replace(/\\/g, '/'), fromPrevious: !!(flags & 0x1), toNext: !!(flags & 0x2) });
      }
    } else if (type === 0x7b) {
      info.continues = !!(flags & 0x1);
      if (flags & 0x8) {
        const at = pos + 7 + ((flags & 0x2) ? 4 : 0);
        if (at + 2 <= buf.length) info.number = buf.readUInt16LE(at) + 1;
      }
      return;
    }
    pos += headSize + addSize;
  }
  info.problem = 'no end-of-archive record (file cut off?)';
}

function readRar(file) {
  const buf = fs.readFileSync(file);
  const info = emptyInfo(file, buf.length);
  try {
    if (buf.subarray(0, 8).equals(SIG5)) { info.format = 'RAR5'; parse5(buf, info); }
    else if (buf.subarray(0, 7).equals(SIG4)) { info.format = 'RAR4'; parse4(buf, info); }
    else {
      const head = buf.toString('latin1', 0, 200).toLowerCase();
      info.problem = /<html|<!doctype/.test(head) ? 'not a RAR file: it is a web page (saved error or login page?)'
        : buf.length === 0 ? 'empty file' : 'not a RAR file (no RAR signature)';
    }
  } catch (e) {
    info.problem = e.message;
  }
  return info;
}

module.exports = { readRar, readVint };
