/**
 * Searches a directory tree (the app's user-data directory) for secrets in plaintext.
 *
 * Every file is searched as raw bytes. Chromium keeps IndexedDB, localStorage and session
 * storage in LevelDB, whose table files (.ldb/.sst) store blocks Snappy-compressed, so a raw
 * search alone could miss plaintext: table files are also parsed (footer → index block →
 * data blocks) and every block is decompressed before searching.
 *
 * Each needle is searched in several encodings: UTF-8/Latin-1, UTF-16LE (V8 two-byte strings),
 * and for binary keys raw bytes, hex, base64 and base64url.
 */
import fs from "node:fs";
import path from "node:path";

function varint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++];
    if (b === undefined) throw new Error("truncated varint");
    result += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [result, pos];
    shift += 7;
  }
}

export function snappyDecompress(buf) {
  let [len, pos] = varint(buf, 0);
  const out = Buffer.alloc(len);
  let op = 0;
  while (pos < buf.length) {
    const tag = buf[pos++];
    const type = tag & 3;
    if (type === 0) {
      let l = tag >> 2;
      if (l >= 60) {
        const nb = l - 59;
        l = 0;
        for (let i = 0; i < nb; i++) l += buf[pos++] * 2 ** (8 * i);
      }
      l += 1;
      buf.copy(out, op, pos, pos + l);
      pos += l;
      op += l;
    } else {
      let l;
      let off;
      if (type === 1) {
        l = ((tag >> 2) & 7) + 4;
        off = ((tag >> 5) << 8) | buf[pos++];
      } else if (type === 2) {
        l = (tag >> 2) + 1;
        off = buf.readUInt16LE(pos);
        pos += 2;
      } else {
        l = (tag >> 2) + 1;
        off = buf.readUInt32LE(pos);
        pos += 4;
      }
      for (let i = 0; i < l; i++, op++) out[op] = out[op - off];
    }
  }
  return out;
}

function readBlock(file, offset, size) {
  const raw = file.subarray(offset, offset + size);
  const type = file[offset + size];
  return type === 1 ? snappyDecompress(raw) : raw;
}

/** Values of a LevelDB block's entries (used for the index block → data block handles). */
function blockValues(block) {
  const numRestarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - numRestarts * 4;
  const values = [];
  let pos = 0;
  while (pos < end) {
    let shared;
    let nonShared;
    let valueLen;
    [shared, pos] = varint(block, pos);
    [nonShared, pos] = varint(block, pos);
    [valueLen, pos] = varint(block, pos);
    void shared;
    pos += nonShared;
    values.push(block.subarray(pos, pos + valueLen));
    pos += valueLen;
  }
  return values;
}

/** All decompressed data blocks of a LevelDB table file (or [] if it isn't one). */
export function leveldbTableBlocks(file) {
  if (file.length < 48) return [];
  const footer = file.subarray(file.length - 48);
  if (footer.readUInt32LE(40) !== 0x8b80fb57 || footer.readUInt32LE(44) !== 0xdb477524) return [];
  let pos = 0;
  let metaOff, metaSize, idxOff, idxSize;
  [metaOff, pos] = varint(footer, pos);
  [metaSize, pos] = varint(footer, pos);
  [idxOff, pos] = varint(footer, pos);
  [idxSize, pos] = varint(footer, pos);
  void metaOff;
  void metaSize;
  const index = readBlock(file, idxOff, idxSize);
  const blocks = [index];
  for (const handle of blockValues(index)) {
    let off, size;
    let p = 0;
    [off, p] = varint(handle, p);
    [size, p] = varint(handle, p);
    blocks.push(readBlock(file, off, size));
  }
  return blocks;
}

export function needleForms(label, value) {
  const forms = [];
  if (typeof value === "string") {
    forms.push([`${label} (utf8)`, Buffer.from(value, "utf8")]);
    forms.push([`${label} (utf16le)`, Buffer.from(value, "utf16le")]);
  } else {
    const b = Buffer.from(value);
    forms.push([`${label} (raw bytes)`, b]);
    forms.push([`${label} (hex)`, Buffer.from(b.toString("hex"))]);
    forms.push([`${label} (base64)`, Buffer.from(b.toString("base64").replace(/=+$/, ""))]);
    forms.push([`${label} (base64url)`, Buffer.from(b.toString("base64url"))]);
  }
  return forms;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * @param {string} dir
 * @param {Record<string, string | Uint8Array>} secrets
 * @returns {{ files: number, bytes: number, tables: number, blocks: number, hits: {file: string, form: string, where: string}[] }}
 */
export function scanForSecrets(dir, secrets) {
  const needles = Object.entries(secrets).flatMap(([k, v]) => needleForms(k, v));
  const hits = [];
  let bytes = 0;
  let tables = 0;
  let blocks = 0;
  const files = walk(dir);
  for (const f of files) {
    let data;
    try {
      data = fs.readFileSync(f);
    } catch {
      continue; // locked/vanished
    }
    bytes += data.length;
    const rel = path.relative(dir, f);
    for (const [form, n] of needles) if (data.includes(n)) hits.push({ file: rel, form, where: "raw" });
    if (/\.(ldb|sst)$/.test(f)) {
      let bl = [];
      try {
        bl = leveldbTableBlocks(data);
      } catch (e) {
        hits.push({ file: rel, form: `unparseable LevelDB table: ${e.message}`, where: "parse" });
      }
      if (bl.length) tables++;
      blocks += bl.length;
      for (const b of bl) for (const [form, n] of needles) if (b.includes(n) && !hits.some((h) => h.file === rel && h.form === form)) hits.push({ file: rel, form, where: "decompressed block" });
    }
  }
  return { files: files.length, bytes, tables, blocks, hits };
}
