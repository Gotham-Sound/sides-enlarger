// The outcue tokenizer: which words of each speech get the Reader-mode
// underline. This must agree word for word with Sides Helper's CueSheet, so
// the app's screen and the engine's PDF underline the same five words.
//
// Usage: node tools/test_outcue.mjs      (no files needed; the cases are inline)
// Prints one PASS/FAIL line per case and "OUTCUE: all N passed" at the end;
// exit code 1 means a case failed.
//
// The rule under test (Peter's rulings, 2026-10-04): a speech is everything
// one character says before another character speaks; dialogue by the same
// speaker with no other speaker's cue or dialogue in between is one speech,
// across parentheticals, page breaks, action lines and a (CONT'D) cue; a new
// scene heading ends it. Words are whitespace-separated tokens of the
// speech's dialogue elements joined with a space (so "--" and "..." count);
// parentheticals never count; a speech of five words or fewer is marked whole.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// the tokenizer is pure: no PDF libraries are needed, so stubs stand in for them
const policy = JSON.parse(fs.readFileSync(path.join(root, 'policy/scriptparse-policy.json'), 'utf8'));
const engine = require(path.join(root, 'engine.js'))({ pdfjsLib: {}, PDFLib: {}, policy });

const el = (t, text, name) => ({ t, text, name });
const cases = [];
const add = (label, elements, expectOutcues, expectTrailing, n) => cases.push({ label, elements, expectOutcues, expectTrailing, n });

// 1. a short speech is marked whole
add('short speech marked whole',
  [el('cue', 'LAURA', 'LAURA'), el('dialogue', 'Close the door.', 'LAURA')],
  [['Close', 'the', 'door.']], { 1: 3 });
// 2. the last five words span two dialogue elements; the parenthetical between them never counts
add('five words across a parenthetical',
  [el('cue', 'MORROW', 'MORROW'), el('dialogue', 'Eight years I have known you.', 'MORROW'),
   el('paren', '(not looking up)', 'MORROW'), el('dialogue', 'You only say clerical when lying.', 'MORROW')],
  [['only', 'say', 'clerical', 'when', 'lying.']], { 3: 5 });
add('outcue reaches back into the earlier element',
  [el('cue', 'LAURA', 'LAURA'), el('dialogue', 'one two three four', 'LAURA'),
   el('paren', '(beat)', 'LAURA'), el('dialogue', 'five six seven', 'LAURA')],
  [['three', 'four', 'five', 'six', 'seven']], { 1: 2, 3: 3 });
// 3. a (CONT'D) cue after a page break continues the same speech
add("a CONT'D cue continues the speech",
  [el('cue', 'LAURA', 'LAURA'), el('dialogue', 'one two three four', 'LAURA'),
   el('break', 'SCRIPT PAGE 35'), el('cue', "LAURA (CONT'D)", 'LAURA'), el('dialogue', 'five six seven', 'LAURA')],
  [['three', 'four', 'five', 'six', 'seven']], { 1: 2, 4: 3 });
// 4. an action line in the middle does not end the speech either
add('an action line does not end the speech',
  [el('cue', 'SAM', 'SAM'), el('dialogue', 'one two three four', 'SAM'),
   el('action', 'He looks away.'), el('dialogue', 'five six seven', 'SAM')],
  [['three', 'four', 'five', 'six', 'seven']], { 1: 2, 3: 3 });
// 5. another speaker ends it; so does a new scene heading
add("another speaker's cue ends the speech",
  [el('cue', 'LAURA', 'LAURA'), el('dialogue', 'alpha beta gamma delta epsilon zeta', 'LAURA'),
   el('cue', 'MORROW', 'MORROW'), el('dialogue', 'Clerical error.', 'MORROW'),
   el('cue', 'LAURA', 'LAURA'), el('dialogue', 'eta theta', 'LAURA')],
  [['beta', 'gamma', 'delta', 'epsilon', 'zeta'], ['Clerical', 'error.'], ['eta', 'theta']], { 1: 5, 3: 2, 5: 2 });
add('a scene heading ends the speech',
  [el('cue', 'LAURA', 'LAURA'), el('dialogue', 'one two', 'LAURA'),
   el('slug', 'INT. HALL - DAY'), el('cue', 'LAURA', 'LAURA'), el('dialogue', 'three four', 'LAURA')],
  [['one', 'two'], ['three', 'four']], { 1: 2, 4: 2 });
// 6. dashes and ellipses are words; extra spaces are not
add('dashes and ellipses count as words',
  [el('cue', 'DIAZ', 'DIAZ'), el('dialogue', 'Well -- I mean ... maybe  not', 'DIAZ')],
  [['I', 'mean', '...', 'maybe', 'not']], { 1: 5 });
// 7. n <= 0 means no marks at all
add('zero words means no marks',
  [el('cue', 'DIAZ', 'DIAZ'), el('dialogue', 'Well -- I mean', 'DIAZ')], [], {}, 0);

let passed = 0;
for (const c of cases) {
  const n = c.n === undefined ? 5 : c.n;
  const got = engine.outcueMarks(c.elements, n);
  const outcues = got.speeches.map(s => s.outcue);
  const trailing = {}; for (const [k, v] of got.trailing) trailing[k] = v;
  const ok = JSON.stringify(outcues) === JSON.stringify(c.expectOutcues) && JSON.stringify(trailing) === JSON.stringify(c.expectTrailing);
  console.log(`    [${ok ? 'PASS' : 'FAIL'}] ${c.label}` + (ok ? '' : `  got ${JSON.stringify(outcues)} / ${JSON.stringify(trailing)}`));
  if (ok) passed++;
}
if (passed === cases.length) console.log(`OUTCUE: all ${passed} passed`);
else { console.log(`OUTCUE: ${cases.length - passed} of ${cases.length} FAILED`); process.exit(1); }
