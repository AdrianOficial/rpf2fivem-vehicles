#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const RPF7_MAGIC_LE = 0x52504637;
const RPF_SECTOR_SIZE = 512;
const DIRECTORY_MARKER = 0x7fffff00;

const STREAM_EXTENSIONS = new Set([
  '.awc',
  '.ydd',
  '.ydr',
  '.yft',
  '.yld',
  '.ymap',
  '.ymf',
  '.ymt',
  '.ypt',
  '.ytd',
  '.ycd',
  '.ybn',
  '.ytyp',
  '.yvr',
  '.ywr',
]);

const META_TYPES = [
  { match: /^handling\.meta$/i, type: 'HANDLING_FILE' },
  { match: /^vehicles\.meta$/i, type: 'VEHICLE_METADATA_FILE' },
  { match: /^carcols\.meta$/i, type: 'CARCOLS_FILE' },
  { match: /^carvariations\.meta$/i, type: 'VEHICLE_VARIATION_FILE' },
  { match: /^vehiclelayouts\.meta$/i, type: 'VEHICLE_LAYOUTS_FILE' },
  { match: /^dlctext\.meta$/i, type: 'TEXTFILE_METAFILE' },
  { match: /^caraddoncontentunlocks\.meta$/i, type: 'CONTENT_UNLOCKING_META_FILE' },
  { match: /^vehiclemodelsets\.meta$/i, type: 'VEHICLE_MODEL_SET_FILE' },
  { match: /^txdrelationships\.meta$/i, type: 'TXD_RELATIONSHIP_FILE' },
];

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.list) {
    const input = path.resolve(args.input || 'dlc.rpf');
    listRpf(input);
    return;
  }

  if (args.batch) {
    runBatchConversion(args);
    return;
  }

  const resourceName = sanitizeResourceName(
    args.name || path.basename(process.cwd())
  );

  const outputDir = path.resolve(
    args.output || `${resourceName}_fivem`
  );

  prepareOutputDirectory(outputDir, args.force);

  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'dlc-rpf-')
  );

  try {
    const extractedRoot = args.sourceDir
      ? path.resolve(args.sourceDir)
      : extractInputRpf(
          path.resolve(args.input || 'dlc.rpf'),
          tempRoot
        );

    const result = buildFiveMResource(
      extractedRoot,
      outputDir,
      resourceName
    );

    printSummary(result, outputDir);
  } finally {
    fs.rmSync(tempRoot, {
      recursive: true,
      force: true,
    });
  }
}

function prepareOutputDirectory(outputDir, force) {
  if (!fs.existsSync(outputDir)) {
    return;
  }

  if (!force) {
    throw new Error(
      `Output already exists: ${outputDir}\n` +
      'Use --force to overwrite generated files.'
    );
  }

  fs.rmSync(outputDir, {
    recursive: true,
    force: true,
  });
}

function runBatchConversion(args) {
  const batchRoot = path.resolve(args.batch);
  const outputRoot = path.resolve(
    args.output || 'converted'
  );

  if (
    !fs.existsSync(batchRoot) ||
    !fs.statSync(batchRoot).isDirectory()
  ) {
    throw new Error(
      `Batch input folder does not exist: ${batchRoot}`
    );
  }

  if (path.resolve(outputRoot) === path.resolve(batchRoot)) {
    throw new Error(
      'Batch input and output folders must be different.'
    );
  }

  fs.mkdirSync(outputRoot, {
    recursive: true,
  });

  const rpfFiles = findFilesNamed(
    batchRoot,
    'dlc.rpf',
    outputRoot
  );

  if (rpfFiles.length === 0) {
    throw new Error(
      `No dlc.rpf files were found inside: ${batchRoot}`
    );
  }

  const results = [];
  let failed = 0;

  console.log(
    `Found ${rpfFiles.length} DLC archive(s).`
  );

  for (const rpfPath of rpfFiles) {
    const modFolder = path.dirname(rpfPath);
    const relativeModFolder = path.relative(
      batchRoot,
      modFolder
    );

    const fallbackName = path.basename(modFolder);

    const resourceName = sanitizeResourceName(
      relativeModFolder || fallbackName
    );

    const outputDir = path.join(
      outputRoot,
      resourceName
    );

    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dlc-rpf-batch-')
    );

    try {
      prepareOutputDirectory(
        outputDir,
        args.force
      );

      const extractedRoot = extractInputRpf(
        rpfPath,
        tempRoot
      );

      const result = buildFiveMResource(
        extractedRoot,
        outputDir,
        resourceName
      );

      results.push({
        rpfPath,
        outputDir,
        result,
      });

      console.log(
        `OK  ${path.relative(batchRoot, rpfPath)}` +
        ` -> ${path.relative(outputRoot, outputDir)}`
      );
    } catch (err) {
      failed += 1;

      console.error(
        `FAIL ${path.relative(batchRoot, rpfPath)}: ` +
        err.message
      );
    } finally {
      fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
      });
    }
  }

  console.log('');
  console.log('Batch conversion finished.');
  console.log(`converted: ${results.length}`);
  console.log(`failed:    ${failed}`);
  console.log(`output:    ${outputRoot}`);

  if (results.length === 0) {
    process.exitCode = 1;
  }
}

