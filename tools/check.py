#!/usr/bin/env python3
"""Independent verifier for Sides Enlarger output.

Usage: python3 tools/check.py before.pdf after.pdf [report.json]

Asserts:
  1. page counts equal
  2. every non-dialogue span is unchanged in position (<= 0.7pt) and size
  3. dialogue spans: baseline unchanged, size ratio == page's applied scale
     (median over doc >= 1.2x unless pages backed off)
  4. kerning fidelity: word gaps inside dialogue lines scale uniformly with
     the applied scale (multi-run lines must not crowd or overlap)
  5. if the report requested highlights: each assigned character's blocks are
     covered by exactly one rect of that character's color, every word of the
     block sits inside the rect, and no rect covers any other line's text
  6. selective mode (report.enlargeOnly): only the listed characters' dialogue
     scales; everyone else's dialogue is checked as unchanged like non-dialogue
  7. page mode (report.mode == "page"): body text is s times bigger on its
     own UNMOVED baseline, x mapped about the page anchor; margin marks
     (scene numbers, revision stars, page numbers) are byte-identical
  8. renders side-by-side page images to out/compare_pNN.png for eyeballing

The dialogue classifier here is an independent Python re-implementation of
the geometric rules (x-band + follows-a-cue), so the engine is checked
against a second opinion, not against itself.
"""
import json
import re
import statistics
import sys

import fitz

LEAD = 12
TOL_POS = 0.7


def get_lines(page, burn=None):
    """visual lines: [{y, x0, x1, text, spans:[(x0,y_origin,x1,size,text)], segs}]
    `burn` = the page's stripped-span keys from burn_spans() (signal 2)"""
    greys = grey_boxes(page)
    burn_keys = (burn or {}).get("keys", set())
    d = page.get_text("dict")
    spans = []
    for blk in d["blocks"]:
        if blk["type"] != 0:
            continue
        for ln in blk["lines"]:
            # mirror the engine's item.rot exclusion: rotated overlay text
            # (watermarks / burn-in stamps) is not part of the horizontal
            # layout and must not enter line-building (scriptparse #37).
            d2 = ln.get("dir", (1, 0))
            if abs(d2[1]) > 0.02:
                continue
            for sp in ln["spans"]:
                t = sp["text"]
                if not t.strip():
                    continue
                # mirror the engine's grey-region exclusion: shaded text is
                # omitted context, never classified (and never asserted scaled)
                x0g, _, x1g, _ = sp["bbox"]
                if greys and in_grey((x0g + x1g) / 2, sp["origin"][1] - 3, greys):
                    continue
                # mirror the engine's burn-in signal 2 strip (scriptparse
                # policy burn_in): repeated-position stamps never enter
                # line-building
                if (round(sp["bbox"][0], 2), round(sp["origin"][1], 2), t) in burn_keys:
                    continue
                x0, y0, x1, y1 = sp["bbox"]
                spans.append({"x0": x0, "x1": x1, "y": round(sp["origin"][1], 2),
                              "size": sp["size"], "text": t})
    spans.sort(key=lambda s: (s["y"], s["x0"]))
    # double-struck "bold" (same text drawn twice in place) reads once,
    # mirroring the engine's item dedupe
    deduped = []
    for sp in spans:
        p = deduped[-1] if deduped else None
        if (p and p["text"] == sp["text"] and abs(p["x0"] - sp["x0"]) < 1.2
                and abs(p["y"] - sp["y"]) <= 1.0):
            continue
        deduped.append(sp)
    spans = deduped
    lines = []
    for sp in spans:
        if lines and abs(lines[-1]["y"] - sp["y"]) <= 2.0:
            lines[-1]["spans"].append(sp)
        else:
            lines.append({"y": sp["y"], "spans": [sp]})
    for L in lines:
        L["spans"].sort(key=lambda s: s["x0"])
        # the line's type size (median of its spans), for the type-size gate
        L["size"] = statistics.median(s["size"] for s in L["spans"])
        L["x0"] = L["spans"][0]["x0"]
        L["x1"] = max(s["x1"] for s in L["spans"])
        # segments split at >40pt gaps (dual dialogue)
        segs = []
        for s in L["spans"]:
            if segs and s["x0"] - segs[-1]["x1"] <= 40:
                segs[-1]["x1"] = max(segs[-1]["x1"], s["x1"])
                segs[-1]["text"] += " " + s["text"]
            else:
                segs.append({"x0": s["x0"], "x1": s["x1"], "text": s["text"]})
        L["segs"] = segs
        L["text"] = "   ".join(s["text"] for s in segs)
    return lines


def grey_boxes(page):
    """Grey-shaded (omitted / non-shooting) region rects, mirroring the
    engine's detector: even grey fill (component spread < 0.05, mean 0.2-0.92)
    and big enough to hold a text line (>= 36x14pt). Text inside is context,
    not the day's work: excluded from classification and reader expectations."""
    boxes = []
    for d in page.get_drawings():
        f = d.get("fill")
        if not f:
            continue
        if max(f) - min(f) >= 0.05:
            continue
        mean = sum(f) / len(f)
        if not (0.2 <= mean <= 0.92):
            continue
        r = d["rect"]
        if r.width >= 36 and r.height >= 14:
            boxes.append(r)
    return boxes


def in_grey(px, py, boxes):
    return any(b.x0 - 1 <= px <= b.x1 + 1 and b.y0 - 1 <= py <= b.y1 + 1 for b in boxes)


