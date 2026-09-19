# Sides Enlarger

Makes the **dialogue** in a day's shooting sides bigger (default 1.25×) so it's
readable on set — while keeping the page **exactly** as it was. Same page count,
same page breaks, same scene numbers, same everything-else. When someone says
"page 34," it's still page 34.

It can also **highlight each character's lines** in their own translucent color,
like a highlighter through a photocopy: it finds the character names on the
pages, you tap a color next to yours (and maybe one for your scene partner), and
the output paints those blocks. Highlights compose with the enlargement.

The whole thing is **one HTML file**. The PDF is processed **inside the browser**
— nothing is ever uploaded, no server, no accounts, no tracking. That's the point:
production scripts never leave the device.

---

## For the actor — how to use it

1. Open `index.html` (double-click it, or open it in Safari/Chrome on a
   phone, tablet, or computer).
2. Drag your sides PDF onto the page (or tap to choose the file).
   **Got a Netflix sides link instead of a file?** Paste it into the "Netflix
   sides link" field under the drop zone and tap the button: your sides open
   as a PDF in a new tab. Save it there (on an iPad: Share, then Save to
   Files) and drop it here. The page never fetches anything itself, and the
   link is not kept anywhere.
3. It shows the original and the enlarged version side by side. Flip through the
   pages to check.
4. Tap **Download enlarged PDF**. Print it or read it on your device.

There's a **size slider** (1.0× – 1.5×) if you want it bigger or smaller. It
remembers your setting on that device. You don't have to touch anything else.

A **"Make bigger"** switch picks what grows:
- **All dialogue** (default): every character's dialogue, in place.
- **Selected characters**: tap "Aa" next to a name and only that dialogue
  grows; everyone else's lines stay exactly as printed. Combine freely with
  highlight colors.
- **Everything**: action, cues, dialogue, headers, all of it grows on its own
  line, spreading out toward the paper edges, up to the slider size. Stage
  direction runs nearly edge to edge and the dialogue column widens by the
  same factor. Scene numbers, revision stars and page numbers stay exactly
  where they were. Line positions never change, so pages stay identical; the
  practical ceiling (usually 1.1x to 1.25x) is where neighboring lines would
  start to touch or where text would escape a table cell, and pages that hit
  a limit say which one. Pages with no dialogue at all (title pages,
  coverage, call sheets, revision tables) are passed through untouched in
  every mode.

And set apart from those three, because it deliberately breaks the
same-page-count rule:
- **Reader mode**: reflows the script into large, clean reading text (like an
  e-reader): bold scene headings, centered character names, full-width
  dialogue and action with the line wraps removed, at the size you pick with
  the slider. Headers, footers, page numbers, revision stars and watermarks
  are dropped. Where each original script page begins, a gray "SCRIPT PAGE
  34" rule is drawn inline, so when someone on set calls a page you can still
  find it. Every reader page carries a footer reminding you the new page
  numbers do not match the shooting script. Highlights work here too.

### Highlighting your lines
After a PDF loads, a **"Highlight characters"** panel lists every speaking
character it found, biggest part first, with line counts. Tap a color next to a
name to highlight that character's cue, parentheticals and dialogue; tap the
empty circle to clear it. Highlight some, all or none. Two characters can't
share a color (picking a taken color swaps it). The name-to-color choices are
remembered on your device for the run of the show, so your character stays
yellow in every new sides packet.

The list comes from the pages themselves (sides have no cast page), so review
it: hide anything that isn't a character with the ×, and type in a name if one
was missed. One-line entries are dimmed; they're either tiny parts or noise.
Dual dialogue (two side-by-side speakers) is never highlighted.

If a warning appears under a page, it's just letting you know that page was left
alone (see "What it leaves alone" below) — the page is still correct.

### Works on a phone?
Yes — iOS (Safari) and Android (Chrome) both work. It renders the preview as
images rather than relying on the phone's built-in PDF viewer, so the before/after
comparison shows up the same everywhere. To save the file on iPhone, tap Download
and choose "Save to Files"; on Android it goes to Downloads.

---

## Giving it to other people

Because it's a single self-contained file, you can share it three ways:

- **Send the file.** Email/AirDrop `index.html`. They open it. Done.
- **Host it free on GitHub Pages.** Put `index.html` in a repo (rename it
  `index.html` if you want a clean URL), enable Pages, and share the link. GitHub
  only ever serves the static file — since the PDF is processed in the visitor's
  browser, **no script ever touches GitHub's servers.**
- **Custom domain later.** Point `scriptenlarger.com` at the same GitHub Pages
  file with a CNAME. No code changes.

### "Security by obscurity" — per-person links
The tool identifies a person by the part of the URL after `#`:

```
scriptenlarger.com/#laura          → remembers Laura's size setting
scriptenlarger.com/#laura-x7k2q9   → same, but an unguessable link
```

The name after `#` is *only* a key for saved preferences (it never stores any
script). Because unguessable names cost nothing, use one if you want the link to
be hard to find. The page also sends `noindex` so search engines skip it. This
isn't real authentication — it's deliberate light-touch obscurity, which is all
that's needed for now. If it gets popular we can add real access control later.

---

## Run it offline (keep your own copy)

You don't need the internet, and you don't need this website, to use Sides
Enlarger. The whole tool is the single `index.html` file, so you can save your
own copy and run it with nothing connected:

- **Save it from the page you're on:** in your browser use File → Save Page As
  (or press Ctrl+S / Cmd+S) and keep `index.html` somewhere handy. Double-click
  it any time, on or offline.