function findFilesNamed(root, targetName, excludedRoot) {
  const found = [];
  const stack = [root];
  const excluded = path.resolve(excludedRoot);

  while (stack.length) {
    const current = stack.pop();
    const currentResolved = path.resolve(current);

    if (
      currentResolved === excluded ||
      currentResolved.startsWith(
        `${excluded}${path.sep}`
      )
    ) {
      continue;
    }

    const entries = fs.readdirSync(current, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const abs = path.join(
        current,
        entry.name
      );

      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase() ===
          targetName.toLowerCase()
      ) {
        found.push(abs);
      }
    }
  }

  return found.sort((a, b) =>
    a.localeCompare(b)
  );
}

function parseArgs(argv) {
  const args = {};

  for (
    let i = 0;
    i < argv.length;
    i += 1
  ) {
    const arg = argv[i];

    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;

      case '--list':
        args.list = true;
        break;

      case '--force':
        args.force = true;
        break;

      case '-i':
      case '--input':
        args.input = readValue(
          argv,
          ++i,
          arg
        );
        break;

      case '-o':
      case '--output':
        args.output = readValue(
          argv,
          ++i,
          arg
        );
        break;

      case '-n':
      case '--name':
        args.name = readValue(
          argv,
          ++i,
          arg
        );
        break;

      case '--source-dir':
        args.sourceDir = readValue(
          argv,
          ++i,
          arg
        );
        break;

      case '--batch':
        args.batch = readValue(
          argv,
          ++i,
          arg
        );
        break;

      default:
        throw new Error(
          `Unknown argument: ${arg}`
        );
    }
  }

  if (args.input && args.sourceDir) {
    throw new Error(
      'Use either --input or --source-dir, not both.'
    );
  }

  if (
    args.batch &&
    (
      args.input ||
      args.sourceDir ||
      args.list
    )
  ) {
    throw new Error(
      '--batch cannot be combined with ' +
      '--input, --source-dir, or --list.'
    );
  }

  return args;
}

function readValue(argv, index, flag) {
  const value = argv[index];

  if (
    !value ||
    value.startsWith('-')
  ) {
    throw new Error(
      `Missing value for ${flag}`
    );
  }

  return value;
}

function printHelp() {
  console.log(`Usage:
  node convert-dlc-rpf-batch.js --input dlc.rpf --output vehicle_fivem
  node convert-dlc-rpf-batch.js --source-dir extracted_dlc --output vehicle_fivem
  node convert-dlc-rpf-batch.js --batch ./mods --output ./converted --force
  node convert-dlc-rpf-batch.js --input dlc.rpf --list

Options:
  -i, --input <file>       Source dlc.rpf. Defaults to ./dlc.rpf.
  --source-dir <folder>    Convert an already extracted DLC folder.
  --batch <folder>         Recursively scan for every dlc.rpf and convert each car.
  -o, --output <folder>    Output resource folder, or batch output root.
  -n, --name <name>        FiveM resource name. Defaults to current folder name.
  --force                  Remove existing output folders before conversion.
  --list                   List top-level RPF contents without extracting.
  -h, --help               Show this help.

Notes:
  This native extractor supports standard unencrypted RPF7 archives.
  If payloads are encrypted or locked by a nonstandard packer,
  extract the DLC with OpenIV/CodeWalker first, then run this script
  with --source-dir.`);
}

