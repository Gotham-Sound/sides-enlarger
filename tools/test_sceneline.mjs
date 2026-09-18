// Headless acceptance tests for the .sceneline interchange feature (Brief A).
// Browser-free: exercises the engine's pure parse/union/reconcile/export data
// layer against the synthetic fixtures. Fixtures are GENERATED here (spec §7:
// never store a .sceneline; the PDFs come from make_fixture.py), so this runs
// standalone or from tools/test.sh.
//
//   node tools/test_sceneline.mjs
import { createRequire } from 'module';
import { deepStrictEqual } from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDFLib = require(path.join(root, 'node_modules/pdf-lib/dist/pdf-lib.js'));
// pdfjs-dist 3.x ships a CJS legacy build (pdf.js); 4+/5.x is ESM-only
// (pdf.mjs, needs a DOMMatrix stand-in at import time). Support both so this
// test runs on either pin.
const pdfCjs = path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.js');
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class { constructor(){ this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0; } };
}
const pdfjsLib = fs.existsSync(pdfCjs)
  ? require(pdfCjs)
  : await import(pathToFileURL(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const createSidesEngine = require(path.join(root, 'engine.js'));
const policy = JSON.parse(fs.readFileSync(path.join(root, 'policy/scriptparse-policy.json'), 'utf8'));
const engine = createSidesEngine({ pdfjsLib, PDFLib, policy });

const fixture = path.join(root, 'out', 'fixture.pdf');
const fixtureMulti = path.join(root, 'out', 'fixture_multi.pdf');
if (!fs.existsSync(fixture) || !fs.existsSync(fixtureMulti)) {
  execFileSync('python3', [path.join(root, 'tools', 'make_fixture.py')], { stdio: 'ignore' });
}

let failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e && e.message)]); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const run = async pdf => (await engine.process(new Uint8Array(fs.readFileSync(pdf)), { scale: 1.25 })).report;
const pdfFacts = r => ({ characters: r.characters, sluglines: r.sluglines });

// ---- (e) v1 files (no interchange / no extensions) import cleanly ----
await test('(e) v1 file imports cleanly', async () => {
  const v1 = {
    format: 'sceneline',
    source: { title: 'OLD 101' },
    show: {
      characters: ['LAURA', 'MORROW'],
      scenes: [{ scene: '1', scene_heading: 'INT. PRECINCT BULLPEN - NIGHT', speakers: ['LAURA'] }],
    },
  };
  const p = engine.parseSceneline(JSON.stringify(v1));
  assert(p.version === 1, 'v1 detected as version ' + p.version);
  assert(p.profile === 'lean', 'v1 with no text should infer lean, got ' + p.profile);
  assert(p.show.characters.length === 2, 'characters lost');
  // a bare-object v1 with neither format nor interchange still parses
  const p2 = engine.parseSceneline(JSON.stringify({ show: { characters: ['X'] } }));
  assert(p2.version === 1 && p2.show.characters[0] === 'X', 'minimal v1 rejected');
  // interchange > 2 is refused LOUDLY (spec §6)
  let threw = null;
  try { engine.parseSceneline(JSON.stringify({ format: 'sceneline', interchange: 3, show: {} })); }
  catch (e) { threw = e; }
  assert(threw && threw.code === 'SCENELINE_VERSION', 'newer interchange not refused');
});

