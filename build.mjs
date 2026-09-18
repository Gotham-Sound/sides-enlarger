// Bundle everything into one self-contained sidesenlarger.html
// usage: node build.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// inline scripts must not contain a literal "</script"; inside JS string
// literals "<\/script" is byte-identical after parsing, so this is safe.
const safe = s => s.replace(/<\/script/gi, '<\\/script');

// pdf.js v4+ is ESM-only (.mjs, no UMD build): both the main library and the
// worker are embedded as base64 and reconstituted at runtime as blob: URLs
// (the module is `await import()`ed; the CSP's `script-src blob:` allows it).
const pdfjsB64 = fs.readFileSync(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs')).toString('base64');
const workerB64 = fs.readFileSync(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs')).toString('base64');
const logoB64 = fs.readFileSync(path.join(root, 'assets/gothamsound_green-and-black.png')).toString('base64');
const version = JSON.parse(read('package.json')).version;
// the scriptparse policy data (identity rulings as versioned JSON, vendored
// byte-identical from the hub; tools/conformance_check.mjs verifies it)
const policyJson = JSON.stringify(JSON.parse(read('policy/scriptparse-policy.json')));

const template = read('ui_template.html');
const out = template
  .replace('/*__PDFJS_B64__*/', () => pdfjsB64)
  .replace('/*__PDFWORKER_B64__*/', () => workerB64)
  .replace('/*__PDFLIB__*/', () => safe(read('node_modules/pdf-lib/dist/pdf-lib.min.js')))
  .replace('/*__ENGINE__*/', () => safe(read('engine.js')))
  .replace('/*__POLICY__*/', () => safe(policyJson))
  .replace('__LOGO_B64__', () => logoB64)
  .replace(/__VERSION__/g, () => version);

// index.html is the canonical, committed build output: GitHub Pages serves it
// directly, and it's also the single file to email/AirDrop to an actor.
const dest = path.join(root, 'index.html');
fs.writeFileSync(dest, out);
console.log('wrote', dest, (out.length / 1048576).toFixed(2) + ' MB');