function listRpf(inputPath) {
  const archive = parseRpfArchive(
    fs.readFileSync(inputPath),
    inputPath
  );

  console.log(`${inputPath}`);
  console.log(
    `entries: ${archive.entries.length}`
  );
  console.log(
    `names:   ${archive.nameLength} bytes`
  );
  console.log(
    `mode:    ${archive.encryptionName}`
  );

  for (
    const item of flattenArchive(archive)
  ) {
    const suffix =
      item.entry.kind === 'directory'
        ? '/'
        : ` (${
            formatBytes(
              item.entry.diskSize ||
              item.entry.uncompressedSize ||
              0
            )
          })`;

    console.log(
      `${item.path}${suffix}`
    );
  }
}

function extractInputRpf(inputPath, tempRoot) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `Input RPF does not exist: ${inputPath}`
    );
  }

  const extractedRoot = path.join(
    tempRoot,
    'extracted'
  );

  fs.mkdirSync(extractedRoot, {
    recursive: true,
  });

  extractRpfBuffer(
    fs.readFileSync(inputPath),
    extractedRoot,
    path.basename(inputPath),
    0
  );

  return extractedRoot;
}
function extractRpfBuffer(
  buffer,
  destRoot,
  archiveLabel,
  depth
) {
  if (depth > 8) {
    throw new Error(
      `Too many nested RPF archives while reading ${archiveLabel}`
    );
  }

  const archive = parseRpfArchive(
    buffer,
    archiveLabel
  );

  const files = flattenArchive(archive)
    .filter(
      (item) =>
        item.entry.kind === 'file'
    );

  for (const item of files) {
    const decoded = extractFileEntry(
      buffer,
      item.entry,
      `${archiveLabel}:${item.path}`
    );

    const rel = sanitizeRelPath(
      item.path
    );

    const ext = path
      .extname(rel)
      .toLowerCase();

    if (ext === '.rpf') {
      if (!isRpf7(decoded)) {
        throw new Error(
          [
            `Nested RPF did not decode to an RPF7 archive: ${archiveLabel}:${item.path}`,
            'The DLC payload is probably encrypted, locked, or packed by a nonstandard tool.',
            'Extract it with OpenIV/CodeWalker and run this script again with --source-dir.',
          ].join('\n')
        );
      }

      const nestedRoot = path.join(
        destRoot,
        rel.replace(/\.rpf$/i, '')
      );

      fs.mkdirSync(nestedRoot, {
        recursive: true,
      });

      try {
        extractRpfBuffer(
          decoded,
          nestedRoot,
          `${archiveLabel}/${item.path}`,
          depth + 1
        );
      } catch (err) {
        const normalizedItemPath = slash(item.path).toLowerCase();
        const isLanguageArchive =
          normalizedItemPath.includes('/data/lang/') ||
          normalizedItemPath.startsWith('data/lang/');
        const isEncryptedTable =
          /Unsupported encrypted RPF table mode/i.test(err.message);

        if (isLanguageArchive && isEncryptedTable) {
          fs.rmSync(nestedRoot, {
            recursive: true,
            force: true,
          });
          continue;
        }

        throw err;
      }

      continue;
    }

    const outPath = path.join(
      destRoot,
      rel
    );

    fs.mkdirSync(
      path.dirname(outPath),
      {
        recursive: true,
      }
    );

    fs.writeFileSync(
      outPath,
      decoded
    );
  }
}

