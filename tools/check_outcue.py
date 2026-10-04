#!/usr/bin/env python3
"""Verify the outcue underline in a Reader-mode PDF (v1.17.0).

Usage: python3 tools/check_outcue.py <elements.json> <reader.pdf> <words> [style]
       style = underline (default) | bold | both

The engine marks the last <words> words of every speech in Reader mode with
an underline, bold type, or both. This script checks that independently of
the renderer: it rebuilds the speeches from the element stream (the JSON that
run_engine_node.mjs writes with --emit=elements), works out which words should
be marked, then reads the marks back out of the PDF (underlines from the
drawings, matched to the words beneath them; bold from the font of each span
at body size, which keeps the bold scene headings out of it). It passes when
the lists agree exactly: every expected word carries the mark(s) asked for,
no other word does, no underline floats free, and a mark that was NOT asked
for appears nowhere.

Vocabulary: a "speech" is everything one character says before another
character speaks. Dialogue by the same speaker with no other speaker's cue
or dialogue in between is ONE speech, across parentheticals, page breaks,
action lines and a (CONT'D) cue; a new scene heading ends it. That is the
rule Sides Helper's CueSheet uses, mirrored here so the app and the PDF
underline the same five words. Parentheticals never count as words.
Exit code 0 = pass, 1 = fail (with the reasons printed).
"""
import json
import sys

import fitz  # pymupdf


def speeches(els, n):
    """The outcue (last n words) of every speech in element order."""
    def is_speech(e):
        return e["t"] in ("dialogue", "cue", "paren")

    def extend(k, name, step):
        edge, j = k, k + step
        while 0 <= j < len(els):
            e = els[j]
            if is_speech(e):
                if (e.get("name") or "") == name:
                    edge = j
                elif e["t"] in ("cue", "dialogue"):
                    break
            elif e["t"] == "slug":
                break
            j += step
        return edge

    out, seen = [], set()
    for i, e in enumerate(els):
        if e["t"] != "dialogue" or i in seen:
            continue
        name = e.get("name") or ""
        first, last = extend(i, name, -1), extend(i, name, 1)
        words = []
        for j in range(first, last + 1):
            if els[j]["t"] == "dialogue" and (els[j].get("name") or "") == name:
                seen.add(j)
                words += els[j]["text"].split()
        out.append(words[-n:] if len(words) > n else words)
    return out


def underlined_words(doc):
    """Words in the PDF that have a thin black line just under them, plus the
    number of such lines that sit under no word at all."""
    got, stray = [], 0
    for page in doc:
        words = page.get_text("words")  # x0, y0, x1, y1, text, ...
        for d in page.get_drawings():
            col, width = d.get("color"), d.get("width") or 0
            if col is None or max(col) > 0.05 or width > 2.5:
                continue  # not a black hairline: break rules are gray, the scene rule is thick
            for it in d["items"]:
                if it[0] != "l":
                    continue
                p1, p2 = it[1], it[2]
                if abs(p1.y - p2.y) > 0.5:
                    continue
                x0, x1, yy = min(p1.x, p2.x), max(p1.x, p2.x), p1.y
                # the line sits in the lower half of the word's box or just under it
                # (it is drawn below the descenders, about a quarter of the type size
                # under the baseline)
                hit = [w for w in words
                       if w[0] < x1 - 0.5 and w[2] > x0 + 0.5 and (w[1] + 0.5 * (w[3] - w[1])) <= yy <= w[3] + 3.5]
                if not hit:
                    stray += 1
                got += [w[4] for w in hit]
    return got, stray


def bold_words(doc):
    """Words set in the bold face at the body text size. Scene headings are
    bold too, but a touch larger (1.02x), so the size keeps them out; the
    body size is the most common size of the roman spans."""
    from collections import Counter
    spans = [sp for page in doc for b in page.get_text("dict")["blocks"]
             for l in b.get("lines", []) for sp in l["spans"] if sp["text"].strip()]
    roman = Counter(round(sp["size"], 1) for sp in spans
                    if "Bold" not in sp["font"] and "Italic" not in sp["font"] and sp["size"] >= 10)
    if not roman:
        return []
    body = roman.most_common(1)[0][0]
    return [w for sp in spans if "Bold" in sp["font"] and abs(sp["size"] - body) < 0.05
            for w in sp["text"].split()]


def compare(label, got, exp_tokens, fails):
    if sorted(got) != exp_tokens:
        missing = sorted(set(exp_tokens) - set(got))[:6]
        extra = sorted(set(got) - set(exp_tokens))[:6]
        fails.append(f"{label} words differ: expected {len(exp_tokens)}, got {len(got)}; "
                     f"missing {missing}; unexpected {extra}")


def main():
    els_path, pdf_path, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
    style = sys.argv[4] if len(sys.argv) > 4 else "underline"
    want_u, want_b = style in ("underline", "both"), style in ("bold", "both")
    els = json.load(open(els_path, encoding="utf-8"))["elements"]
    expected = speeches(els, n)
    exp_tokens = sorted(w for oc in expected for w in oc)
    doc = fitz.open(pdf_path)
    got_u, stray = underlined_words(doc)
    got_b = bold_words(doc)
    fails = []
    if not expected:
        fails.append("no speeches found in the element stream")
    if stray:
        fails.append(f"{stray} underline(s) sit under no word")
    compare("underlined", got_u, exp_tokens if want_u else [], fails)
    compare("bold", got_b, exp_tokens if want_b else [], fails)
    short = sum(1 for oc in expected if len(oc) < n)
    if fails:
        for f in fails:
            print("      - " + f)
        sys.exit(1)
    print(f"      outcue ({style}): {len(expected)} speeches, {len(exp_tokens)} marked words "
          f"({short} short speeches marked whole)")


if __name__ == "__main__":
    main()
