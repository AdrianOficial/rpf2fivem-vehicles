#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RPF7_MAGIC_LE = 0x52504637;
const RSC7_MAGIC_LE = 0x37435352;
const RPF_SECTOR_SIZE = 512;
const DIRECTORY_MARKER = 0x7fffff00;
const SYS_BASE = 0x50000000;
const GFX_BASE = 0x60000000;
const TEXTURE_STRUCT_SIZE = 0x90;
const DICT_STRUCT_SIZE = 0x40;
const NEW_DICT_VFT = 0x650890b2;
const GEOMETRY_EXTENSIONS = new Set(['.yft', '.ydr', '.ydd']);

const LIBRARY_PRIORITY = [
  'vehshare',
];

function joaat(s) {
  s = s.toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h + s.charCodeAt(i)) >>> 0;
    h = (h + ((h << 10) >>> 0)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + ((h << 3) >>> 0)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + ((h << 15) >>> 0)) >>> 0;
  return h >>> 0;
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function readCString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString('utf8', off, end);
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function getSizeFromFlags(flags) {
  const s0 = ((flags >>> 27) & 0x1) << 0;
  const s1 = ((flags >>> 26) & 0x1) << 1;
  const s2 = ((flags >>> 25) & 0x1) << 2;
  const s3 = ((flags >>> 24) & 0x1) << 3;
  const s4 = ((flags >>> 17) & 0x7f) << 4;
  const s5 = ((flags >>> 11) & 0x3f) << 5;
  const s6 = ((flags >>> 7) & 0xf) << 6;
  const s7 = ((flags >>> 5) & 0x3) << 7;
  const s8 = ((flags >>> 4) & 0x1) << 8;
  const ss = flags & 0xf;
  return (0x200 << ss) * (s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8);
}

function encodeSegmentFlags(size) {
  for (let ss = 0; ss <= 15; ss++) {
    const base = 0x200 << ss;
    const unit = base << 4;
    let c4 = Math.floor(size / unit);
    let remPages = Math.ceil((size - c4 * unit) / base);
    if (remPages > 15) {
      c4 += 1;
      remPages = 0;
    }
    if (c4 > 16) continue;
    const c3 = (remPages >> 3) & 1;
    const c2 = (remPages >> 2) & 1;
    const c1 = (remPages >> 1) & 1;
    const c0 = remPages & 1;
    const flags = ((c0 << 27) | (c1 << 26) | (c2 << 25) | (c3 << 24) | (c4 << 17) | ss) >>> 0;
    const paddedSize = getSizeFromFlags(flags);
    if (paddedSize < size) continue;
    return { flags, paddedSize, pageCount: c4 + c3 + c2 + c1 + c0 };
  }
  throw new Error(`Segment prea mare pentru codificarea RSC7: ${size} bytes`);
}

function parseRsc(buffer, label) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== RSC7_MAGIC_LE) {
    throw new Error(`Nu este un fisier RSC7: ${label}`);
  }
  const version = buffer.readUInt32LE(4);
  const sysFlags = buffer.readUInt32LE(8);
  const gfxFlags = buffer.readUInt32LE(12);
  const sysSize = getSizeFromFlags(sysFlags);
  const gfxSize = getSizeFromFlags(gfxFlags);
  const raw = buffer.subarray(16);
  let payload = null;
  let compression = null;
  for (const [name, run] of [
    ['raw', () => zlib.inflateRawSync(raw)],
    ['zlib', () => zlib.inflateSync(raw)],
  ]) {
    try {
      const out = run();
      if (out.length >= sysSize) {
        payload = out;
        compression = name;
        break;
      }
    } catch (err) {  }
  }
  if (!payload) {
    throw new Error(`Payload-ul RSC7 nu a putut fi decomprimat (criptat?): ${label}`);
  }
  return {
    version,
    compression,
    sys: payload.subarray(0, sysSize),
    gfx: payload.subarray(sysSize, sysSize + gfxSize),
  };
}

