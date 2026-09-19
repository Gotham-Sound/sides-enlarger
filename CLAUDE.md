# CLAUDE.md — Sides Enlarger

Guidance for Claude Code working in this repo. Read this before changing anything.

## What this is
A single-file web tool that ingests a screenplay "sides" PDF and outputs a
**page-for-page identical** PDF with only the **dialogue** enlarged (~25%). It's
for a TV actor reading sides on set. It also extracts the character names
geometrically and lets the user assign each a translucent highlight color that
is painted behind that character's blocks (composing with the enlargement).
Enlargement has three modes: all dialogue (default), only selected characters'
dialogue (`opts.enlargeOnly`), or the whole page zoomed uniformly toward the
margins (`opts.mode: 'page'`). All PDF processing happens **in the browser**;
there is no backend.

## Non-negotiable constraints (do not regress these)
1. **Page-for-page parity.** Content must never reflow across pages. On set,
   "page 34" must stay page 34. All enlargement modes rescale text runs in
   place around each line's own baseline — nothing ever moves vertically, so
   nothing can reflow. If enlargement wouldn't fit a page, **back off the
   scale for that page and report it**; never push content onto another page.
   The ONE sanctioned exception is Reader mode (`opts.mode: 'reader'`), which
   reflows by design: it must mark where each original page begins (gray
   "SCRIPT PAGE N" rules from the printed header page numbers) and stamp
   every page with a footer saying the numbering doesn't match.
2. **Confidentiality / offline.** Scripts must never leave the device. No network
   calls, no CDNs, no telemetry, no cloud. Everything (pdf.js, its worker, pdf-lib,
   the engine) is inlined into `index.html`. Keep it that way.
3. **Only dialogue blocks change.** A block = the character cue plus its
   parentheticals and dialogue; the cue scales with its block. Sluglines,
   action, page headers, page/scene numbers, revision `*` marks, watermarks —
   all stay byte-for-byte in place (in Everything mode, body text scales but
   margin marks and repeated header/footer furniture still never move).
   Dialogue is detected **geometrically** (indented column + follows a
   character cue, calibrated per document), never by reading the words.
4. **Output is a normal printable PDF** at the original page size.

## Repo layout
```
index.html              BUILD OUTPUT — do not hand-edit. Regenerate with `npm run build`.
ui_template.html        The page markup + app glue (edit this, then rebuild).
engine.js               Core logic. Runs UNCHANGED in both browser and Node.
policy/scriptparse-policy.json  The hub's identity policy data, vendored BYTE-IDENTICAL (injected into the engine).
build.mjs               Inlines pdf.js + worker (base64) + pdf-lib + engine.js -> index.html
tools/make_fixture.py   Generates a synthetic screenplay PDF (reportlab) for tests.
tools/run_engine_node.mjs  Runs engine.js headless on a PDF (uses node_modules build).
tools/check.py          Independent verifier (pymupdf) + side-by-side page renders.
tools/test_sceneline.mjs  Headless acceptance tests for the .sceneline interchange.
tools/test_links.mjs    Unit test for the studio sides-link rewrite (made-up tokens only).
tools/conformance_check.mjs  Inverted-verification runner for the hub's conformance corpus (scriptparse #40).
tools/test.sh           One-shot: fixture (and optional real PDFs) at 1.0/1.25/1.5.
docs/sceneline-interchange-v2.md  The .sceneline interchange spec (committed, no script text).
.nojekyll               So GitHub Pages serves index.html as-is.
```

## Build & test
```bash
npm install            # dev-only deps (pdf-lib, pdfjs-dist); both get inlined
npm run build          # ui_template.html + engine.js + libs -> index.html
npm test               # bash tools/test.sh  (fixture only; always safe to commit)

# test against REAL sides you have locally (never commit them):
bash tools/test.sh /path/to/real_sides.pdf
```

**Loop-test rule:** on the dev box, real production sides live in `samplesides/`
(gitignored, CONFIDENTIAL). After any change to `engine.js`, `check.py` or the
fixture, run `bash tools/test.sh samplesides/*.pdf`, not just the fixture, and
eyeball the renders. The fixture cannot reproduce every real layout (form
XObjects, permission locks, glyph-per-op text, drift).
Requires: Node 18+, Python 3 with `reportlab` and `pymupdf`
(`pip install reportlab pymupdf --break-system-packages`).

