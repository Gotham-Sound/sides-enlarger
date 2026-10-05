// Headless engine run:
//   node tools/run_engine_node.mjs <in.pdf> <out.pdf> [scale] ["NAME=paletteIdx;NAME2=paletteIdx"] \
//        [--mode=page] [--enlarge-only="NAME;NAME2"] [--outcue=N] [--outcue-style=underline,bold,lastWord]
//
// What this is: the same engine that runs inside the web page, run from the
// command line on one PDF. The tests and the verifier (check.py) use it so
// they can look at the engine's output without a browser. It writes the
// enlarged PDF to <out.pdf> and a JSON "report" (what the engine found and
// what it did to each page) next to it as <out.pdf>.report.json, and prints
// that report.
// Also accepted: --mode=reader, --emit=elements | --emit=analyze (write reader-mode elements
// as JSON instead of a PDF), --watermark-text="A|B" (text to treat as a
// watermark, not script), --outcue=N (Reader mode: mark the last N words of
// every speech; 0 = off) with --outcue-style=underline,bold,lastWord (any mix;
// default underline; lastWord = the last real word bold at 1.25x).
// Exit codes: 0 ok; 3 the PDF is a scan with no real text layer; anything
// else is a crash.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// This file is an ES module, but engine.js and pdf-lib are CommonJS files
// (the older Node module style), so we build a require() to load them.
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// pdf-lib writes PDFs. The engine never loads libraries itself: callers hand
// them in ("dependency injection"), which is what lets the same engine.js
// run unchanged in the browser and in Node.
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

// Command-line arguments: the positional ones first (file paths, scale, the
// highlight list), then any --flags.
const argv = process.argv.slice(2);
const pos = argv.filter(a => !a.startsWith('--'));
const [inFile, outFile, scaleArg, hlArg] = pos;
const scale = parseFloat(scaleArg || '1.25');
// "NAME=idx;NAME2=idx" becomes { NAME: idx }: which character gets which
// color, as an index into the engine's fixed 16-color palette.
const highlights = {};
if (hlArg) {
  for (const part of hlArg.split(';')) {
    const m = part.match(/^(.+)=(\d+)$/);
    if (m) highlights[m[1].trim()] = parseInt(m[2], 10);
  }
}
// Defaults: enlarge all dialogue in place, no names singled out, no declared
// watermark text, and write a PDF (not elements).
let mode = 'dialogue', enlargeOnly = null, watermarkText = null, emit = null, outcueWords = 0, outcueStyle = null;
for (const f of argv.filter(a => a.startsWith('--'))) {
  if (f === '--mode=page') mode = 'page';
  else if (f === '--mode=reader') mode = 'reader';
  else if (f === '--emit=elements') emit = 'elements';
  else if (f === '--emit=analyze') emit = 'analyze';
  else if (f.startsWith('--outcue=')) outcueWords = parseInt(f.slice('--outcue='.length), 10) || 0;
  else if (f.startsWith('--outcue-style=')) {
    outcueStyle = {};
    for (const s of f.slice('--outcue-style='.length).split(',')) if (s.trim()) outcueStyle[s.trim()] = true;
  }
  else if (f.startsWith('--enlarge-only=')) {
    enlargeOnly = f.slice('--enlarge-only='.length).split(';').map(s => s.trim()).filter(Boolean);
  } else if (f.startsWith('--watermark-text=')) {
    watermarkText = f.slice('--watermark-text='.length).split('|').map(s => s.trim()).filter(Boolean);
  }
}

// The identity policy is shared data from the scriptparse hub (which names
// count as characters, how to normalise them); the engine interprets it and
// has no name rules of its own.
const policy = JSON.parse(fs.readFileSync(path.join(root, 'policy/scriptparse-policy.json'), 'utf8'));
const engine = createSidesEngine({ pdfjsLib, PDFLib, policy });
// The engine works on raw bytes, exactly as the browser hands it a dropped file.
const bytes = new Uint8Array(fs.readFileSync(inFile));

try {
  // --emit=elements: reader mode as data (one element per slug, cue, line of
  // dialogue, ...) for tools that draw their own reading view, e.g. Sides Helper.
  // --emit=analyze: the extraction-only report (characters, rails, per-page
  // counts) with no PDF written; test.sh compares it with a full run's report.
  if (emit === 'analyze') {
    const report = await engine.analyze(bytes);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  if (emit === 'elements') {
    const { elements, report } = await engine.reader(bytes, { highlights, watermarkText });
    fs.writeFileSync(outFile, JSON.stringify({ elements, report }, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  // Normal path: rewrite the PDF, and keep the report beside it for check.py.
  const { bytes: out, report } = await engine.process(bytes, { scale, highlights, mode, enlargeOnly, watermarkText, outcueWords, outcueStyle });
  fs.writeFileSync(outFile, out);
  fs.writeFileSync(outFile + '.report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  // A scanned PDF (pictures of pages, no text) cannot be processed. Exit 3 so
  // test.sh can tell that apart from a crash.
  if (e.code === 'SCANNED') { console.error('SCANNED: ' + e.message); process.exit(3); }
  throw e;
}