function buildRsc(version, sysBuf, gfxBuf) {
  const sysEnc = encodeSegmentFlags(sysBuf.length);
  const gfxEnc = encodeSegmentFlags(gfxBuf.length);
  const payload = Buffer.alloc(sysEnc.paddedSize + gfxEnc.paddedSize);
  sysBuf.copy(payload, 0);
  gfxBuf.copy(payload, sysEnc.paddedSize);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(RSC7_MAGIC_LE, 0);
  header.writeUInt32LE(version, 4);
  const sysFlags = (sysEnc.flags | (((version >> 4) & 0xf) << 28)) >>> 0;
  const gfxFlags = (gfxEnc.flags | ((version & 0xf) << 28)) >>> 0;
  header.writeUInt32LE(sysFlags, 8);
  header.writeUInt32LE(gfxFlags, 12);
  const compressed = zlib.deflateRawSync(payload, { level: 9 });
  return {
    file: Buffer.concat([header, compressed]),
    sysPages: sysEnc.pageCount,
    gfxPages: gfxEnc.pageCount,
    sysPadded: sysEnc.paddedSize,
    gfxPadded: gfxEnc.paddedSize,
  };
}

function ptrOffset(p) {
  return { segment: Number((p >> 28n) & 0xfn), offset: Number(p & 0xfffffffn) };
}

function parseYtd(buffer, label) {
  const rsc = parseRsc(buffer, label);
  const { sys, gfx } = rsc;
  if (sys.length < DICT_STRUCT_SIZE) {
    throw new Error(`Segment system prea mic pentru un dictionar: ${label}`);
  }
  const dictVft = sys.readUInt32LE(0);
  const hashesPtr = ptrOffset(sys.readBigUInt64LE(0x20));
  const hashesCount = sys.readUInt16LE(0x28);
  const texturesPtr = ptrOffset(sys.readBigUInt64LE(0x30));
  const texturesCount = sys.readUInt16LE(0x38);
  if (hashesCount !== texturesCount) {
    throw new Error(`Dictionar inconsistent (${hashesCount} hash-uri, ${texturesCount} texturi): ${label}`);
  }

  const entries = [];
  for (let i = 0; i < texturesCount; i++) {
    const structOff = ptrOffset(sys.readBigUInt64LE(texturesPtr.offset + i * 8)).offset;
    const struct = Buffer.from(sys.subarray(structOff, structOff + TEXTURE_STRUCT_SIZE));
    const namePtr = ptrOffset(struct.readBigUInt64LE(0x28));
    const name = readCString(sys, namePtr.offset);
    entries.push({
      name,
      hash: sys.readUInt32LE(hashesPtr.offset + i * 4),
      struct,
      width: struct.readUInt16LE(0x50),
      height: struct.readUInt16LE(0x52),
      depth: struct.readUInt16LE(0x54),
      format: struct.readUInt32LE(0x58),
      levels: struct.readUInt8(0x5d),
      dataOffset: ptrOffset(struct.readBigUInt64LE(0x70)).offset,
      data: null,
    });
  }

  const uniqueOffsets = [...new Set(entries.map((e) => e.dataOffset))].sort((a, b) => a - b);
  const nextOffset = new Map();
  for (let i = 0; i < uniqueOffsets.length; i++) {
    nextOffset.set(uniqueOffsets[i], i + 1 < uniqueOffsets.length ? uniqueOffsets[i + 1] : gfx.length);
  }
  for (const entry of entries) {
    entry.data = Buffer.from(gfx.subarray(entry.dataOffset, nextOffset.get(entry.dataOffset)));
  }

  return { version: rsc.version, dictVft, textures: entries };
}