**After ANY change to `engine.js` or `ui_template.html`, run `npm run build`** or
`index.html` will be stale. Then run `npm test`.

## The verifier is the source of truth
`tools/check.py` re-implements the geometric classifier independently and asserts:
equal page counts; every non-dialogue span unchanged in position (≤0.7pt) and size;
dialogue baselines unmoved and enlarged to the page's applied scale; word gaps
inside dialogue scaled uniformly (the kerning regression lock); when highlights
were requested, each assigned character's blocks covered by exactly one rect of
their color with every word inside it and no foreign text under any rect; no text
off the page; and no text lost (page-level word-multiset preserved, robust to the
renderer re-segmenting enlarged lines). It also writes
`out/renders/**/compare_pNN.png` — **look at these**, don't just trust the PASS.

## How the engine works (engine.js)
- **Extract + calibrate** (pdf.js): per-document x-bands for cue / dialogue /
  parenthetical, from the page geometry (median cue x, etc.). Sides are
  photocopies — margins drift, so never hardcode absolute x positions. Use
  **medians**, never modes: per-page drift clusters samples per page, and a mode
  locks onto one page's drift instead of the document center.
- **Type-size gate (v1.11.1):** calibration also learns the script's type size
  (`cal.cueSize`, the median size of the cue lines), and a cue or dialogue
  candidate more than a quarter off it is never script. Call sheets, coverage
  grids and revision tables are small type (4-7pt against 12pt body) and their
  rows can land exactly on the cue x with a note beneath at the dialogue x; by
  position alone that is a cue block, so without the gate the sheet gains two
  "dialogue" lines, two 1-line "characters", and reader mode reflows the whole
  sheet (real packet, 2026-09-18). Relative to the document, never an absolute
  size: photocopied sides get re-scaled. Mirrored in check.py.
- **Classify** each visual line: cue / dialogue / parenthetical / dual / other.
  Classification also collects cue-led **blocks** (cue + parentheticals +
  dialogue) used for character extraction and highlighting.
- **Rewrite content streams** (pdf-lib): for dialogue text-show ops only, inject
  a scaled text matrix anchored on the line's own baseline, with every run on a
  page mapped by the SAME horizontal affine: `x' = C + s*(x - C)` where
  `C = dialX + colW/2`. This uniform anchor is what keeps kerning correct:
  real sides are often drawn word-per-op or **glyph-per-op**, and scaling each
  op around its own origin grows glyphs while leaving their origins on the old
  pitch (letters crowd, word gaps shrink). Emits everything else byte-identical.
- **Character extraction**: a cue is a geometric fact (all-caps, in the cue
  band, dialogue-band text under it); the dialogue-follow test is the noise
  filter, do not weaken it to catch more names. **Identity is NOT local** (federation
  Phase 1, scriptparse #83, since v1.10.0): `compilePolicy` in engine.js is a JS
  mirror of the hub's reference interpreter, driven only by the injected
  `policy.json`, and pinned by the hub's conformance corpus
  (`tools/conformance_check.mjs`, all consumed vector files must stay green).
  `normalizeCueName` = the local revision-`*` strip, then the hub's `norm_cue`
  (parentheticals/brackets stripped, trailing `[.:]` stripped, adjacent duplicate
  words collapsed, uppercase). `cueGateOk` = the hub's semantic gate (stop words
  AND/OR/BUT/NOR/FROM in 2+ word names, numbered furniture, transitions, trailing
  `-`, 1..4 words, 2..30 chars) + charset gate (`[A-Z0-9 .'-]` after the two
  admitted trailing shapes: `#N` numbered parts and `, JR/SR/II/III/IV` suffixes).
  So `MERC #1` and `SALLY, JR` seat; `ELEANOR FROM HR`, `GIRLS/CASSIDY` and
  `MYRON & WANDA` are railed. **Railed is never silent:** a cue-led block with
  dialogue whose name fails the gate lands on `report.rejectedCues` with the reason
  and a warning (it still enlarges in All-dialogue mode; the user can add the name
  by hand). Never re-add a local name rule; a wrong ruling is a federation motion.
- **Dual dialogue**: an all-caps body row with 2+ segments is a dual header only
  if the hub's `splitDualHeader` says so (exactly one gap > `min_gap_pt`, both
  halves pass the full gate; colon-terminated halves are list labels). Names
  surface flagged `dual`, rows beneath are attributed by the column boundary for
  the line count; dual blocks are still never enlarged or highlighted.
