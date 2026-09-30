// Unit test for engine.rewriteSidesLink (the Netflix sides-link rewrite).
// No real token anywhere: the shapes below are made up.
//   node tools/test_links.mjs
//
// What it checks: the page can turn a Netflix "pdfView" sides link into the
// direct file link, and it must leave every other kind of input alone
// (other hosts, other paths, a missing or unsafe token). It is a pure string
// rewrite: the page never fetches anything (see the CSP note in CLAUDE.md).
// Exit code 1 means at least one case failed.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'policy/scriptparse-policy.json'), 'utf8'));
// The rewrite needs no PDF libraries, so empty stand-ins are enough to build
// the engine here.
const engine = require(path.join(root, 'engine.js'))({ pdfjsLib: {}, PDFLib: {}, policy });
const rw = engine.rewriteSidesLink;
// A made-up token in the shape a real one has. Never put a real token here.
const T = 'AbC123-xyz_789';
// Each case: a label, the input, and the expected output. null means "leave
// it untouched" (the page then shows no link).
const cases = [
  ['pdfView link rewrites to the file link', 'https://linkshare.netflixstudios.com/pdfView?file=' + T, 'https://linkshare.netflixstudios.com/file?fileId=' + T],
  ['already a file link stays a file link', 'https://linkshare.netflixstudios.com/file?fileId=' + T, 'https://linkshare.netflixstudios.com/file?fileId=' + T],
  ['other host untouched', 'https://example.com/pdfView?file=' + T, null],
  ['missing token untouched', 'https://linkshare.netflixstudios.com/pdfView', null],
  ['empty token untouched', 'https://linkshare.netflixstudios.com/pdfView?file=', null],
  ['other path on the host untouched', 'https://linkshare.netflixstudios.com/share?file=' + T, null],
  ['surrounding whitespace tolerated, http upgraded', '  http://linkshare.netflixstudios.com/pdfView?file=' + T + '  ', 'https://linkshare.netflixstudios.com/file?fileId=' + T],
  ['not a URL', 'pdfView?file=' + T, null],
  ['token with unsafe characters untouched', 'https://linkshare.netflixstudios.com/pdfView?file=<script>', null],
];
let failed = 0;
for (const [name, input, expect] of cases) {
  const got = rw(input);
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`    [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' (got ' + JSON.stringify(got) + ')'}`);
}
console.log(failed ? `LINKS: ${failed} failed` : 'LINKS: all ' + cases.length + ' passed');
process.exit(failed ? 1 : 0);