function parseRpfArchive(
  buffer,
  label
) {
  if (
    buffer.length < 16 ||
    buffer.readUInt32LE(0) !==
      RPF7_MAGIC_LE
  ) {
    throw new Error(
      `Not an RPF7 archive: ${label}`
    );
  }

  const entryCount =
    buffer.readUInt32LE(4);

  const nameLength =
    buffer.readUInt32LE(8);

  const encryptionName =
    buffer.toString(
      'ascii',
      12,
      16
    );

  const entriesOffset = 16;

  const namesOffset =
    entriesOffset +
    entryCount * 16;

  const namesEnd =
    namesOffset +
    nameLength;

  if (entryCount <= 0) {
    throw new Error(
      `RPF archive has no entries: ${label}`
    );
  }

  if (namesEnd > buffer.length) {
    throw new Error(
      `RPF table is outside file bounds: ${label}`
    );
  }

  if (encryptionName !== 'OPEN') {
    throw new Error(
      `Unsupported encrypted RPF table mode "${encryptionName}" in ${label}. ` +
      'Open/encrypt-free RPF7 tables are required.'
    );
  }

  const readName = (offset) => {
    if (
      offset < 0 ||
      offset >= nameLength
    ) {
      throw new Error(
        `Name offset ${offset} is outside the RPF name table in ${label}`
      );
    }

    let end =
      namesOffset +
      offset;

    while (
      end < namesEnd &&
      buffer[end] !== 0
    ) {
      end += 1;
    }

    return buffer.toString(
      'utf8',
      namesOffset + offset,
      end
    );
  };

  const entries = [];

  for (
    let index = 0;
    index < entryCount;
    index += 1
  ) {
    const off =
      entriesOffset +
      index * 16;

    const first =
      buffer.readBigUInt64LE(off);

    const second =
      buffer.readUInt32LE(off + 8);

    const third =
      buffer.readUInt32LE(off + 12);

    const nameOffset =
      Number(
        first & 0xffffn
      );

    const name =
      readName(nameOffset);

    const marker =
      buffer.readUInt32LE(off + 4);

    if (
      marker ===
      DIRECTORY_MARKER
    ) {
      entries.push({
        index,
        kind: 'directory',
        name,
        firstChild: second,
        childCount: third,
      });

      continue;
    }

    const compressedSize =
      Number(
        (first >> 16n) &
        0xffffffn
      );

    const sectorOffset =
      Number(
        (first >> 40n) &
        0x7fffffn
      );

    const uncompressedSize =
      second;

    const encryptionType =
      third;

    const diskSize =
      compressedSize ||
      uncompressedSize;

    entries.push({
      index,
      kind: 'file',
      name,
      compressedSize,
      sectorOffset,
      uncompressedSize,
      encryptionType,
      diskSize,
    });
  }

  return {
    entries,
    entryCount,
    nameLength,
    encryptionName,
    label,
  };
}

function flattenArchive(archive) {
  const out = [];

  const walk = (
    index,
    prefix
  ) => {
    const dir =
      archive.entries[index];

    if (
      !dir ||
      dir.kind !== 'directory'
    ) {
      throw new Error(
        `Invalid directory entry ${index} in ${archive.label}`
      );
    }

    const end =
      dir.firstChild +
      dir.childCount;

    if (
      end >
      archive.entries.length
    ) {
      throw new Error(
        `Directory entry range is outside the RPF table in ${archive.label}`
      );
    }

    for (
      let childIndex =
        dir.firstChild;
      childIndex < end;
      childIndex += 1
    ) {
      const child =
        archive.entries[
          childIndex
        ];

      const rel =
        prefix
          ? `${prefix}/${child.name}`
          : child.name;

      out.push({
        path: rel,
        entry: child,
      });

      if (
        child.kind ===
        'directory'
      ) {
        walk(
          childIndex,
          rel
        );
      }
    }
  };

  walk(0, '');

  return out;
}

function extractFileEntry(
  buffer,
  entry,
  label
) {
  const start =
    entry.sectorOffset *
    RPF_SECTOR_SIZE;

  const end =
    start +
    entry.diskSize;

  if (
    start < 0 ||
    end > buffer.length
  ) {
    throw new Error(
      `RPF entry points outside archive bounds: ${label}`
    );
  }

  const raw =
    buffer.subarray(
      start,
      end
    );

  const ext =
    path
      .extname(entry.name)
      .toLowerCase();

  const isResourceFile =
    STREAM_EXTENSIONS.has(ext);

  if (
    !isResourceFile &&
    entry.encryptionType !== 0
  ) {
    throw new Error(
      `Unsupported encrypted RPF entry in ${label} ` +
      `(encryption type ${entry.encryptionType}).`
    );
  }

  const shouldKeepRaw =
    isResourceFile ||
    ext === '.rpf' ||
    !entry.compressedSize ||
    entry.compressedSize ===
      entry.uncompressedSize;

  if (shouldKeepRaw) {
    return Buffer.from(raw);
  }

  return inflatePayload(
    raw,
    entry.uncompressedSize,
    label
  );
}