// ---- (b) authoritative identity + reconcile against PDF geometry ----
await test('(b) file identity is authoritative; geometry gives pages; unmatched -> chip', async () => {
  const report = await run(fixture);
  const pdfNames = new Set(report.characters.map(c => c.name));
  assert(pdfNames.has('LAURA') && pdfNames.has('WITNESS'), 'fixture PDF names missing: ' + [...pdfNames]);

  // A show file that: keeps most PDF names, adds an operator-only name no
  // parser would find (MERC #2), tests parenthetical normalization
  // (LAURA (V.O.) -> LAURA) and the shared trailing-punctuation strip
  // (SALLY, JR. -> SALLY, JR, scriptparse #63/#79), and OMITS WITNESS (a
  // real PDF cue). Names the shared gate rails (ELEANOR FROM HR) never
  // appear in a hub-written file, so none is listed here.
  const file = {
    format: 'sceneline', interchange: 2, source: { title: 'EP 407', profile: 'lean' },
    show: {
      characters: ['LAURA (V.O.)', 'MORROW', 'DIAZ', 'SAM', 'SALLY, JR.', 'MERC #1', 'MERC #2'],
      scenes: [{ scene: '1', scene_heading: 'INT. PRECINCT BULLPEN - NIGHT', speakers: ['LAURA'] }],
    },
    extensions: {},
  };
  const parsed = engine.parseSceneline(JSON.stringify(file));
  const unioned = engine.unionShows([parsed]);
  const rec = engine.reconcile(unioned, pdfFacts(report));

  const byName = Object.fromEntries(rec.roster.map(r => [r.name, r]));
  // parenthetical normalized to LAURA and matched to geometry with pages
  assert(byName['LAURA'] && byName['LAURA'].source === 'file', 'LAURA (V.O.) did not normalize to file LAURA');
  assert(byName['LAURA'].matched && byName['LAURA'].pages.length > 0, 'LAURA not matched to geometry pages');
  // MERC #1 (operator-style name) matches the PDF cue exactly
  assert(byName['MERC #1'] && byName['MERC #1'].matched, 'MERC #1 not matched');
  // MERC #2 is authoritative identity with NO geometry -> reconcile chip, not error
  assert(byName['MERC #2'] && !byName['MERC #2'].matched && byName['MERC #2'].pages.length === 0, 'MERC #2 should be unmatched with no pages');
  assert(rec.unmatchedFileNames.length === 1 && rec.unmatchedFileNames[0] === 'MERC #2',
    'unmatchedFileNames should be exactly [MERC #2], got ' + JSON.stringify(rec.unmatchedFileNames));
  // WITNESS present in PDF but omitted from the file -> secondary group
  assert(byName['WITNESS'] && byName['WITNESS'].source === 'pdf', 'geometric-only WITNESS not surfaced as secondary');
  // every file name appears as a source:'file' roster entry (identity from file)
  for (const n of ['LAURA', 'MORROW', 'DIAZ', 'SAM', 'SALLY, JR', 'MERC #1', 'MERC #2'])
    assert(byName[n] && byName[n].source === 'file', 'file identity missing ' + n);
});

// ---- (c) multi-episode packet: subset check, no false alarms ----
await test('(c) stitched packet vs multiple shows raises no false alarms; a foreign slug does', async () => {
  const report = await run(fixtureMulti);
  const heads = report.sluglines.map(s => s.text);
  assert(heads.length >= 6, 'expected the multi fixture sluglines, got ' + JSON.stringify(heads));

  const show = (title, headings) => ({
    format: 'sceneline', interchange: 2, source: { title },
    show: { characters: [], scenes: headings.map((h, i) => ({ scene: String(i + 1), scene_heading: h, speakers: [] })) },
  });
  // three separate episode files that together cover every printed heading
  const shows = [
    show('EP A', ['INT. SQUAD ROOM - DAY', 'INT. SQUAD ROOM - LATER']),
    show('EP B', ['EXT. RIVER WALK - NIGHT', 'INT. INTERVIEW ROOM - CONTINUOUS']),
    show('EP C', ['INT. MORGUE - DAY', 'EXT. LOADING DOCK - DAWN']),
  ].map(s => engine.parseSceneline(JSON.stringify(s)));

  const unioned = engine.unionShows(shows);
  const rec = engine.reconcile(unioned, pdfFacts(report));
  assert(rec.foreignSluglines.length === 0,
    'false draft alarm: ' + JSON.stringify(rec.foreignSluglines.map(s => s.raw)));

  // Drop EP C's coverage -> exactly the two MORGUE/DOCK headings go foreign.
  const unioned2 = engine.unionShows(shows.slice(0, 2));
  const rec2 = engine.reconcile(unioned2, pdfFacts(report));
  const foreign = rec2.foreignSluglines.map(s => s.text).sort();
  deepStrictEqual(foreign, ['EXT. LOADING DOCK - DAWN', 'INT. MORGUE - DAY'],
    'expected exactly the uncovered headings to be flagged, got ' + JSON.stringify(foreign));
});

