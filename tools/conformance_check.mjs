#!/usr/bin/env node
// Inverted-verification runner for the scriptparse conformance corpus
// (hub issue #40 protocol; Phase 1 flip per #83). This bench's standing
// harness: re-run it on every corpus bump and post the numbers on the hub
// work-order issue.
//
//   node tools/conformance_check.mjs [--hub ../scriptparse] [--corpus DIR]
//                                    [--policy FILE] [--verbose]
//
// Two gates, both required for GREEN:
//  1. Consumability: every vector file, the manifest and policy.json parse with
//     plain JSON.parse (zero deps), every per-file sha256 matches the manifest,
//     declared case counts match, the manifest's policy_version binding matches
//     the shipped policy, and the VENDORED copy (policy/scriptparse-policy.json,
//     what the engine actually interprets) is byte-identical to the hub's.
//  2. Contract: the engine's policy interpreter (engine.js compilePolicy)
//     reproduces every vector this bench consumes, deep-equal: normalize,
//     cue_gate, charset, fold, part_of, parts, offers, dual, burn_in.
//     margin_rows (classify_margin_row) has no consumer on this bench (it
//     builds no scene inventory) and is reported as n/a, not mirrored.
// The manifest's own sha256 (printed raw and CR-stripped, per the
// constitution's Windows note) is the ack number.
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
const hubPolicyFile = path.resolve(opt('--policy', path.join(hub, 'scriptparse', 'policy.json')));
const vendoredPolicyFile = path.join(root, 'policy', 'scriptparse-policy.json');
const verbose = args.includes('--verbose') || args.includes('-v');

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const shaCR = buf => sha(Buffer.from(buf.toString('utf8').replace(/\r/g, ''), 'utf8'));
const short = h => h.slice(0, 12) + '…';
// deep equality, key-order-insensitive (the corpus is emitted with sorted keys)
const deepEq = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return deepEq(ka, kb) && ka.every(k => deepEq(a[k], b[k]));
  }
  return false;
};

const manifestPath = path.join(corpusDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.log(`CONFORMANCE: SKIP (no corpus at ${corpusDir}; pass --hub, --corpus, or set SCRIPTPARSE_HUB)`);
  process.exit(0);
}

let red = 0;
const fail = msg => { red++; console.log('  RED  ' + msg); };

// ---- the engine, on the vendored policy (what ships in index.html) ----
const vendoredBuf = fs.readFileSync(vendoredPolicyFile);
const vendored = JSON.parse(vendoredBuf.toString('utf8'));
const engine = require(path.join(root, 'engine.js'))({ pdfjsLib: {}, PDFLib: {}, policy: vendored });
const pol = engine.policy;

