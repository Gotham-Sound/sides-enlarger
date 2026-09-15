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
expected = sorted(["LAURA", "MORROW", "WITNESS", "DIAZ",
                   "ELEANOR FROM HR", "SAM", "MERC #1"])
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