- **Burn-in (two signals, both before line-building; scriptparse #16/#37):**
  signal 1 drops rotated items in `extract()`; signal 2 (`stripRepeatedBurnIn`,
  policy `burn_in`) drops text that repeats at the same 24pt-quantized
  bottom-left cell on >= max(4, ceil(pages/2)) pages when the row group has a
  lowercase letter (running headers ending in a page token are exempt). Strips
  affect classification, the character list and reader mode ONLY; the rewriter
  still emits the stamp bytes byte-identical. `report.burnIns` + a warning say so.
- **Modes**: `opts.enlargeOnly` (array of names) gates the in-place scaling per
  cue-led block: unselected characters' dialogue must stay byte-identical, and
  the verifier checks it like non-dialogue. `opts.mode: 'page'` ("Everything")
  feeds the SAME rewriter proxy lines for every body text line, anchored at
  the page's content-center x, so all text grows on its own unmoved baseline
  and spreads toward the edges. Margin furniture (segments left of x=70 or
  right of pageW-80: scene numbers, revision stars, page numbers) never
  scales, and neither does header/footer FURNITURE (top/bottom-zone rows
  whose digit-stripped text repeats on half the pages: show-name headers,
  CONTINUED: rows, (CONTINUED) footers) — furniture would otherwise cap the
  whole page with its tight internal gaps. The horizontal map is a per-page
  affine `x' = s*x + t` (max feasible s by binary search over per-line stops,
  then t centers the body), so the widest stage-direction line spans the full
  printable width. Caps: line-spacing fit `gap / (0.16*size_above +
  0.64*size_below)` (fixed rows only consume their unscaled share) and a CLIP
  fit: a measure pass walks the content tracking rectangular clip paths
  (`re W n` — table cells, row bands) and tightens the per-line stops so no
  text grows out of its clip and gets cut off invisibly. Typically lands
  1.15-1.25x on real sides. Pages with ZERO classified dialogue (title pages,
  coverage, call sheets, revision tables) are never enlarged in any mode;
  they pass through byte-identical with a note.
- **Reader mode** (`opts.mode: 'reader'`): builds a verbatim element stream
  (slug / action / cue / paren / dialogue / transition, dual emitted
  sequentially) from body segments, dropping furniture, margin marks,
  (MORE)/(CONTINUED) and rotated watermark items (`item.rot`), and skipping
  no-dialogue pages; then renders a fresh Times PDF at `12 * scale` pt with
  pdf-lib (wrapping re-done at reader width). Each source page starts with a
  gray rule labeled with the printed page number AND the page's full header
  name (`SCRIPT PAGE 17 · NCIS: NY Ep. 101 ...`, word-trimmed to fit); each
  new scene gets a thick rule above its slug. Highlights paint as pastel
  strips UNDER the text (we own the background). The verifier's contract for
  reader mode is different: no body word lost, nothing invented beyond the
  reported `readerBreaks` markers and footers, stars dropped, size correct.
  **The recipient's stamp rides the footer (v1.13.0):** the text of rotated
  runs (signal 1, reconstructed per rotated baseline by `rotatedStampTexts` in
  `extract()`) and of signal-2 groups is listed in `report.readerStamps`,
  announced in a warning, and drawn in every reader page's footer (`drawStamp`
  in `renderReader`; the elements API takes it as a 4th argument). The verifier
  requires each stamp in every reader page's footer zone and never in the
  reading text. Footer, not a diagonal re-draw, by Peter's call: it respects
  reader mode's clean page, and the diagonal is the escalation if a studio
  asks for more; it would replace that one helper.
- **Highlighting**: one rounded rect per block of an assigned character,
  painted as a Multiply-blend fill in a content stream APPENDED after the page
  content (so white background fills inside forms can't hide it; glyphs stay
  crisp/selectable). Rect geometry uses the same uniform-anchor map at the
  page's applied scale. Palette is 8 fixed pastels (luminance >= ~0.87 so
  grayscale printing keeps contrast); no free color picker. Dual-dialogue
  blocks are never painted.