// ---- 1. consumability ----
const manifestBuf = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBuf.toString('utf8'));
console.log(`corpus_version ${manifest.corpus_version}  policy_version(bound) ${manifest.policy_version}`);
console.log(`manifest sha256 (raw)         ${sha(manifestBuf)}`);
console.log(`manifest sha256 (CR-stripped) ${shaCR(manifestBuf)}`);
console.log(`vendored policy sha256 (raw)  ${sha(vendoredBuf)}  policy_version ${vendored.policy_version}  (policy/scriptparse-policy.json)`);
if (fs.existsSync(hubPolicyFile)) {
  const hb = fs.readFileSync(hubPolicyFile);
  const hp = JSON.parse(hb.toString('utf8'));
  console.log(`hub policy sha256 (raw)       ${sha(hb)}  policy_version ${hp.policy_version}`);
  if (sha(hb) !== sha(vendoredBuf) && shaCR(hb) !== shaCR(vendoredBuf)) fail(`vendored policy differs from the hub's (${short(sha(vendoredBuf))} vs ${short(sha(hb))}): copy scriptparse/policy.json to policy/scriptparse-policy.json`);
  if (hp.policy_version !== manifest.policy_version) fail(`hub policy_version ${hp.policy_version} != manifest binding ${manifest.policy_version}`);
} else console.log(`hub policy.json not found at ${hubPolicyFile} (byte-identity check skipped)`);
if (vendored.policy_version !== manifest.policy_version) fail(`vendored policy_version ${vendored.policy_version} != manifest binding ${manifest.policy_version}`);
const walk = (v, p) => {
  if (v instanceof RegExp) fail(`policy has a RegExp at ${p}`);
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`);
};
walk(vendored, 'policy');

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
const consumRed = red;
console.log(`\nJS-consumability: ${consumRed ? 'RED (' + consumRed + ' problem(s) above)' : 'GREEN'}  (${manifest.files.length} files, ${total} cases, zero deps beyond JSON.parse)`);

// ---- 2. contract: the engine's interpreter vs the vectors ----
console.log('\nContract (engine.js policy interpreter vs the hub vectors, deep-equal):');
const misses = [];
const summary = [];
const run = (file, cases, fn, label) => {
  if (!cases) { summary.push(`| \`vectors/${file}.json\` | 0 | not loaded | RED |`); red++; return; }
  let ok = 0;
  for (const c of cases) {
    let got, err = null;
    try { got = fn(c); } catch (e) { err = e; got = 'THREW ' + e.message; }
    const pass = !err && deepEq(got, c.expect);
    if (pass) ok++; else misses.push({ file, input: c.input !== undefined ? c.input : (c.cue ?? c.raw ?? c.words ?? c.names ?? c.name ?? c.pages ?? c.word), got, expect: c.expect });
  }
  const pass = ok === cases.length;
  if (!pass) red++;
  summary.push(`| \`vectors/${file}.json\` | ${ok} / ${cases.length} | ${label} | ${pass ? 'GREEN' : 'RED'} |`);
  console.log(`  ${file}.json: ${ok}/${cases.length} ${pass ? 'green' : 'RED'}`);
};
const expectOf = (c, key) => Object.assign({}, c, { expect: c[key] });
run('normalize', vectors.normalize && vectors.normalize.cases, c => pol.normCue(c.raw), 'norm_cue (seating)');
run('cue_gate', vectors.cue_gate && vectors.cue_gate.cases, c => pol.cueSemanticOk(c.cue), 'cue_semantic_ok');
run('charset', vectors.charset && vectors.charset.cases, c => pol.cueCharsetOk(c.cue), 'cue_charset_ok');
run('fold', vectors.fold && vectors.fold.cases, c => pol.fold(c.cue), 'fold {base,channel,tier,kind}');
run('part_of', vectors.part_of && vectors.part_of.cases, c => pol.partOf(c.cue, c.aliases), 'part_of (aliases win)');
run('parts', vectors.parts && vectors.parts.cases, c => pol.parts(c.parse, c.aliases), 'parts derivation');
run('offers', vectors.offers && vectors.offers.cases, c => pol.foldCandidates(c.names), 'fold_candidates');
run('dual', vectors.dual && vectors.dual.cases, c => pol.splitDualHeader(c.words), 'split_dual_header');
if (vectors.burn_in) {
  const b = vectors.burn_in;
  const cases = [
    ...b.quantizer.map(c => Object.assign({ kind: 'quantizer', input: c.word }, c, { expect: c.expect_cell })),
    ...b.thresholds.map(c => Object.assign({ kind: 'threshold', input: c.pages }, c, { expect: c.expect_threshold })),
    ...b.detect.map(c => Object.assign({ kind: 'detect', input: c.name }, c, { expect: c.expect_strip_indices })),
  ];
  run('burn_in', cases, c => c.kind === 'quantizer' ? pol.wordCell(c.word, c.page_height, c.grid)
    : c.kind === 'threshold' ? pol.repeatThreshold(c.pages)
    : pol.detectRepeatedBurnin(c.pages, c.page_heights), 'signal-2 cells / thresholds / strip decisions');
} else run('burn_in', null);
if (vectors.margin_rows) {
  summary.push(`| \`vectors/margin_rows.json\` | n/a (${countCases(vectors.margin_rows)}) | classify_margin_row: no consumer on this bench (no scene inventory); consumable, not mirrored | n/a |`);
  console.log(`  margin_rows.json: n/a (${countCases(vectors.margin_rows)} cases; no consumer on this bench, not mirrored)`);
}
console.log('\n| vector file | green / cases | contract | verdict |');
console.log('|---|---|---|---|');
for (const s of summary) console.log(s);
if (verbose && misses.length) {
  console.log('\nMisses (input -> got | expect):');
  for (const m of misses) console.log(`  [${m.file}] ${JSON.stringify(m.input)} -> ${JSON.stringify(m.got)} | ${JSON.stringify(m.expect)}`);
}
console.log(`\nCONFORMANCE: ${red ? 'RED' : 'GREEN'} (consumability ${consumRed ? 'RED' : 'GREEN'}, contract ${red - consumRed ? 'RED' : 'GREEN'}) manifest ${sha(manifestBuf)} policy ${vendored.policy_version}`);
process.exit(red ? 1 : 0);