function buildYtd(textures, { version = 13, dictVft = NEW_DICT_VFT } = {}) {
  const entries = [...textures]
    .map((t) => ({ ...t, hash: joaat(t.name) }))
    .sort((a, b) => a.hash - b.hash);
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].hash === entries[i - 1].hash) {
      throw new Error(`Hash duplicat in dictionar: "${entries[i - 1].name}" / "${entries[i].name}"`);
    }
  }
  const count = entries.length;

  const ptrArrayOff = DICT_STRUCT_SIZE;
  const pagesInfoOff = alignUp(ptrArrayOff + count * 8, 16);
  const structsOff = alignUp(pagesInfoOff + 0x440, 16);
  const namesOff = structsOff + count * TEXTURE_STRUCT_SIZE;
  let cursor = namesOff;
  const nameOffsets = entries.map((t) => {
    const off = alignUp(cursor, 4);
    cursor = off + Buffer.byteLength(t.name, 'utf8') + 1;
    return off;
  });
  const hashesOff = alignUp(cursor, 16);
  const sysSize = hashesOff + count * 4;

  let gfxCursor = 0;
  const dataOffsets = entries.map((t) => {
    const off = alignUp(gfxCursor, 0x1000);
    gfxCursor = off + t.data.length;
    return off;
  });
  const gfxSize = alignUp(gfxCursor, 0x1000) + 0x1000;

  const sys = Buffer.alloc(sysSize);
  sys.writeUInt32LE(dictVft >>> 0, 0x00);
  sys.writeUInt32LE(1, 0x04);
  sys.writeBigUInt64LE(BigInt(SYS_BASE + pagesInfoOff), 0x08);
  sys.writeUInt32LE(0, 0x10);
  sys.writeUInt32LE(0, 0x14);
  sys.writeUInt32LE(1, 0x18);
  sys.writeUInt32LE(0, 0x1c);
  sys.writeBigUInt64LE(BigInt(SYS_BASE + hashesOff), 0x20);
  sys.writeUInt16LE(count, 0x28);
  sys.writeUInt16LE(count, 0x2a);
  sys.writeBigUInt64LE(BigInt(SYS_BASE + ptrArrayOff), 0x30);
  sys.writeUInt16LE(count, 0x38);
  sys.writeUInt16LE(count, 0x3a);

  for (let i = 0; i < count; i++) {
    const entry = entries[i];
    const structOff = structsOff + i * TEXTURE_STRUCT_SIZE;
    sys.writeBigUInt64LE(BigInt(SYS_BASE + structOff), ptrArrayOff + i * 8);
    sys.writeUInt32LE(entry.hash, hashesOff + i * 4);
    entry.struct.copy(sys, structOff, 0, TEXTURE_STRUCT_SIZE);
    sys.writeBigUInt64LE(BigInt(SYS_BASE + nameOffsets[i]), structOff + 0x28);
    sys.writeBigUInt64LE(BigInt(GFX_BASE + dataOffsets[i]), structOff + 0x70);
    sys.write(entry.name, nameOffsets[i], 'utf8');
  }

  const gfx = Buffer.alloc(gfxSize);
  for (let i = 0; i < count; i++) {
    entries[i].data.copy(gfx, dataOffsets[i]);
  }

  sys.writeUInt8(encodeSegmentFlags(sys.length).pageCount, pagesInfoOff + 8);
  sys.writeUInt8(encodeSegmentFlags(gfx.length).pageCount, pagesInfoOff + 9);
  return buildRsc(version, sys, gfx).file;
}

function collectYtdsFromRpf(buffer, label, sink, depth = 0) {
  if (depth > 8) throw new Error(`Prea multe RPF-uri imbricate in ${label}`);
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== RPF7_MAGIC_LE) {
    throw new Error(`Nu este o arhiva RPF7: ${label}`);
  }
  const entryCount = buffer.readUInt32LE(4);
  const nameLength = buffer.readUInt32LE(8);
  const encryption = buffer.toString('ascii', 12, 16);
  if (encryption !== 'OPEN') {
    throw new Error(`Arhiva RPF criptata ("${encryption}") nesuportata: ${label}`);
  }
  const entriesOffset = 16;
  const namesOffset = entriesOffset + entryCount * 16;

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const off = entriesOffset + i * 16;
    const first = buffer.readBigUInt64LE(off);
    const nameOff = Number(first & 0xffffn);
    let end = namesOffset + nameOff;
    while (end < buffer.length && buffer[end] !== 0) end++;
    const name = buffer.toString('utf8', namesOffset + nameOff, end);
    if (buffer.readUInt32LE(off + 4) === DIRECTORY_MARKER) {
      entries.push({ kind: 'directory', name, firstChild: buffer.readUInt32LE(off + 8), childCount: buffer.readUInt32LE(off + 12) });
    } else {
      const compressedSize = Number((first >> 16n) & 0xffffffn);
      const sectorOffset = Number((first >> 40n) & 0x7fffffn);
      const uncompressedSize = buffer.readUInt32LE(off + 8);
      entries.push({ kind: 'file', name, compressedSize, sectorOffset, uncompressedSize });
    }
  }

  const visit = (index, prefix) => {
    const dir = entries[index];
    for (let i = dir.firstChild; i < dir.firstChild + dir.childCount; i++) {
      const child = entries[i];
      const rel = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.kind === 'directory') {
        visit(i, rel);
        continue;
      }
      const ext = path.extname(child.name).toLowerCase();
      if (ext !== '.ytd' && ext !== '.rpf') continue;
      const start = child.sectorOffset * RPF_SECTOR_SIZE;
      const diskSize = child.compressedSize || child.uncompressedSize;
      const raw = buffer.subarray(start, start + diskSize);
      if (ext === '.rpf') {
        let nested = Buffer.from(raw);
        if (nested.readUInt32LE(0) !== RPF7_MAGIC_LE && child.compressedSize) {
          nested = zlib.inflateRawSync(raw);
        }
        collectYtdsFromRpf(nested, `${label}/${rel}`, sink, depth + 1);
      } else {
        sink.push({ name: child.name, source: `${label}/${rel}`, buffer: Buffer.from(raw) });
      }
    }
  };
  visit(0, '');
}