- **Recurses through form XObjects.** Real production sides put the page text inside
  `/Form` XObjects invoked via `Do`; the rewriter descends into them (accumulating
  CTM) and mutates the form stream. A form invoked more than once (shared across
  pages, or placed twice) can only be mutated once, and mutating it would bake one
  placement's geometry into every other placement. A pre-pass counts every form
  invocation across all pages (`formUse`) and flags which carry text; any page whose
  text lives in a multi-use form is left **entirely unscaled** with a note. Do not
  "optimize" this back to a per-traversal visited-set — that silently corrupts the
  other placements.
- **Decrypts in-engine.** Production PDFs are usually permission-locked (RC4-128 or
  AES-128, empty user password). `decryptInPlace` handles Standard security handler
  R2–R4 and drops `/Encrypt`; output is unlocked. AES needs `crypto.subtle` (https
  or file://), RC4 is pure JS. R5+/AES-256 is refused with a clear message.
  **V4 crypt filters:** streams (`StmF`) and strings (`StrF`) can use *different*
  methods, one of which may be `/Identity` (not encrypted). A per-stream `/Crypt`
  filter (e.g. unencrypted XMP `/Metadata`) overrides the document default and is
  then stripped from the stream's `/Filter`. Applying one method to everything
  corrupts mixed documents, so the method is resolved per object.

## The `.sceneline` interchange (import/export)
Gotham's scene-breakdown tools share one JSON file (spec: `docs/sceneline-interchange-v2.md`).
sides-enlarger reads it as authoritative for **identity and speaker facts** and
writes its own `sides` block back; **geometry always comes from the PDF**, so
import is RECONCILIATION, not skipped extraction.
- **Engine (pure, in the outer factory scope, exported on the return literal):**
  `parseSceneline` (accepts v1 + v2; refuses `interchange > 2` loudly),
  `unionShows` (multi-file packets union, since sides pull pages from several
  episodes), `reconcile` (maps each PDF cue name to a file name with the SAME
  `normalizeCueName`; emits `roster`, `unmatchedFileNames`, `foreignSluglines`),
  `buildSidesBlock`, `buildScenelineExport`. `collectSluglines` (uses `SLUG_SEG`,
  which tolerates a scene number FUSED into the heading segment, and
  `normalizeHeading`, which strips leading scene numbers + trailing
  stars/day-codes/right scene numbers) feeds `report.sluglines`; `collectCharacters`
  now also carries per-character `pages[]`.
- **Round-trip law (spec §3):** preserve every foreign extension block and
  unknown top-level field **value-identically** (keep the parsed object, re-emit
  by reference); rewrite only `extensions.sides`; `show` is preserved verbatim
  (v1 never edits the matrix). Tests assert **deep-equal**, never byte-equal.
- **Draft-mismatch is SUBSET, never count:** a side packet is a small pull from a
  whole-episode file, so scene-count comparison is meaningless. The PDF's detected
  sluglines must be a subset of the loaded shows' scenes; a heading in no loaded
  show raises a per-scene chip. No-dialogue pages (call sheets) contribute no
  sluglines. Getting fewer headings only weakens detection (no false alarms).
- **UI (`ui_template.html`):** the drop zone accepts `.sceneline` too (multi-file);
  with a file loaded the rail shows file identity first (unmatched names get an
  "in show file" chip), geometric-only names in a secondary group; a banner offers
  a source picker when foreign sluglines appear; "Export .sceneline" is round-trip
  only (needs a loaded base) and defaults to lean.
- **UI, Selected-characters mode (v1.11.0, 2026-09-18):** the READING tick per
  name is what the engine gets as `enlargeOnly`; highlight colors are a separate
  control. Entering the mode or loading a file with nobody ticked seeds the ticks
  from the colors, and a color tap with nobody ticked ticks that name. Zero
  enlarged pages in this mode is a SHOUTED status ("Nobody's ticked yet…", or
  "None of the ticked names are in this PDF…"), and the download button is
  disabled ("Nothing to download yet") unless highlights make the output differ.
  The author fell into the silent version of this state; keep it loud.
- **Tests:** `tools/test_sceneline.mjs` (wired into `test.sh`) generates synthetic
  fixtures at runtime (spec §7: never store a `.sceneline`) and asserts acceptance
  (a)-(e) incl. the deep-equal round-trip. `*.sceneline` is gitignored.

## Known gotchas (already handled — don't reintroduce)
- **Revision `*` marks** sit in the far-right margin. A line's fit-width and
  scale-match band use the **dialogue segment only** (spans left of `pageW-80`), or
  they'd wrongly force back-off and could scale the `*`. Mirror this in check.py.
  If a line has such marks, enlargement is additionally capped so the grown text
  stays 4pt clear of them (`L.starX0`). A starred CUE ("TRACY  *") is two
  segments: cue detection and dual-row detection both look at body segments
  only, or the cue (and its whole block) silently vanishes.
- **Glyph-per-op PDFs**: pdf.js returns one item per glyph; when joining item
  text, insert a space only across a real word-sized gap or cue names read as
  "R U M A" and every text heuristic breaks.
- **Scene numbers print in BOTH margins** of a slugline and look like a dual-cue
  row; spaceless letter+digit runs are filtered from dual-name candidates only
  (never from real cue-derived names). In whole-page mode the margin/body split
  is done at ITEM level by x-thresholds (left of 70 / right of pageW-80), never
  by gap-joined segments — the left scene number sits closer than a segment gap
  to the slug text.
- **Clip rects hide moved text.** Table cells and per-row bands clip their
  text (`re W n`); anything scaled beyond the clip is silently invisible, so
  whole-page mode measures clips first and backs off. pymupdf respects clips
  in extraction; pdf.js does not.
- **Text inside forms**: page content stream often has zero `Tj` — don't conclude
  "no dialogue," descend into `Do`.
- **`'` and `"` show-operators** are decomposed so a scaled `Tm` can be injected.
- **Inline images (`BI`)**: a stream containing them is left unscaled (guarded).
- **Dual dialogue** and **revision-history / call-sheet tables** are left untouched
  (a table row may or may not read as a dual header; either way the page must stay
  identical, and no-dialogue pages contribute no names).
- **A call sheet is not a no-dialogue page by luck.** Its small-type rows can
  sit on the script's cue and dialogue x bands; the type-size gate is what keeps
  them out of classification. The fixture's call-sheet page carries that trap
  (`smallcue` / `smalldial` tokens) and test.sh asserts the page stays
  no-dialogue in enlarge mode and absent from reader mode.

## Rules for changes
- Never commit real scripts or their renders. `.gitignore` blocks `sides/`,
  `out/`, `*.real.pdf`, `samples-private/`. The only test fixture in-repo is the
  synthetic one from `make_fixture.py`.
- `engine.js` must stay dependency-injected (`{ pdfjsLib, PDFLib, policy }`) and
  free of Node-only or browser-only globals except where feature-detected (e.g.
  `crypto.subtle`). It ships to the browser verbatim. `policy` is the parsed
  `policy/scriptparse-policy.json` (build.mjs inlines it; the Node tools read it).
- Don't add runtime network access or external assets. The Netflix sides-link
  feature (`rewriteSidesLink`, v1.12.0) is a pure string rewrite offered as a
  plain `target=_blank rel=noopener noreferrer` link the user opens; the page
  never fetches it (CSP `connect-src 'none'` stands), never stores the token,
  and only recognises that one host. Do not add a fetch path for it.
- If you touch classification or scaling, add/extend a case in `make_fixture.py`
  and confirm `npm test` stays green **and** eyeball the renders.

## Security posture (audited — keep these intact)
- **No network, technically enforced.** A CSP `<meta>` in `ui_template.html` sets
  `default-src 'none'; connect-src 'none'` so the page cannot make any network
  request even if a future edit tried to. `script-src 'unsafe-inline' blob:` is the
  *minimum* that works: inline for the bundled libs, `blob:` because the pdf.js
  worker (and its fake-worker fallback) loads from a `blob:` URL. It deliberately
  omits `'unsafe-eval'`, which blocks the pre-4.2.67 pdf.js eval-execution advisory
  (GHSA-wgrm-67xf-hhpq) at the browser level. **Always re-test the built page in a
  real browser after touching the CSP** — Node tests don't enforce it, and a missing
  token silently breaks the worker ("Could not open this PDF").
- **pdf.js eval mitigation:** every `getDocument` call passes `isEvalSupported:false`
  (both `engine.js` extract and the UI preview `openDoc`). This plus the CSP is why
  the pdfjs-dist advisory is mitigated without the 3.x→5.x major bump. If you *do*
  bump pdfjs-dist, re-verify the worker inlining in `build.mjs` and the
  `getTextContent` item shape (`transform`, `width`, `str`).
- **`.npmrc` `omit=optional`** keeps the unused `canvas` (Node-render only; we use
  pymupdf/reportlab for images) and its vulnerable `tar` subtree out of installs.
  Don't add a runtime dep on `canvas`.
- **localStorage** holds only a `#name` → {size, mode, colors, character lists} map,
  and only when the URL has a `#name`; the root URL is stateless. A "forget my saved
  settings" control clears it. Never send this anywhere.

## Deploy (GitHub Pages)
Commit everything, push. In repo Settings → Pages, serve from the default branch
root. `index.html` + `.nojekyll` are all Pages needs. Per-user prefs key off the
URL hash (`/#laura`); nothing but a preferences label is stored, and only in the
visitor's localStorage. The ROOT URL (no hash) is stateless by design: always
default options, nothing loaded or saved.

**Versioning:** bump `version` in package.json for every user-visible release;
the build stamps it into the page footer (`__VERSION__`) so the public page
shows which version people are using.

## Federation (scriptparse)

This bench consumes the shared parser/policy/interchange truth from the
private `Gotham-Sound/scriptparse` repo (the hub). Standing law lives in the
hub's CLAUDE.md (the constitution) and binds this repo's agents too. The
rules that most often apply here:

- Parse/identity/interchange divergences are NEVER fixed locally. File a
  federation motion in scriptparse (issue template) with evidence, affected
  benches, and a proposed disposition. Filing is enough: the hub steward's
  standing sweep litigates (mentions are inert since the 2026-07-27 routing
  ruling, scriptparse #28).
- **Pin-lag doctrine (RULED, Peter, 2026-07-30; scriptparse #37):** lagging
  the hub pin stays this bench's right for behavior changes. It does NOT
  cover correctness classes: when a release is flagged as fixing a
  correctness class and this bench loads NEW material that matches it, the
  bump comes first. Load-time tells for the burn-in class: unexplained
  scene-id gaps, or repeated single-glyph tokens across pages; either one
  means suspect burn-in, bump before trusting the parse.
- Evidence in motions: fixtures by name + checksum, diffs, numbers. Never
  script text or real production strings.
- When a hub sync PR or federation issue arrives here (relayed by a cloud
  routine — the hub's Actions agent has no cross-repo token): absorb it per
  this repo's own requirements docs, run this repo's gates, and comment the ack
  (or the objection) on the hub issue. Pin bumps are boring on purpose.
- **Verification is inverted (ruled 2026-07-26): this bench reports, the hub
  reconciles.** When the hub publishes a checksum for a shared file (spec copy,
  policy data, pin), verify THIS repo's copy and post its `sha256` on the hub
  issue. Nobody reads into another bench's tree, so a missing report reads as
  unverified, not as clean. On Windows, post both the raw `sha256` and
  `tr -d '\r' < file | sha256sum` — a difference between them is a
  `core.autocrlf` artifact, not drift.
- Escalation is the hub's job: if litigation goes novel, the hub labels
  needs-peter. Don't ping Peter directly from here for federation matters.
- **Standing corpus harness (Phase 1 flipped 2026-09-18, hub #83):**
  `node tools/conformance_check.mjs --hub ../scriptparse` (test.sh runs it when a
  hub checkout is present). Two gates: consumability (every corpus file's sha256
  vs `manifest.json`, zero-dep JSON.parse, policy binding, and the vendored
  `policy/scriptparse-policy.json` byte-identical to the hub's) and contract (the
  engine's interpreter deep-equal on normalize, cue_gate, charset, fold, part_of,
  parts, offers, dual, burn_in; margin_rows has no consumer here and is reported
  n/a). It prints the manifest sha256 (the ack number, raw and CR-stripped).
  **Policy bump = copy the hub's `scriptparse/policy.json` over the vendored file,
  run this, run the gates, post the numbers on the hub issue.** A red contract
  vector is either our interpreter bug (fix here) or a hub change we must absorb
  (never a local rule). Vectors never store script text.
- **Identity-touching releases (RULED, Peter, 2026-09-17; scriptparse #93):**
  when a hub release is flagged identity-touching, diff the names this bench
  would seat under the candidate policy before taking it and publish the diff in
  the ack. This bench keeps no show; per-visitor localStorage color/selection maps
  are keyed by seated name strings and orphaned keys are inert (an unknown name
  simply does not render; "forget my saved settings" clears them).
