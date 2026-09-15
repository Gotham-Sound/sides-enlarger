#!/usr/bin/env node
// Inverted-verification runner for the scriptparse conformance corpus
// (hub issue #40, Phase 0). This bench's standing harness: re-run it on every
// corpus bump and post the numbers on the hub work-order issue.
//
//   node tools/conformance_check.mjs [--hub ../scriptparse] [--corpus DIR]
//                                    [--policy FILE] [--verbose]
//
// What it proves (the gate that is ours to prove): every vector file, the
// manifest and policy.json are consumable by a zero-dependency JS reader
// (plain JSON.parse), every per-file sha256 matches the manifest, the
// declared case counts match the files, and the manifest's policy_version
// binding matches the shipped policy. The manifest's own sha256 (printed raw
// and CR-stripped, per the constitution's Windows note) is the ack number.
//
// What it also measures (informational, never a gate): the LOCAL pre-adoption
// interpreter (normalizeCueName + isPlausibleName) against the vectors whose
// shape it can consume. Every miss there is red-on-local: the delta Phase 1
// closes when this bench retires its local fold/gate onto policy.json. This
// script is NOT a policy interpreter; adoption is a separate, ratified step.
//
// Exit status: 1 only when consumability is red. Prints SKIP (exit 0) when no
// corpus is found, so tools/test.sh can call it unconditionally.
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const hub = path.resolve(opt('--hub', process.env.SCRIPTPARSE_HUB || path.join(root, '..', 'scriptparse')));
const corpusDir = path.resolve(opt('--corpus', path.join(hub, 'conformance')));
const policyFile = path.resolve(opt('--policy', path.join(hub, 'scriptparse', 'policy.json')));
const verbose = args.includes('--verbose') || args.includes('-v');

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const shaCR = buf => sha(Buffer.from(buf.toString('utf8').replace(/\r/g, ''), 'utf8'));
const short = h => h.slice(0, 12) + '…';

const manifestPath = path.join(corpusDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.log(`CONFORMANCE: SKIP (no corpus at ${corpusDir}; pass --hub, --corpus, or set SCRIPTPARSE_HUB)`);
  process.exit(0);
}

// The engine's pure exports only: no PDF libs are touched by the fold/gate.
const engine = require(path.join(root, 'engine.js'))({ pdfjsLib: {}, PDFLib: {} });
if (typeof engine.isPlausibleName !== 'function' || typeof engine.normalizeCueName !== 'function') {
  console.log('CONFORMANCE: RED (engine.js does not export normalizeCueName + isPlausibleName)');
  process.exit(1);
}
const norm = s => engine.normalizeCueName(s);
const gate = s => engine.isPlausibleName(norm(s)); // the engine's real path: collectCharacters gates the normalized name

// ---- 1. consumability: checksums, parse, counts, policy binding ----
let red = 0;
const fail = msg => { red++; console.log('  RED  ' + msg); };

const manifestBuf = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBuf.toString('utf8'));
console.log(`corpus_version ${manifest.corpus_version}  policy_version(bound) ${manifest.policy_version}`);
console.log(`manifest sha256 (raw)         ${sha(manifestBuf)}`);
console.log(`manifest sha256 (CR-stripped) ${shaCR(manifestBuf)}`);

