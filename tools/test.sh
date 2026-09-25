#!/usr/bin/env bash
# One-shot verification: synthesize a fixture, run the engine at several scales,
# and assert page parity + non-dialogue-unchanged + dialogue-enlarged via the
# independent checker. Optionally also runs against real PDFs you pass as args.
#
#   bash tools/test.sh                 # fixture only (safe, in-repo)
#   bash tools/test.sh path/to/real.pdf [more.pdf ...]   # + your local sides
set -euo pipefail
cd "$(dirname "$0")/.."

RENDER_DIR="${RENDER_DIR:-out/renders}"
mkdir -p out "$RENDER_DIR"

echo "==> generating synthetic fixture"
python3 tools/make_fixture.py

fail=0
run_one () {
  local src="$1" tag="$2"
  for scale in 1.0 1.25 1.5; do
    local outpdf="out/${tag}.${scale}.pdf"
    node tools/run_engine_node.mjs "$src" "$outpdf" "$scale" >/dev/null 2>"out/${tag}.err" || {
      if grep -q '^SCANNED' "out/${tag}.err"; then
        echo "    [$tag @ $scale] correctly rejected as scan"; continue
      fi
      echo "    [$tag @ $scale] ENGINE ERROR:"; cat "out/${tag}.err"; fail=1; continue
    }
    if CHECK_RENDER_DIR="$RENDER_DIR/${tag}_${scale}" \
         python3 tools/check.py "$src" "$outpdf" "${outpdf}.report.json" \
         | grep -q '^PASS'; then
      echo "    [$tag @ $scale] PASS"
    else
      echo "    [$tag @ $scale] FAIL"
      CHECK_RENDER_DIR="$RENDER_DIR/${tag}_${scale}" \
        python3 tools/check.py "$src" "$outpdf" "${outpdf}.report.json" | grep '  - ' || true
      fail=1
    fi
  done
}

check_one () {  # src outpdf label renderdir
  local src="$1" outpdf="$2" label="$3" rdir="$4"
  if CHECK_RENDER_DIR="$rdir" python3 tools/check.py "$src" "$outpdf" "${outpdf}.report.json" \
       | grep -q '^PASS'; then
    echo "    [$label] PASS"
  else
    echo "    [$label] FAIL"
    CHECK_RENDER_DIR="$rdir" python3 tools/check.py "$src" "$outpdf" "${outpdf}.report.json" | grep '  - ' || true
    fail=1
  fi
}

echo "==> ios/webkit floor: getTextContent ReadableStream async-iterator (scriptparse #43 cliff 2)"
if node tools/test_ios_stream.mjs out/fixture.pdf 2>/dev/null | grep -q '^IOS-STREAM: ok'; then
  echo "    [ios stream polyfill] PASS"
else
  echo "    [ios stream polyfill] FAIL"
  node tools/test_ios_stream.mjs out/fixture.pdf 2>&1 | grep -E 'control|engine|FAIL' || true
  fail=1
fi

echo "==> testing fixture"
run_one out/fixture.pdf fixture

echo "==> fixture: character extraction"
python3 - <<'PY' && echo "    [extraction] PASS" || { echo "    [extraction] FAIL"; fail=1; }
import json, sys
rep = json.load(open("out/fixture.1.25.pdf.report.json"))
names = sorted(c["name"] for c in rep.get("characters", []))
# WALLACE speaks only inside the grey-shaded (omitted) block on page 10 and
# must NOT be extracted; the grey exclusion must also announce itself.
assert "WALLACE" not in names, "grey-shaded character leaked into the list"
assert any("grey" in w.lower() for w in rep.get("warnings", [])), \
    "no grey-region warning emitted"
# Identity is the shared scriptparse policy (federation Phase 1): the
# generational suffixes seat as two distinct performers with the period
# stripped; ELEANOR FROM HR is gate-railed (stop word FROM, the canonical
# FROM rejection) and must land on the never-silent rejected rail, not vanish.
expected = sorted(["LAURA", "MORROW", "WITNESS", "DIAZ", "SAM", "MERC #1",
                   "SALLY, JR", "SALLY, SR"])