def rot_ids(page):
    """(block_no, line_no) of rotated text lines (watermark / burn-in
    overlays). get_text('words') tuples carry the same block/line indices as
    get_text('dict'), so this identifies rotated WORDS exactly — a bbox test
    would swallow body words under a page-sized diagonal stamp. The engine
    excludes item.rot from the classifier; the word-level checks below mirror
    that (scriptparse #37)."""
    ids = set()
    for bi, blk in enumerate(page.get_text("dict")["blocks"]):
        if blk.get("type") != 0:
            continue
        for li, ln in enumerate(blk["lines"]):
            if abs(ln["dir"][1]) > 0.02:
                ids.add((bi, li))
    return ids


def not_rotated(w, ids):
    return (w[5], w[6]) not in ids


def capsy(t):
    letters = re.sub(r"[^A-Za-z]", "", t)
    return len(letters) >= 2 and letters == letters.upper()


def is_cue(L, lo, hi, pageW=0):
    # a cue may carry revision marks in the far-right margin ("TRACY  *")
    segs = [s for s in L["segs"] if s["x0"] < pageW - 80] if pageW else L["segs"]
    if len(segs) != 1 or (segs and L["segs"] and segs[0] is not L["segs"][0]):
        return False
    text = segs[0]["text"] if segs else ""
    return (capsy(text) and len(text.strip()) <= 42
            and lo <= L["x0"] <= hi
            and not re.search(r"\b(INT|EXT)\s*[./]", text)
            and not re.search(r"(CUT TO|FADE (IN|OUT)|DISSOLVE)", text))


# ---- scriptparse policy mirror (federation Phase 1) ----
# The verifier runs the hub's Python REFERENCE code (build_matrix.py /
# policy.py, copied verbatim where pure) on the vendored policy data, so the
# engine's JS interpreter is checked against the reference by construction.
import json as _json
import math as _math
import os as _os

_POLICY = _json.load(open(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..",
                                        "policy", "scriptparse-policy.json"), encoding="utf-8"))
_NON_CHARACTER = frozenset(_POLICY["transitions_non_character"])
_BAD_WORDS = frozenset(_POLICY["cue_stop_words"])
_REJECT_TRAILING = tuple(_POLICY.get("cue_reject_trailing", ["-"]))
_NAME_SUFFIXES = frozenset(s.replace(".", "").upper() for s in _POLICY.get("name_suffixes", []))
_MARKER = _POLICY.get("numbered_part_marker", "#")
_SUFFIX_TAIL_RE = re.compile(r",\s*(?P<suffix>[A-Z][A-Z.]*)$")
_NUMBERED_TAIL_RE = re.compile(re.escape(_MARKER) + r"\d+$")
_FURNITURE_CUE_RE = re.compile(
    r"^(?:" + "|".join(_POLICY["furniture_numbered_words"]) + r")\s+"
    r"(?:" + re.escape(_MARKER) + r"?\d+[A-Z]?|" + "|".join(_POLICY["furniture_number_words"]) + r")$")
_PAGE_TOKEN_RE = re.compile(r"^[A-Z]?\d+[A-Z]?\.$")


