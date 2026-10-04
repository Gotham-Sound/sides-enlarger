#!/usr/bin/env python3
"""Verify the outcue underline in a Reader-mode PDF (v1.17.0).

Usage: python3 tools/check_outcue.py <elements.json> <reader.pdf> <words>

The engine underlines the last <words> words of every speech in Reader mode.
This script checks that independently of the renderer: it rebuilds the
speeches from the element stream (the JSON that run_engine_node.mjs writes
with --emit=elements), works out which words should be underlined, then reads
the underlines back out of the PDF's drawings and matches them to the words
beneath them. It passes when the two lists agree exactly: every expected
word carries an underline, no other word does, and no underline floats free.

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


def main():
    els_path, pdf_path, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
    els = json.load(open(els_path, encoding="utf-8"))["elements"]
    expected = speeches(els, n)
    exp_tokens = sorted(w for oc in expected for w in oc)
    got, stray = underlined_words(fitz.open(pdf_path))
    fails = []
    if not expected:
        fails.append("no speeches found in the element stream")
    if stray:
        fails.append(f"{stray} underline(s) sit under no word")
    if sorted(got) != exp_tokens:
        missing = sorted(set(exp_tokens) - set(got))[:6]
        extra = sorted(set(got) - set(exp_tokens))[:6]
        fails.append(f"underlined words differ: expected {len(exp_tokens)}, got {len(got)}; "
                     f"missing {missing}; unexpected {extra}")
    short = sum(1 for oc in expected if len(oc) < n)
    if fails:
        for f in fails:
            print("      - " + f)
        sys.exit(1)
    print(f"      outcue: {len(expected)} speeches, {len(exp_tokens)} underlined words "
          f"({short} short speeches marked whole)")


if __name__ == "__main__":
    main()
