// Cliff-2 regression (scriptparse #43): pdf.js 4.2+/5.x iterates its
// text-content ReadableStream with `for await`, which WebKit only shipped in
// Safari 26. Node is async-iterable since 16, so a plain Node run PASSES while
// a real iPhone on Safari 15.4-18.x FAILS. This test strips the async iterator
// to stand in for those phones, proves raw pdf.js fails identically, and proves
// the engine's main-thread polyfill recovers.
//
// Usage: node tools/test_ios_stream.mjs [fixture.pdf]
//
// Why it matters: the page ships as one file that must also work on an
// iPhone. Node passing on its own would prove nothing about Safari, so the
// test first removes the feature those Safari versions lack, then checks two
// things: plain pdf.js now fails (so the test really recreates the phone),
// and the engine still works (its fallback covers the gap).
// Exit code 1 means one of those two checks failed.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Same setup as run_engine_node.mjs: pdf-lib, a DOMMatrix stand-in so pdf.js
// can load in Node (it is a browser class), then the engine.
const PDFLib = require(path.join(root, 'node_modules/pdf-lib/dist/pdf-lib.js'));
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class { constructor(){ this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0; } };
}
const pdfjsLib = await import(pathToFileURL(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const createSidesEngine = require(path.join(root, 'engine.js'));

// The synthetic fixture PDF from make_fixture.py by default; any PDF works.
const fixture = process.argv[2] || path.join(root, 'out/fixture.pdf');
const bytes = new Uint8Array(fs.readFileSync(fixture));

// simulate a pre-Safari-26 WebKit: ReadableStream is not async-iterable
// (a ReadableStream is how pdf.js hands over page text in chunks; deleting
// its async iterator recreates the older Safari that could not loop over
// one with for-await)
function stripStreamAsyncIterator() {
  try { delete ReadableStream.prototype[Symbol.asyncIterator]; } catch {}
  try { delete ReadableStream.prototype.values; } catch {}
}

let fail = 0;

// (1) control: raw pdf.js with the iterator stripped must throw at getTextContent
stripStreamAsyncIterator();
let rawFailed = false, rawErr = '';
try {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  await page.getTextContent();
  await doc.destroy();
} catch (e) { rawFailed = true; rawErr = (e && e.message) || String(e); }
if (rawFailed) console.log(`  [control] raw pdf.js FAILED as expected with the iterator stripped: ${rawErr.slice(0, 70)}`);
else { console.log('  [control] FAIL: raw pdf.js did NOT fail; cliff 2 not reproduced (test is not proving anything)'); fail = 1; }

// (2) engine.process with the iterator stripped must SUCCEED (extract() reinstalls the polyfill)
stripStreamAsyncIterator();
const policy = JSON.parse(fs.readFileSync(path.join(root, 'policy/scriptparse-policy.json'), 'utf8'));
const engine = createSidesEngine({ pdfjsLib, PDFLib, policy });
let chars = -1, engErr = '';
try {
  const { report } = await engine.process(new Uint8Array(bytes), { scale: 1.25 });
  chars = (report.characters || []).length;
} catch (e) { engErr = (e && e.message) || String(e); }
if (chars >= 0) console.log(`  [engine] extracted ${chars} characters with the iterator stripped (main-thread polyfill works)`);
else { console.log(`  [engine] FAIL: engine did not recover: ${engErr}`); fail = 1; }

console.log(fail ? 'IOS-STREAM: FAIL' : 'IOS-STREAM: ok');
process.exit(fail);