function inflatePayload(
  raw,
  expectedSize,
  label
) {
  const attempts = [
    [
      'deflate-raw',
      () =>
        zlib.inflateRawSync(
          raw
        ),
    ],
    [
      'zlib',
      () =>
        zlib.inflateSync(
          raw
        ),
    ],
  ];

  const failures = [];

  for (
    const [name, run]
    of attempts
  ) {
    try {
      const inflated =
        run();

      if (
        expectedSize &&
        inflated.length !==
          expectedSize
      ) {
        failures.push(
          `${name}: decoded ${inflated.length} bytes, expected ${expectedSize}`
        );

        continue;
      }

      return inflated;
    } catch (err) {
      failures.push(
        `${name}: ${
          err.code ||
          err.message
        }`
      );
    }
  }

  throw new Error(
    [
      `Could not decompress RPF entry ${label}.`,
      ...failures.map(
        (line) =>
          `  ${line}`
      ),
      'The payload may be encrypted, locked, or not standard deflate data.',
      'Extract it with OpenIV/CodeWalker and run this script again with --source-dir.',
    ].join('\n')
  );
}
function buildFiveMResource(
  sourceRoot,
  outputDir,
  resourceName
) {
  if (
    !fs.existsSync(sourceRoot) ||
    !fs.statSync(sourceRoot).isDirectory()
  ) {
    throw new Error(
      `Source folder does not exist: ${sourceRoot}`
    );
  }

  const allFiles =
    collectFiles(sourceRoot);

  const copiedData = [];
  const copiedStream = [];
  const skipped = [];

  const usedDestinations =
    new Set();

  fs.mkdirSync(
    outputDir,
    {
      recursive: true,
    }
  );

  fs.mkdirSync(
    path.join(
      outputDir,
      'data'
    ),
    {
      recursive: true,
    }
  );

  fs.mkdirSync(
    path.join(
      outputDir,
      'stream'
    ),
    {
      recursive: true,
    }
  );

  for (const abs of allFiles) {
    const rel = slash(
      path.relative(
        sourceRoot,
        abs
      )
    );

    const base =
      path.basename(abs);

    const ext =
      path
        .extname(base)
        .toLowerCase();

    if (
      ext === '.meta' &&
      getMetaType(base)
    ) {
      const destRel =
        uniqueDest(
          `data/${base}`,
          usedDestinations
        );

      copyFile(
        abs,
        path.join(
          outputDir,
          destRel
        )
      );

      copiedData.push(
        destRel
      );

      continue;
    }

    if (
      STREAM_EXTENSIONS.has(ext)
    ) {
      const destRel =
        uniqueDest(
          `stream/${base}`,
          usedDestinations
        );

      copyFile(
        abs,
        path.join(
          outputDir,
          destRel
        )
      );

      copiedStream.push(
        destRel
      );

      continue;
    }

    skipped.push(rel);
  }

  if (
    copiedStream.length === 0
  ) {
    throw new Error(
      'No streamable vehicle assets were found. ' +
      'Expected files like .yft, .ytd, .ydr, or .ytyp.'
    );
  }

  if (
    copiedData.length === 0
  ) {
    throw new Error(
      'No recognized vehicle metadata files were found. ' +
      'Expected files like handling.meta or vehicles.meta.'
    );
  }

  writeManifest(
    outputDir,
    resourceName,
    copiedData
  );

  return {
    resourceName,
    dataFiles: copiedData,
    streamFiles: copiedStream,
    skipped,
  };
}

function printSummary(
  result,
  outputDir
) {
  console.log(
    `Created FiveM resource: ${outputDir}`
  );

  console.log(
    `resource name: ${result.resourceName}`
  );

  console.log(
    `metadata:      ${result.dataFiles.length}`
  );

  console.log(
    `stream files:  ${result.streamFiles.length}`
  );

  if (
    result.skipped.length
  ) {
    console.log(
      `skipped:       ${result.skipped.length}`
    );
  }
}