// ---- (d) round-trip law: foreign blocks survive deep-equal ----
await test('(d) round-trip preserves foreign blocks deep-equal; sides reflects edits', async () => {
  const base = {
    format: 'sceneline', interchange: 2,
    source: { title: 'MB 102', file: 'CombinedPrintable-102.pdf', profile: 'lean' },
    show: {
      characters: ['MYRON', 'WIN'],
      scenes: [{ scene: '14', scene_heading: 'INT. LAB - NIGHT', page_start: 12, speakers: ['MYRON', 'WIN'] }],
      review_dismissed: [],
    },
    extensions: {
      sound: { moments: [{ scene: '14', category: 'playback', snippet: 'a song plays under', page: 12, characters: ['MYRON'], dismissed: false }] },
      video: { moments: [] },
      'x-myidea': { nested: { deep: [1, 2, 3], flag: true }, note: 'unregistered experiment' },
    },
    'x-unknown-top': { keep: 'me too' },
  };
  const parsed = engine.parseSceneline(JSON.stringify(base));
  const sides = engine.buildSidesBlock({
    scale: 1.25, mode: 'selected',
    characters: [
      { name: 'MYRON', pages: [1, 2], paletteIndex: 0, enlarge: true },
      { name: 'WIN', pages: [], paletteIndex: 2, enlarge: false, added: true },
    ],
  });
  const out = engine.buildScenelineExport(parsed.envelope, sides, { profile: 'lean', appVersion: '1.7.6' });

  // simulate export -> file -> re-import
  const reimported = engine.parseSceneline(JSON.stringify(out)).envelope;
  deepStrictEqual(reimported.extensions.sound, base.extensions.sound, 'foreign sound block was altered');
  deepStrictEqual(reimported.extensions.video, base.extensions.video, 'foreign video block was altered');
  deepStrictEqual(reimported.extensions['x-myidea'], base.extensions['x-myidea'], 'x- experiment block was altered');
  deepStrictEqual(reimported['x-unknown-top'], base['x-unknown-top'], 'unknown top-level field was dropped');
  deepStrictEqual(reimported.show, base.show, 'show was not preserved verbatim (base had no text)');
  // our block reflects the edits
  assert(reimported.extensions.sides.settings.mode === 'selected', 'sides settings not written');
  assert(reimported.extensions.sides.characters.MYRON.highlight.key === 'yellow', 'MYRON highlight key wrong');
  assert(/^#/.test(reimported.extensions.sides.characters.MYRON.highlight.rgb), 'highlight rgb should be a hex string');
  assert(reimported.extensions.sides.characters.WIN.added === true, 'added:true not marked');
  assert(reimported.source.generator === 'sides-enlarger/1.7.6', 'generator not stamped');
  assert(reimported.source.title === 'MB 102', 'source.title not preserved');
});

// ---- profiles: lean drops screenplay text; full keeps it; foreign untouched ----
await test('(profiles) lean strips show text, full keeps it, foreign block still deep-equal', async () => {
  const full = {
    format: 'sceneline', interchange: 2, source: { title: 'X', profile: 'full' },
    show: { characters: ['MYRON'], scenes: [{ scene: '14', scene_heading: 'INT. LAB - NIGHT', speakers: ['MYRON'], dialogue_text: 'MYRON: Hello.', action_text: 'He enters.' }] },
    extensions: { sound: { moments: [{ scene: '14', snippet: 'x', dismissed: false }] } },
  };
  const p = engine.parseSceneline(JSON.stringify(full));
  assert(p.profile === 'full', 'file with dialogue_text should be full');
  const sides = engine.buildSidesBlock({ scale: 1.25, mode: 'all', characters: [] });

  const lean = engine.buildScenelineExport(full, sides, { profile: 'lean' });
  assert(lean.source.profile === 'lean', 'lean profile not declared');
  assert(lean.show.scenes[0].dialogue_text === undefined && lean.show.scenes[0].action_text === undefined, 'lean did not strip screenplay text');
  assert(lean.show.scenes[0].scene === '14' && lean.show.scenes[0].scene_heading === 'INT. LAB - NIGHT', 'lean dropped non-text scene fields');
  deepStrictEqual(lean.extensions.sound, full.extensions.sound, 'foreign block altered by lean export');

  const kept = engine.buildScenelineExport(full, sides, { profile: 'full' });
  assert(kept.show.scenes[0].dialogue_text === 'MYRON: Hello.', 'full export lost dialogue_text');
});

for (const [status, name] of results) console.log('    [' + status + '] ' + name);
if (failed) { console.log('\nSCENELINE: ' + failed + ' FAILED'); process.exit(1); }
console.log('\nSCENELINE: all ' + results.length + ' passed');