rej = {r["name"]: r for r in rep.get("rejectedCues", [])}
assert "ELEANOR FROM HR" in rej and "FROM" in rej["ELEANOR FROM HR"]["reason"], \
    "ELEANOR FROM HR must be railed with the FROM reason, got %r" % rej
assert any("ELEANOR FROM HR" in w for w in rep.get("warnings", [])), "railed cue not announced"
assert rep.get("policyVersion"), "report carries no policyVersion"
# the call sheet's small-type rows at the script's x bands are not dialogue
# (type-size gate): the page stays a no-dialogue page and the rows never
# become characters
assert "NO SMOKING ON SET" not in names, "call-sheet small-type row seated as a character"
nodial = {p["page"]: p["dialogueLines"] for p in rep["pages"]}
assert nodial.get(6) == 0 and nodial.get(9) == 0, "coverage/call-sheet page gained dialogue: %r" % nodial
# the call sheet (page 9) is small type throughout: the shared script-page
# gate (policy script_page, hub #103) excludes the whole page, names it on
# the never-silent rail and in a warning, and its scene-table row never
# becomes a slugline; the script-sized coverage page (6) is admitted
nsp = [p["page"] for p in rep.get("nonScriptPages", [])]
assert nsp == [9], "script-page gate rail should list exactly the call sheet: %r" % nsp
assert any("script-page gate" in w for w in rep.get("warnings", [])), "non-script page not announced"
assert not any(s.get("page") == 9 for s in rep.get("sluglines", [])), "call-sheet scene-table row seated as a slugline"
if names != expected:
    print("      extracted:", names)
    print("      expected :", expected)
    # call-sheet column headings arriving as zero-line "characters" is the
    # signature of the no-dialogue page guard regressing
    strays = [c["name"] for c in rep.get("characters", []) if not c.get("lines")]
    if strays:
        print("      zero-line strays (call-sheet leakage):", strays)
    sys.exit(1)
PY

echo "==> fixture: highlights (LAURA=yellow, MERC #1=sky)"
for scale in 1.0 1.25; do
  outpdf="out/fixture.hl.${scale}.pdf"
  node tools/run_engine_node.mjs out/fixture.pdf "$outpdf" "$scale" 'LAURA=0;MERC #1=2' \
    >/dev/null 2>out/fixture.hl.err || { echo "    [highlights @ $scale] ENGINE ERROR:"; cat out/fixture.hl.err; fail=1; continue; }
  if CHECK_RENDER_DIR="$RENDER_DIR/fixture_hl_${scale}" \
       python3 tools/check.py out/fixture.pdf "$outpdf" "${outpdf}.report.json" \
       | grep -q '^PASS'; then
    echo "    [highlights @ $scale] PASS"
  else
    echo "    [highlights @ $scale] FAIL"
    CHECK_RENDER_DIR="$RENDER_DIR/fixture_hl_${scale}" \
      python3 tools/check.py out/fixture.pdf "$outpdf" "${outpdf}.report.json" | grep '  - ' || true
    fail=1
  fi
done

echo "==> fixture: highlights on the second eight (LAURA=coral, MERC #1=tan; v1.14.0)"
outpdf="out/fixture.hl16.pdf"
node tools/run_engine_node.mjs out/fixture.pdf "$outpdf" 1.25 'LAURA=8;MERC #1=15' \
  >/dev/null 2>out/fixture.hl16.err || { echo "    [highlights 8..15] ENGINE ERROR:"; cat out/fixture.hl16.err; fail=1; }
if CHECK_RENDER_DIR="$RENDER_DIR/fixture_hl16" \
     python3 tools/check.py out/fixture.pdf "$outpdf" "${outpdf}.report.json" \
     | grep -q '^PASS'; then
  echo "    [highlights 8..15] PASS"