function buildLibrary(vehshareDir, log, dumpDir) {
  const found = [];
  for (const file of walkFiles(vehshareDir)) {
    const ext = path.extname(file).toLowerCase();
    try {
      if (ext === '.rpf') {
        collectYtdsFromRpf(fs.readFileSync(file), path.relative(vehshareDir, file), found);
      } else if (ext === '.ytd') {
        found.push({ name: path.basename(file), source: path.relative(vehshareDir, file), buffer: fs.readFileSync(file) });
      }
    } catch (err) {
      log(`AVERTISMENT: nu am putut citi ${file}: ${err.message}`);
    }
  }

  const dicts = new Map();
  const dictFiles = new Map();
  for (const item of found) {
    const dictName = path.basename(item.name, path.extname(item.name)).toLowerCase();
    try {
      const parsed = parseYtd(item.buffer, item.source);
      const map = dicts.get(dictName) || new Map();
      for (const tex of parsed.textures) {
        if (!map.has(tex.name.toLowerCase())) map.set(tex.name.toLowerCase(), tex);
      }
      dicts.set(dictName, map);
      if (dumpDir && !dictFiles.has(dictName)) {
        const dumpPath = path.join(dumpDir, `${dictName}.ytd`);
        fs.mkdirSync(dumpDir, { recursive: true });
        fs.writeFileSync(dumpPath, item.buffer);
        dictFiles.set(dictName, dumpPath);
      }
      log(`  biblioteca: ${dictName} (${parsed.textures.length} texturi) din ${item.source}`);
    } catch (err) {
      log(`AVERTISMENT: YTD ilizibil ${item.source}: ${err.message}`);
    }
  }

  const order = [
    ...LIBRARY_PRIORITY.filter((n) => dicts.has(n)),
    ...[...dicts.keys()].filter((n) => !LIBRARY_PRIORITY.includes(n)).sort(),
  ];
  const allNames = new Set();
  for (const map of dicts.values()) for (const name of map.keys()) allNames.add(name);

  return {
    dictFiles,
    dicts,
    order,
    allNames,
    resolve(nameLower, preferredDicts = []) {
      for (const dictName of [...preferredDicts, ...order]) {
        const map = dicts.get(dictName);
        if (map && map.has(nameLower)) return { texture: map.get(nameLower), dictName };
      }
      return null;
    },
  };
}

function extractStrings(buf, minLength = 3) {
  const out = new Set();
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const c = i < buf.length ? buf[i] : 0;
    const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
      c === 0x5f || c === 0x2d || c === 0x40 || c === 0x2e || c === 0x7e;
    if (ok) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= minLength && i - start <= 128) {
        out.add(buf.toString('utf8', start, i).toLowerCase());
      }
      start = -1;
    }
  }
  return out;
}