let policy = null;
if (fs.existsSync(policyFile)) {
  const pb = fs.readFileSync(policyFile);
  policy = JSON.parse(pb.toString('utf8'));
  console.log(`policy.json sha256 (raw)      ${sha(pb)}  policy_version ${policy.policy_version}`);
  if (policy.policy_version !== manifest.policy_version) fail(`policy_version mismatch: manifest ${manifest.policy_version} vs policy.json ${policy.policy_version}`);
  // JS-consumable shape: lists, maps and scalars only (a RegExp can't survive JSON.parse, so this is a tripwire for a future non-JSON policy)
  const walk = (v, p) => {
    if (v instanceof RegExp) fail(`policy has a RegExp at ${p}`);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`);
  };
  walk(policy, 'policy');
} else console.log(`policy.json: not found at ${policyFile} (binding check skipped)`);

const countCases = obj => Array.isArray(obj.cases) ? obj.cases.length
  : Object.keys(obj).filter(k => Array.isArray(obj[k])).reduce((n, k) => n + obj[k].length, 0);
const vectors = {};
console.log('\n| vector file | cases (manifest / file) | sha256 vs manifest | JSON.parse |');
console.log('|---|---|---|---|');
for (const f of manifest.files) {
  const p = path.join(corpusDir, f.path);
  const row = `| \`${f.path}\` | ${f.cases} / `;
  if (!fs.existsSync(p)) { fail(`${f.path} missing`); console.log(row + 'missing | — | — |'); continue; }
  const buf = fs.readFileSync(p);
  const h = sha(buf), hc = shaCR(buf);
  const shaOk = h === f.sha256 || hc === f.sha256;
  if (!shaOk) fail(`${f.path} sha256 ${short(h)} (CR-stripped ${short(hc)}) != manifest ${short(f.sha256)}`);
  let obj = null, parseOk = false;
  try { obj = JSON.parse(buf.toString('utf8')); parseOk = true; } catch (e) { fail(`${f.path} JSON.parse: ${e.message}`); }
  const n = parseOk ? countCases(obj) : 0;
  if (parseOk && n !== f.cases) fail(`${f.path} declares ${f.cases} cases, file has ${n}`);
  if (parseOk) vectors[path.basename(f.path, '.json')] = obj;
  console.log(row + `${n} | ${shaOk ? 'match' : 'MISMATCH'} \`${short(f.sha256)}\` | ${parseOk ? 'ok' : 'FAIL'} |`);
}
const total = manifest.files.reduce((n, f) => n + f.cases, 0);
console.log(`\nJS-consumability: ${red ? 'RED (' + red + ' problem(s) above)' : 'GREEN'}  (${manifest.files.length} files, ${total} cases, zero deps beyond JSON.parse)`);

// ---- 2. local-vs-contract (informational) ----
console.log('\nLocal pre-adoption interpreter vs contract (red-on-local = the Phase-1 delta; not a gate):');
const misses = [];
const measure = (name, cases, fn) => {
  if (!cases) { console.log(`  ${name}: vector file not loaded`); return; }
  let ok = 0;
  for (const c of cases) { const r = fn(c); if (r.ok) ok++; else misses.push({ file: name, ...r }); }
  console.log(`  ${name}: ${ok}/${cases.length} agree`);
};
measure('fold.json base (full {base,channel,tier,kind} is red-on-local by construction: local emits a string)',
  vectors.fold && vectors.fold.cases, c => ({ input: c.cue, local: norm(c.cue), expect: c.expect.base, ok: norm(c.cue) === c.expect.base }));
measure('normalize.json (norm_cue)',
  vectors.normalize && vectors.normalize.cases, c => ({ input: c.raw, local: norm(c.raw), expect: c.expect, ok: norm(c.raw) === c.expect }));
measure('part_of.json (aliases ignored locally)',
  vectors.part_of && vectors.part_of.cases, c => ({ input: c.cue, local: norm(c.cue), expect: c.expect, ok: norm(c.cue) === c.expect }));
measure('cue_gate.json (local isPlausibleName after normalizeCueName)',
  vectors.cue_gate && vectors.cue_gate.cases, c => ({ input: c.cue, local: gate(c.cue), expect: c.expect, ok: gate(c.cue) === c.expect }));
measure('charset.json (same local predicate: one gate locally, two in the contract)',
  vectors.charset && vectors.charset.cases, c => ({ input: c.cue, local: gate(c.cue), expect: c.expect, ok: gate(c.cue) === c.expect }));
for (const f of ['dual', 'parts', 'offers', 'burn_in']) {
  if (vectors[f]) console.log(`  ${f}.json: no local interpreter of this shape (red-on-local by construction, ${countCases(vectors[f])} cases)`);
}
if (policy && policy.dual_dialogue) {
  console.log(`  note: policy dual_dialogue.min_gap_pt = ${policy.dual_dialogue.min_gap_pt}; this engine splits line segments at gaps > 40pt (buildLines), the same constant.`);
}
if (verbose && misses.length) {
  console.log('\nMisses (input -> local | expect):');
  for (const m of misses) console.log(`  [${m.file.split(' ')[0]}] ${JSON.stringify(m.input)} -> ${JSON.stringify(m.local)} | ${JSON.stringify(m.expect)}`);
}
console.log(`\nCONFORMANCE: ${red ? 'RED' : 'GREEN'} (consumability) manifest ${sha(manifestBuf)}`);
process.exit(red ? 1 : 0);