else
  echo "    [highlights 8..15] FAIL"
  CHECK_RENDER_DIR="$RENDER_DIR/fixture_hl16" \
    python3 tools/check.py out/fixture.pdf "$outpdf" "${outpdf}.report.json" | grep '  - ' || true
  fail=1
fi

echo "==> palette: sixteen entries, unique keys and hexes, light enough to print gray (luma >= 0.87), none an even grey (spread > 0.05)"
if node --input-type=module -e '
  import { createRequire } from "node:module";
  const src = (await import("node:fs")).readFileSync("engine.js", "utf8");
  const m = src.match(/const PALETTE = \[([\s\S]*?)\n  \];/);
  const entries = [...m[1].matchAll(/key: \x27([a-z]+)\x27,\s*hex: \x27(#[0-9A-F]{6})\x27, rgb: \[([^\]]+)\]/g)];
  const keys = entries.map(e => e[1]), hexes = entries.map(e => e[2]);
  let ok = entries.length === 16 && new Set(keys).size === 16 && new Set(hexes).size === 16;
  for (const e of entries) {
    const [r, g, b] = e[3].split(",").map(Number);
    const hex = [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, "0").toUpperCase()).join("");
    const luma = 0.299 * r + 0.587 * g + 0.114 * b, spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (luma < 0.87 || spread <= 0.05 || "#" + hex !== e[2]) { console.error("palette:", e[1], "luma", luma.toFixed(3), "rgb", hex, "hex", e[2]); ok = false; }
  }
  process.exit(ok ? 0 : 1);
'; then
  echo "    [palette] PASS"
else
  echo "    [palette] FAIL"; fail=1
fi

echo "==> fixture: selective enlargement (only LAURA; highlight on unenlarged MERC #1)"
node tools/run_engine_node.mjs out/fixture.pdf out/fixture.sel.pdf 1.25 'MERC #1=2' --enlarge-only='LAURA' \
  >/dev/null 2>out/fixture.sel.err || { echo "    [selective] ENGINE ERROR:"; cat out/fixture.sel.err; fail=1; }
check_one out/fixture.pdf out/fixture.sel.pdf "selective @ 1.25" "$RENDER_DIR/fixture_sel"

echo "==> fixture: whole-page mode"
node tools/run_engine_node.mjs out/fixture.pdf out/fixture.page.pdf 1.5 'LAURA=0' --mode=page \
  >/dev/null 2>out/fixture.page.err || { echo "    [page mode] ENGINE ERROR:"; cat out/fixture.page.err; fail=1; }
check_one out/fixture.pdf out/fixture.page.pdf "page mode @ 1.5" "$RENDER_DIR/fixture_page"

echo "==> fixture: reader mode"
node tools/run_engine_node.mjs out/fixture.pdf out/fixture.reader.pdf 1.25 'LAURA=0' --mode=reader \
  >/dev/null 2>out/fixture.reader.err || { echo "    [reader mode] ENGINE ERROR:"; cat out/fixture.reader.err; fail=1; }
check_one out/fixture.pdf out/fixture.reader.pdf "reader mode @ 1.25" "$RENDER_DIR/fixture_reader"
python3 - <<'PY' && echo "    [reader skips the call sheet] PASS" || { echo "    [reader skips the call sheet] FAIL"; fail=1; }
import fitz, json
doc = fitz.open("out/fixture.reader.pdf")
txt = "\n".join(doc[i].get_text() for i in range(doc.page_count))
assert "Vans depart base camp" not in txt and "CALL SHEET" not in txt, "call-sheet text reflowed into reader output"
rep = json.load(open("out/fixture.reader.pdf.report.json"))
assert not any(b.endswith("PAGE 42") for b in rep.get("readerBreaks", [])), "reader marked the call-sheet page (34+8=42)"
PY

# watermarked side: a rotated per-recipient watermark drops a glyph onto minor
# cue baselines. Without the rotated-item guard those cues fail geometric
# detection and their characters vanish silently (scriptparse #37); the guard
# excludes item.rot from line-building so the full cast is recovered, and a
# never-silent warning still flags the watermark.
echo "==> fixture (watermarked): rotated burn-in guard recovers the cast (scriptparse #37)"
node tools/run_engine_node.mjs out/fixture_wm.pdf out/fixture_wm.out.pdf 1.25 \
  >/dev/null 2>out/fixture_wm.err || { echo "    [watermark] ENGINE ERROR:"; cat out/fixture_wm.err; fail=1; }
python3 - <<'PY' && echo "    [watermark: cast recovered + never-silent] PASS" || { echo "    [watermark] FAIL"; fail=1; }
import json
clean = sorted(c["name"] for c in json.load(open("out/fixture.1.25.pdf.report.json")).get("characters", []))
rep = json.load(open("out/fixture_wm.out.pdf.report.json"))
wm = sorted(c["name"] for c in rep.get("characters", []))
warns = rep.get("warnings", [])
assert wm == clean, "cast not recovered under watermark: %r vs clean %r" % (wm, clean)
assert "WM" not in wm, "watermark text leaked into the cast: %r" % wm
assert any("watermark" in w.lower() for w in warns), "no never-silent watermark warning emitted"
PY
check_one out/fixture_wm.pdf out/fixture_wm.out.pdf "watermark: geometry parity" "$RENDER_DIR/fixture_wm"
# reader mode drops the rotated stamp from the reading text and carries its
# words in every reader page's footer instead (the recipient's watermark
# survives the reflow); the report lists what it carried
node tools/run_engine_node.mjs out/fixture_wm.pdf out/fixture_wm.reader.pdf 1.25 'LAURA=0' --mode=reader \
  >/dev/null 2>out/fixture_wm.reader.err || { echo "    [watermark reader] ENGINE ERROR:"; cat out/fixture_wm.reader.err; fail=1; }
check_one out/fixture_wm.pdf out/fixture_wm.reader.pdf "watermark: reader parity + footer stamp" "$RENDER_DIR/fixture_wm_reader"
python3 - <<'PY' && echo "    [watermark: stamp in every reader footer, never in the text] PASS" || { echo "    [watermark: reader stamp] FAIL"; fail=1; }
import fitz, json
rep = json.load(open("out/fixture_wm.reader.pdf.report.json"))
assert rep.get("readerStamps") == ["WM"], "readerStamps should be ['WM'], got %r" % rep.get("readerStamps")
assert any("watermark text carried" in w.lower() for w in rep.get("warnings", [])), "stamp carry not announced"
doc = fitz.open("out/fixture_wm.reader.pdf")
for i in range(doc.page_count):
    H = doc[i].rect.height
    words = doc[i].get_text("words")
    assert any(w[4] == "WM" and w[3] >= H - 45 for w in words), "page %d footer lacks the stamp" % (i + 1)
    assert not any(w[4] == "WM" and w[3] < H - 45 for w in words), "page %d: stamp leaked into the reading text" % (i + 1)
PY

# declared watermark text (opts.watermarkText): the page-10 stamp "COPY OF
# JANE DOE" is horizontal, so only the user's declaration can exclude it.
# Geometry parity must hold (stamp bytes untouched), the match must announce
# itself, and a mistyped declaration must warn instead of silently no-opping.
echo "==> fixture: declared watermark text"
node tools/run_engine_node.mjs out/fixture.pdf out/fixture.wmtext.pdf 1.25 --watermark-text='COPY OF JANE DOE' \
  >/dev/null 2>out/fixture.wmtext.err || { echo "    [wm-text] ENGINE ERROR:"; cat out/fixture.wmtext.err; fail=1; }
python3 - <<'PY' && echo "    [wm-text: matched + announced] PASS" || { echo "    [wm-text] FAIL"; fail=1; }
import json
rep = json.load(open("out/fixture.wmtext.pdf.report.json"))
w = rep.get("warnings", [])
assert any("Watermark text matched" in x for x in w), "match warning missing: %r" % w
PY
check_one out/fixture.pdf out/fixture.wmtext.pdf "wm-text: geometry parity" "$RENDER_DIR/fixture_wmtext"
node tools/run_engine_node.mjs out/fixture.pdf out/fixture.wmmiss.pdf 1.25 --watermark-text='NOT ON ANY PAGE' \
  >/dev/null 2>/dev/null
python3 - <<'PY' && echo "    [wm-text: miss warns] PASS" || { echo "    [wm-text: miss warns] FAIL"; fail=1; }
import json
rep = json.load(open("out/fixture.wmmiss.pdf.report.json"))
assert any("did not match" in x for x in rep.get("warnings", [])), "no-match warning missing"
PY

# burn-in stamp (signal 2): a NON-rotated per-recipient stamp at a fixed
# position on every page shares the page-1 cue baseline. Without the
# policy-driven repeated-position strip that cue fails geometric detection;
# with it the cast and every page's dialogue-line count match the clean
# fixture, the report says so (never silent), the stamp bytes stay put, and
# reader mode does not read the stamp aloud.
echo "==> fixture (burn-in stamp): repeated-position strip recovers the cast (scriptparse #16 signal 2, #37 residual)"
node tools/run_engine_node.mjs out/fixture_burnin.pdf out/fixture_burnin.out.pdf 1.25 \
  >/dev/null 2>out/fixture_burnin.err || { echo "    [burn-in] ENGINE ERROR:"; cat out/fixture_burnin.err; fail=1; }
python3 - <<'PY' && echo "    [burn-in: cast + lines recovered, never-silent] PASS" || { echo "    [burn-in] FAIL"; fail=1; }
import json
clean = json.load(open("out/fixture.1.25.pdf.report.json"))
rep = json.load(open("out/fixture_burnin.out.pdf.report.json"))
cn = sorted(c["name"] for c in clean.get("characters", []))
bn = sorted(c["name"] for c in rep.get("characters", []))
assert bn == cn, "cast not recovered under the stamp: %r vs clean %r" % (bn, cn)
cl = [p["dialogueLines"] for p in clean["pages"]]
bl = [p["dialogueLines"] for p in rep["pages"]]
assert bl == cl, "dialogue line counts differ under the stamp: %r vs clean %r" % (bl, cl)
assert any("Prepared for J. Doe" == b["text"] for b in rep.get("burnIns", [])), "burn-in rail missing the stamp: %r" % rep.get("burnIns")
assert any("burn-in" in w.lower() for w in rep.get("warnings", [])), "no never-silent burn-in warning"
PY
check_one out/fixture_burnin.pdf out/fixture_burnin.out.pdf "burn-in: geometry parity" "$RENDER_DIR/fixture_burnin"
node tools/run_engine_node.mjs out/fixture_burnin.pdf out/fixture_burnin.reader.pdf 1.25 'LAURA=0' --mode=reader \
  >/dev/null 2>out/fixture_burnin.reader.err || { echo "    [burn-in reader] ENGINE ERROR:"; cat out/fixture_burnin.reader.err; fail=1; }
check_one out/fixture_burnin.pdf out/fixture_burnin.reader.pdf "burn-in: reader parity" "$RENDER_DIR/fixture_burnin_reader"
python3 - <<'PY' && echo "    [burn-in: stamp in every reader footer, never in the text] PASS" || { echo "    [burn-in: reader stamp] FAIL"; fail=1; }
import fitz, json
rep = json.load(open("out/fixture_burnin.reader.pdf.report.json"))
assert "Prepared for J. Doe" in rep.get("readerStamps", []), "readerStamps lacks the signal-2 stamp: %r" % rep.get("readerStamps")
doc = fitz.open("out/fixture_burnin.reader.pdf")
for i in range(doc.page_count):
    H = doc[i].rect.height
    body = " ".join(w[4] for w in doc[i].get_text("words") if w[3] < H - 45)
    foot = " ".join(w[4] for w in doc[i].get_text("words") if w[3] >= H - 45)
    assert "Prepared for J. Doe" not in body, "page %d: stamp leaked into the reading text" % (i + 1)
    assert "Prepared for J. Doe" in foot, "page %d footer lacks the stamp" % (i + 1)
PY

# multi-episode day-side: the running header varies per page (only the show
# name is constant) and its glyph-per-op name straddles the x=70 body edge.
# Locks the show-name furniture anchor and the reader header label.
echo "==> fixture (multi-episode): dialogue / whole-page / reader"
run_one out/fixture_multi.pdf fixture_multi
for m in page reader; do
  node tools/run_engine_node.mjs out/fixture_multi.pdf "out/fixture_multi.$m.pdf" 1.25 'VOIGHT=0' --mode=$m \
    >/dev/null 2>"out/fixture_multi.$m.err" || { echo "    [multi $m] ENGINE ERROR:"; cat "out/fixture_multi.$m.err"; fail=1; continue; }
  check_one out/fixture_multi.pdf "out/fixture_multi.$m.pdf" "multi $m @ 1.25" "$RENDER_DIR/fixture_multi_$m"
done
echo "==> fixture (multi-episode): header is furniture, not body text"
python3 - <<'PY' && echo "    [multi header/label] PASS" || { echo "    [multi header/label] FAIL"; fail=1; }
import json, re, sys, fitz
rep = json.load(open("out/fixture_multi.reader.pdf.report.json"))
breaks = rep.get("readerBreaks", [])
bad = [b for b in breaks if "PROCEDURAL" not in b]
if bad:
    print("      break markers missing the full show name:", bad[:3]); sys.exit(1)
txt = "\n".join(fitz.open("out/fixture_multi.reader.pdf")[i].get_text()
                for i in range(fitz.open("out/fixture_multi.reader.pdf").page_count))
# the header must not leak into the reflowed body as an action paragraph
for ep in ("'Cold Open'", "'Fallen'", "'Young Blood'"):
    for line in txt.splitlines():
        if ep in line and not line.lstrip().startswith("SCRIPT PAGE"):
            print("      header leaked into reader body:", line[:70]); sys.exit(1)
# the clipped-head signature of the old left-margin bug
if re.search(r"\bEDURAL\b", txt):
    print("      show name lost its head (left-clip regression)"); sys.exit(1)
# the mid-scene left-margin continuation number must survive
if "5.46pt1" not in txt:
    print("      mid-scene left-margin scene number was eaten as furniture"); sys.exit(1)
PY

# real sides: whole-page mode + selective enlargement of the top character
run_modes () {
  local src="$1" tag="$2"
  node tools/run_engine_node.mjs "$src" "out/${tag}.page.pdf" 1.25 "" --mode=page \
    >/dev/null 2>"out/${tag}.page.err" || { echo "    [$tag page mode] ENGINE ERROR:"; cat "out/${tag}.page.err"; fail=1; return; }
  check_one "$src" "out/${tag}.page.pdf" "$tag page mode" "$RENDER_DIR/${tag}_page"
  local top
  top=$(python3 -c "import json;r=json.load(open('out/${tag}.1.25.pdf.report.json'));cs=[c for c in r.get('characters',[]) if c.get('lines')];print(cs[0]['name'] if cs else '')" 2>/dev/null || true)
  [ -z "$top" ] && return
  node tools/run_engine_node.mjs "$src" "out/${tag}.sel.pdf" 1.25 "${top}=0" --enlarge-only="$top" \
    >/dev/null 2>"out/${tag}.sel.err" || { echo "    [$tag selective] ENGINE ERROR:"; cat "out/${tag}.sel.err"; fail=1; return; }
  check_one "$src" "out/${tag}.sel.pdf" "$tag selective '$top'" "$RENDER_DIR/${tag}_sel"
  node tools/run_engine_node.mjs "$src" "out/${tag}.reader.pdf" 1.25 "${top}=0" --mode=reader \
    >/dev/null 2>"out/${tag}.reader.err" || { echo "    [$tag reader] ENGINE ERROR:"; cat "out/${tag}.reader.err"; fail=1; return; }
  check_one "$src" "out/${tag}.reader.pdf" "$tag reader" "$RENDER_DIR/${tag}_reader"
}

# real sides: also verify highlighting the most-talkative extracted character
run_hl () {
  local src="$1" tag="$2"
  local top
  top=$(python3 -c "import json;r=json.load(open('out/${tag}.1.25.pdf.report.json'));cs=[c for c in r.get('characters',[]) if c.get('lines')];print(cs[0]['name'] if cs else '')" 2>/dev/null || true)
  if [ -z "$top" ]; then echo "    [$tag highlight] no characters extracted — skipped"; return; fi
  node tools/run_engine_node.mjs "$src" "out/${tag}.hl.pdf" 1.25 "${top}=0" \
    >/dev/null 2>"out/${tag}.hl.err" || { echo "    [$tag highlight] ENGINE ERROR:"; cat "out/${tag}.hl.err"; fail=1; return; }
  if CHECK_RENDER_DIR="$RENDER_DIR/${tag}_hl" \
       python3 tools/check.py "$src" "out/${tag}.hl.pdf" "out/${tag}.hl.pdf.report.json" \
       | grep -q '^PASS'; then
    echo "    [$tag highlight '$top'] PASS"
  else
    echo "    [$tag highlight '$top'] FAIL"
    CHECK_RENDER_DIR="$RENDER_DIR/${tag}_hl" \
      python3 tools/check.py "$src" "out/${tag}.hl.pdf" "out/${tag}.hl.pdf.report.json" | grep '  - ' || true
    fail=1
  fi
}

echo "==> reader mode as a function (engine.reader / renderReaderPdf)"
if node tools/test_reader_elements.mjs out/fixture.pdf 2>/dev/null | grep -q '^READER-ELEMENTS: ok'; then
  echo "    [reader elements] PASS"
else
  echo "    [reader elements] FAIL"
  node tools/test_reader_elements.mjs out/fixture.pdf 2>&1 | grep -E '  - |Error|FAIL' | head -20 || true
  fail=1
fi

echo "==> studio sides-link rewrite (pure, no network)"
if node tools/test_links.mjs 2>/dev/null | tee /tmp/links.out | grep -q '^LINKS: all'; then
  grep '    \[' /tmp/links.out
else
  grep '    \[' /tmp/links.out || true
  echo "    [links] FAIL"; fail=1
fi

echo "==> .sceneline interchange (import/reconcile/export, acceptance a-e)"
if node tools/test_sceneline.mjs 2>/dev/null | tee /tmp/sceneline.out | grep -q '^SCENELINE: all'; then
  grep '    \[' /tmp/sceneline.out
else
  grep '    \[' /tmp/sceneline.out || true
  echo "    [.sceneline] FAIL"; fail=1
fi

# scriptparse conformance corpus (hub #40 Phase 0, inverted verification): runs
# when a hub checkout is present (../scriptparse or $SCRIPTPARSE_HUB), skips
# cleanly otherwise. Consumability is the gate; local misses are informational.
echo "==> scriptparse conformance corpus (JS-consumability)"
if node tools/conformance_check.mjs 2>/dev/null | tee /tmp/conformance.out | grep -qE '^CONFORMANCE: (GREEN|SKIP)'; then
  grep -E '^(CONFORMANCE|JS-consumability|  [a-z_]+\.json)' /tmp/conformance.out | sed 's/^/    /'
else
  grep -E '^(CONFORMANCE|  RED)' /tmp/conformance.out | sed 's/^/    /' || true
  echo "    [conformance] FAIL"; fail=1
fi

for real in "$@"; do
  name="$(basename "$real" .pdf)"
  echo "==> testing real: $name"
  run_one "$real" "real_${name}"
  run_hl "$real" "real_${name}"
  run_modes "$real" "real_${name}"
done

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL GREEN. Side-by-side renders in $RENDER_DIR/"
else
  echo "SOME CHECKS FAILED (see above)."; exit 1
fi