function parseVehiclesMeta(xml) {
  const models = [];
  const relationships = [];
  const itemRegex = /<modelName>\s*([^<\s]+)\s*<\/modelName>[\s\S]*?<txdName>\s*([^<\s]+)\s*<\/txdName>/gi;
  let match;
  while ((match = itemRegex.exec(xml))) {
    models.push({ model: match[1].toLowerCase(), txd: match[2].toLowerCase() });
  }
  const relRegex = /<parent>\s*([^<\s]+)\s*<\/parent>\s*<child>\s*([^<\s]+)\s*<\/child>/gi;
  while ((match = relRegex.exec(xml))) {
    relationships.push({ parent: match[1].toLowerCase(), child: match[2].toLowerCase() });
  }
  return { models, relationships };
}

function processResource(resourceDir, library, options, log) {
  const name = path.basename(resourceDir);
  const files = walkFiles(resourceDir);
  const geometryFiles = files.filter((f) => GEOMETRY_EXTENSIONS.has(path.extname(f).toLowerCase()));
  const ytdFiles = files.filter((f) => path.extname(f).toLowerCase() === '.ytd');
  const metaFiles = files.filter((f) => /vehicles\.meta$/i.test(f));

  if (!geometryFiles.length) {
    return { name, skipped: 'fara fisiere de geometrie (.yft/.ydr/.ydd)' };
  }

  let models = [];
  const relationships = [];
  for (const metaFile of metaFiles) {
    const parsed = parseVehiclesMeta(fs.readFileSync(metaFile, 'utf8'));
    models.push(...parsed.models);
    relationships.push(...parsed.relationships);
  }
  if (!models.length) {
    const bases = new Set(geometryFiles.map((f) => path.basename(f, path.extname(f)).toLowerCase()));
    const guesses = [...bases].filter((b) => bases.has(`${b}_hi`));
    const model = guesses[0] || [...bases].sort((a, b) => a.length - b.length)[0];
    models = [{ model, txd: model }];
  }

  const presentByFile = new Map();
  const presentAll = new Set();
  for (const file of ytdFiles) {
    try {
      const parsed = parseYtd(fs.readFileSync(file), file);
      const names = new Set(parsed.textures.map((t) => t.name.toLowerCase()));
      presentByFile.set(file, names);
      for (const n of names) presentAll.add(n);
    } catch (err) {
      log(`  AVERTISMENT [${name}]: YTD ilizibil ${path.basename(file)}: ${err.message}`);
    }
  }

  const referencedByGeometry = new Map();
  const referencedAll = new Set();
  const baseGameHints = new Set();
  for (const file of geometryFiles) {
    try {
      const rsc = parseRsc(fs.readFileSync(file), file);
      const strings = extractStrings(rsc.sys);
      const matches = new Set();
      for (const s of strings) {
        if (library.allNames.has(s)) {
          matches.add(s);
          referencedAll.add(s);
        } else if (/^vehicle_(generic|shared)/.test(s) && !presentAll.has(s)) {
          baseGameHints.add(s);
        }
      }
      referencedByGeometry.set(file, matches);
    } catch (err) {
      log(`  AVERTISMENT [${name}]: geometrie ilizibila ${path.basename(file)}: ${err.message}`);
    }
  }

  const excludeRegex = options.exclude ? new RegExp(options.exclude, 'i') : null;
  const missingAll = [...referencedAll]
    .filter((n) => !presentAll.has(n))
    .filter((n) => !excludeRegex || !excludeRegex.test(n))
    .sort();

  if (!missingAll.length) {
    return { name, missing: [], message: 'toate texturile referentiate sunt deja prezente' };
  }

  const txds = [...new Set(models.map((m) => m.txd))];
  const missingByTxd = new Map(txds.map((t) => [t, new Set()]));
  for (const [file, matches] of referencedByGeometry) {
    const base = path.basename(file, path.extname(file)).toLowerCase();
    const owner = models
      .filter((m) => base === m.model || base.startsWith(m.model))
      .sort((a, b) => b.model.length - a.model.length)[0];
    const targets = owner ? [owner.txd] : txds;
    for (const texName of matches) {
      if (presentAll.has(texName)) continue;
      if (excludeRegex && excludeRegex.test(texName)) continue;
      for (const t of targets) missingByTxd.get(t).add(texName);
    }
  }

  const preferredByTxd = new Map();
  for (const txd of txds) {
    const preferred = [];
    const owners = models.filter((m) => m.txd === txd).map((m) => m.model);
    for (const rel of relationships) {
      if ((rel.child === txd || owners.includes(rel.child)) && library.dicts.has(rel.parent)) {
        preferred.push(rel.parent);
      }
    }
    preferredByTxd.set(txd, preferred);
  }

  const actions = [];
  for (const [txd, missingSet] of missingByTxd) {
    if (!missingSet.size) continue;
    const preferred = preferredByTxd.get(txd) || [];
    const additions = [];
    for (const texName of [...missingSet].sort()) {
      const resolved = library.resolve(texName, preferred);
      if (resolved) additions.push({ name: texName, ...resolved });
    }
    if (!additions.length) continue;

    const owners = models.filter((m) => m.txd === txd).map((m) => m.model);
    const candidates = [txd, ...owners];
    let targetFile = null;
    for (const candidate of candidates) {
      targetFile = ytdFiles.find((f) => path.basename(f, '.ytd').toLowerCase() === candidate) || null;
      if (targetFile) break;
    }
    if (!targetFile && ytdFiles.length === 1 && txds.length === 1) targetFile = ytdFiles[0];
    actions.push({ txd, targetFile, additions });
  }

  if (!actions.length) {
    return { name, missing: missingAll, message: 'texturile lipsa nu au sursa in biblioteca' };
  }

  const applied = [];
  for (const action of actions) {
    const targetPath = action.targetFile ||
      path.join(resourceDir, 'stream', `${action.txd}.ytd`);
    const creating = !action.targetFile;

    let existing = [];
    let buildOptions = {};
    if (!creating) {
      const parsed = parseYtd(fs.readFileSync(targetPath), targetPath);
      existing = parsed.textures;
      buildOptions = { version: parsed.version, dictVft: parsed.dictVft };
      const existingNames = new Set(existing.map((t) => t.name.toLowerCase()));
      action.additions = action.additions.filter((a) => !existingNames.has(a.name));
      if (!action.additions.length) continue;
    }

    const merged = [...existing, ...action.additions.map((a) => a.texture)];
    const addedBytes = action.additions.reduce((sum, a) => sum + a.texture.data.length, 0);

    if (options.manifestSink) {
      options.manifestSink.push({
        resource: name,
        baseFile: creating ? null : path.resolve(targetPath),
        outFile: path.resolve(targetPath),
        additions: action.additions.map((a) => ({ name: a.texture.name, dict: a.dictName })),
      });
    } else if (!options.dryRun) {
      const rebuilt = buildYtd(merged, buildOptions);
      const check = parseYtd(rebuilt, `${targetPath} (rebuilt)`);
      if (check.textures.length !== merged.length) {
        throw new Error(`Verificarea a esuat pentru ${targetPath}: ${check.textures.length} != ${merged.length}`);
      }
      if (!creating && !options.noBackup) {
        const backupPath = path.join(options.backupRoot, name, path.basename(targetPath));
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        if (!fs.existsSync(backupPath)) fs.copyFileSync(targetPath, backupPath);
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, rebuilt);
    }

    applied.push({
      file: path.relative(resourceDir, targetPath),
      created: creating,
      added: action.additions.map((a) => `${a.name} (${a.dictName})`),
      addedBytes,
    });
  }

  return {
    name,
    missing: missingAll,
    applied,
    baseGameHints: [...baseGameHints].sort(),
  };
}

