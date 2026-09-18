// Headless engine run:
//   node tools/run_engine_node.mjs <in.pdf> <out.pdf> [scale] ["NAME=paletteIdx;NAME2=paletteIdx"] \
//        [--mode=page] [--enlarge-only="NAME;NAME2"]
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const PDFLib = require(path.join(root, 'node_modules/pdf-lib/dist/pdf-lib.js'));
// pdf.js v5 evaluates `new DOMMatrix()` at import time; Node has none, and the
// official polyfill (@napi-rs/canvas) is only needed for RENDERING. This
// runner only extracts text (page images are pymupdf's job in check.py), so a
// minimal identity-matrix stand-in satisfies module evaluation. If anything
// in the text path ever really used it, the independent verifier would fail.
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      if (Array.isArray(init) && init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
    }
  };
}
// pdf.js v4+ ships ESM only; the module namespace is API-compatible with the
// old UMD global (getDocument, GlobalWorkerOptions, ...)
const pdfjsLib = await import(pathToFileURL(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const createSidesEngine = require(path.join(root, 'engine.js'));

const argv = process.argv.slice(2);
const pos = argv.filter(a => !a.startsWith('--'));
const [inFile, outFile, scaleArg, hlArg] = pos;
const scale = parseFloat(scaleArg || '1.25');
const highlights = {};
if (hlArg) {
  for (const part of hlArg.split(';')) {
    const m = part.match(/^(.+)=(\d+)$/);
    if (m) highlights[m[1].trim()] = parseInt(m[2], 10);
  }
}
let mode = 'dialogue', enlargeOnly = null, watermarkText = null, emit = null;
for (const f of argv.filter(a => a.startsWith('--'))) {
  if (f === '--mode=page') mode = 'page';
  else if (f === '--mode=reader') mode = 'reader';
  else if (f === '--emit=elements') emit = 'elements';
  else if (f.startsWith('--enlarge-only=')) {
    enlargeOnly = f.slice('--enlarge-only='.length).split(';').map(s => s.trim()).filter(Boolean);
  } else if (f.startsWith('--watermark-text=')) {
    watermarkText = f.slice('--watermark-text='.length).split('|').map(s => s.trim()).filter(Boolean);
  }
}

const policy = JSON.parse(fs.readFileSync(path.join(root, 'policy/scriptparse-policy.json'), 'utf8'));
const engine = createSidesEngine({ pdfjsLib, PDFLib, policy });
const bytes = new Uint8Array(fs.readFileSync(inFile));

try {
  if (emit === 'elements') {
    const { elements, report } = await engine.reader(bytes, { highlights, watermarkText });
    fs.writeFileSync(outFile, JSON.stringify({ elements, report }, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  const { bytes: out, report } = await engine.process(bytes, { scale, highlights, mode, enlargeOnly, watermarkText });
  fs.writeFileSync(outFile, out);
  fs.writeFileSync(outFile + '.report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (e.code === 'SCANNED') { console.error('SCANNED: ' + e.message); process.exit(3); }
  throw e;
}