function collectFiles(root) {
  const files = [];
  const stack = [root];

  while (stack.length) {
    const current =
      stack.pop();

    const entries =
      fs.readdirSync(
        current,
        {
          withFileTypes: true,
        }
      );

    for (
      const entry of entries
    ) {
      const abs =
        path.join(
          current,
          entry.name
        );

      if (
        entry.isDirectory()
      ) {
        stack.push(abs);
      } else if (
        entry.isFile()
      ) {
        files.push(abs);
      }
    }
  }

  return files.sort(
    (a, b) =>
      a.localeCompare(b)
  );
}

function copyFile(
  src,
  dest
) {
  fs.mkdirSync(
    path.dirname(dest),
    {
      recursive: true,
    }
  );

  fs.copyFileSync(
    src,
    dest
  );
}

function uniqueDest(
  rel,
  usedDestinations
) {
  const parsed =
    path.parse(rel);

  let candidate = rel;
  let counter = 1;

  while (
    usedDestinations.has(
      slash(candidate)
        .toLowerCase()
    )
  ) {
    candidate =
      path.join(
        parsed.dir,
        `${parsed.name}_${counter}${parsed.ext}`
      );

    counter += 1;
  }

  const normalized =
    slash(candidate);

  usedDestinations.add(
    normalized.toLowerCase()
  );

  return normalized;
}

function writeManifest(
  outputDir,
  resourceName,
  dataFiles
) {
  const dataEntries =
    dataFiles
      .map((rel) => {
        const type =
          getMetaType(
            path.basename(rel)
          );

        return type
          ? `data_file '${type}' '${slash(rel)}'`
          : null;
      })
      .filter(Boolean);

  const fileEntries =
    dataFiles.map(
      (rel) =>
        `  '${slash(rel)}'`
    );

  const manifest = [
    "fx_version 'cerulean'",
    "game 'gta5'",
    '',
    `name '${escapeLuaString(resourceName)}'`,
    "author 'converted from dlc.rpf'",
    '',
    'files {',
    fileEntries.join(',\n'),
    '}',
    '',
    dataEntries.join('\n'),
    '',
  ].join('\n');

  fs.writeFileSync(
    path.join(
      outputDir,
      'fxmanifest.lua'
    ),
    manifest,
    'utf8'
  );
}

function getMetaType(fileName) {
  const found =
    META_TYPES.find(
      (item) =>
        item.match.test(
          fileName
        )
    );

  return found
    ? found.type
    : null;
}

function sanitizeRelPath(rel) {
  const parts = slash(rel)
    .split('/')
    .filter(Boolean)
    .map((part) =>
      part.replace(
        /[<>:"|?*]/g,
        '_'
      )
    );

  if (
    parts.some(
      (part) =>
        part === '..'
    )
  ) {
    throw new Error(
      `Unsafe path inside RPF: ${rel}`
    );
  }

  return parts.join(
    path.sep
  );
}

function sanitizeResourceName(
  name
) {
  const cleaned =
    String(name)
      .trim()
      .replace(
        /[^a-zA-Z0-9_-]+/g,
        '_'
      )
      .replace(
        /^_+|_+$/g,
        ''
      );

  return cleaned ||
    'converted_vehicle';
}

function escapeLuaString(
  value
) {
  return String(value)
    .replace(
      /\\/g,
      '\\\\'
    )
    .replace(
      /'/g,
      "\\'"
    );
}

function isRpf7(buffer) {
  return (
    buffer.length >= 4 &&
    buffer.readUInt32LE(0) ===
      RPF7_MAGIC_LE
  );
}

function slash(value) {
  return value.replace(
    /\\/g,
    '/'
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (
    bytes <
    1024 * 1024
  ) {
    return `${
      (
        bytes /
        1024
      ).toFixed(1)
    } KB`;
  }

  return `${
    (
      bytes /
      1024 /
      1024
    ).toFixed(1)
  } MB`;
}

try {
  main();
} catch (err) {
  console.error(
    err.message
  );

  process.exitCode = 1;
}