def _normalize_text(s):
    s = (s or "").strip()
    s = s.replace("\u201c", "").replace("\u201d", "").replace('"', "")
    s = s.replace("\u2019", "'").replace("\u2018", "'")
    s = re.sub(r"\[[^\]]+\]", "", s)
    s = re.sub(r"\([^)]*\)", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _hub_norm_cue(raw):
    text = _normalize_text(raw).upper()
    text = re.sub(r"[.:]+$", "", text).strip()
    deduped = []
    for word in text.split():
        if not deduped or deduped[-1] != word:
            deduped.append(word)
    return " ".join(deduped)


def norm_cue(t):
    """mirror of the engine's normalizeCueName: the local revision-star strip,
    then the hub's norm_cue (the seating layer)"""
    return _hub_norm_cue(re.sub(r"\*", " ", t or ""))


def _strip_admitted_shapes(cue):
    m = _SUFFIX_TAIL_RE.search(cue)
    if m and m.group("suffix").replace(".", "") in _NAME_SUFFIXES:
        cue = cue[:m.start()].rstrip()
    return _NUMBERED_TAIL_RE.sub("", cue).rstrip()


def cue_charset_ok(cue):
    rest = _strip_admitted_shapes(cue)
    return bool(rest) and bool(re.fullmatch(r"[A-Z0-9 .'\-]+", rest))


def cue_semantic_ok(cue):
    if not cue or cue in _NON_CHARACTER or _FURNITURE_CUE_RE.match(cue):
        return False
    if cue.endswith(_REJECT_TRAILING):
        return False
    if len(cue) < 2:
        return False
    words = cue.split()
    if not (1 <= len(words) <= 4):
        return False
    if len(words) >= 2 and any(word in _BAD_WORDS for word in words):
        return False
    if len(cue) > 30:
        return False
    return True


def cue_gate_ok(cue):
    return bool(cue) and cue_semantic_ok(cue) and cue_charset_ok(cue)


def split_dual_header(words):
    """the hub's split_dual_header: words = [(text, x0, x1), ...] in x order"""
    min_gap = _POLICY.get("dual_dialogue", {}).get("min_gap_pt", 40)
    if len(words) < 2:
        return None
    wide = [k for k in range(len(words) - 1) if words[k + 1][1] - words[k][2] > min_gap]
    if len(wide) != 1:
        return None
    k = wide[0]
    left_ws, right_ws = words[:k + 1], words[k + 1:]
    left = " ".join(w[0] for w in left_ws).strip()
    right = " ".join(w[0] for w in right_ws).strip()
    for half in (left, right):
        if half.endswith(":"):
            return None
        cue = _hub_norm_cue(half)
        if not cue or not cue_semantic_ok(cue) or not cue_charset_ok(cue):
            return None
    return left, right, (left_ws[0][1] + right_ws[0][1]) / 2.0


def _word_cell(w, page_height, grid):
    return (_math.floor(w["x0"] / grid), _math.floor((page_height - w["bottom"]) / grid))


def detect_repeated_burnin(pages_words, page_heights):
    """the hub's _detect_repeated_burnin (signal 2): per page, the set of word
    indices to strip"""
    rule = _POLICY.get("burn_in", {})
    grid = rule.get("repeat_grid_pt", 24)
    n_pages = len(pages_words)
    threshold = max(rule.get("repeat_min_pages", 4), _math.ceil(n_pages * rule.get("repeat_page_fraction", 0.5)))
    seen_on = {}
    for pi, words in enumerate(pages_words):
        h = page_heights[pi]
        for w in words:
            key = (w["text"].strip(),) + _word_cell(w, h, grid)
            seen_on.setdefault(key, set()).add(pi)
    repeated = {k for k, pages in seen_on.items() if len(pages) >= threshold}
    strip = []
    for pi, words in enumerate(pages_words):
        h = page_heights[pi]
        groups = {}
        for wi, w in enumerate(words):
            key = (w["text"].strip(),) + _word_cell(w, h, grid)
            if key in repeated:
                groups.setdefault(_word_cell(w, h, grid)[1], []).append(wi)
        drop = set()
        for yb, wis in groups.items():
            line_words = [w for w in words if _word_cell(w, h, grid)[1] == yb]
            rightmost = max(line_words, key=lambda w: w["x0"])
            if _PAGE_TOKEN_RE.match(rightmost["text"].strip()):
                continue
            joined = " ".join(words[wi]["text"] for wi in sorted(wis, key=lambda i: words[i]["x0"]))
            if re.search(r"[a-z]", joined):
                drop.update(wis)
        strip.append(drop)
    return strip


def burn_spans(doc):
    """mirror of the engine's stripRepeatedBurnIn at pymupdf span granularity:
    per page, (a) the set of span keys to exclude from line-building and (b)
    their bboxes (so word-level checks can skip them). Spans are this
    verifier's "words": the same (text, cell) repeat logic strips the same
    stamp regions the engine strips glyph-by-glyph or word-by-word."""
    pages_words, heights, keys = [], [], []
    for page in doc:
        rot = rot_ids(page)
        greys = grey_boxes(page)
        words, pkeys = [], []
        d = page.get_text("dict")
        for bi, blk in enumerate(d["blocks"]):
            if blk["type"] != 0:
                continue
            for li, ln in enumerate(blk["lines"]):
                if abs(ln.get("dir", (1, 0))[1]) > 0.02 or (bi, li) in rot:
                    continue
                for sp in ln["spans"]:
                    t = sp["text"]
                    if not t.strip():
                        continue
                    x0g, _, x1g, _ = sp["bbox"]
                    if greys and in_grey((x0g + x1g) / 2, sp["origin"][1] - 3, greys):
                        continue
                    # bottom = the baseline in top-down space, so
                    # page_height - bottom is the engine's baseline y (anchor space)
                    words.append({"text": t, "x0": sp["bbox"][0], "x1": sp["bbox"][2],
                                  "bottom": sp["origin"][1], "top": sp["bbox"][1], "bbox": sp["bbox"]})
                    pkeys.append((round(sp["bbox"][0], 2), round(sp["origin"][1], 2), t))
        pages_words.append(words)
        heights.append(page.rect.height)
        keys.append(pkeys)
    strips = detect_repeated_burnin(pages_words, heights)
    out = []
    for pi, drop in enumerate(strips):
        out.append({"keys": {keys[pi][i] for i in drop},
                    "boxes": [pages_words[pi][i]["bbox"] for i in drop]})
    return out


_BURN_CACHE = {}


def burn_spans_cached(doc):
    k = id(doc)
    if k not in _BURN_CACHE:
        _BURN_CACHE[k] = burn_spans(doc)
    return _BURN_CACHE[k]


def in_burn(w, boxes):
    """word tuple (x0,y0,x1,y1,text,...) inside any stripped span bbox"""
    cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
    return any(b[0] - 1 <= cx <= b[2] + 1 and b[1] - 1 <= cy <= b[3] + 1 for b in boxes)


def collect_blocks(lines):
    """cue-led blocks from an already-classified page, mirroring the engine"""
    blocks, cur = [], None
    for L in lines:
        c = L.get("cls")
        if c == "cue":
            cur = {"name": norm_cue(L["text"]), "cue": L, "lines": []}
            blocks.append(cur)
        elif c in ("dialogue", "more"):
            if cur:
                cur["lines"].append(L)
        else:
            cur = None
    return blocks


def classify_doc(doc):
    burn = burn_spans_cached(doc)
    pages_lines = [get_lines(p, burn[i]) for i, p in enumerate(doc)]
    widths = [p.rect.width for p in doc]
    cue_xs = [L["x0"] for lines, W in zip(pages_lines, widths) for L in lines if is_cue(L, 200, 340, W)]
    assert len(cue_xs) >= 2, "verifier could not find character cues"
    cue_x = statistics.median(cue_xs)
    # mirror the engine's type-size gate: the script's type size is the
    # median over its cue lines; a cue or dialogue candidate more than a
    # quarter off it (a call sheet's small-type rows at the script's x bands)
    # is never script
    cue_sizes = [L["size"] for lines, W in zip(pages_lines, widths) for L in lines
                 if is_cue(L, cue_x - 12, cue_x + 12, W)]
    cue_size = statistics.median(cue_sizes) if cue_sizes else 0

    def type_ok(L):
        return not cue_size or abs(L["size"] - cue_size) <= 0.25 * cue_size
    dial_xs = []
    for lines, W in zip(pages_lines, widths):
        for i, L in enumerate(lines):
            if type_ok(L) and is_cue(L, cue_x - 12, cue_x + 12, W) and i + 1 < len(lines):
                nxt = lines[i + 1]
                if (type_ok(nxt) and nxt["y"] - L["y"] < 3 * LEAD and cue_x - 130 < nxt["x0"] < cue_x - 30
                        and not nxt["text"].strip().startswith("(")):
                    dial_xs.append(nxt["x0"])
    dial_x = statistics.median(dial_xs)
    paren_xs = [L["x0"] for lines in pages_lines for L in lines
                if L["text"].strip().startswith("(") and dial_x + 6 < L["x0"] < dial_x + 70]
    paren_x = statistics.median(paren_xs) if paren_xs else dial_x + 43

    for lines, W in zip(pages_lines, widths):
        in_block, dual, prev_y = False, False, None
        for L in lines:
            if prev_y is not None and L["y"] - prev_y > 28:
                in_block = False
            prev_y = L["y"]
            body_segs = [s for s in L["segs"] if s["x0"] < W - 80]
            # dual-dialogue header: the shared splitter on the all-caps body
            # segments (each segment is a splitter "word"), mirroring the engine
            if (len(body_segs) >= 2 and all(capsy(s["text"]) for s in body_segs)
                    and split_dual_header([(s["text"], s["x0"], s["x1"]) for s in body_segs]) is not None):
                L["cls"], dual, in_block = "dual", True, False
                continue
            if dual:
                if len(L["segs"]) >= 2:
                    L["cls"] = "dual"
                    continue
                dual = False
            if type_ok(L) and is_cue(L, cue_x - 12, cue_x + 12, W):
                L["cls"], in_block = "cue", True
                continue
            if in_block and type_ok(L) and (abs(L["x0"] - dial_x) <= 9 or abs(L["x0"] - paren_x) <= 9):
                L["cls"] = "more" if re.match(r"^\(\s*MORE\s*\)\s*$", L["text"].strip(), re.I) else "dialogue"
                continue
            L["cls"], in_block = "other", False
    return pages_lines


def mark_furniture(pages_lines, heights):
    """mirror of the engine's markFurniture (engine.js). Top/bottom-zone rows
    that repeat across pages, recognized two ways:
      (A) identical text — the whole digit-stripped row repeats on >= half the
          pages (single-show headers, CONTINUED: rows), matched in the wider
          15%/12% zones.
      (B) shared show-name anchor — multi-episode "day" sides vary everything
          but the leading show-name token, matched on that token in the
          extreme 8% edge band only. A row with no 3+-letter word (a lone page
          number or "*") is furniture only in that edge band, so a mid-scene
          left-margin scene number in the top zone stays body text."""
    from collections import defaultdict

    def zone(L, H):  # pymupdf y is top-down
        if L["y"] < 0.15 * H:
            return "top"
        if L["y"] > 0.88 * H:
            return "bot"
        return None

    def edge(L, H):
        if L["y"] < 0.08 * H:
            return "top"
        if L["y"] > 0.92 * H:
            return "bot"
        return None

    def sig(t):
        return re.sub(r"[^A-Za-z]", "", t)

    def key_full(L):
        return " ".join(t for t in L["text"].split() if len(sig(t)) >= 3).upper()

    def key_lead(L):
        for t in L["text"].split():
            if len(sig(t)) >= 3:
                return sig(t).upper()
        return ""

    seen_full, seen_lead = defaultdict(set), defaultdict(set)
    for pi, lines in enumerate(pages_lines):
        for L in lines:
            if L.get("cls") in ("cue", "dialogue"):
                continue
            zf = zone(L, heights[pi])
            if zf:
                kf = key_full(L)
                if kf:
                    seen_full[(zf, kf)].add(pi)
            ze = edge(L, heights[pi])
            if ze:
                kl = key_lead(L)
                if kl:
                    seen_lead[(ze, kl)].add(pi)
    need = max(2, -(-len(pages_lines) // 2))
    for pi, lines in enumerate(pages_lines):
        for L in lines:
            if L.get("cls") in ("cue", "dialogue"):
                continue
            zf = zone(L, heights[pi])
            if zf and key_full(L) and len(seen_full[(zf, key_full(L))]) >= need:
                L["furn"] = True
                continue
            ze = edge(L, heights[pi])
            if ze and (not key_lead(L) or len(seen_lead[(ze, key_lead(L))]) >= need):
                L["furn"] = True


def reader_check(b, a, report, fails, notes):
    """Reader mode deliberately breaks page parity. Contract instead:
    every kept body word survives (no text lost), nothing is invented
    beyond the known page-break markers/footers, revision stars and
    furniture are dropped, and the text is at the reader size."""
    import collections
    before_cls = classify_doc(b)
    mark_furniture(before_cls, [p.rect.height for p in b])
    burn_b = burn_spans_cached(b)
    need = collections.Counter()
    allb = collections.Counter()
    for pi in range(len(b)):
        W = b[pi].rect.width
        lines = before_cls[pi]
        burn_boxes = burn_b[pi]["boxes"]
        has_dial = any(L.get("cls") == "dialogue" for L in lines)
        # rotated watermark words are dropped in reader view (identified by
        # block/line index, not geometry — a page-sized diagonal stamp's bbox
        # would swallow body words)
        rot_b = rot_ids(b[pi])
        words = b[pi].get_text("words")
        for w in words:
            if w[4].strip():
                allb[w[4]] += 1
        if not has_dial:
            continue  # coverage/title pages are skipped in reader view
        keep_rows = [L for L in lines if not L.get("furn") and L.get("cls") != "more"]
        counted = set()  # double-struck "bold" words appear twice in place
        scene_shape = re.compile(r"^[A-Z]{0,3}\d+[A-Z0-9]*$")
        for L in keep_rows:
            row = sorted((w for w in words
                          if abs(w[3] - L["y"]) <= 5.0 and w[4].strip()
                          and not_rotated(w, rot_b)
                          and not (burn_boxes and in_burn(w, burn_boxes))),
                         key=lambda w: w[0])
            # margin scene numbers are furniture, not body words: reader mode
            # drops/relabels them, so they must not be required. Mirror the
            # engine — a leading scene-number-shaped word set well left of the
            # body, and its identical right-margin twin.
            skip = set()
            if len(row) >= 2 and scene_shape.match(row[0][4]) and row[1][0] - row[0][2] > 16:
                sc = row[0][4]
                skip.add(id(row[0]))
                if scene_shape.match(row[-1][4]) and row[-1][4] == sc:
                    skip.add(id(row[-1]))
            for w in row:
                if id(w) in skip:
                    continue
                if w[2] > 70 and w[0] < W - 80 and w[4] != "*":
                    k = (w[4], round(w[0]), round(w[3]))
                    if k in counted:
                        continue
                    counted.add(k)
                    need[w[4]] += 1
    got = collections.Counter()
    sizes = []
    for pi in range(len(a)):
        H = a[pi].rect.height
        for w in a[pi].get_text("words"):
            if w[3] < H - 45 and w[4].strip():
                got[w[4]] += 1
        for blk in a[pi].get_text("dict")["blocks"]:
            if blk["type"] != 0:
                continue
            for ln in blk["lines"]:
                for sp in ln["spans"]:
                    if sp["bbox"][3] < H - 45 and sp["text"].strip() and sp["size"] > 9:
                        sizes.append(sp["size"])
    # the recipient's watermark text must ride EVERY reader page's footer
    # zone (report.readerStamps; the footer zone is the bottom 45pt, which the
    # body accounting above excludes), and nowhere in the reading text
    stamps = [str(s) for s in (report or {}).get("readerStamps", []) if str(s).strip()]
    for pi in range(len(a)):
        H = a[pi].rect.height
        foot = " ".join(w[4] for w in sorted(a[pi].get_text("words"), key=lambda w: (round(w[1]), w[0])) if w[3] >= H - 45)
        foot = re.sub(r"\s+", " ", foot)
        for st in stamps:
            if re.sub(r"\s+", " ", st) not in foot:
                fails.append(f"reader: p{pi+1} footer lacks the watermark stamp {st[:30]!r}")
    # subtract the known page-break marker text before the invented check
    # (labels are the full drawn strings, e.g. 'SCRIPT PAGE 17 · NCIS: ...')
    for label in (report or {}).get("readerBreaks", []):
        got.subtract(collections.Counter(str(label).split()))
    # "Sc." is the reader-added scene-number label, never source text
    if "Sc." in got:
        del got["Sc."]
    got = +got
    missing = need - got
    for t, n in list(missing.items())[:8]:
        fails.append(f"reader: text LOST: {t[:30]!r} x{n}")
    if len(missing) > 8:
        fails.append(f"reader: ... and {len(missing) - 8} more missing words")
    invented = got - allb
    for t, n in list(invented.items())[:8]:
        fails.append(f"reader: text INVENTED: {t[:30]!r} x{n}")
    if got.get("*"):
        fails.append("reader: revision stars must be dropped")
    req = (report or {}).get("requestedScale", 1.25)
    med = statistics.median(sizes) if sizes else 0
    notes.append(f"reader: {len(b)} script pages -> {len(a)} reader pages, "
                 f"{len(report.get('readerBreaks', []))} page markers, median size {med:.1f}")
    if abs(med - 12 * req) > 0.8:
        fails.append(f"reader: median text size {med:.2f} != {12 * req:.2f}")


def main():
    before_path, after_path = sys.argv[1], sys.argv[2]
    report = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else None

    b, a = fitz.open(before_path), fitz.open(after_path)
    fails, notes = [], []

    if (report or {}).get("mode") == "reader":
        reader_check(b, a, report, fails, notes)
        import os
        outdir = os.environ.get("CHECK_RENDER_DIR") or os.path.dirname(after_path) or "."
        os.makedirs(outdir, exist_ok=True)
        for pi in range(len(a)):
            a[pi].get_pixmap(dpi=110).save(os.path.join(outdir, f"reader_p{pi+1:02d}.png"))
        notes.append(f"reader renders: {outdir}/reader_pNN.png")
        report_and_exit(fails, notes)

    # 1. page parity
    if len(b) != len(a):
        fails.append(f"page count differs: {len(b)} vs {len(a)}")
        report_and_exit(fails, notes)

    mode = (report or {}).get("mode") or "dialogue"
    sel = (report or {}).get("enlargeOnly")  # None = all dialogue; list = only these
    try:
        before_cls = classify_doc(b)
    except Exception:
        if mode != "page":
            raise
        before_cls = [get_lines(p) for p in b]
        notes.append("no cues classifiable; page-mode geometric checks only")
    if mode == "page":
        mark_furniture(before_cls, [p.rect.height for p in b])
    ratios = []
    gap_bad = []
    hl = (report or {}).get("highlights") or {}

    def wordbag(page):
        import collections
        c = collections.Counter()
        for w in page.get_text("words"):
            t = re.sub(r"\s+", "", w[4])
            if t:
                c[t] += 1
        return c

    for pi in range(len(b)):
        blines = before_cls[pi]
        # the stamp is untouched in the output, so the BEFORE doc's stripped
        # span keys apply to the after doc unchanged
        alines = get_lines(a[pi], burn_spans_cached(b)[pi])
        aspans = [s for L in alines for s in L["spans"]]
        applied = report["pages"][pi]["appliedScale"] if report else None
        pinfo = report["pages"][pi] if report else {}
        s_eff = applied if applied else 1.0
        pageW = a[pi].rect.width
        pageH = b[pi].rect.height
        marginStart = pageW - 80  # exclude right-margin revision marks (*)
        blocks = collect_blocks(blines)
        line_name = {}
        enl_cues = set()
        for B in blocks:
            for L in B["lines"]:
                line_name[id(L)] = B["name"]
            # the character name scales with its block (when the block has
            # dialogue and, in selective mode, is selected)
            if any(l.get("cls") == "dialogue" for l in B["lines"]) and (sel is None or B["name"] in sel):
                enl_cues.add(id(B["cue"]))

        def line_enlarged(L):
            c = L.get("cls")
            if c == "cue":
                return id(L) in enl_cues
            if c != "dialogue":
                return False
            if sel is None:
                return True
            return line_name.get(id(L)) in sel

        if mode == "page":
            # whole-page mode: baselines never move; body x maps about the
            # page's content-center anchor
            anchor = pinfo.get("anchor", pageW / 2.0)

            def ymap(L):
                return L["y"]

            def xspan(L):
                if s_eff > 1.001:
                    return (anchor + s_eff * (max(L["x0"], 70) - anchor),
                            anchor + s_eff * (min(L["x1"], marginStart) - anchor))
                return (L["x0"], L["x1"])
        else:
            def ymap(L):
                return L["y"]

            def xspan(L):
                if line_enlarged(L) and s_eff > 1.001:
                    calib = (report or {}).get("calibration") or {}
                    C = calib.get("dialX", 180) + calib.get("colW", 252) / 2.0
                    return (C + s_eff * (L["x0"] - C), C + s_eff * (min(L["x1"], marginStart) - C))
                return (L["x0"], L["x1"])

        # --- (a) no text lost: page-level word multiset must be preserved.
        # Robust to renderer re-segmenting enlarged dialogue into different spans.
        bb, ab = wordbag(b[pi]), wordbag(a[pi])
        if bb != ab:
            missing = (bb - ab)
            extra = (ab - bb)
            for t, n in list(missing.items())[:6]:
                fails.append(f"p{pi+1}: text LOST: {t[:40]!r} x{n}")
            for t, n in list(extra.items())[:3]:
                fails.append(f"p{pi+1}: text ADDED: {t[:40]!r} x{n}")

        # --- (b) unchanged spans: byte-identical stream => exact position/size.
        # In selective mode, dialogue of unselected characters must also stay
        # untouched. Skipped in page mode (everything moves by the affine).
        for L in (blines if mode != "page" else []):
            keep = (L.get("cls") in ("other", "dual", "more")
                    or (L.get("cls") in ("cue", "dialogue") and not line_enlarged(L)))
            if not keep:
                continue
            for sp in L["spans"]:
                cands = [t for t in aspans if t["text"] == sp["text"] and abs(t["y"] - sp["y"]) <= 2.5]
                if not cands:
                    # segmentation can vary; only fail if this exact string's
                    # position truly can't be confirmed near where it was
                    near = [t for t in aspans if abs(t["y"] - sp["y"]) <= TOL_POS and abs(t["x0"] - sp["x0"]) <= TOL_POS]
                    if not near:
                        fails.append(f"p{pi+1}: non-dialogue span not found in place: {sp['text'][:30]!r}")
                    continue
                m = min(cands, key=lambda t: abs(t["x0"] - sp["x0"]))
                if abs(m["x0"] - sp["x0"]) > TOL_POS or abs(m["y"] - sp["y"]) > TOL_POS:
                    fails.append(f"p{pi+1}: non-dialogue moved {sp['text'][:30]!r} "
                                 f"dx={m['x0']-sp['x0']:.2f} dy={m['y']-sp['y']:.2f}")
                if abs(m["size"] - sp["size"]) > 0.05:
                    fails.append(f"p{pi+1}: non-dialogue resized {sp['text'][:30]!r} "
                                 f"{sp['size']:.2f}->{m['size']:.2f}")

        # --- (c2) kerning fidelity: word gaps must scale uniformly. On
        # word-per-op / glyph-per-op PDFs a per-run anchor would leave gaps
        # at original size while glyphs grow — this catches that regression.
        # Applies in page mode too (dialogue lines, uniform about the anchor).
        if applied is not None and applied > 1.001:
            bwords = b[pi].get_text("words")
            awords = a[pi].get_text("words")
            brot, arot = rot_ids(b[pi]), rot_ids(a[pi])
            # burn-in signal-2 stamps sit on body baselines but are not body
            # text: they leave every word-level check, like rotated words
            bburn = burn_spans_cached(b)[pi]["boxes"]
            for L in blines:
                if mode == "page":
                    if L.get("cls") != "dialogue":
                        continue
                elif not line_enlarged(L):
                    continue
                bw = sorted(w for w in bwords if abs(w[3] - L["y"]) <= 5.0 and w[0] < marginStart and not_rotated(w, brot)
                            and not (bburn and in_burn(w, bburn)))
                aw = sorted(w for w in awords if abs(w[3] - L["y"]) <= 5.0 and w[0] < marginStart and not_rotated(w, arot)
                            and not (bburn and in_burn(w, bburn)))
                if len(bw) < 2:
                    continue
                if len(aw) != len(bw):
                    if "".join(w[4] for w in bw) == "".join(w[4] for w in aw):
                        gap_bad.append(f"p{pi+1}: words merged/re-split after enlargement at y={L['y']:.1f}")
                    continue
                for k in range(len(bw) - 1):
                    bgap = bw[k + 1][0] - bw[k][2]
                    agap = aw[k + 1][0] - aw[k][2]
                    if abs(agap - applied * bgap) > 1.2:
                        gap_bad.append(f"p{pi+1}: gap {bw[k][4]!r}->{bw[k+1][4]!r} "
                                       f"{bgap:.2f} -> {agap:.2f} (expected {applied*bgap:.2f})")

        if mode == "page":
            # --- (e) whole-page "all bigger": body text grows s about the
            # page anchor on its own UNMOVED baseline; margin marks (left
            # scene numbers, revision stars, page numbers) stay put exactly.
            # Word-level positions (words never merge across the mark
            # boundary and carry no space-bbox noise); span-level sizes.
            # Pages without dialogue (title/coverage/call sheets) must not
            # be enlarged at all.
            if s_eff > 1.001 and not any(L.get("cls") == "dialogue" for L in blines):
                fails.append(f"p{pi+1}: page without dialogue was enlarged "
                             f"(coverage/call-sheet/title pages must stay untouched)")
            furn_ys = [L["y"] for L in blines if L.get("furn")]

            def near_furn(y):
                return any(abs(y - fy) <= 5.0 for fy in furn_ys)

            bwords_e = b[pi].get_text("words")
            awords_e = a[pi].get_text("words")
            greys_e = grey_boxes(b[pi])
            brot_e = rot_ids(b[pi])
            bburn_e = burn_spans_cached(b)[pi]["boxes"]
            for w in bwords_e:
                if not w[4].strip():
                    continue
                # grey-shaded (omitted) words and rotated watermark words are
                # excluded from enlargement: they stay put exactly, like marks
                is_fixed = (w[0] >= marginStart or w[2] <= 70 or near_furn(w[3])
                            or (greys_e and in_grey((w[0] + w[2]) / 2, w[3] - 3, greys_e))
                            or (brot_e and not not_rotated(w, brot_e))
                            or (bburn_e and in_burn(w, bburn_e)))
                ex0 = w[0] if (is_fixed or s_eff <= 1.001) else anchor + s_eff * (w[0] - anchor)
                tol = 0.7 if is_fixed else 1.5
                m = [t for t in awords_e if t[4] == w[4]
                     and abs(t[3] - w[3]) <= 1.5 and abs(t[0] - ex0) <= tol]
                if not m:
                    kind = "fixed row/mark" if is_fixed else "body word"
                    fails.append(f"p{pi+1}: {kind} not at expected x={ex0:.1f} "
                                 f"(y={w[3]:.1f}): {w[4][:20]!r}")
            for L in blines:
                s_line = 1.0 if L.get("furn") else s_eff
                for sp in L["spans"]:
                    if sp["x1"] <= 70 or sp["x0"] >= marginStart:
                        continue  # pure margin mark: position covered above
                    # body portion of this span, mapped
                    bx0 = max(sp["x0"], 70)
                    bx1 = min(sp["x1"], marginStart)
                    if bx1 - bx0 < 4:
                        continue
                    exp_size = sp["size"] if s_line <= 1.001 else s_line * sp["size"]
                    win0 = bx0 if s_line <= 1.001 else anchor + s_line * (bx0 - anchor)
                    win1 = bx1 if s_line <= 1.001 else anchor + s_line * (bx1 - anchor)
                    # judge by the candidate covering most of the window: a
                    # margin-mark span (leading-space bbox) can sit inside the
                    # mapped body window without owning it
                    best, best_ov = None, 2.0
                    for t in aspans:
                        if abs(t["y"] - sp["y"]) > 1.0:
                            continue
                        ov = min(t["x1"], win1) - max(t["x0"], win0)
                        if ov > best_ov:
                            best, best_ov = t, ov
                    if best is None:
                        continue  # presence is asserted by the word check
                    r = best["size"] / sp["size"]
                    ratios.append(r)
                    if abs(best["size"] - exp_size) > 0.05 * exp_size:
                        fails.append(f"p{pi+1}: body size {r:.3f}x != {s_line}x at y={sp['y']:.1f}: "
                                     f"{sp['text'][:20]!r}")
        else:
            # --- (c) enlarged dialogue: line-level scale + unmoved baseline.
            for L in blines:
                if not line_enlarged(L):
                    continue
                bsize = statistics.median([s["size"] for s in L["spans"] if s["x0"] < marginStart] or [s["size"] for s in L["spans"]])
                # after spans sharing this baseline, excluding margin marks
                same = [t for t in aspans if abs(t["y"] - L["y"]) <= 1.0 and t["x0"] < marginStart]
                if not same:
                    fails.append(f"p{pi+1}: dialogue baseline vanished at y={L['y']:.1f}: {L['text'][:30]!r}")
                    continue
                asize = statistics.median([t["size"] for t in same])
                r = asize / bsize
                ratios.append(r)
                if applied is not None and abs(r - applied) > 0.03:
                    fails.append(f"p{pi+1}: dialogue scale {r:.3f} != applied {applied} at y={L['y']:.1f}")

        # off-page check
        pw = a[pi].rect.width
        for L in alines:
            if L["x1"] > pw - 3 or L["x0"] < 3:
                fails.append(f"p{pi+1}: text off page edge x0={L['x0']:.0f} x1={L['x1']:.0f}: {L['text'][:30]!r}")

        # --- (d) highlights: rects land on the assigned character's blocks
        # (cue + parentheticals + dialogue), cover every word of them, and
        # never touch anyone else's text.
        if hl:
            rects_by_name = {}
            for d in a[pi].get_drawings():
                f = d.get("fill")
                if not f:
                    continue
                for name, info in hl.items():
                    rgb = info["rgb"]
                    if all(abs(f[j] - rgb[j]) < 0.02 for j in range(3)):
                        rects_by_name.setdefault(name, []).append(d["rect"])
            # rotated watermark words (a full-page diagonal stamp crosses every
            # block) are not body text: never demand them inside a highlight
            arot_hl = rot_ids(a[pi])
            awords = [w for w in a[pi].get_text("words") if not_rotated(w, arot_hl)]
            wcut = marginStart
            for name, info in hl.items():
                myblocks = [B for B in blocks if B["name"] == name
                            and any(l.get("cls") == "dialogue" for l in B["lines"])]
                rects = rects_by_name.get(name, [])
                if len(rects) != len(myblocks):
                    fails.append(f"p{pi+1}: highlight {name!r}: {len(myblocks)} blocks vs {len(rects)} rects")
                mine = set()
                for B in myblocks:
                    blk_lines = [B["cue"]] + B["lines"]
                    mine.update(id(L) for L in blk_lines)
                    ys = [ymap(L) for L in blk_lines]
                    cover = next((r for r in rects if all(r.y0 <= yy <= r.y1 for yy in ys)), None)
                    if cover is None:
                        fails.append(f"p{pi+1}: highlight {name!r}: block at y={ys[0]:.0f} has no covering rect")
                        continue
                    for L in blk_lines:
                        ey = ymap(L)
                        for w in awords:
                            if abs(w[3] - ey) <= 5.0 and w[0] < wcut:
                                if w[0] < cover.x0 - 1 or w[2] > cover.x1 + 1:
                                    fails.append(f"p{pi+1}: highlight {name!r}: word {w[4]!r} "
                                                 f"outside rect at y={ey:.0f}")
                for r in rects:
                    for L in blines:
                        if id(L) in mine:
                            continue
                        ey = ymap(L)
                        if not (r.y0 + 2 < ey < r.y1 - 2):
                            continue
                        fx0, fx1 = xspan(L)
                        if fx1 > r.x0 + 2 and fx0 < r.x1 - 2:
                            fails.append(f"p{pi+1}: highlight {name!r} rect covers foreign line "
                                         f"{L['text'][:30]!r} at y={ey:.0f}")

    if len(gap_bad) > 2:
        fails.append(f"kerning: {len(gap_bad)} word gaps deviate from uniform scaling")
        fails.extend("  " + g for g in gap_bad[:8])

    med = statistics.median(ratios) if ratios else 0
    notes.append(f"dialogue lines checked: {len(ratios)}, median size ratio {med:.3f}")
    requested = report["requestedScale"] if report else 1.25
    backoffs = [p for p in (report["pages"] if report else []) if p["appliedScale"] < requested - 0.005]
    # Only require real enlargement when the user actually asked for it (>1.05x).
    if requested > 1.05 and ratios and med < min(1.2, requested - 0.03) and not backoffs:
        fails.append(f"median dialogue ratio {med:.3f} < 1.2 with no reported back-off")
    if backoffs:
        notes.append("reported back-off pages: " + ", ".join(f"p{p['page']}={p['appliedScale']}" for p in backoffs))

    # 4. side-by-side renders
    import os
    outdir = os.environ.get("CHECK_RENDER_DIR") or os.path.dirname(after_path) or "."
    os.makedirs(outdir, exist_ok=True)
    for pi in range(len(b)):
        pb = b[pi].get_pixmap(dpi=110)
        pa = a[pi].get_pixmap(dpi=110)
        W = pb.width + pa.width + 12
        H = max(pb.height, pa.height)
        combo = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, W, H))
        combo.clear_with(90)
        combo.copy(pb, fitz.IRect(0, 0, pb.width, pb.height))
        pa.set_origin(pb.width + 12, 0)
        combo.copy(pa, fitz.IRect(pb.width + 12, 0, pb.width + 12 + pa.width, pa.height))
        fn = os.path.join(outdir, f"compare_p{pi+1:02d}.png")
        combo.save(fn)
    notes.append(f"side-by-side renders: {outdir}/compare_pNN.png")

    report_and_exit(fails, notes)


def report_and_exit(fails, notes):
    for n in notes:
        print("NOTE:", n)
    if fails:
        print(f"\nFAIL ({len(fails)} problems)")
        for f in fails[:40]:
            print("  -", f)
        sys.exit(1)
    print("\nPASS: page parity, non-dialogue positions, dialogue scaling all verified")
    sys.exit(0)


if __name__ == "__main__":
    main()
