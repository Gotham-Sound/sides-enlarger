// Unit test for engine.rewriteSidesLink (the Netflix sides-link rewrite).
// No real token anywhere: the shapes below are made up.
//   node tools/test_links.mjs
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'policy/scriptparse-policy.json'), 'utf8'));
const engine = require(path.join(root, 'engine.js'))({ pdfjsLib: {}, PDFLib: {}, policy });
const rw = engine.rewriteSidesLink;
const T = 'AbC123-xyz_789';
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
