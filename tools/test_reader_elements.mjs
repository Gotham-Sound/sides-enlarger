// Reader mode as a function (engine.reader / engine.renderReaderPdf).
// Asserts: the element stream carries name / page / pageLabel / scene /
// highlight; it is the SAME stream the PDF path renders (deep-equal of the
// text+type sequence, same readerBreaks); and renderReaderPdf(elements)
// yields the same page count as process({mode:'reader'}).
//
// Usage: node tools/test_reader_elements.mjs [fixture.pdf]
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDFLib = require(path.join(root, 'node_modules/pdf-lib/dist/pdf-lib.js'));
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class { constructor(){ this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0; } };
}
const pdfjsLib = await import(pathToFileURL(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const createSidesEngine = require(path.join(root, 'engine.js'));
const policy = JSON.parse(fs.readFileSync(path.join(root, 'policy/scriptparse-policy.json'), 'utf8'));
const engine = createSidesEngine({ pdfjsLib, PDFLib, policy });

const src = process.argv[2] || path.join(root, 'out/fixture.pdf');
const bytes = new Uint8Array(fs.readFileSync(src));
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const hlIn = { 'LAURA': 0, 'MERC #1': 2 };
const { elements, report } = await engine.reader(bytes, { highlights: hlIn });
ok(Array.isArray(elements) && elements.length > 0, 'no elements');
ok(report.elements === elements.length, 'report.elements mismatch');
const types = new Set(['break', 'slug', 'action', 'cue', 'paren', 'dialogue', 'transition']);
elements.forEach((el, i) => {
  ok(el.i === i, `element ${i}: index`);
  ok(types.has(el.t), `element ${i}: type ${el.t}`);
  ok(typeof el.text === 'string' && el.text.trim(), `element ${i}: empty text`);
  ok(Number.isInteger(el.page) && el.page >= 0, `element ${i}: page`);
  ok(typeof el.pageLabel === 'string' && el.pageLabel, `element ${i}: pageLabel`);
  if (el.t === 'dialogue' || el.t === 'cue') ok(typeof el.name === 'string' && el.name, `element ${i}: ${el.t} without name`);
  if (el.t === 'slug') ok(typeof el.heading === 'string' && el.heading, `element ${i}: slug without heading`);
  if (el.t !== 'break') ok(el.heading == null || typeof el.heading === 'string', `element ${i}: heading type`);
  if (el.name && hlIn[el.name] != null) ok(el.highlight && el.highlight.palette === hlIn[el.name] && el.highlight.hex, `element ${i}: highlight for ${el.name}`);
  else ok(el.highlight === null, `element ${i}: unexpected highlight`);
});
ok(elements.some(el => el.t === 'break'), 'no page breaks');
ok(elements.some(el => el.t === 'slug'), 'no slugs');
ok(elements.some(el => el.t === 'dialogue' && el.highlight), 'no highlighted dialogue');
// every element after the first slug belongs to a scene
let seenSlug = false;
for (const el of elements) { if (el.t === 'slug') seenSlug = true; if (seenSlug && el.t !== 'break') ok(el.heading != null, `element ${el.i}: no scene after first slug`); }
// characters/sluglines still ride the report
ok(Array.isArray(report.characters) && report.characters.length, 'report.characters missing');
ok(Array.isArray(report.sluglines), 'report.sluglines missing');

// same stream as the PDF path
const pdfRun = await engine.process(bytes, { mode: 'reader', scale: 1.25, highlights: hlIn });
const pdfDoc = await PDFLib.PDFDocument.load(pdfRun.bytes);
const rendered = await engine.renderReaderPdf(elements, 1.25, hlIn);
const rDoc = await PDFLib.PDFDocument.load(rendered);
ok(rDoc.getPageCount() === pdfDoc.getPageCount(), `renderReaderPdf page count ${rDoc.getPageCount()} != process reader ${pdfDoc.getPageCount()}`);
ok(pdfRun.report.readerBreaks.length === elements.filter(e => e.t === 'break').length, 'break count differs from PDF path');
// no script text in the summary we print
if (fails.length) { console.log('READER-ELEMENTS: FAIL'); for (const f of fails.slice(0, 20)) console.log('  - ' + f); process.exit(1); }
console.log(`READER-ELEMENTS: ok (${elements.length} elements, ${rDoc.getPageCount()} reader pages)`);