- **Or download it from GitHub:** grab
  [index.html](https://github.com/gothamsound/sides-enlarger/raw/main/index.html)
  and open it in any browser.
- **On a phone or tablet:** save the file through your browser's share or
  download menu, then open it from Files (iPhone) or Downloads (Android).

An offline copy behaves exactly the same, and because every PDF is processed
inside the browser, your scripts still never leave your device.

---

## What it changes vs. leaves alone

**Enlarges:** spoken dialogue, the parentheticals inside a dialogue block, and
the character name above it.

**Highlights (opt-in):** the blocks of any character you assign a color, painted
behind the text with a multiply blend so the words stay crisp, selectable and
printable; the fixed palette is light enough that black-and-white printing keeps
full contrast.

**Leaves exactly in place:** scene headings (sluglines), action, page headers,
page numbers, scene numbers, revision stars (the `*` marks in the margin),
watermarks, and anything else.

It figures out what's dialogue **by where it sits on the page** (the indented
dialogue column, directly under a character cue), calibrated per document — not by
reading the words. That's what keeps it safe on photocopied sides where the margins
drift.

**Per-page back-off.** If enlarging a page's dialogue would push text off the page,
it automatically uses a smaller size *for that page only* (never reflowing text onto
another page) and tells you. Pages with no dialogue (title pages, revision tables,
pure action) are passed through untouched.

**Dual dialogue** (two side-by-side speakers) is left at original size with a
per-page note, rather than risk mangling it.

**Encrypted / permission-locked sides** (very common from productions) are handled
automatically — the output is a normal, unlocked, printable PDF. Treat it with the
same care as the original.

**Scanned sides** (an image with no real text) can't be enlarged this way; v1 shows
a clear "this looks like a scan" message instead of producing garbage.

---

## For a developer

### Files
```
index.html             ← the deliverable: build output, fully self-contained (also what Pages serves)
ui_template.html       ← the page + app glue (before bundling)
engine.js              ← core logic (runs identically in browser and Node)
build.mjs              ← inlines pdf.js, pdf.js worker (base64), pdf-lib, engine -> index.html
tools/make_fixture.py  ← generates a synthetic screenplay PDF for testing
tools/run_engine_node.mjs ← run the engine headless on a PDF
tools/check.py         ← independent verifier + before/after page renders
tools/test.sh          ← one-shot: fixture (and optional real PDFs) at 1.0/1.25/1.5
CLAUDE.md              ← notes for a Claude Code CLI session on this repo
```

### Build
```bash
npm install                 # pdf-lib, pdfjs-dist (build-time only; both get inlined)
npm run build               # writes index.html
```
The output HTML has **no external dependencies** and makes **no network requests**.

### How the engine works
1. **Extract & calibrate** (pdf.js): read every text run's position; find the
   character-cue column as the median cue x; derive the dialogue and parenthetical
   x-bands from the page geometry itself.
2. **Classify** each visual line geometrically: cue / dialogue / parenthetical /
   dual / other — dialogue must sit in the dialogue band *and* follow a cue.
3. **Rewrite the PDF content streams** (pdf-lib): for dialogue text-show operators
   only, inject a scaled text matrix anchored on that line's own baseline, shifted
   left by half the growth so the column stays put. Text lives inside **form
   XObjects** in real production PDFs, so the rewriter recurses through `Do`.
   Nothing moves vertically, so nothing can reflow — page parity is structural.
4. **Per-page fit / back-off** and **scan / dual-dialogue / encryption** handling as
   described above. Permission-locked PDFs are decrypted in-engine (RC4 & AES-128,
   empty user password — the standard "you can read but not edit" lock).
5. **Character extraction + highlighting**: cue-led blocks are collected during
   classification; names are normalized ((CONT'D)/(V.O.)/revision stars stripped)
   and aggregated with line counts (`report.characters`, also available without a
   rewrite via `engine.analyze()`). Assigned characters (`opts.highlights`,
   name to palette index; palette exported as `engine.PALETTE`) get one rounded
   multiply-blend rect per block, appended after the page content so form-XObject
   white fills can't mask it.

### Verify (do this, don't hope)
```bash
npm test                              # fixture at 1.0 / 1.25 / 1.5, all checks
bash tools/test.sh /path/to/real.pdf  # also run against your real sides locally
```
The checker asserts: equal page counts; every non-dialogue span unchanged in
position and size (0.7pt tolerance); dialogue enlarged to the applied scale with
unmoved baselines; nothing pushed off the page. It also writes `compare_pNN.png`
side-by-side page images for eyeball review. Point it at your real sides locally —
the synthetic fixture means the test suite never needs a confidential script.

Verified against a synthetic fixture **and** four real production sides
(text-based, incl. permission-locked and form-XObject layouts): full 1.25×
enlargement with page-for-page parity on every dialogue page.

---

## License and no warranty

Sides Enlarger is free software released under the **MIT License** (see the
[`LICENSE`](LICENSE) file for the full terms). You're free to use, copy, modify,
and share it.

It is provided **"as is," without warranty of any kind.** It's a convenience
tool, not a guarantee of correctness: always compare the enlarged PDF against
your original before you rely on it on set, and keep your original sides. To the
fullest extent allowed by law, the authors and Gotham Sound accept no liability
for any loss, error, or damage arising from its use. (Nothing here changes how
the tool works: your script is still processed entirely in your browser and is
never uploaded.)