function parseArgs(argv) {
  const args = { resources: 'resources', vehshare: 'vehshare' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': args.dryRun = true; break;
      case '--no-backup': args.noBackup = true; break;
      case '--resources': args.resources = argv[++i]; break;
      case '--vehshare': args.vehshare = argv[++i]; break;
      case '--resource': args.only = argv[++i]; break;
      case '--exclude': args.exclude = argv[++i]; break;
      case '--manifest': args.manifest = argv[++i]; break;
      case '-h':
      case '--help': args.help = true; break;
      default: throw new Error(`Argument necunoscut: ${argv[i]}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Utilizare: node fix-vehshare-textures.js [optiuni]

Optiuni:
  --dry-run            Doar raporteaza, nu modifica nimic.
  --resource <nume>    Proceseaza doar resursa cu acest nume.
  --resources <dir>    Folderul cu resurse FiveM (implicit ./resources).
  --vehshare <dir>     Folderul cu DLC-urile vehshare (implicit ./vehshare).
  --exclude <regex>    Nu injecta texturile al caror nume se potriveste.
  --no-backup          Nu salva copii ale YTD-urilor modificate.`);
    return;
  }

  const resourcesDir = path.resolve(args.resources);
  const vehshareDir = path.resolve(args.vehshare);
  if (!fs.existsSync(resourcesDir)) throw new Error(`Folderul de resurse nu exista: ${resourcesDir}`);
  if (!fs.existsSync(vehshareDir)) throw new Error(`Folderul vehshare nu exista: ${vehshareDir}`);

  const reportLines = [];
  const log = (line) => {
    console.log(line);
    reportLines.push(line);
  };

  const manifestDir = args.manifest ? path.join(path.dirname(path.resolve(args.manifest)), 'library_ytd') : null;

  log(`Construiesc biblioteca de texturi din ${vehshareDir} ...`);
  const library = buildLibrary(vehshareDir, log, manifestDir);
  log(`Biblioteca: ${library.allNames.size} nume unice de texturi in ${library.dicts.size} dictionare.\n`);

  const options = {
    dryRun: !!args.dryRun,
    noBackup: !!args.noBackup,
    exclude: args.exclude,
    backupRoot: path.resolve('backup_vehshare_fix'),
    manifestSink: args.manifest ? [] : null,
  };
  if (options.dryRun) log('MOD DRY-RUN: nu se scrie nimic.\n');
  if (options.manifestSink) log(`MOD MANIFEST: analizez si scriu planul in ${args.manifest}, nu modific YTD-uri.\n`);

  const resourceDirs = fs.readdirSync(resourcesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(resourcesDir, e.name))
    .filter((dir) => !args.only || path.basename(dir).toLowerCase() === args.only.toLowerCase());
  if (args.only && !resourceDirs.length) throw new Error(`Resursa nu a fost gasita: ${args.only}`);

  let modified = 0;
  let created = 0;
  let injectedTextures = 0;
  let failed = 0;

  for (const dir of resourceDirs) {
    let result;
    try {
      result = processResource(dir, library, options, log);
    } catch (err) {
      failed++;
      log(`EROARE [${path.basename(dir)}]: ${err.message}`);
      continue;
    }
    if (result.skipped) {
      log(`- ${result.name}: sarit (${result.skipped})`);
      continue;
    }
    if (!result.applied || !result.applied.length) {
      log(`- ${result.name}: OK, nimic de injectat${result.message ? ` (${result.message})` : ''}`);
      continue;
    }
    log(`- ${result.name}:`);
    for (const action of result.applied) {
      const verb = action.created
        ? (options.dryRun ? 'ar crea' : 'creat')
        : (options.dryRun ? 'ar actualiza' : 'actualizat');
      log(`    ${verb} ${action.file} (+${action.added.length} texturi, ${formatBytes(action.addedBytes)}):`);
      for (const texName of action.added) log(`      + ${texName}`);
      injectedTextures += action.added.length;
      if (action.created) created++;
      else modified++;
    }
    if (result.baseGameHints && result.baseGameHints.length) {
      log(`    (referinte negasite in biblioteca, probabil din jocul de baza: ${result.baseGameHints.join(', ')})`);
    }
  }

  log('');
  log('Rezumat:');
  log(`  resurse procesate: ${resourceDirs.length}`);
  log(`  YTD-uri actualizate: ${modified}`);
  log(`  YTD-uri create: ${created}`);
  log(`  texturi injectate: ${injectedTextures}`);
  if (failed) log(`  resurse cu erori: ${failed}`);
  if (!options.dryRun && !options.noBackup && modified) {
    log(`  backup-uri: ${options.backupRoot}`);
  }

  if (options.manifestSink) {
    const manifest = {
      libraryFiles: Object.fromEntries(library.dictFiles),
      actions: options.manifestSink,
    };
    fs.writeFileSync(path.resolve(args.manifest), JSON.stringify(manifest, null, 2), 'utf8');
    log(`Manifest scris in: ${path.resolve(args.manifest)}`);
  }

  const reportPath = path.resolve('vehshare_fix_report.txt');
  fs.writeFileSync(reportPath, reportLines.join('\n') + '\n', 'utf8');
  console.log(`\nRaport salvat in: ${reportPath}`);
  if (failed) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
