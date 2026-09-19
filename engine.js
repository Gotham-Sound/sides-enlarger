/* Sides Enlarger core engine.
 * Runs in browser and Node. Dependencies injected: { pdfjsLib, PDFLib }.
 *
 * Pipeline:
 *  A) pdf.js text extraction -> per-document geometric calibration
 *     (cue / dialogue / parenthetical x-bands) -> per-line classification.
 *  B) pdf-lib content-stream rewrite: dialogue text runs get a scaled text
 *     matrix anchored on their own baseline; everything else is emitted
 *     byte-for-byte untouched. Page-for-page parity is structural: nothing
 *     ever moves vertically, so nothing can reflow.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.createSidesEngine = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ---------- small stats helpers ----------
  const median = a => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const quantile = (a, q) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const fmt = n => {
    const r = Math.round(n * 1000) / 1000;
    return Object.is(r, -0) ? '0' : String(r);
  };

  // ---------- matrices (PDF order: [a b c d e f]) ----------
  const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  // ---------- phase A: extraction + classification ----------
  const LEAD = 12, EDGE = 14; // pts: nominal leading, min page margin kept

  function buildLines(items) {
    // cluster text items into visual lines by baseline y
    const sorted = [...items].sort((p, q) => q.y - p.y || p.x - q.x);
    const lines = [];
    for (const it of sorted) {
      const L = lines[lines.length - 1];
      if (L && Math.abs(L.y - it.y) <= 2.0) L.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    for (const L of lines) {
      L.items.sort((p, q) => p.x - q.x);
      // double-struck "bold" (the same string drawn twice in place) reads once
      L.items = L.items.filter((it, i) => {
        const p = L.items[i - 1];
        return !(p && p.str === it.str && Math.abs(p.x - it.x) < 1.2);
      });
      L.y = median(L.items.map(i => i.y));
      L.x0 = L.items[0].x;
      L.x1 = Math.max(...L.items.map(i => i.x + i.w));
      // segments: item clusters split at horizontal gaps > 40pt (dual dialogue).
      // Join item text with a space only across a real word-sized gap:
      // glyph-per-item PDFs abut (gap ~0) and must not become "R U M A".
      L.segments = [];
      for (const it of L.items) {
        const S = L.segments[L.segments.length - 1];
        if (S && it.x - S.x1 <= 40) {
          const gap = it.x - S.x1;
          const wordGap = Math.max(1.5, 0.25 * (it.size || 12));
          S.items.push(it); S.x1 = Math.max(S.x1, it.x + it.w);
          S.text += (gap > wordGap ? ' ' : '') + it.str;
        }
        else L.segments.push({ x0: it.x, x1: it.x + it.w, items: [it], text: it.str });
      }
      L.text = L.segments.map(s => s.text).join('   ');
    }
    return lines;
  }

  const capsy = t => {
    const letters = (t || '').replace(/[^A-Za-z]/g, '');
    return letters.length >= 2 && letters === letters.toUpperCase();
  };
  // A cue may carry revision marks in the far-right margin ("TRACY  *"):
  // those margin segments must not disqualify it. pageW=0 keeps the strict
  // single-segment rule (calibration's first pass has no page context).
  const isCueLine = (L, band, pageW) => {
    const segs = pageW
      ? L.segments.filter(sg => sg.x0 < pageW - 80)
      : L.segments;
    if (segs.length !== 1 || segs[0] !== L.segments[0]) return false;
    const text = segs[0].text;
    return capsy(text) && text.trim().length <= 42 &&
      L.x0 >= band[0] && L.x0 <= band[1] &&
      !/\b(INT|EXT)\s*[.\/]/.test(text) &&
      !/(CUT TO|FADE (IN|OUT)|DISSOLVE)/.test(text);
  };

  // A line's type size: the median of its items' sizes (glyph-per-op PDFs
  // carry one size per glyph). Script body text is one size throughout a
  // document; call sheets, coverage grids and revision tables are small type.
  const lineSize = L => median(L.items.map(it => it.size || 0));

  function calibrate(pages) {
    const CUE_BAND = [200, 340]; // 2.8"–4.7" initial guess, then refined
    const cueXs = [];
    for (const P of pages) for (const L of P.lines) if (isCueLine(L, CUE_BAND, P.width)) cueXs.push(L.x0);
    if (cueXs.length < 2) return null;
    const cueX = median(cueXs);
    // the script's type size, from the cue lines (median, like the x bands).
    // A candidate more than a quarter off it is not script: a call sheet's
    // caps row at the cue x with a note beneath it at the dialogue x reads
    // exactly like a cue block by position, but at 5-7pt against 12pt body
    // text. Never an absolute size: sides get photocopied and re-scaled.
    const cueSizes = [];
    for (const P of pages) for (const L of P.lines) if (isCueLine(L, [cueX - 12, cueX + 12], P.width)) cueSizes.push(lineSize(L));
    const cueSize = cueSizes.length ? median(cueSizes) : 0;
    const typeOk = L => !cueSize || Math.abs(lineSize(L) - cueSize) <= 0.25 * cueSize;
    // dialogue x0: lines directly below a cue, indented left of it.
    // Skip parentheticals (they sit in their own column) and take the median,
    // not the mode: per-page photocopy drift clusters samples per page, and a
    // mode would lock onto one page's drift instead of the document center.
    const dialXs = [];
    for (const P of pages) {
      for (let i = 0; i < P.lines.length; i++) {
        if (!typeOk(P.lines[i]) || !isCueLine(P.lines[i], [cueX - 12, cueX + 12], P.width)) continue;
        const nxt = P.lines[i + 1];
        if (nxt && typeOk(nxt) && P.lines[i].y - nxt.y < 3 * LEAD && !/^\(/.test(nxt.text.trim()) &&
            nxt.x0 > cueX - 130 && nxt.x0 < cueX - 30) dialXs.push(nxt.x0);
      }
    }
    const dialX = dialXs.length ? median(dialXs) : cueX - 86;
    const parenXs = [];
    for (const P of pages) for (const L of P.lines)
      if (/^\(/.test(L.text.trim()) && L.x0 > dialX + 6 && L.x0 < dialX + 70) parenXs.push(L.x0);
    const parenX = parenXs.length ? median(parenXs) : dialX + 43;
    return { cueX, dialX, parenX, cueSize };
  }

  // ---------- scriptparse policy interpreter (identity as policy-as-data) ----------
  // JS mirror of the hub's Python reference interpreter (scriptparse/policy.py
  // plus the pure helpers in scriptparse/build_matrix.py), driven ONLY by the
  // injected policy.json (lists, maps and scalars: no regex ships in the data;
  // the regexes below are this interpreter's implementation details, exactly
  // as they are in the Python reference). Pinned by the hub's conformance
  // corpus: tools/conformance_check.mjs must stay green on every vector file
  // this bench consumes. Identity RULINGS live in the hub; this bench
  // interprets, never decides (federation Phase 1, scriptparse #40 / #83).
  function compilePolicy(policy) {
    if (!policy || typeof policy !== 'object' || typeof policy.policy_version !== 'string') {
      throw new Error('createSidesEngine: the scriptparse policy.json object is required ({ pdfjsLib, PDFLib, policy })');
    }
    const esc = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const canonTag = t => String(t).replace(/\./g, '').replace(/\s+/g, ' ').trim().toUpperCase();
    const upperNorm = x => String(x || '').trim().replace(/\s+/g, ' ').toUpperCase();
    const stripTrailingPunct = x => x.replace(/[.:]+$/, '').trim();
    const cpLen = x => Array.from(x).length;
    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const standard = new Set((policy.standard_tags || []).map(canonTag));
    const channelTags = new Set((policy.channel_tags || []).map(canonTag));
    const possessive = new Set(policy.possessive_channel_nouns || []);
    const kinds = new Map(Object.keys(policy.channel_kinds || {}).map(k => [canonTag(k), policy.channel_kinds[k]]));
    const kindDefault = policy.channel_kind_default || 'unknown';
    const marker = policy.numbered_part_marker != null ? String(policy.numbered_part_marker) : '#';
    const markerRe = marker ? new RegExp(esc(marker) + '\\d') : null;
    const numberedTailRe = marker ? new RegExp(esc(marker) + '\\d+$') : null;
    const nonCharacter = new Set(policy.transitions_non_character || []);
    const stopWords = new Set(policy.cue_stop_words || []);
    const rejectTrailing = (policy.cue_reject_trailing || ['-']).map(String);
    const suffixes = new Set((policy.name_suffixes || []).map(x => String(x).replace(/\./g, '').toUpperCase()));
    const numWords = policy.furniture_numbered_words || [], numberWords = policy.furniture_number_words || [];
    // rule type 'numbered-furniture': <word> + (digits, optional letter, optional marker prefix | number word)
    const furnitureRe = numWords.length
      ? new RegExp('^(?:' + numWords.map(esc).join('|') + ')\\s+(?:' + (marker ? esc(marker) + '?' : '') + '\\d+[A-Z]?'
        + (numberWords.length ? '|' + numberWords.map(esc).join('|') : '') + ')$')
      : /(?!)/;
    const TRAILING_PAREN = /\s*\(([^()]*)\)\s*$/;
    const POSSESSIVE = /^(.+?)['’]S\s+([A-Z]+)$/;
    const SUFFIX_TAIL = /,\s*([A-Z][A-Z.]*)$/;
    const PAGE_TOKEN = /^[A-Z]?\d+[A-Z]?\.$/;

    // normalize_text / norm_cue: the SEATING layer (what a printed cue line
    // becomes before it can enter a character list)
    const normalizeText = x => {
      let t = String(x || '').trim();
      t = t.replace(/[“”"]/g, '').replace(/[’‘]/g, "'");
      t = t.replace(/\[[^\]]+\]/g, '').replace(/\([^)]*\)/g, '');
      return t.replace(/\s+/g, ' ').trim();
    };
    const normCue = raw => {
      const t = stripTrailingPunct(normalizeText(raw).toUpperCase());
      const out = [];
      for (const w of t.split(/\s+/)) if (w && (!out.length || out[out.length - 1] !== w)) out.push(w);
      return out.join(' ');
    };

    // fold / part_of / parts / fold_candidates: the DERIVATION layer (raw
    // occurrence strings in; trailing [.:] canonicalized like seating, #79)
    const ident = name => ({ base: name, channel: null, tier: null, kind: null });
    const kindOf = ch => (kinds.has(canonTag(ch)) ? kinds.get(canonTag(ch)) : kindDefault);
    const fold = printed => {
      const name = stripTrailingPunct(upperNorm(printed));
      if (!name) return ident(name);
      if (markerRe && markerRe.test(name)) return ident(name); // numbered parts never fold
      let base = name, channel = null, sawStandard = false;
      for (;;) {
        const m = TRAILING_PAREN.exec(base);
        if (!m) break;
        const tag = canonTag(m[1]);
        if (standard.has(tag)) { sawStandard = true; base = base.slice(0, m.index).replace(/\s+$/, ''); }
        else if (channelTags.has(tag) && channel === null) { channel = tag; base = base.slice(0, m.index).replace(/\s+$/, ''); }
        else return ident(name); // unknown (or second channel) parenthetical: not a recognized variant
      }
      if (channel === null) {
        const pm = POSSESSIVE.exec(base);
        if (pm && possessive.has(pm[2])) return { base: pm[1].trim(), channel: pm[2], tier: 'channel', kind: kindOf(pm[2]) };
      }
      if (channel !== null) return { base, channel, tier: 'channel', kind: kindOf(channel) };
      if (sawStandard && base !== name) return { base, channel: null, tier: 'standard', kind: null };
      return ident(name);
    };
    const partOf = (cue, aliases) => {
      const name = stripTrailingPunct(upperNorm(cue));
      if (aliases && hasOwn(aliases, name) && aliases[name]) return upperNorm(aliases[name]);
      const f = fold(name);
      return (f.tier === 'standard' || f.tier === 'channel') ? f.base : name;
    };
    const foldCandidates = names => {
      const out = [];
      for (const n of (names || [])) {
        const f = fold(n);
        if (f.tier === 'channel' && f.base && f.base !== n) out.push({ from: n, into: f.base, channel: f.channel, tier: 'channel', kind: f.kind });
      }
      return out;
    };
    const nv = v => (v === undefined ? null : v);
    const parts = (parse, aliases) => {
      const map = {};
      for (const sc of ((parse && parse.scenes) || [])) {
        for (const o of (sc.cues || [])) {
          const raw = o.raw !== undefined ? o.raw : (o.character !== undefined ? o.character : '');
          const pid = partOf(raw, aliases);
          const a = o.anchor || null;
          if (!hasOwn(map, pid)) map[pid] = [];
          map[pid].push({ cue_string: o.raw !== undefined ? o.raw : '', source_doc: a ? nv(a.source_doc) : null,
            page: a ? nv(a.page) : null, anchor: (a && Object.keys(a).length) ? a : null, scene: nv(sc.scene) });
        }
      }
      return map;
    };

    // the cue GATE: semantic (stop words, furniture, trailing glyphs, size)
    // and charset (strict class after the two ruled trailing admissions)
    const stripAdmitted = cue => {
      let c = cue;
      const m = SUFFIX_TAIL.exec(c);
      if (m && suffixes.has(m[1].replace(/\./g, ''))) c = c.slice(0, m.index).replace(/\s+$/, '');
      if (numberedTailRe) c = c.replace(numberedTailRe, '');
      return c.replace(/\s+$/, '');
    };
    const cueCharsetOk = cue => { const rest = stripAdmitted(String(cue || '')); return !!rest && /^[A-Z0-9 .'\-]+$/.test(rest); };
    const cueSemanticOk = cue => {
      cue = String(cue || '');
      if (!cue || nonCharacter.has(cue) || furnitureRe.test(cue)) return false;
      if (rejectTrailing.some(g => g && cue.endsWith(g))) return false;
      if (cpLen(cue) < 2) return false;
      const words = cue.split(/\s+/).filter(Boolean);
      if (words.length < 1 || words.length > 4) return false;
      if (words.length >= 2 && words.some(w => stopWords.has(w))) return false;
      if (cpLen(cue) > 30) return false;
      return true;
    };
    const cueGateOk = cue => cueSemanticOk(cue) && cueCharsetOk(cue);
    // why a name failed the gate (this bench's never-silent rail; vocabulary
    // follows the hub's classify_cue_reject reasons)
    const cueRejectReason = cue => {
      cue = String(cue || '');
      if (!cue) return 'empty';
      if (nonCharacter.has(cue)) return 'transition/furniture';
      if (furnitureRe.test(cue)) return 'numbered furniture';
      const tg = rejectTrailing.find(g => g && cue.endsWith(g));
      if (tg) return "trailing '" + tg + "'";
      if (cpLen(cue) < 2) return 'single glyph';
      const words = cue.split(/\s+/).filter(Boolean);
      if (words.length > 4) return 'wide (' + words.length + ' words)';
      const sw = words.length >= 2 ? words.find(w => stopWords.has(w)) : undefined;
      if (sw) return "word '" + sw + "'";
      if (cpLen(cue) > 30) return 'long (' + cpLen(cue) + ' chars)';
      const rest = stripAdmitted(cue);
      if (!rest) return 'charset (nothing left after the admitted shapes)';
      const bad = Array.from(rest).find(ch => !/[A-Z0-9 .'\-]/.test(ch));
      if (bad !== undefined) return "charset '" + bad + "'";
      return null;
    };

    // split_dual_header (issue #69): words = [[text, x0, x1], ...] in x order
    const splitDualHeader = words => {
      const minGap = (policy.dual_dialogue && policy.dual_dialogue.min_gap_pt != null) ? policy.dual_dialogue.min_gap_pt : 40;
      if (!words || words.length < 2) return null;
      const wide = [];
      for (let k = 0; k < words.length - 1; k++) if (words[k + 1][1] - words[k][2] > minGap) wide.push(k);
      if (wide.length !== 1) return null;
      const k = wide[0], lw = words.slice(0, k + 1), rw = words.slice(k + 1);
      const left = lw.map(w => w[0]).join(' ').trim(), right = rw.map(w => w[0]).join(' ').trim();
      for (const half of [left, right]) {
        if (half.endsWith(':')) return null; // raw colon-terminated halves are list labels
        const cue = normCue(half);
        if (!cue || !cueSemanticOk(cue) || !cueCharsetOk(cue)) return null;
      }
      return [left, right, (lw[0][1] + rw[0][1]) / 2];
    };

    // burn-in signal 2 arithmetic (issue #16): words carry {text, x0, x1,
    // bottom, top} in top-left extractor space; the cell flips to spec 3.5
    // anchor space here, at the boundary, with floor as the pinned quantizer
    const burn = policy.burn_in || {};
    const grid = burn.repeat_grid_pt != null ? burn.repeat_grid_pt : 24;
    const wordCell = (w, pageHeight, g) => { const G = g || grid; return [Math.floor(w.x0 / G), Math.floor((pageHeight - w.bottom) / G)]; };
    const repeatThreshold = n => Math.max(burn.repeat_min_pages != null ? burn.repeat_min_pages : 4,
      Math.ceil(n * (burn.repeat_page_fraction != null ? burn.repeat_page_fraction : 0.5)));
    const detectRepeatedBurnin = (pagesWords, pageHeights) => {
      const threshold = repeatThreshold(pagesWords.length);
      const keyOf = (w, h) => { const c = wordCell(w, h); return JSON.stringify([String(w.text).trim(), c[0], c[1]]); };
      const seenOn = new Map();
      pagesWords.forEach((words, pi) => {
        const h = pageHeights[pi];
        for (const w of words) { const k = keyOf(w, h); let st = seenOn.get(k); if (!st) seenOn.set(k, st = new Set()); st.add(pi); }
      });
      const repeated = new Set();
      for (const [k, st] of seenOn) if (st.size >= threshold) repeated.add(k);
      return pagesWords.map((words, pi) => {
        const h = pageHeights[pi];
        const groups = new Map();
        words.forEach((w, wi) => {
          if (!repeated.has(keyOf(w, h))) return;
          const yb = wordCell(w, h)[1];
          let g = groups.get(yb); if (!g) groups.set(yb, g = []); g.push(wi);
        });
        const drop = new Set();
        for (const [yb, wis] of groups) {
          let rightmost = null;
          for (const w of words) if (wordCell(w, h)[1] === yb && (rightmost === null || w.x0 > rightmost.x0)) rightmost = w;
          if (rightmost && PAGE_TOKEN.test(String(rightmost.text).trim())) continue; // running header, never burn-in
          const joined = wis.slice().sort((a, b) => words[a].x0 - words[b].x0).map(i => String(words[i].text)).join(' ');
          if (/[a-z]/.test(joined)) for (const i of wis) drop.add(i);
        }
        return Array.from(drop).sort((a, b) => a - b);
      });
    };
    return { version: policy.policy_version, data: policy, normalizeText, normCue, fold, foldCandidates, partOf, parts,
      cueCharsetOk, cueSemanticOk, cueGateOk, cueRejectReason, splitDualHeader, wordCell, repeatThreshold, detectRepeatedBurnin };
  }
  // The compiled policy for this engine instance (set by createSidesEngine).
  let POL = null;
  const pol = () => { if (!POL) throw new Error('scriptparse policy not compiled: construct the engine with createSidesEngine({ pdfjsLib, PDFLib, policy })'); return POL; };

  // ---------- character extraction ----------
  // A cue like "SAM", "SAM (CONT'D)", "SAM (V.O.) *" is all one character: SAM.
  // Identity is the hub's seating layer (norm_cue: parentheticals and brackets
  // stripped, trailing [.:] stripped, adjacent duplicate words collapsed,
  // uppercase) after the LOCAL revision-mark strip: `*` glyphs are margin
  // furniture that clusters onto cue lines, and both engines hard-code '*'
  // pending scriptparse #25. Used everywhere a name is compared (blocks,
  // highlights, enlargeOnly, .sceneline reconcile).
  function normalizeCueName(text) { return pol().normCue(String(text || '').replace(/\*/g, ' ')); }
  // The shared name gate (semantic + charset) on the normalized name. What it
  // rails is never silent: see collectRejectedCues.
  const cueGateOk = n => !!n && pol().cueGateOk(n);

  // Aggregate cue-led blocks (built by classifyPage) into unique character
  // names with dialogue-line counts. The dialogue-follow requirement (a block
  // must contain at least one dialogue line) is the noise filter: shouted
  // action and INSERT/CHYRON labels never have a dialogue block under them.
  function collectCharacters(pages) {
    const map = new Map();
    const get = name => {
      let e = map.get(name);
      if (!e) map.set(name, e = { name, lines: 0, blocks: 0, firstPage: 0, pages: [], dual: false });
      return e;
    };
    const seenOn = (e, pi) => { if (!e.pages.includes(pi)) e.pages.push(pi); };
    for (const P of pages) {
      // A page with no classified dialogue is not script: title pages,
      // coverage, revision tables and CALL SHEETS. A call sheet's column
      // table ("SCENE | SET/ DESCRIPTION | CAST | D/N", crew rows like
      // "HMU/ WARDROBE" and "RPT RPT TO") reads as a grid of dual-cue rows,
      // and dualNames below bypasses the dialogue-follow noise filter, so
      // those column labels would land in the character list as zero-line
      // names. Such pages already pass through byte-identical and are skipped
      // by reader mode; they must contribute no characters either. Same
      // predicate reader mode uses, so the three stay consistent.
      if (!P.lines.some(l => l.cls === 'dialogue')) continue;
      for (const B of (P.blocks || [])) {
        const dial = B.lines.filter(l => l.cls === 'dialogue').length;
        if (!dial || !cueGateOk(B.name)) continue;
        const e = get(B.name);
        if (!e.firstPage) e.firstPage = P.index;
        seenOn(e, P.index);
        e.lines += dial; e.blocks++;
      }
      // dual-dialogue headers (parted by the shared splitter; both halves
      // already passed the gate): surface the names for user review, with the
      // rows beneath attributed by the column boundary (they merge if the
      // name already exists; dual blocks are still never enlarged/painted)
      for (const D of (P.dualBlocks || [])) {
        for (const side of ['left', 'right']) {
          const n = D[side];
          if (!n) continue;
          const e = get(n);
          if (!e.firstPage) e.firstPage = P.index;
          seenOn(e, P.index);
          e.dual = true; e.lines += D[side + 'Lines'] || 0; e.blocks++;
        }
      }
    }
    return [...map.values()].sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : 1));
  }

  // Never-silent rail: cue-led blocks WITH dialogue whose normalized name the
  // shared gate refuses. Geometry is ours, so they still enlarge in
  // All-dialogue mode; identity is the hub's, so they never reach the
  // character list unasked. The report says so, with the gate's reason
  // (the #37 doctrine: a missing character must never pass unremarked).
  function collectRejectedCues(pages) {
    const map = new Map();
    for (const P of pages) {
      if (!P.lines.some(l => l.cls === 'dialogue')) continue;
      for (const B of (P.blocks || [])) {
        const dial = B.lines.filter(l => l.cls === 'dialogue').length;
        if (!dial || !B.name || cueGateOk(B.name)) continue;
        let e = map.get(B.name);
        if (!e) map.set(B.name, e = { name: B.name, reason: pol().cueRejectReason(B.name) || 'gate', lines: 0, blocks: 0, pages: [] });
        e.lines += dial; e.blocks++;
        if (!e.pages.includes(P.index)) e.pages.push(P.index);
      }
    }
    return [...map.values()].sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : 1));
  }

  // ---------- .sceneline interchange (spec v2) ----------
  // Pure data helpers: parse/union/reconcile/export the `.sceneline` JSON that
  // other Gotham benches (Sceneline, TechSpotter, Tablecut) write. The file is
  // authoritative for identity + speaker facts; geometry always comes from the
  // PDF, so importing is RECONCILIATION (map each PDF cue name to a file name
  // by the SAME normalizeCueName used everywhere), never skipped extraction.
  const SLUG_RE = /^(INT|EXT|I\/E|INT\/EXT|EST)[.\s\/]/;

  // Normalize a scene heading for the subset draft-mismatch check: uppercase,
  // hyphenate en/em dashes, drop a leading scene number and a trailing story-day
  // code "(D21)"/"(N3)" so the PDF's printed heading compares to the file's.
  function normalizeHeading(t) {
    let s = String(t || '').toUpperCase().replace(/[‐-―]/g, '-');
    s = s.replace(/^\s*[A-Z]{0,3}\d+[A-Z0-9]*\s+(?=INT|EXT|I\/E|EST)/, ''); // leading scene number
    // Right-margin furniture (revision stars, a repeated scene number, story-day
    // "(D21)" codes) can fuse into the heading segment. Strip them off the end
    // repeatedly. Applied to BOTH the PDF heading and the file's scene_heading,
    // so the comparison stays consistent whichever side carries the day code.
    let prev;
    do {
      prev = s;
      s = s.replace(/\s*\*+\s*$/, '');                    // revision stars
      s = s.replace(/\s*\([^)]*\)\s*$/, '');               // trailing (D21) / (PRESENT)
      s = s.replace(/\s+[A-Z]{0,3}\d+[A-Z0-9]*\s*$/, '');  // right-margin scene number
    } while (s !== prev);
    return s.replace(/\s+/g, ' ').trim();
  }

  // A heading may lead with its scene number FUSED into the same segment
  // ("18 INT. QUINN'S CAR ...") when the left scene number sits within a word
  // gap of the slug, so allow an optional leading scene-number token before
  // INT/EXT (normalizeHeading strips it back off).
  const SLUG_SEG = /^\s*(?:[A-Z]{0,3}\d+[A-Z0-9]*\s+)?(?:INT|EXT|I\/E|INT\/EXT|EST)[.\s\/]/;

  // Collect the PDF's geometrically-detected scene headings. Scans line
  // SEGMENTS (not L.text) so right-margin scene numbers — their own segments —
  // never ride along. Skips pages with no classified dialogue (a call sheet's
  // scene list is not the script's scene set). Surfaced as report.sluglines.
  function collectSluglines(pages) {
    const out = [];
    for (const P of (pages || [])) {
      if (!(P.lines || []).some(l => l.cls === 'dialogue')) continue;
      for (const L of (P.lines || [])) {
        for (const sg of (L.segments || [])) {
          const raw = String(sg.text || '').trim();
          if (SLUG_SEG.test(raw)) { out.push({ text: normalizeHeading(raw), raw, page: P.index }); break; }
        }
      }
    }
    return out;
  }

  // Parse a `.sceneline` file. Accepts v1 (no `interchange`/`extensions`) and
  // v2; refuses interchange > 2 LOUDLY (spec §6 — never guess a newer format).
  function parseSceneline(text) {
    let obj;
    try { obj = JSON.parse(text); }
    catch (e) { const err = new Error('Not a valid .sceneline file (could not parse JSON).'); err.code = 'SCENELINE_PARSE'; throw err; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      const err = new Error('Not a .sceneline file (expected a JSON object).'); err.code = 'SCENELINE_SHAPE'; throw err;
    }
    if (obj.format != null && obj.format !== 'sceneline') {
      const err = new Error('Not a .sceneline file (format is "' + obj.format + '").'); err.code = 'SCENELINE_SHAPE'; throw err;
    }
    const version = (typeof obj.interchange === 'number') ? obj.interchange : 1;
    if (version > 2) {
      const err = new Error('This .sceneline file is from a newer tool (interchange ' + version + '); this build reads up to 2. Update sides-enlarger.'); err.code = 'SCENELINE_VERSION'; throw err;
    }
    const show = (obj.show && typeof obj.show === 'object') ? obj.show : {};
    const warnings = [];
    if (!obj.show) warnings.push('This .sceneline file has no "show" block; no characters or scenes were loaded from it.');
    const hasText = (show.scenes || []).some(sc => sc && (sc.dialogue_text != null || sc.action_text != null));
    const profile = (obj.source && obj.source.profile) || (hasText ? 'full' : 'lean');
    return { envelope: obj, version, profile, show, warnings };
  }

  // Union one or more parsed files (side packets pull pages from several
  // episodes). Characters union (normalized, order-preserving); scene headings
  // collect for the subset check; speakers imply characters.
  function unionShows(parsed) {
    const characters = [], charSeen = new Set();
    const sceneHeadings = new Set(), scenes = [];
    const speakersByChar = new Map();
    const addChar = raw => { const n = normalizeCueName(raw); if (n && !charSeen.has(n)) { charSeen.add(n); characters.push(n); } return n; };
    for (const item of (parsed || [])) {
      const show = (item && (item.show || (item.envelope && item.envelope.show) || ((item.characters || item.scenes) ? item : null))) || {};
      for (const c of (show.characters || [])) addChar(c);
      for (const sc of (show.scenes || [])) {
        scenes.push(sc);
        const h = normalizeHeading((sc && sc.scene_heading) || '');
        if (h) sceneHeadings.add(h);
        for (const sp of ((sc && sc.speakers) || [])) {
          const n = addChar(sp);
          if (n) { if (!speakersByChar.has(n)) speakersByChar.set(n, new Set()); speakersByChar.get(n).add(String(sc.scene)); }
        }
      }
    }
    return { characters, sceneHeadings, scenes, speakersByChar };
  }

  // Reconcile the authoritative file identity against PDF geometry.
  //  - roster: file names first (authoritative), each matched to a PDF cue by
  //    normalizeCueName (carrying its geometric pages); then geometric-only
  //    names (in the PDF, in no loaded show) as source:'pdf' — shown secondary.
  //  - unmatchedFileNames: file names with no dialogue block on this packet
  //    (reconcile chips; an operator-added MERC #1 with no lines lands here).
  //  - foreignSluglines: PDF headings that are a member of NO loaded show
  //    (per-scene "wrong draft/episode?" chips). Subset, never count.
  function reconcile(unioned, pdf) {
    const fileNames = (unioned && unioned.characters) || [];
    const fileSet = new Set(fileNames);
    const pdfChars = ((pdf && pdf.characters) || []).map(c => ({ src: c, norm: normalizeCueName(c.name) }));
    const pdfByNorm = new Map();
    for (const c of pdfChars) if (c.norm && !pdfByNorm.has(c.norm)) pdfByNorm.set(c.norm, c.src);
    const roster = [];
    for (const n of fileNames) {
      const hit = pdfByNorm.get(n);
      roster.push({ name: n, source: 'file', matched: !!hit, pages: hit ? (hit.pages || []).slice() : [], lines: hit ? (hit.lines || 0) : 0 });
    }
    for (const c of pdfChars) {
      if (c.norm && !fileSet.has(c.norm)) roster.push({ name: c.norm, source: 'pdf', matched: true, pages: (c.src.pages || []).slice(), lines: c.src.lines || 0 });
    }
    const unmatchedFileNames = roster.filter(r => r.source === 'file' && !r.matched).map(r => r.name);
    const foreignSluglines = ((pdf && pdf.sluglines) || []).filter(sl => !unioned.sceneHeadings.has(sl.text));
    return { roster, unmatchedFileNames, foreignSluglines };
  }

  // Build our own `extensions.sides` block from live sides state.
  // state.characters: [{ name, pages, paletteIndex|null, enlarge, added }].
  function buildSidesBlock(state) {
    const characters = {};
    for (const c of ((state && state.characters) || [])) {
      const entry = { pages: (c.pages || []).slice() };
      if (c.paletteIndex != null && PALETTE[c.paletteIndex]) {
        entry.highlight = { key: PALETTE[c.paletteIndex].key, rgb: PALETTE[c.paletteIndex].hex };
      }
      entry.enlarge = !!c.enlarge;
      if (c.added) entry.added = true;
      characters[c.name] = entry;
    }
    return { settings: { scale: (state && state.scale) || null, mode: (state && state.mode) || null }, characters };
  }

  function leanShow(show) {
    const scenes = ((show && show.scenes) || []).map(sc => {
      const c = {}; for (const k of Object.keys(sc)) if (k !== 'dialogue_text' && k !== 'action_text') c[k] = sc[k]; return c;
    });
    return Object.assign({}, show, { scenes });
  }

  // Export a v2 envelope. THE ROUND-TRIP LAW: every foreign extension block and
  // unknown top-level field is preserved by reference (deep-equal), `show` is
  // preserved verbatim (v1 never edits the matrix), and only `extensions.sides`
  // is rewritten. Lean (default) drops screenplay text from `show`; foreign
  // blocks are never touched (their owner lean-ifies them, not us).
  function buildScenelineExport(baseEnvelope, sidesBlock, opts) {
    opts = opts || {};
    const profile = opts.profile === 'full' ? 'full' : 'lean';
    const base = (baseEnvelope && typeof baseEnvelope === 'object') ? baseEnvelope : {};
    const out = {};
    for (const k of Object.keys(base)) out[k] = base[k]; // unknown top-level fields preserved by reference
    out.format = 'sceneline';
    out.interchange = 2;
    out.source = Object.assign({}, base.source || {}, { generator: 'sides-enlarger/' + (opts.appVersion || '1'), profile });
    const show = (base.show && typeof base.show === 'object') ? base.show : { characters: [], scenes: [] };
    out.show = (profile === 'full') ? show : leanShow(show);
    const outExt = {};
    const baseExt = (base.extensions && typeof base.extensions === 'object') ? base.extensions : {};
    for (const k of Object.keys(baseExt)) outExt[k] = baseExt[k]; // foreign blocks preserved by reference
    outExt.sides = sidesBlock;
    out.extensions = outExt;
    return out;
  }

  // scriptparse burn-in signal 2 (policy `burn_in`, issue #16 ruling; the
  // residual #37 exposure on actor sides): text repeating at the same
  // quantized position on enough pages, in a row group that carries a
  // lowercase letter, is a per-recipient stamp. Stripped from LINE-BUILDING
  // only (classification, character extraction, reader mode): the rewriter
  // still sees the raw stream, so the stamp's bytes stay byte-identical in
  // the output. "Words" are this engine's pdf.js items (a glyph-per-op stamp
  // strips glyph by glyph, which is the hub's "before line clustering"
  // ordering by construction); `bottom` is converted from anchor space so the
  // shared cell arithmetic applies exactly as pinned. Signal 1 (rotated runs)
  // is applied in extract(). Never silent: returns a rail for the report.
  function stripRepeatedBurnIn(pages) {
    const P0 = pol();
    const pagesWords = pages.map(P => P.live.map(it => ({ text: it.str, x0: it.x, x1: it.x + it.w, bottom: P.height - it.y, top: P.height - it.y - (it.size || 0), it })));
    const strips = P0.detectRepeatedBurnin(pagesWords, pages.map(P => P.height));
    const rail = new Map();
    let runs = 0, pagesHit = 0;
    strips.forEach((idxs, pi) => {
      if (!idxs.length) return;
      const P = pages[pi];
      const drop = new Set(idxs.map(i => pagesWords[pi][i].it));
      const byRow = new Map();
      for (const i of idxs) {
        const w = pagesWords[pi][i], yb = P0.wordCell(w, P.height)[1];
        if (!byRow.has(yb)) byRow.set(yb, []);
        byRow.get(yb).push(w);
      }
      for (const ws of byRow.values()) {
        ws.sort((a, b) => a.x0 - b.x0);
        let text = '';
        for (let i = 0; i < ws.length; i++) {
          const gap = i ? ws[i].x0 - ws[i - 1].x1 : 0;
          text += (i && gap > Math.max(1.5, 0.25 * (ws[i - 1].it.size || 12)) ? ' ' : '') + ws[i].text;
        }
        text = text.replace(/\s+/g, ' ').trim();
        let e = rail.get(text);
        if (!e) rail.set(text, e = { text, pages: 0, firstPage: P.index });
        e.pages++;
      }
      P.live = P.live.filter(it => !drop.has(it));
      P.lines = buildLines(P.live);
      P.burnStripped = idxs.length; runs += idxs.length; pagesHit++;
    });
    return { runs, pages: pagesHit, rail: [...rail.values()] };
  }

  function classifyPage(P, cal) {
    // walk top -> bottom; dialogue = in a block opened by a character cue.
    // Also collects the cue-led blocks (P.blocks) used for character
    // extraction and highlighting, and dual-cue names (P.dualNames).
    let inBlock = false, dualMode = false, dualCur = null, prevY = null, cur = null;
    P.blocks = []; P.dualNames = []; P.dualBlocks = [];
    for (const L of P.lines) {
      if (prevY !== null && prevY - L.y > 28) { inBlock = false; cur = null; } // big vertical gap
      prevY = L.y;
      // a cue with a revision star in the margin is 2 segments but NOT dual:
      // dual detection looks at body segments only
      const bodySegs = L.segments.filter(sg => sg.x0 < P.width - 80);
      // dual-dialogue header (scriptparse #69 ruling, shared splitter): an
      // all-caps body row that parts at exactly ONE gap wider than
      // dual_dialogue.min_gap_pt into two halves that each pass the full cue
      // gate. Our segments are already word-joined and gap-split (buildLines),
      // so they are the splitter's "words". Scene numbers printed in both
      // margins of a slugline are geometry, never names: filtered here.
      const split = (bodySegs.length >= 2 && bodySegs.every(s => capsy(s.text)))
        ? pol().splitDualHeader(bodySegs.map(s => [s.text, s.x0, s.x1])) : null;
      if (split) {
        L.cls = 'dual'; dualMode = true; inBlock = false; cur = null; P.hasDual = true;
        const names = [split[0], split[1]].map(t => normalizeCueName(t))
          .map(n => (n && !/^[A-Z]{0,3}\d+[A-Z0-9]*$/.test(n)) ? n : '');
        dualCur = { left: names[0], right: names[1], boundary: split[2], leftLines: 0, rightLines: 0 };
        P.dualBlocks.push(dualCur);
        for (const n of names) if (n) P.dualNames.push(n);
        continue;
      }
      if (dualMode) {
        if (L.segments.length >= 2) {
          L.cls = 'dual'; P.hasDual = true;
          if (dualCur) { // attribute the row by the column boundary (midpoint of the two x starts)
            const bs = L.segments.filter(sg => sg.x0 < P.width - 80);
            if (bs.some(sg => sg.x1 < dualCur.boundary)) dualCur.leftLines++;
            if (bs.some(sg => sg.x0 > dualCur.boundary)) dualCur.rightLines++;
          }
          continue;
        }
        dualMode = false; dualCur = null;
      }
      // type-size gate (see calibrate): script type only, for cues and for
      // the dialogue beneath them
      const typeOk = !cal.cueSize || Math.abs(lineSize(L) - cal.cueSize) <= 0.25 * cal.cueSize;
      if (typeOk && isCueLine(L, [cal.cueX - 12, cal.cueX + 12], P.width)) {
        L.cls = 'cue'; inBlock = true;
        setDialExtent(L, P.width); // cue extents/star cap for scaling
        cur = { name: normalizeCueName(L.text), cue: L, lines: [] };
        P.blocks.push(cur);
        continue;
      }
      if (inBlock && typeOk && (near(L.x0, cal.dialX, 9) || near(L.x0, cal.parenX, 9))) {
        L.cls = /^\(\s*MORE\s*\)\s*$/i.test(L.text.trim()) ? 'more' : 'dialogue';
        setDialExtent(L, P.width);
        if (cur) cur.lines.push(L);
        continue;
      }
      L.cls = 'other'; inBlock = false; cur = null;
    }
  }

  // Dialogue extent excludes right-margin marks (revision asterisks, scene
  // continuation *, etc.) which sit far right and must never be scaled or
  // counted toward the fit calculation. If such marks exist on the line,
  // record where they start so enlargement never grows into them.
  function setDialExtent(L, pageW) {
    const marginStart = pageW - 80; // ~1.1" from right edge
    const segs = L.segments.filter(s => s.x0 < marginStart);
    if (segs.length) {
      L.dx0 = Math.min(...segs.map(s => s.x0));
      L.dx1 = Math.max(...segs.map(s => s.x1));
      const marks = L.segments.filter(s => s.x0 >= marginStart);
      if (marks.length) L.starX0 = Math.min(...marks.map(s => s.x0));
    } else { L.dx0 = L.x0; L.dx1 = L.x1; }
  }

  function pageScale(P, requested, colW, dialX) {
    // Every dialogue run is scaled uniformly about the column-center anchor
    // C = dialX + colW/2 (x' = C + s*(x - C)), so letter pitch, word gaps and
    // indents all grow together. Max uniform scale so every dialogue line
    // stays on the page (and clear of right-margin revision marks); back off
    // (never reflow) when it doesn't fit.
    const C = dialX + colW / 2;
    let s = requested;
    for (const L of P.lines) {
      if (!((L.cls === 'dialogue' || L.cls === 'cue') && L.enlarge !== false)) continue;
      const x0 = L.dx0 != null ? L.dx0 : L.x0;
      const x1 = L.dx1 != null ? L.dx1 : L.x1;
      // left edge: C + s*(x0 - C) >= EDGE
      const sLeft = x0 < C ? (C - EDGE) / (C - x0) : Infinity;
      // right edge: C + s*(x1 - C) <= right limit (page edge, or just short
      // of a revision mark sitting in the margin on this same line)
      const rightLimit = L.starX0 != null ? Math.min(P.width - EDGE, L.starX0 - 4) : P.width - EDGE;
      const sRight = x1 > C ? (rightLimit - C) / (x1 - C) : Infinity;
      s = Math.min(s, sLeft, sRight);
    }
    return Math.max(1, Math.floor(s * 100) / 100);
  }

  // ---------- content stream lexer ----------
  const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
  const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

  function tokenize(src) {
    // src: latin1 string (1 char == 1 byte). Yields {t, raw, val?}
    const toks = [];
    let i = 0;
    const n = src.length;
    const isWS = c => WS.has(src.charCodeAt(c));
    while (i < n) {
      const c = src[i];
      if (isWS(i)) { i++; continue; }
      if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
      if (c === '(') { // literal string, nested parens + escapes
        let depth = 0, j = i;
        for (; j < n; j++) {
          const ch = src[j];
          if (ch === '\\') { j++; continue; }
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
        }
        toks.push({ t: 'str', raw: src.slice(i, j) }); i = j; continue;
      }
      if (c === '<') {
        if (src[i + 1] === '<') { // dict: copy raw to matching >>
          let depth = 0, j = i;
          while (j < n) {
            if (src[j] === '<' && src[j + 1] === '<') { depth++; j += 2; continue; }
            if (src[j] === '>' && src[j + 1] === '>') { depth--; j += 2; if (!depth) break; continue; }
            if (src[j] === '(') { let d2 = 0; for (; j < n; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === '(') d2++; else if (src[j] === ')') { d2--; if (!d2) { j++; break; } } } continue; }
            j++;
          }
          toks.push({ t: 'dict', raw: src.slice(i, j) }); i = j; continue;
        }
        let j = i + 1; while (j < n && src[j] !== '>') j++;
        toks.push({ t: 'str', raw: src.slice(i, j + 1) }); i = j + 1; continue;
      }
      if (c === '[') { toks.push({ t: 'arrOpen', raw: '[' }); i++; continue; }
      if (c === ']') { toks.push({ t: 'arrClose', raw: ']' }); i++; continue; }
      if (c === '/') {
        let j = i + 1;
        while (j < n && !isWS(j) && !DELIM.has(src[j])) j++;
        toks.push({ t: 'name', raw: src.slice(i, j) }); i = j; continue;
      }
      if (c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
        let j = i + 1;
        while (j < n && /[0-9.+\-eE]/.test(src[j])) j++;
        const raw = src.slice(i, j);
        toks.push({ t: 'num', raw, val: parseFloat(raw) }); i = j; continue;
      }
      { // operator / keyword
        let j = i;
        while (j < n && !isWS(j) && !DELIM.has(src[j])) j++;
        toks.push({ t: 'op', raw: src.slice(i, j) }); i = j;
      }
    }
    return toks;
  }

  function toInstructions(toks, src) {
    // group tokens into {operands:[tok], op} — arrays become one operand
    const out = [];
    let operands = [];
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      if (tk.t === 'arrOpen') {
        const parts = ['['];
        k++;
        for (; k < toks.length && toks[k].t !== 'arrClose'; k++) parts.push(toks[k].raw);
        parts.push(']');
        operands.push({ t: 'arr', raw: parts.join(' ') });
        continue;
      }
      if (tk.t === 'op') {
        if (tk.raw === 'true' || tk.raw === 'false' || tk.raw === 'null') { operands.push(tk); continue; }
        if (tk.raw === 'BI') {
          // inline image: swallow tokens up to ID, then raw-scan handled upstream
          out.push({ op: 'BI_RAW', operands: [], raw: null, biStart: k });
          operands = [];
          continue;
        }
        out.push({ op: tk.raw, operands });
        operands = [];
        continue;
      }
      operands.push(tk);
    }
    return out;
  }

  // ---------- decryption (Standard security handler, empty user password) ----
  // Production sides are routinely permission-locked (RC4-128 / AES-128 with an
  // empty user password). pdf.js decrypts transparently for reading; for the
  // rewrite we decrypt every stream & string in place, then drop /Encrypt.
  const PAD = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
  ];

  // Minimal MD5 (public-domain style implementation), returns Uint8Array(16)
  function md5(bytes) {
    const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
               4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    const n = bytes.length;
    const total = (((n + 8) >> 6) + 1) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes); buf[n] = 0x80;
    const bitLen = n * 8;
    buf[total - 8] = bitLen & 0xff; buf[total - 7] = (bitLen >>> 8) & 0xff;
    buf[total - 6] = (bitLen >>> 16) & 0xff; buf[total - 5] = (bitLen >>> 24) & 0xff;
    // (PDF inputs are < 512MB; higher length bytes stay 0)
    let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
    const M = new Int32Array(16);
    const rotl = (x, c) => (x << c) | (x >>> (32 - c));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        M[i] = buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24);
      }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, s[i])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((w, i) => {
      out[i * 4] = w & 0xff; out[i * 4 + 1] = (w >>> 8) & 0xff;
      out[i * 4 + 2] = (w >>> 16) & 0xff; out[i * 4 + 3] = (w >>> 24) & 0xff;
    });
    return out;
  }

  function rc4(key, data) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 0xff;
      const t = S[i]; S[i] = S[j]; S[j] = t;
    }
    const out = new Uint8Array(data.length);
    let i = 0; j = 0;
    for (let k = 0; k < data.length; k++) {
      i = (i + 1) & 0xff;
      j = (j + S[i]) & 0xff;
      const t = S[i]; S[i] = S[j]; S[j] = t;
      out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
    }
    return out;
  }

  async function aesCbcDecrypt(key, data) {
    if (data.length < 16) return new Uint8Array(0);
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
    if (!subtle) throw new Error('AES-encrypted PDF needs a secure context (https) to decrypt.');
    const iv = data.slice(0, 16);
    let body = data.slice(16);
    if (!body.length) return new Uint8Array(0);
    const k = await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
    try {
      const plain = await subtle.decrypt({ name: 'AES-CBC', iv }, k, body);
      return new Uint8Array(plain);
    } catch (e) {
      throw new Error('AES decryption failed (bad padding) — file may use an unsupported variant.');
    }
  }

  function buildDecryptor(PDFLib, ctx) {
    const encRef = ctx.trailerInfo.Encrypt;
    if (!encRef) return null;
    const enc = ctx.lookup(encRef);
    const g = k => enc.get(PDFLib.PDFName.of(k));
    const filter = g('Filter');
    if (!filter || filter.asString() !== '/Standard') {
      throw new Error('This PDF uses a non-standard security handler; cannot process it locally.');
    }
    const V = g('V') ? g('V').asNumber() : 0;
    const R = g('R') ? g('R').asNumber() : 2;
    if (R > 4) throw new Error('This PDF uses AES-256 (newer encryption). Ask production for a standard export, or print-to-PDF first.');
    const length = g('Length') ? g('Length').asNumber() : 40;
    const O = ctx.lookup(g('O')).asBytes();
    let P = ctx.lookup(g('P')).asNumber();
    // V4 crypt filters: streams (StmF) and strings (StrF) can use DIFFERENT
    // methods, including Identity (not encrypted at all) — applying one
    // method to everything corrupts mixed documents.
    let stmMethod = 'RC4', strMethod = 'RC4';
    const cfDict = V === 4 && g('CF') ? ctx.lookup(g('CF')) : null;
    const methodOf = fname => {
      if (!fname || fname === 'Identity') return 'Identity';
      const fRef = cfDict && cfDict.get(PDFLib.PDFName.of(fname));
      const f = fRef && ctx.lookup(fRef);
      const cfm = f && f.get(PDFLib.PDFName.of('CFM'));
      const m = cfm ? cfm.toString() : '/V2';
      if (m === '/AESV3') throw new Error('AES-256 PDF encryption is not supported.');
      if (m === '/AESV2') return 'AES';
      if (m === '/None') return 'Identity';
      return 'RC4';
    };
    if (V === 4) {
      stmMethod = methodOf(g('StmF') ? g('StmF').asString().slice(1) : 'Identity');
      strMethod = methodOf(g('StrF') ? g('StrF').asString().slice(1) : 'Identity');
    }
    const encryptMetadata = g('EncryptMetadata') ? String(g('EncryptMetadata')) !== 'false' : true;
    const idArr = ctx.lookup(ctx.trailerInfo.ID);
    const id0 = idArr ? ctx.lookup(idArr.get(0)).asBytes() : new Uint8Array(0);

    const keyLen = R === 2 ? 5 : Math.floor(length / 8);
    const pBytes = new Uint8Array(4);
    const p = P >>> 0; // two's complement as unsigned
    pBytes[0] = p & 0xff; pBytes[1] = (p >>> 8) & 0xff; pBytes[2] = (p >>> 16) & 0xff; pBytes[3] = (p >>> 24) & 0xff;
    const material = concatBytes([new Uint8Array(PAD), O.slice(0, 32), pBytes, id0,
      (R >= 4 && !encryptMetadata) ? new Uint8Array([0xff, 0xff, 0xff, 0xff]) : new Uint8Array(0)]);
    let key = md5(material).slice(0, keyLen);
    if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key.slice(0, keyLen)).slice(0, keyLen);

    const objKey = (num, gen, aes) => {
      const extra = aes ? [0x73, 0x41, 0x6C, 0x54] : [];
      const m = concatBytes([key,
        new Uint8Array([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]),
        new Uint8Array(extra)]);
      return md5(m).slice(0, Math.min(keyLen + 5, 16));
    };
    return {
      stmMethod, strMethod, methodOf, encryptMetadata,
      apply: async (num, gen, data, method) => {
        if (method === 'Identity') return data;
        if (method === 'AES') return aesCbcDecrypt(objKey(num, gen, true), data);
        return rc4(objKey(num, gen, false), data);
      },
    };
  }

  // A stream can carry its own /Crypt filter naming the crypt-filter to use
  // (commonly Identity, e.g. unencrypted XMP metadata). Returns the named
  // filter ('Identity' when unnamed) or undefined when there is no /Crypt.
  function cryptFilterName(PDFLib, ctx, dict) {
    const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
    const filt = dict.get(N('Filter'));
    const f = filt && ctx.lookup(filt);
    if (!f) return undefined;
    const entries = f instanceof PDFLib.PDFArray
      ? [...Array(f.size()).keys()].map(i => ctx.lookup(f.get(i)))
      : [f];
    const idx = entries.findIndex(e => e && e.toString && e.toString() === '/Crypt');
    if (idx === -1) return undefined;
    const dp = dict.get(N('DecodeParms')) || dict.get(N('DP'));
    const d = dp && ctx.lookup(dp);
    let parms = d;
    if (d instanceof PDFLib.PDFArray) parms = ctx.lookup(d.get(idx));
    const name = parms && parms.get && parms.get(N('Name'));
    return name ? name.toString().slice(1) : 'Identity';
  }

  // After in-place decryption the document is plaintext: /Crypt filter
  // entries must be removed or viewers will reject the streams.
  function stripCryptFilter(PDFLib, ctx, dict) {
    const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
    const filt = dict.get(N('Filter'));
    const f = filt && ctx.lookup(filt);
    if (!f) return;
    if (!(f instanceof PDFLib.PDFArray)) {
      if (f.toString() === '/Crypt') { dict.delete(N('Filter')); dict.delete(N('DecodeParms')); dict.delete(N('DP')); }
      return;
    }
    const idx = [...Array(f.size()).keys()]
      .findIndex(i => { const e = ctx.lookup(f.get(i)); return e && e.toString && e.toString() === '/Crypt'; });
    if (idx === -1) return;
    const keepF = [];
    for (let i = 0; i < f.size(); i++) if (i !== idx) keepF.push(f.get(i));
    dict.set(N('Filter'), ctx.obj(keepF));
    const dpKey = dict.get(N('DecodeParms')) ? 'DecodeParms' : (dict.get(N('DP')) ? 'DP' : null);
    if (dpKey) {
      const d = ctx.lookup(dict.get(N(dpKey)));
      if (d instanceof PDFLib.PDFArray) {
        const keepD = [];
        for (let i = 0; i < d.size(); i++) if (i !== idx) keepD.push(d.get(i));
        dict.set(N(dpKey), ctx.obj(keepD));
      } else dict.delete(N(dpKey));
    }
  }

  function concatBytes(list) {
    let n = 0;
    for (const b of list) n += b.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
  }

  async function decryptInPlace(PDFLib, pdfDoc) {
    const ctx = pdfDoc.context;
    const dec = buildDecryptor(PDFLib, ctx);
    if (!dec) return false;
    const encRefStr = ctx.trailerInfo.Encrypt && ctx.trailerInfo.Encrypt.toString();
    const strCache = new Map();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (ref.toString() === encRefStr) continue;
      const num = ref.objectNumber, gen = ref.generationNumber;
      // streams
      if (obj instanceof PDFLib.PDFRawStream) {
        const t = obj.dict.get(PDFLib.PDFName.of('Type'));
        if (t && t.toString() === '/XRef') continue; // never encrypted
        if (!dec.encryptMetadata && t && t.toString() === '/Metadata') continue;
        let method = dec.stmMethod;
        const cn = cryptFilterName(PDFLib, ctx, obj.dict);
        if (cn !== undefined) {
          // per-stream /Crypt filter overrides the document stream method
          method = dec.methodOf(cn);
          stripCryptFilter(PDFLib, ctx, obj.dict);
        }
        obj.contents = await dec.apply(num, gen, obj.contents, method);
        continue;
      }
      // strings anywhere inside this object
      if (dec.strMethod !== 'Identity') {
        await visitStrings(PDFLib, obj, async bytes => dec.apply(num, gen, bytes, dec.strMethod), strCache);
      }
    }
    delete ctx.trailerInfo.Encrypt;
    return true;
  }

  async function visitStrings(PDFLib, obj, fn, seen) {
    if (!obj || typeof obj !== 'object') return;
    if (seen.has(obj)) return;
    seen.set(obj, true);
    if (obj instanceof PDFLib.PDFDict) {
      for (const [k, v] of obj.entries()) {
        const nv = await replaceString(PDFLib, v, fn);
        if (nv) obj.set(k, nv);
        else await visitStrings(PDFLib, v, fn, seen);
      }
    } else if (obj instanceof PDFLib.PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const v = obj.get(i);
        const nv = await replaceString(PDFLib, v, fn);
        if (nv) obj.set(i, nv);
        else await visitStrings(PDFLib, v, fn, seen);
      }
    } else if (obj instanceof PDFLib.PDFRawStream) {
      await visitStrings(PDFLib, obj.dict, fn, seen);
    }
  }

  async function replaceString(PDFLib, v, fn) {
    if (v instanceof PDFLib.PDFString || v instanceof PDFLib.PDFHexString) {
      const plain = await fn(v.asBytes());
      let hex = '';
      for (const b of plain) hex += (b < 16 ? '0' : '') + b.toString(16);
      return PDFLib.PDFHexString.of(hex.toUpperCase());
    }
    return null;
  }

  // ---------- phase B: rewrite ----------
  // Returns { out, changed, bail }. `onDo(name, ctmAtInvoke)` handles form
  // XObject recursion; text may live inside forms (real production sides do
  // exactly this), so scaling has to descend through `Do`.
  //
  // Clip awareness: rectangular clip paths (`re W n`, table cells, row bands)
  // are tracked in device space. When `collect` is given the walk runs in
  // MEASURE mode: nothing is emitted or mutated; instead every show op that
  // would scale reports its line and the active clip x-range, so the caller
  // can cap the page scale to keep text inside its clips.
  function rewriteStream(src, ctm0, dialogLines, sPage, anchorX, stats, onDo, collect) {
    if (src.indexOf('BI') !== -1 && /(^|[\s>\]])BI[\s\/]/.test(src)) {
      // inline images present: bail out of scaling this stream rather than corrupt
      stats.warnings.push('stream contains inline images; left unscaled');
      return { out: null, changed: false, bail: true };
    }
    const instrs = toInstructions(tokenize(src), src);
    const out = [];
    const emitRaw = ins => { out.push(ins.operands.map(o => o.raw).join(' ') + (ins.operands.length ? ' ' : '') + ins.op); };
    const emit = s => out.push(s);

    let ctm = ctm0 ? ctm0.slice() : [1, 0, 0, 1, 0, 0];
    const gsStack = [];
    let tm = null, tlm = null, tl = 0;
    let scaledRun = false; // currently inside an injected-scale run
    let changedHere = false;
    // device-space x-range of the active rectangular clip (if any)
    let clipLo = -Infinity, clipHi = Infinity, clipUnknown = false;
    let pathRects = [], pathOther = false, pendingClip = false;
    const applyPendingClip = () => {
      if (pendingClip) {
        if (pathOther || !pathRects.length) clipUnknown = true;
        else {
          clipLo = Math.max(clipLo, Math.min(...pathRects.map(r => r[0])));
          clipHi = Math.min(clipHi, Math.max(...pathRects.map(r => r[1])));
        }
        pendingClip = false;
      }
      pathRects = []; pathOther = false;
    };

    const restoreIfScaled = () => {
      if (scaledRun) { emit(tlm.map(fmt).join(' ') + ' Tm'); scaledRun = false; }
    };
    const num = (ins, idx) => (ins.operands[idx] && ins.operands[idx].val) || 0;

    const classifyShow = () => {
      if (!tlm) return null;
      const dev = apply(mul(tlm, ctm), 0, 0);
      for (const L of dialogLines) {
        const lo = (L.dx0 != null ? L.dx0 : L.x0) - 2;
        const hi = (L.dx1 != null ? L.dx1 : L.x1) + 2;
        if (Math.abs(dev[1] - L.y) <= 2.5 && dev[0] >= lo && dev[0] <= hi) return { L, devX: dev[0] };
      }
      return null;
    };
    const beginScaledIfDialogue = () => {
      if (scaledRun) return; // continuing same run: advances already scaled
      const hit = classifyShow();
      if (!hit || (hit.L.cls !== 'dialogue' && hit.L.cls !== 'cue') || hit.L.enlarge === false || sPage <= 1.001) return;
      if (collect) { // measure mode: report line + active clip, mutate nothing
        collect.push({ L: hit.L, clipLo, clipHi, clipUnknown });
        return;
      }
      // Uniform scale about the page's column anchor: x' = C + s*(x - C),
      // anchored on this line's own baseline (nothing moves vertically).
      // Every run on a line gets the same affine map, so multi-run lines
      // (word-per-op or glyph-per-op PDFs) keep letter pitch, word gaps and
      // indents consistent instead of crowding around fixed origins.
      // The per-op delta is computed from device x; ctm x-scale is assumed
      // ~1 (translation/flip only), as everywhere else in this rewriter.
      const ax = ctm[0] || 1;
      const delta = (sPage - 1) * (hit.devX - anchorX) / ax;
      const m = [tlm[0] * sPage, tlm[1] * sPage, tlm[2] * sPage, tlm[3] * sPage,
                 tlm[4] + delta, tlm[5]];
      emit(m.map(fmt).join(' ') + ' Tm');
      scaledRun = true;
      changedHere = true;
      stats.scaledOps++;
    };

    for (const ins of instrs) {
      switch (ins.op) {
        case 'q': gsStack.push([ctm, clipLo, clipHi, clipUnknown]); emitRaw(ins); break;
        case 'Q': {
          const g = gsStack.pop();
          if (g) { ctm = g[0]; clipLo = g[1]; clipHi = g[2]; clipUnknown = g[3]; }
          else { ctm = [1, 0, 0, 1, 0, 0]; clipLo = -Infinity; clipHi = Infinity; clipUnknown = false; }
          restoreIfScaled(); emitRaw(ins); break;
        }
        case 'cm': {
          const m = [0, 1, 2, 3, 4, 5].map(i => num(ins, i));
          ctm = mul(m, ctm); emitRaw(ins); break;
        }
        case 're': {
          const x = num(ins, 0), y = num(ins, 1), w = num(ins, 2), h = num(ins, 3);
          const pts = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x, y + h), apply(ctm, x + w, y + h)];
          pathRects.push([Math.min(...pts.map(p => p[0])), Math.max(...pts.map(p => p[0]))]);
          emitRaw(ins); break;
        }
        case 'm': case 'l': case 'c': case 'v': case 'y': case 'h':
          pathOther = true; emitRaw(ins); break;
        case 'W': case 'W*':
          pendingClip = true; emitRaw(ins); break;
        case 'n': case 'f': case 'F': case 'f*': case 'S': case 's':
        case 'B': case 'B*': case 'b': case 'b*':
          applyPendingClip(); emitRaw(ins); break;
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); scaledRun = false; emitRaw(ins); break;
        case 'ET': restoreIfScaled(); tm = tlm = null; emitRaw(ins); break;
        case 'TL': tl = num(ins, 0); emitRaw(ins); break;
        case 'Td': {
          restoreIfScaled();
          tlm = mul([1, 0, 0, 1, num(ins, 0), num(ins, 1)], tlm || [1, 0, 0, 1, 0, 0]);
          tm = tlm.slice(); emitRaw(ins); break;
        }
        case 'TD': {
          restoreIfScaled();
          tl = -num(ins, 1);
          tlm = mul([1, 0, 0, 1, num(ins, 0), num(ins, 1)], tlm || [1, 0, 0, 1, 0, 0]);
          tm = tlm.slice(); emitRaw(ins); break;
        }
        case 'Tm': {
          restoreIfScaled();
          tlm = [0, 1, 2, 3, 4, 5].map(i => num(ins, i));
          tm = tlm.slice(); emitRaw(ins); break;
        }
        case 'T*': {
          restoreIfScaled();
          tlm = mul([1, 0, 0, 1, 0, -tl], tlm || [1, 0, 0, 1, 0, 0]);
          tm = tlm.slice(); emitRaw(ins); break;
        }
        case 'Tj': case 'TJ': {
          beginScaledIfDialogue();
          emitRaw(ins); break;
        }
        case "'": {
          restoreIfScaled();
          tlm = mul([1, 0, 0, 1, 0, -tl], tlm || [1, 0, 0, 1, 0, 0]);
          tm = tlm.slice();
          // decompose so the scaled matrix can be injected between move & show
          beginScaledIfDialogue();
          if (scaledRun) emit(ins.operands.map(o => o.raw).join(' ') + ' Tj');
          else { emit('T*'); emit(ins.operands.map(o => o.raw).join(' ') + ' Tj'); }
          if (!scaledRun) break;
          break;
        }
        case '"': {
          restoreIfScaled();
          emit(fmt(num(ins, 0)) + ' Tw'); emit(fmt(num(ins, 1)) + ' Tc');
          tlm = mul([1, 0, 0, 1, 0, -tl], tlm || [1, 0, 0, 1, 0, 0]);
          tm = tlm.slice();
          beginScaledIfDialogue();
          const strTok = ins.operands[2] ? ins.operands[2].raw : '()';
          if (scaledRun) emit(strTok + ' Tj');
          else { emit('T*'); emit(strTok + ' Tj'); }
          break;
        }
        case 'Do': {
          const nameTok = ins.operands[0];
          if (onDo && nameTok && nameTok.raw[0] === '/') {
            try { if (onDo(nameTok.raw.slice(1), ctm)) changedHere = changedHere || false; } catch (e) { stats.warnings.push('form xobject skipped: ' + (e && e.message || e)); }
          }
          emitRaw(ins); break;
        }
        case 'BI_RAW': return { out: null, changed: false, bail: true };
        default:
          emitRaw(ins);
      }
    }
    return { out: out.join('\n'), changed: changedHere, bail: false };
  }

  // Header/footer furniture for whole-page mode: rows in the top/bottom page
  // zones that repeat across pages. Furniture is page identity: it never
  // scales, and its tight internal line gaps must not cap the body's
  // enlargement. Recognized two ways:
  //  (A) identical text — the whole digit-stripped row repeats on >= half the
  //      pages (single-show running headers, CONTINUED: rows, (CONTINUED)
  //      footers). Matched in the top/bottom 15%/12% zones.
  //  (B) shared show-name anchor — a multi-episode "day" side stitches scenes
  //      from several episodes, so the header's episode number, title, draft
  //      color and page number all vary; only the leading show-name token is
  //      constant across pages. Match on that leading token, but ONLY in the
  //      extreme EDGE band (top/bottom 8%, above the text block) so sluglines
  //      and action that dip into the wider zone are never swept up. A row
  //      with no 3+-letter word at all (a lone page number or "*") is
  //      furniture only in that same edge band — a bare scene number deeper in
  //      the top zone (e.g. a mid-scene "5.46pt1" continuation mark in the
  //      left margin) is body text, not furniture, and must survive reader mode.
  function markFurniture(pages) {
    const zoneOf = (L, P) => (L.y > P.height * 0.85 ? 'top' : (L.y < P.height * 0.12 ? 'bot' : null));
    const edgeOf = (L, P) => (L.y > P.height * 0.92 ? 'top' : (L.y < P.height * 0.08 ? 'bot' : null));
    const sig = t => t.replace(/[^A-Za-z]/g, '');
    // full key: words with 3+ letters only (scene/page numbers, dates and
    // (2)-style suffixes vary per page and must not split the group)
    const keyFull = L => L.text.split(/\s+/).filter(t => sig(t).length >= 3).join(' ').toUpperCase();
    // lead key: the first 3+-letter word (the show name), '' if none
    const keyLead = L => { for (const t of L.text.split(/\s+/)) if (sig(t).length >= 3) return sig(t).toUpperCase(); return ''; };
    const seenFull = new Map(), seenLead = new Map(); // zone+key -> Set of page indexes
    const bump = (m, k, i) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(i); };
    for (const P of pages) {
      for (const L of P.lines) {
        if (L.cls === 'dialogue' || L.cls === 'cue') continue;
        const zf = zoneOf(L, P); if (zf) { const kf = keyFull(L); if (kf) bump(seenFull, zf + '|' + kf, P.index); }
        const ze = edgeOf(L, P); if (ze) { const kl = keyLead(L); if (kl) bump(seenLead, ze + '|' + kl, P.index); }
      }
    }
    const need = Math.max(2, Math.ceil(pages.length / 2));
    const hits = (m, k) => (m.get(k) || new Set()).size >= need;
    for (const P of pages) {
      for (const L of P.lines) {
        if (L.cls === 'dialogue' || L.cls === 'cue') continue;
        const zf = zoneOf(L, P);
        if (zf) { const kf = keyFull(L); if (kf && hits(seenFull, zf + '|' + kf)) { L.furn = true; continue; } }
        const ze = edgeOf(L, P);
        if (ze) { const kl = keyLead(L); if (!kl || hits(seenLead, ze + '|' + kl)) L.furn = true; }
      }
    }
  }

  // ---------- reader mode (reflow) ----------
  // Streams the script as elements (slug / action / cue / paren / dialogue /
  // transition) in reading order. Page furniture (headers, footers, page
  // numbers, revision stars, (MORE)/(CONTINUED)) and rotated watermark text
  // are dropped; hard line wraps are removed so the renderer can re-wrap the
  // verbatim text at the reader size. Pages without dialogue (title pages,
  // coverage, call sheets) are skipped entirely.
  function buildReaderElements(pages) {
    const els = [];
    // every element carries its source page (0-based index + printed label)
    // and the scene it sits in (id from the margin scene number, heading
    // normalized), so a consumer can key a cursor to a page or a scene
    // without re-deriving either. Additive: the PDF renderer ignores them.
    let curPage = null, curLabel = null, curScene = { id: null, heading: null };
    const push = el => {
      if (!(el && el.text && el.text.trim())) return;
      el.page = curPage; el.pageLabel = curLabel;
      el.scene = curScene.id; el.heading = curScene.heading;
      els.push(el);
    };
    const textFromItems = items => {
      // content order, not x order: kerned per-glyph text can overlap
      // slightly and x-sorting would scramble the reading order
      const inOrder = [...items].sort((a2, b2) => (a2.seq || 0) - (b2.seq || 0));
      const kept = [];
      for (const it of inOrder) {
        // double-struck "bold" text: the same string drawn twice in place
        if (kept.some(p => p.str === it.str && Math.abs(p.x - it.x) < 1.2)) continue;
        kept.push(it);
      }
      let out = '', px = null;
      for (const it of kept) {
        if (px != null) {
          const gap = it.x - px;
          // big |gap| either way = a word boundary or an out-of-order jump
          if (gap > Math.max(1.5, 0.25 * (it.size || 12)) || gap < -0.6 * (it.size || 12)) out += ' ';
        }
        out += it.str;
        px = it.x + it.w;
      }
      return out.replace(/\s+/g, ' ').trim();
    };
    // the printed page number of a source page (header zone; "34." style
    // dotted tokens beat bare digits, which may be episode/scene numbers)
    const pageLabelOf = P => {
      const dotted = [], plain = [];
      for (const L of P.lines) {
        if (L.y < P.height * 0.85) continue;
        for (const sg of L.segments) {
          for (const tok of sg.text.trim().split(/\s+/)) {
            if (/^\d{1,4}[A-Z]{0,2}\.$/.test(tok)) dotted.push(tok.slice(0, -1));
            else if (/^\d{1,4}[A-Z]{0,2}$/.test(tok)) plain.push(tok);
          }
        }
      }
      if (dotted.length) return dotted[dotted.length - 1];
      if (plain.length) return plain[plain.length - 1];
      return String(P.index);
    };
    for (const P of pages) {
      if (!P.lines.some(l => l.cls === 'dialogue')) continue;
      const marginR0 = P.width - 80;
      // mark where this original script page starts, so on-set page calls
      // can be found in reader view; reference the FULL header name, e.g.
      // 'SCRIPT PAGE 17 · NCIS: NY Ep. 101 "Pilot" Prod. Draft (Full Blue)'
      const num = pageLabelOf(P);
      let headerText = '';
      const hdr = P.lines
        .filter(l => l.furn && l.y > P.height * 0.85)
        .sort((a2, b2) => b2.y - a2.y)[0];
      if (hdr) {
        // the header spans the full printable width and its show name
        // legitimately begins in the far-left margin (left of the body's
        // x=70), so do NOT clip the left here — a glyph-per-op name drawn as
        // "RESU|RRECTION" would otherwise lose its head. Drop only rotated
        // watermarks and right-margin marks (revision stars) past the
        // page-number column.
        headerText = textFromItems(hdr.items.filter(t => !t.rot && t.x < marginR0));
        // drop the trailing printed page number ("... 4/28/26  50.") — already
        // shown as "SCRIPT PAGE N". Glyph-per-op headers split it ("5 0."), so
        // tolerate spaces between the number's own characters and a bare dot.
        const numLoose = num.replace(/[^A-Za-z0-9]/g, '').split('').join('\\s*');
        headerText = headerText.replace(new RegExp('\\s+' + numLoose + '\\s*\\.?\\s*$'), '').trim();
      }
      curPage = P.index; curLabel = num;
      push({ t: 'break', text: 'SCRIPT PAGE ' + num + (headerText ? ' · ' + headerText : ''), header: headerText });
      const ML = 70, marginR = P.width - 80;
      const lineName = new Map();
      for (const B of (P.blocks || [])) {
        lineName.set(B.cue, B.name);
        for (const l of B.lines) lineName.set(l, B.name);
      }
      let para = null, paren = null, dual = null, prevY = null;
      const flushPara = () => {
        if (para) { push(para); para = null; }
        if (paren) { push(paren); paren = null; }
      };
      const flushDual = () => {
        if (!dual) return;
        for (const col of [dual.left, dual.right]) {
          if (col.cue) push({ t: 'cue', text: col.cue, name: normalizeCueName(col.cue) });
          push({ t: 'dialogue', text: col.text.replace(/\s+/g, ' ').trim(), name: normalizeCueName(col.cue || '') });
        }
        dual = null;
      };
      for (const L of P.lines) {
        if (L.furn) continue;
        let live = L.items.filter(t => !t.rot && !/^\*+$/.test(t.str.trim()));
        // pdf.js v5 merges a trailing right-margin revision star into the
        // dialogue text item (v3 emitted it separately, dropped by the filter
        // above). The margin gap becomes a space, so a trailing " *" is a
        // revision mark, not content (dialogue never ends that way); strip it
        // so it can't bleed into the reflowed text.
        live = live.map(t => /\s\*+\s*$/.test(t.str)
          ? Object.assign({}, t, { str: t.str.replace(/\s+\*+\s*$/, '') })
          : t).filter(t => t.str.trim());
        // Scene number prints identically in BOTH margins of a scene/shot
        // heading. The left copy is always separated from the body column by
        // a wide gap (far bigger than a word space, so this is drift-proof);
        // detect it there, then drop it and its matching right-margin twin so
        // neither bleeds into the reflowed text. Slugs surface it as "Sc. N".
        let sceneNum = '';
        {
          const xs = [...live].sort((a, b) => a.x - b.x);
          if (xs.length >= 2 && /^[A-Z]{0,3}\d+[A-Z0-9]*$/.test(xs[0].str.trim())
              && xs[1].x - (xs[0].x + xs[0].w) > 16) {
            sceneNum = xs[0].str.trim();
            const drop = new Set([xs[0]]);
            const last = xs[xs.length - 1];
            if (last !== xs[0] && last.str.trim() === sceneNum) drop.add(last);
            live = live.filter(t => !drop.has(t));
          }
        }
        // words are included or excluded WHOLE: a glyph cluster that starts
        // in the body keeps its contiguous glyphs even past the margin
        // boundary (otherwise per-glyph docs lose trailing letters)
        const bodyItems = [];
        {
          let prevEnd = null;
          for (const t of live.filter(t2 => t2.x + t2.w > ML).sort((a2, b2) => a2.x - b2.x)) {
            const wordGap = Math.max(1.5, 0.25 * (t.size || 12));
            const cont = prevEnd != null && t.x - prevEnd < wordGap;
            if (t.x < marginR || (cont && bodyItems.length)) {
              bodyItems.push(t);
              prevEnd = t.x + t.w;
            } else prevEnd = null;
          }
        }
        if (!bodyItems.length) continue;
        const text = textFromItems(bodyItems);
        if (!text) continue;
        const bigGap = prevY != null && prevY - L.y > 20;
        prevY = L.y;

        if (L.cls === 'dual') {
          flushPara();
          if (!dual) dual = { left: { cue: '', text: '' }, right: { cue: '', text: '' } };
          const leftT = textFromItems(bodyItems.filter(t => t.x < P.width / 2));
          const rightT = textFromItems(bodyItems.filter(t => t.x >= P.width / 2));
          if (!dual.left.cue && !dual.left.text.trim() && capsy(leftT)) {
            dual.left.cue = leftT; dual.right.cue = rightT;
          } else {
            if (leftT) dual.left.text += ' ' + leftT;
            if (rightT) dual.right.text += ' ' + rightT;
          }
          continue;
        }
        if (dual) flushDual();
        if (L.cls === 'more') continue;

        if (L.cls === 'cue') {
          flushPara();
          push({ t: 'cue', text, name: lineName.get(L) || normalizeCueName(text) });
          continue;
        }
        if (L.cls === 'dialogue') {
          const name = lineName.get(L) || null;
          if (paren || /^\(/.test(text)) {
            if (!paren) {
              if (para) { push(para); para = null; }
              paren = { t: 'paren', text, name };
            } else paren.text += ' ' + text;
            if (/\)\s*$/.test(text)) { push(paren); paren = null; }
            continue;
          }
          if (para && para.t === 'dialogue' && para.name === name && !bigGap) para.text += ' ' + text;
          else { flushPara(); para = { t: 'dialogue', text, name }; }
          continue;
        }
        // 'other': slug / transition / action
        if (SLUG_RE.test(text)) {
          flushPara();
          // margin scene numbers were already stripped from `text` above;
          // show the number once, labeled and set clear of the heading, so
          // "- DAY     Sc. 24" can't read as the phrase "DAY 24".
          curScene = { id: sceneNum || null, heading: normalizeHeading(text) };
          push({ t: 'slug', text: text + (sceneNum ? '     Sc. ' + sceneNum : ''), heading: curScene.heading });
          continue;
        }
        if (/^(CUT TO|DISSOLVE|FADE|SMASH CUT|MATCH CUT|TIME CUT|END OF)/.test(text) && L.x0 > P.width / 2) {
          flushPara();
          push({ t: 'transition', text });
          continue;
        }
        if (para && para.t === 'action' && !bigGap) para.text += ' ' + text;
        else { flushPara(); para = { t: 'action', text }; }
      }
      flushPara(); flushDual();
    }
    return els;
  }

  // ---------- highlighting ----------
  // Translucent-pastel effect via a Multiply-blend fill painted AFTER the page
  // content: white paper becomes the pastel, black glyphs stay black, and any
  // opaque white background fills inside form XObjects (real sides have them)
  // can't hide the highlight. Glyphs are never altered or overlaid with
  // opaque ink — text stays crisp, selectable and printable, and every color
  // is light enough (luminance >= ~0.87) that grayscale printing keeps full
  // text contrast.
  const PALETTE = [
    { key: 'yellow',   hex: '#FFF39E', rgb: [1.000, 0.953, 0.620] },
    { key: 'mint',     hex: '#D5F4DA', rgb: [0.835, 0.957, 0.855] },
    { key: 'sky',      hex: '#D3E9FA', rgb: [0.827, 0.914, 0.980] },
    { key: 'lavender', hex: '#E5DDF7', rgb: [0.898, 0.867, 0.969] },
    { key: 'peach',    hex: '#FFE3CB', rgb: [1.000, 0.890, 0.796] },
    { key: 'pink',     hex: '#FBDAE7', rgb: [0.984, 0.855, 0.906] },
    { key: 'sage',     hex: '#E2EDD8', rgb: [0.886, 0.929, 0.847] },
    { key: 'sand',     hex: '#F0E6D1', rgb: [0.941, 0.902, 0.820] },
  ];

  function roundedRectPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    const k = 0.5523 * r;
    const f = fmt;
    return [
      `${f(x + r)} ${f(y)} m`,
      `${f(x + w - r)} ${f(y)} l`,
      `${f(x + w - r + k)} ${f(y)} ${f(x + w)} ${f(y + r - k)} ${f(x + w)} ${f(y + r)} c`,
      `${f(x + w)} ${f(y + h - r)} l`,
      `${f(x + w)} ${f(y + h - r + k)} ${f(x + w - r + k)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)} c`,
      `${f(x + r)} ${f(y + h)} l`,
      `${f(x + r - k)} ${f(y + h)} ${f(x)} ${f(y + h - r + k)} ${f(x)} ${f(y + h - r)} c`,
      `${f(x)} ${f(y + r)} l`,
      `${f(x)} ${f(y + r - k)} ${f(x + r - k)} ${f(y)} ${f(x + r)} ${f(y)} c`,
      'h',
    ].join('\n');
  }

  // One rounded rect per cue-led block of a highlighted character: covers the
  // cue line, parentheticals, (MORE) and every dialogue line, at the page's
  // APPLIED scale (same uniform-anchor map as the rewriter, so the rect lands
  // on the enlarged text). Dual-dialogue blocks are never painted.
  // pageAnchor (whole-page mode): every line, cue included, scales about the
  // page's content-center anchor instead of only dialogue about the column.
  function highlightRectsForPage(P, cal, s, hl, pageAnchor) {
    const out = [];
    if (!P.blocks || !P.blocks.length) return out;
    const C = pageAnchor != null ? pageAnchor : cal.dialX + cal.colW / 2;
    for (const B of P.blocks) {
      const idx = hl[B.name];
      const pal = idx != null && PALETTE[idx];
      if (!pal) continue;
      if (!B.lines.some(l => l.cls === 'dialogue')) continue;
      let x0 = Infinity, x1 = -Infinity, top = -Infinity, bot = Infinity;
      for (const L of [B.cue, ...B.lines]) {
        const scaled = s > 1.001 && (pageAnchor != null
          ? L.ax0 != null
          : ((L.cls === 'dialogue' || L.cls === 'cue') && L.enlarge !== false));
        const eff = scaled ? s : 1;
        const lx0 = pageAnchor != null && L.ax0 != null ? L.ax0 : (L.dx0 != null ? L.dx0 : L.x0);
        const lx1 = pageAnchor != null && L.ax1 != null ? L.ax1 : (L.dx1 != null ? L.dx1 : L.x1);
        x0 = Math.min(x0, scaled ? C + s * (lx0 - C) : lx0);
        x1 = Math.max(x1, scaled ? C + s * (lx1 - C) : lx1);
        const size = median(L.items.map(i => i.size)) || 12;
        top = Math.max(top, L.y + 0.78 * size * eff);
        bot = Math.min(bot, L.y - 0.24 * size * eff);
      }
      out.push({ x: x0 - 3, y: bot - 1.5, w: x1 - x0 + 6, h: top - bot + 3, rgb: pal.rgb, name: B.name });
    }
    return out;
  }

  // ---------- public API ----------
  return function createSidesEngine({ pdfjsLib, PDFLib, policy }) {
    POL = compilePolicy(policy);

    async function extract(bytes) {
      // pdf.js 4.2+/5.x iterates its text-content ReadableStream with `for await`.
      // WebKit only shipped ReadableStream async iteration in Safari 26, so every
      // iPhone on Safari 15.4-18.x throws at the FIRST getTextContent (scriptparse
      // #43, cliff 2). core-js does not patch web streams (the legacy build sails
      // through) and Node has been async-iterable since 16, so this is invisible to
      // both the legacy polyfills and Node smoke tests. Install the standard
      // MDN-shape asyncIterator on the main thread before any getTextContent.
      // Feature-detected and idempotent: a no-op on Safari 26+ and on Node.
      if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
        const values = function ({ preventCancel = false } = {}) {
          const reader = this.getReader();
          return {
            async next() {
              try {
                const r = await reader.read();
                if (r.done) reader.releaseLock();
                return r;
              } catch (e) { reader.releaseLock(); throw e; }
            },
            async return(value) {
              if (!preventCancel) { const c = reader.cancel(value); reader.releaseLock(); await c; }
              else { reader.releaseLock(); }
              return { done: true, value };
            },
            [Symbol.asyncIterator]() { return this; },
          };
        };
        if (!ReadableStream.prototype.values) ReadableStream.prototype.values = values;
        ReadableStream.prototype[Symbol.asyncIterator] = ReadableStream.prototype.values;
      }
      const task = pdfjsLib.getDocument({
        data: bytes.slice(), useSystemFonts: true, isEvalSupported: false, disableFontFace: true,
      });
      const doc = await task.promise;
      const pages = [];
      let totalChars = 0;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const items = tc.items
          .filter(it => it.str && it.str.trim().length)
          .map((it, seq) => {
            const size = Math.hypot(it.transform[2], it.transform[3]);
            return {
              str: it.str, seq, // seq = content (reading) order
              x: it.transform[4], y: it.transform[5],
              w: it.width, size,
              rot: Math.abs(it.transform[1]) > 0.05 * (size || 1), // watermarks
            };
          });
        for (const it of items) totalChars += it.str.length;
        // Rotated overlay text (per-recipient watermarks, burn-in stamps) is
        // not part of the horizontal screenplay layout. Exclude it from
        // line-building so a rotated glyph that shares a cue's baseline can't
        // add a left segment / shift x0 and knock the cue out of its band,
        // dropping the character SILENTLY (no reject rail) — the burn-in
        // silent-loss class, scriptparse #37. Reader mode already drops
        // item.rot; the classifier now does too. The rewriter still sees the
        // raw stream, so the watermark bytes stay byte-identical in the output.
        const bodyItems = items.filter(it => !it.rot);
        // items kept raw so process() can re-build lines after grey-region
        // exclusion (rects only known once the content streams are parsed)
        pages.push({ index: p, width: vp.viewBox[2] - vp.viewBox[0], height: vp.viewBox[3] - vp.viewBox[1], lines: buildLines(bodyItems), items: bodyItems, rotatedItems: items.length - bodyItems.length });
      }
      await doc.destroy();
      return { pages, totalChars };
    }

    const scannedError = () => {
      const err = new Error('No extractable text found — this looks like a scanned PDF. Sides Enlarger v1 needs a text-based PDF (ask production for the original export).');
      err.code = 'SCANNED';
      return err;
    };

    // Extraction-only pass: characters + per-page summary, no rewrite.
    async function analyze(bytes) {
      const { pages, totalChars } = await extract(bytes);
      if (totalChars < 40) throw scannedError();
      for (const P of pages) P.live = P.items;
      const burn = stripRepeatedBurnIn(pages);
      const cal = calibrate(pages);
      if (cal) for (const P of pages) classifyPage(P, cal);
      return {
        calibration: cal,
        policyVersion: POL.version,
        characters: cal ? collectCharacters(pages) : [],
        rejectedCues: cal ? collectRejectedCues(pages) : [],
        burnIns: burn.rail,
        pages: pages.map(P => ({ page: P.index, dialogueLines: P.lines.filter(l => l.cls === 'dialogue').length, hasDual: !!P.hasDual })),
      };
    }

    // Reader mode renderer: verbatim element text re-wrapped at the reader
    // size into a fresh PDF (clean serif, slug headings, centered cues,
    // full-width dialogue/action). Deliberately breaks page parity; every
    // page carries a footer saying so. Highlights paint as pastel strips
    // UNDER the text (we own the white background here).
    async function renderReader(elements, requested, hlMap, report) {
      const doc = await PDFLib.PDFDocument.create();
      const F = await doc.embedFont(PDFLib.StandardFonts.TimesRoman);
      const FB = await doc.embedFont(PDFLib.StandardFonts.TimesRomanBold);
      const FI = await doc.embedFont(PDFLib.StandardFonts.TimesRomanItalic);
      const W = 612, H = 792, MX = 64, TOP = 60, BOT = 58;
      const size = Math.round(12 * requested * 10) / 10;
      const lh = Math.round(size * 1.42 * 10) / 10;
      const colW = W - 2 * MX;
      const sanitize = t =>
        t.replace(/[­‐‑‒]/g, '-').replace(/[^\x20-\x7E -ÿ–—‘’“”…]/g, '?');
      const wrap = (text, font, sz, width) => {
        const out = [];
        let cur = '';
        for (const w0 of text.split(' ')) {
          const t2 = cur ? cur + ' ' + w0 : w0;
          if (!cur || font.widthOfTextAtSize(t2, sz) <= width) cur = t2;
          else { out.push(cur); cur = w0; }
        }
        if (cur) out.push(cur);
        return out;
      };
      let page = null, y = 0, readerPage = 0;
      const gray = PDFLib.rgb(0.45, 0.45, 0.45);
      const newPage = () => {
        readerPage++;
        page = doc.addPage([W, H]);
        y = H - TOP;
        page.drawText('READER MODE - reflowed text; page numbers do not match the shooting script',
          { x: MX, y: 30, size: 7.5, font: F, color: gray });
        const pn = String(readerPage);
        page.drawText(pn, { x: W - MX - F.widthOfTextAtSize(pn, 9), y: 30, size: 9, font: F, color: gray });
      };
      newPage();
      const ensure = h => { if (y - h < BOT) newPage(); };
      const drawLines = (lines, font, sz, opts2) => {
        for (const ln of lines) {
          ensure(lh);
          if (opts2.hl) {
            // Balanced top/bottom breathing room: center the strip on the
            // line's glyphs (Times ascent ~0.7, descent ~0.2 of size) instead
            // of hugging the baseline, which left air on top but cropped
            // descenders at the bottom. pad on each side; height >= lh keeps a
            // multi-line block a continuous strip.
            const base = y - lh + sz * 0.32, pad = sz * 0.30;
            page.drawRectangle({ x: MX - 6, y: base - sz * 0.20 - pad, width: colW + 12,
              height: sz * 0.90 + 2 * pad, color: opts2.hl });
          }
          const tw = font.widthOfTextAtSize(ln, sz);
          const x = opts2.align === 'center' ? (W - tw) / 2 : (opts2.align === 'right' ? W - MX - tw : MX);
          page.drawText(ln, { x, y: y - lh + sz * 0.32, size: sz, font });
          y -= lh;
        }
      };
      const rgbOf = i => PDFLib.rgb(PALETTE[i].rgb[0], PALETTE[i].rgb[1], PALETTE[i].rgb[2]);
      report.readerBreaks = [];
      for (const el of elements) {
        const text = sanitize(el.text);
        const hlIdx = el.name != null && hlMap[el.name] != null ? hlMap[el.name] : null;
        const hl = hlIdx != null ? rgbOf(hlIdx) : null;
        switch (el.t) {
          case 'break': {
            // original-script page marker: a labeled gray rule with the full
            // header name (trimmed at word boundaries to fit one line)
            const sz = Math.max(8, size * 0.6);
            let label = text;
            const maxW = colW - 36;
            while (label.indexOf(' ') !== -1 && F.widthOfTextAtSize(label, sz) > maxW) {
              label = label.slice(0, label.lastIndexOf(' ')).trim();
            }
            report.readerBreaks.push(label);
            ensure(lh * 2.2);
            y -= lh * 0.6;
            const tw = F.widthOfTextAtSize(label, sz);
            const midY = y - sz * 0.35;
            page.drawLine({ start: { x: MX, y: midY }, end: { x: (W - tw) / 2 - 9, y: midY }, thickness: 0.7, color: gray });
            page.drawLine({ start: { x: (W + tw) / 2 + 9, y: midY }, end: { x: W - MX, y: midY }, thickness: 0.7, color: gray });
            page.drawText(label, { x: (W - tw) / 2, y: midY - sz * 0.32, size: sz, font: F, color: gray });
            y -= lh * 0.75;
            break;
          }
          case 'slug': {
            // a new scene: thick rule above the heading
            const lines = wrap(text, FB, size * 1.02, colW);
            ensure(lh * (lines.length + 2)); // keep heading with what follows
            y -= lh * 0.55;
            page.drawLine({ start: { x: MX, y: y }, end: { x: W - MX, y: y }, thickness: 2.6, color: PDFLib.rgb(0.15, 0.15, 0.15) });
            y -= lh * 0.45;
            drawLines(lines, FB, size * 1.02, {});
            y -= lh * 0.2;
            break;
          }
          case 'action':
            y -= lh * 0.3;
            drawLines(wrap(text, F, size, colW), F, size, {});
            break;
          case 'cue': {
            const lines = wrap(text, F, size, colW);
            ensure(lh * (lines.length + 2)); // keep the name with its lines
            y -= lh * 0.45;
            drawLines(lines, F, size, { align: 'center', hl });
            break;
          }
          case 'paren':
            drawLines(wrap(text, FI, size, colW * 0.8), FI, size, { align: 'center', hl });
            break;
          case 'dialogue':
            drawLines(wrap(text, F, size, colW), F, size, { hl });
            break;
          case 'transition':
            y -= lh * 0.3;
            drawLines(wrap(text, F, size, colW), F, size, { align: 'right' });
            break;
        }
      }
      report.readerPages = doc.getPageCount();
      return doc.save({ useObjectStreams: false });
    }

    async function process(bytes, opts = {}) {
      const requested = Math.min(1.5, Math.max(1.0, opts.scale || 1.25));
      const { pages, totalChars } = await extract(bytes);

      if (totalChars < 40) throw scannedError();

      // mode: 'dialogue' (default) scales dialogue runs in place around their
      // baselines; 'page' zooms the ENTIRE page uniformly toward the margins;
      // 'reader' reflows the script into new pages (parity deliberately off).
      const mode = opts.mode === 'page' || opts.mode === 'reader' ? opts.mode : 'dialogue';
      // optional selective enlargement: only these characters' dialogue grows
      let enlargeSet = null;
      if (mode === 'dialogue' && opts.enlargeOnly != null) {
        enlargeSet = new Set((opts.enlargeOnly || []).map(normalizeCueName).filter(Boolean));
      }

      // requested highlights: { CHARACTER NAME: palette index }
      const hl = {};
      if (opts.highlights) {
        for (const k of Object.keys(opts.highlights)) {
          const idx = opts.highlights[k];
          if (idx == null || !PALETTE[idx]) continue;
          const n = normalizeCueName(k);
          if (n) hl[n] = idx;
        }
      }

      // ---- PDF-lib load, hoisted ahead of classification: grey-region
      // detection reads the raw content streams, and its exclusions must land
      // BEFORE lines are built and classified. Grey-shaded page regions are
      // omitted / non-shooting context (Peter's rule, 2026-08-05): their text
      // is never enlarged, never highlighted, contributes no characters, and
      // is dropped from reader mode. The bytes stay untouched.
      const pdfDoc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
      const ctx = pdfDoc.context;
      const wasEncrypted = await decryptInPlace(PDFLib, pdfDoc);
      const pdfPages = pdfDoc.getPages();
      if (pdfPages.length !== pages.length) throw new Error('internal: page count mismatch between parsers');

      const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
      const latinOf = u8 => { let s = ''; for (let b = 0; b < u8.length; b++) s += String.fromCharCode(u8[b]); return s; };
      const bytesOfLatin = str => { const a = new Uint8Array(str.length); for (let b = 0; b < str.length; b++) a[b] = str.charCodeAt(b) & 0xff; return a; };
      const decodeStream = st => {
        const hasFilter = st.dict && st.dict.get(N('Filter'));
        if (st instanceof PDFLib.PDFRawStream) return hasFilter ? PDFLib.decodePDFRawStream(st).decode() : st.contents;
        if (st.getContents) return st.getContents();
        return new Uint8Array(0);
      };
      const matrixOf = dict => {
        const mArr = dict && dict.get(N('Matrix'));
        const r = mArr && ctx.lookup(mArr);
        if (r && r.size && r.size() === 6) return [0, 1, 2, 3, 4, 5].map(k => ctx.lookup(r.get(k)).asNumber());
        return [1, 0, 0, 1, 0, 0];
      };
      const pageStreamsLatin = page0 => {
        const resolved0 = ctx.lookup(page0.node.get(N('Contents')));
        const streams0 = [];
        if (resolved0 instanceof PDFLib.PDFArray) {
          for (let k = 0; k < resolved0.size(); k++) streams0.push(ctx.lookup(resolved0.get(k)));
        } else if (resolved0) streams0.push(resolved0);
        let latin0 = '';
        for (const st of streams0) latin0 += latinOf(decodeStream(st)) + '\n';
        return latin0;
      };
      const pageResourcesOf = page0 => page0.node.Resources ? page0.node.Resources() : ctx.lookup(page0.node.get(N('Resources')));

      // Grey-region detection: filled `re` rects with an even grey fill
      // (components equal within 0.05, mean 0.2-0.92 — validated against real
      // packets at 0.75/0.85) big enough to hold a text line (>= 36x14pt),
      // collected in PDF user space through form CTMs. Best-effort: any parse
      // trouble means no exclusions, never a failure.
      const collectGreyRects = () => {
        const perPage = [];
        const isGrey = comps => {
          if (!comps || !comps.length || comps.some(v => !isFinite(v))) return false;
          let mn = Infinity, mx = -Infinity, sum = 0;
          for (const v of comps) { mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; }
          const mean = sum / comps.length;
          return mx - mn < 0.05 && mean >= 0.2 && mean <= 0.92;
        };
        const resolveXF = (resources, tok) => {
          if (!resources || !tok || tok.raw[0] !== '/') return null;
          const xoRef = resources.get(N('XObject'));
          const xoDict = xoRef && ctx.lookup(xoRef);
          const ref = xoDict && xoDict.get(N(tok.raw.slice(1)));
          const form = ref && ctx.lookup(ref);
          if (!form || !form.dict) return null;
          const sub = form.dict.get(N('Subtype'));
          if (!sub || sub.toString() !== '/Form') return null;
          const fResRef = form.dict.get(N('Resources'));
          return { form, res: fResRef ? ctx.lookup(fResRef) : resources };
        };
        const walk = (src, resources, ctm0, out, depth) => {
          if (depth > 4) return;
          if (src.indexOf('BI') !== -1 && /(^|[\s>\]])BI[\s\/]/.test(src)) return;
          let ctm = ctm0, fill = null; // fill: component array, or null = unknown/not-grey-able
          const stack = [];
          let rects = [];
          for (const ins of toInstructions(tokenize(src), src)) {
            const nums = () => ins.operands.map(t => parseFloat(t.raw));
            if (ins.op === 'q') { stack.push({ ctm, fill }); continue; }
            if (ins.op === 'Q') { const s = stack.pop(); if (s) { ctm = s.ctm; fill = s.fill; } continue; }
            if (ins.op === 'cm' && ins.operands.length === 6) { ctm = mul(nums(), ctm); continue; }
            if (ins.op === 'g') { fill = nums().slice(0, 1); continue; }
            if (ins.op === 'rg') { fill = nums().slice(0, 3); continue; }
            if (ins.op === 'k') { const n4 = nums(); fill = (Math.max(n4[0], n4[1], n4[2]) - Math.min(n4[0], n4[1], n4[2]) < 0.05) ? [1 - Math.min(1, n4[3] + (n4[0] + n4[1] + n4[2]) / 3)] : null; continue; }
            if (ins.op === 'cs') { fill = null; continue; }
            if (ins.op === 'sc' || ins.op === 'scn') {
              const vals = ins.operands.map(t => parseFloat(t.raw));
              fill = (vals.length >= 1 && vals.length <= 3 && vals.every(v => isFinite(v))) ? vals
                : (vals.length === 4 && vals.every(v => isFinite(v))) ? [1 - Math.min(1, vals[3] + (vals[0] + vals[1] + vals[2]) / 3)]
                : null;
              continue;
            }
            if (ins.op === 're' && ins.operands.length === 4) { rects.push(nums()); continue; }
            if (ins.op === 'f' || ins.op === 'F' || ins.op === 'f*' || ins.op === 'b' || ins.op === 'b*' || ins.op === 'B' || ins.op === 'B*') {
              if (isGrey(fill)) {
                for (const r of rects) {
                  const c1 = apply(ctm, r[0], r[1]), c2 = apply(ctm, r[0] + r[2], r[1] + r[3]);
                  const x0 = Math.min(c1[0], c2[0]), x1 = Math.max(c1[0], c2[0]);
                  const y0 = Math.min(c1[1], c2[1]), y1 = Math.max(c1[1], c2[1]);
                  if (x1 - x0 >= 36 && y1 - y0 >= 14) out.push([x0, y0, x1, y1]);
                }
              }
              rects = []; continue;
            }
            if (ins.op === 'S' || ins.op === 's' || ins.op === 'n') { rects = []; continue; }
            if (ins.op === 'Do') {
              const hit = resolveXF(resources, ins.operands[0]);
              if (hit) { try { walk(latinOf(decodeStream(hit.form)), hit.res, mul(matrixOf(hit.form.dict), ctm), out, depth + 1); } catch (e) { /* best-effort */ } }
              continue;
            }
          }
        };
        for (const page0 of pdfPages) {
          const out = [];
          try { walk(pageStreamsLatin(page0), pageResourcesOf(page0), [1, 0, 0, 1, 0, 0], out, 0); } catch (e) { /* best-effort */ }
          perPage.push(out);
        }
        return perPage;
      };

      for (const P of pages) P.live = P.items; // the items line-building currently sees
      let greyPages = 0, greyRuns = 0;
      try {
        const greyRects = collectGreyRects();
        for (let i = 0; i < pages.length; i++) {
          const rects = greyRects[i];
          if (!rects || !rects.length) continue;
          const P = pages[i];
          const live = P.items.filter(it => {
            const px = it.x + it.w / 2, py = it.y + 3;
            return !rects.some(r => px >= r[0] - 1 && px <= r[2] + 1 && py >= r[1] - 1 && py <= r[3] + 1);
          });
          if (live.length !== P.items.length) {
            P.greyExcluded = P.items.length - live.length;
            greyRuns += P.greyExcluded; greyPages++;
            P.live = live;
            P.lines = buildLines(live);
          }
        }
      } catch (e) { /* grey detection is best-effort; classification proceeds on all text */ }

      // Optional declared watermark text (opts.watermarkText): HEADLESS-ONLY
      // seam, no UI (the field was removed in v1.9.2 as speculative — exact
      // matching misses the merged-into-a-body-segment case where a
      // non-rotated stamp does real damage, and the harmless own-line case
      // needs no exclusion). Kept for tools/debugging and as the hook a
      // .sceneline burn_ins rail can feed programmatically once the policy
      // strip lands with package adoption; rotated stamps are automatic
      // (above). Declared exclusion of an exact string, NOT content-based
      // classification: the geometric-detection law stands. Matches whole
      // items and whole gap-joined segments; bytes stay untouched.
      // scriptparse burn-in signal 2: repeated-position stamps (policy-driven,
      // corpus-pinned) leave line-building before calibration; see
      // stripRepeatedBurnIn. Runs after the grey exclusion, before the
      // declared-text seam below.
      const burn = stripRepeatedBurnIn(pages);
      const normWm = s => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
      const wmSet = new Set([].concat(opts.watermarkText || []).map(normWm).filter(Boolean));
      let wmRuns = 0, wmPages = 0;
      if (wmSet.size) {
        for (const P of pages) {
          let live = P.live.filter(it => !wmSet.has(normWm(it.str)));
          let lines = buildLines(live);
          const drop = new Set();
          for (const L of lines) for (const sg of L.segments) {
            if (wmSet.has(normWm(sg.text))) for (const it of sg.items) drop.add(it);
          }
          if (drop.size) { live = live.filter(it => !drop.has(it)); lines = buildLines(live); }
          const removed = P.live.length - live.length;
          if (removed) { wmRuns += removed; wmPages++; P.live = live; P.lines = lines; }
        }
      }

      const cal = calibrate(pages);
      const report = { requestedScale: requested, mode, calibration: cal, pages: [], warnings: [] };
      report.enlargeOnly = enlargeSet ? Array.from(enlargeSet) : null;
      if (wasEncrypted) report.warnings.push('Input was permission-locked (encrypted); output is a decrypted copy — treat it with the same care as the original.');
      if (greyRuns) report.warnings.push('Grey-shaded (omitted) regions detected: ' + greyRuns + ' text run' + (greyRuns === 1 ? '' : 's') + ' across ' + greyPages + ' page' + (greyPages === 1 ? '' : 's') + ' left untouched — not enlarged, not highlighted, and not counted toward the character list.');
      if (wmSet.size) {
        report.warnings.push(wmRuns
          ? 'Watermark text matched and excluded from character detection on ' + wmPages + ' page' + (wmPages === 1 ? '' : 's') + ' (' + wmRuns + ' run' + (wmRuns === 1 ? '' : 's') + '); the watermark itself is untouched.'
          : 'The watermark text you entered did not match any text in this PDF — check the spelling, or leave the field empty.');
      }
      if (!cal) {
        report.warnings.push('Could not locate character cues geometrically — layout too unusual. PDF returned unchanged.');
        report.characters = [];
        report.sluglines = [];
        return { bytes, report };
      }
      const wantHl = Object.keys(hl).length > 0;

      // classify + per-page scale
      const widths = [];
      for (const P of pages) {
        classifyPage(P, cal);
        for (const L of P.lines) if (L.cls === 'dialogue') widths.push((L.dx1 != null ? L.dx1 : L.x1) - (L.dx0 != null ? L.dx0 : L.x0));
      }
      const colW = Math.min(300, Math.max(200, quantile(widths, 0.9) || 252));
      cal.colW = colW;
      const anchorC = cal.dialX + colW / 2; // uniform-scale anchor (see pageScale)
      report.policyVersion = POL.version;
      report.characters = collectCharacters(pages);
      report.sluglines = collectSluglines(pages); // for .sceneline draft-mismatch subset check
      // Never-silent rails (#37 doctrine): what the shared gate kept off the
      // list, and what the two burn-in signals stripped from detection.
      report.rejectedCues = collectRejectedCues(pages);
      if (report.rejectedCues.length) {
        report.warnings.push('Kept off the character list by the shared name rule (scriptparse policy ' + POL.version + '): '
          + report.rejectedCues.map(r => r.name + ' (' + r.reason + ', ' + r.lines + ' line' + (r.lines === 1 ? '' : 's') + ')').join('; ')
          + '. Their dialogue still enlarges in All-dialogue mode; add the name by hand to select or highlight it.');
      }
      report.burnIns = burn.rail;
      if (burn.runs) {
        report.warnings.push('Repeated-position burn-in text found on ' + burn.pages + ' page' + (burn.pages === 1 ? '' : 's') + ' (' + burn.runs + ' run' + (burn.runs === 1 ? '' : 's') + ') and excluded from character detection: '
          + burn.rail.map(b => '“' + b.text + '”').join(', ') + '. The stamp itself is untouched in the output.');
      }
      const rotRuns = pages.reduce((n, P) => n + (P.rotatedItems || 0), 0);
      if (rotRuns) report.warnings.push('Rotated watermark/burn-in text detected (' + rotRuns + ' run' + (rotRuns === 1 ? '' : 's') + ') and excluded from character detection, so cues beneath it are still found.');
      // the character name grows with its block: a block's cue is eligible
      // whenever the block has eligible dialogue (a bare cue-shaped label
      // with no dialogue under it never scales)
      for (const P of pages) {
        for (const B of (P.blocks || [])) {
          const on = (enlargeSet ? enlargeSet.has(B.name) : true) &&
            B.lines.some(l => l.cls === 'dialogue');
          B.cue.enlarge = on;
          if (enlargeSet) for (const L of B.lines) L.enlarge = on;
        }
        // defensive: any dialogue line outside a block stays untouched
        if (enlargeSet) for (const L of P.lines) if (L.cls === 'dialogue' && L.enlarge === undefined) L.enlarge = false;
      }
      if (wantHl) {
        report.highlights = {};
        for (const n of Object.keys(hl)) report.highlights[n] = { palette: hl[n], key: PALETTE[hl[n]].key, rgb: PALETTE[hl[n]].rgb };
      }

      if (mode === 'reader') {
        markFurniture(pages);
        const elements = buildReaderElements(pages);
        report.sourcePages = pages.length;
        report.warnings.push('Reader mode reflows the script into new pages: page numbering does NOT match the original sides. Do not use it for on-set page references.');
        if (opts.emit === 'elements') {
          // the reader as DATA: the same element stream the PDF renderer
          // consumes, numbered, with each element's highlight resolved from
          // the requested map. No PDF is built; renderReaderPdf() turns this
          // exact array back into the Reader-mode PDF later.
          elements.forEach((el, i) => {
            el.i = i;
            const idx = el.name != null && hl[el.name] != null ? hl[el.name] : null;
            el.highlight = idx != null ? { palette: idx, key: PALETTE[idx].key, hex: PALETTE[idx].hex, rgb: PALETTE[idx].rgb } : null;
          });
          report.elements = elements.length;
          return { elements, report };
        }
        const readerBytes = await renderReader(elements, requested, hl, report);
        return { bytes: readerBytes, report };
      }

      // (pdfDoc/ctx/decoding helpers are hoisted above classification — the
      // grey-region pass needs them before lines are built)
      const putStreamPlain = (st, str) => {
        const b = bytesOfLatin(str);
        st.contents = b;
        st.dict.set(N('Length'), PDFLib.PDFNumber.of(b.length));
        st.dict.delete(N('Filter'));
        st.dict.delete(N('DecodeParms'));
        st.dict.delete(N('DL'));
      };
      const visitedForms = new Set();

      // Forms invoked more than once (shared across pages, or placed twice)
      // can only be mutated once, which would bake one placement's geometry
      // into every other placement. Count every invocation up front; pages
      // that draw text through a multi-use form are left unscaled entirely.
      const formUse = new Map();     // refKey -> total invocations
      const formHasText = new Map(); // refKey -> shows HORIZONTAL text at some invocation
      const pageSharedTextForm = [];
      {
        // A multi-use form whose text is ALL rotated (per-recipient watermark
        // stamps: "James Baker" at 40° on every page) can never carry dialogue,
        // so it must not cost the page its enlargement. Collect each form's
        // text matrices in FORM SPACE once, then test them against every
        // invocation's CTM: only horizontal text (same |b| > 0.05*size test as
        // item.rot) marks the form text-carrying. Anything unparseable stays
        // conservative (treated as horizontal). The never-mutate-multi-use
        // rule in rewriteLevel is unchanged — stamps stay byte-identical.
        const ID = [1, 0, 0, 1, 0, 0];
        const rotated = m => Math.abs(m[1]) > 0.05 * (Math.hypot(m[2], m[3]) || 1);
        const relCache = new Map(); // refKey -> {mats:[{m,key}], nestedCounts:Map, keys:Set, conservative}
        const resolveForm = (resources, nameTok) => {
          if (!resources || !nameTok || nameTok.raw[0] !== '/') return null;
          const xoRef = resources.get(N('XObject'));
          const xoDict = xoRef && ctx.lookup(xoRef);
          const ref = xoDict && xoDict.get(N(nameTok.raw.slice(1)));
          const form = ref && ctx.lookup(ref);
          if (!form || !form.dict) return null;
          const sub = form.dict.get(N('Subtype'));
          if (!sub || sub.toString() !== '/Form') return null;
          return { form, key: ref.objectNumber + '_' + ref.generationNumber };
        };
        // Parse one form's stream in its own space; nested forms fold their
        // (composed) text matrices and invocation counts into the parent.
        const parseRel = (key, form, outerRes, depth) => {
          if (relCache.has(key)) return relCache.get(key);
          const rel = { mats: [], nestedCounts: new Map(), keys: new Set([key]), conservative: false };
          relCache.set(key, rel); // set first: a self-recursive form stays sane
          const bump = (k, n) => rel.nestedCounts.set(k, (rel.nestedCounts.get(k) || 0) + n);
          try {
            const src = latinOf(decodeStream(form));
            if (src.indexOf('BI') !== -1 && /(^|[\s>\]])BI[\s\/]/.test(src)) { rel.conservative = true; return rel; }
            if (depth > 4) { rel.conservative = true; return rel; }
            const fResRef = form.dict.get(N('Resources'));
            const fRes = fResRef ? ctx.lookup(fResRef) : outerRes;
            let ctm = ID, tm = null;
            const stack = [];
            for (const ins of toInstructions(tokenize(src), src)) {
              const nums = () => ins.operands.map(t => parseFloat(t.raw));
              if (ins.op === 'q') { stack.push(ctm); continue; }
              if (ins.op === 'Q') { ctm = stack.pop() || ID; continue; }
              if (ins.op === 'cm' && ins.operands.length === 6) { ctm = mul(nums(), ctm); continue; }
              if (ins.op === 'BT') { tm = ID; continue; }
              if (ins.op === 'ET') { tm = null; continue; }
              if (ins.op === 'Tm' && ins.operands.length === 6) { tm = nums(); continue; }
              if ((ins.op === 'Td' || ins.op === 'TD') && tm) { const n2 = nums(); tm = mul([1, 0, 0, 1, n2[0], n2[1]], tm); continue; }
              if (ins.op === 'Tj' || ins.op === 'TJ' || ins.op === "'" || ins.op === '"') {
                if (!tm) { rel.conservative = true; break; }
                rel.mats.push({ m: mul(tm, ctm), key });
                if (rel.mats.length > 800) { rel.conservative = true; break; }
                continue;
              }
              if (ins.op === 'Do') {
                const hit = resolveForm(fRes, ins.operands[0]);
                if (!hit) continue;
                bump(hit.key, 1);
                const inner = parseRel(hit.key, hit.form, fRes, depth + 1);
                if (inner.conservative) { rel.conservative = true; break; }
                const innerInv = mul(matrixOf(hit.form.dict), ctm);
                for (const t of inner.mats) rel.mats.push({ m: mul(t.m, innerInv), key: t.key });
                for (const k of inner.keys) rel.keys.add(k);
                for (const [k, n] of inner.nestedCounts) bump(k, n);
                if (rel.mats.length > 800) { rel.conservative = true; break; }
              }
            }
          } catch (e) { rel.conservative = true; }
          return rel;
        };
        // Page pass: absolute space. Count every invocation (nested counts fold
        // in per invocation of the parent) and test each form's text rotation
        // under this invocation's CTM.
        const walkPage = (src, resources, keysOut) => {
          if (src.indexOf('BI') !== -1 && /(^|[\s>\]])BI[\s\/]/.test(src)) return; // rewriteStream guards BI pages itself
          let ctm = ID, tm = null;
          const stack = [];
          for (const ins of toInstructions(tokenize(src), src)) {
            const nums = () => ins.operands.map(t => parseFloat(t.raw));
            if (ins.op === 'q') { stack.push(ctm); continue; }
            if (ins.op === 'Q') { ctm = stack.pop() || ID; continue; }
            if (ins.op === 'cm' && ins.operands.length === 6) { ctm = mul(nums(), ctm); continue; }
            if (ins.op === 'BT') { tm = ID; continue; }
            if (ins.op === 'ET') { tm = null; continue; }
            if (ins.op === 'Tm' && ins.operands.length === 6) { tm = nums(); continue; }
            if (ins.op !== 'Do') continue;
            const hit = resolveForm(resources, ins.operands[0]);
            if (!hit) continue;
            formUse.set(hit.key, (formUse.get(hit.key) || 0) + 1);
            const rel = parseRel(hit.key, hit.form, resources, 0);
            for (const [k, n] of rel.nestedCounts) formUse.set(k, (formUse.get(k) || 0) + n);
            for (const k of rel.keys) keysOut.add(k);
            if (rel.conservative) { for (const k of rel.keys) formHasText.set(k, true); continue; }
            const inv = mul(matrixOf(hit.form.dict), ctm);
            for (const t of rel.mats) {
              if (!rotated(mul(t.m, inv))) formHasText.set(t.key, true);
            }
          }
        };
        for (let i = 0; i < pdfPages.length; i++) {
          const keys = new Set();
          const page0 = pdfPages[i];
          const resolved0 = ctx.lookup(page0.node.get(N('Contents')));
          const streams0 = [];
          if (resolved0 instanceof PDFLib.PDFArray) {
            for (let k = 0; k < resolved0.size(); k++) streams0.push(ctx.lookup(resolved0.get(k)));
          } else if (resolved0) streams0.push(resolved0);
          let latin0 = '';
          for (const st of streams0) latin0 += latinOf(decodeStream(st)) + '\n';
          const pageRes0 = page0.node.Resources ? page0.node.Resources() : ctx.lookup(page0.node.get(N('Resources')));
          try { walkPage(latin0, pageRes0, keys); } catch (e) { /* count best-effort */ }
          pageSharedTextForm.push(keys);
        }
        for (let i = 0; i < pageSharedTextForm.length; i++) {
          pageSharedTextForm[i] = [...pageSharedTextForm[i]]
            .some(k => (formUse.get(k) || 0) > 1 && formHasText.get(k));
        }
      }

      // Recursively rewrite a content string, descending into form XObjects.
      // `resources` is the PDFDict in whose /XObject a `Do` name resolves.
      // `visited` guards shared forms per traversal; `collect` switches the
      // whole walk into measure mode (see rewriteStream).
      const rewriteLevel = (src, ctm0, resources, dialogLines, sPage, anchorX, stats, visited, collect) => {
        const onDo = (name, ctmAtDo) => {
          if (!resources) return false;
          const xoDictRef = resources.get(N('XObject'));
          const xoDict = xoDictRef && ctx.lookup(xoDictRef);
          if (!xoDict) return false;
          const ref = xoDict.get(N(name));
          if (!ref) return false;
          const form = ctx.lookup(ref);
          if (!form || !form.dict) return false;
          const sub = form.dict.get(N('Subtype'));
          if (!sub || sub.toString() !== '/Form') return false; // images etc: leave
          const key = ref.objectNumber + '_' + ref.generationNumber;
          if ((formUse.get(key) || 0) > 1) return false; // multi-use: never mutate
          if (visited.has(key)) return false; // already handled this traversal
          visited.add(key);
          const innerCtm = mul(matrixOf(form.dict), ctmAtDo);
          const fResRef = form.dict.get(N('Resources'));
          const fRes = fResRef ? ctx.lookup(fResRef) : resources;
          const innerSrc = latinOf(decodeStream(form));
          const res = rewriteLevel(innerSrc, innerCtm, fRes, dialogLines, sPage, anchorX, stats, visited, collect);
          if (res.changed && !res.bail && res.out != null) { putStreamPlain(form, res.out); return true; }
          return false;
        };
        return rewriteStream(src, ctm0, dialogLines, sPage, anchorX, stats, onDo, collect);
      };

      // ---- highlight painting plumbing (shared ExtGState, appended stream) ----
      let hlGsRef = null;
      const HL_GS = N('GSsidesHL');
      const ensureHlGs = page => {
        if (!hlGsRef) {
          const gs = ctx.obj({});
          gs.set(N('Type'), N('ExtGState'));
          gs.set(N('BM'), N('Multiply'));
          gs.set(N('ca'), PDFLib.PDFNumber.of(1));
          gs.set(N('CA'), PDFLib.PDFNumber.of(1));
          hlGsRef = ctx.register(gs);
        }
        let res = page.node.Resources ? page.node.Resources() : ctx.lookup(page.node.get(N('Resources')));
        if (!res) { res = ctx.obj({}); page.node.set(N('Resources'), res); }
        let egDict = res.get(N('ExtGState')) && ctx.lookup(res.get(N('ExtGState')));
        if (!egDict) { egDict = ctx.obj({}); res.set(N('ExtGState'), egDict); }
        egDict.set(HL_GS, hlGsRef);
      };
      const paintHighlights = (page, rects) => {
        ensureHlGs(page);
        let ops = 'q\n/GSsidesHL gs\n';
        for (const R of rects) {
          ops += `${fmt(R.rgb[0])} ${fmt(R.rgb[1])} ${fmt(R.rgb[2])} rg\n`;
          ops += roundedRectPath(R.x, R.y, R.w, R.h, 3.5) + '\nf\n';
        }
        ops += 'Q';
        const streamRef = ctx.register(ctx.flateStream(bytesOfLatin(ops)));
        const cur = page.node.get(N('Contents'));
        const resolved = ctx.lookup(cur);
        const arr = ctx.obj([]);
        if (resolved instanceof PDFLib.PDFArray) {
          for (let k = 0; k < resolved.size(); k++) arr.push(resolved.get(k));
        } else if (cur) arr.push(cur);
        arr.push(streamRef);
        page.node.set(N('Contents'), arr);
      };

      if (mode === 'page') {
        // "Make it all bigger": every body text line grows around its own
        // unmoved baseline under one per-page horizontal map x' = s*x + t,
        // fitted so the widest stage-direction line spans the full printable
        // width and dialogue widens by the same factor. Margin furniture
        // (left scene numbers, revision stars, page numbers) and repeated
        // header/footer rows stay put exactly. Growth is capped by the page
        // edges, margin marks, clips, and line spacing so ascenders and
        // descenders of adjacent lines don't collide. Baselines never move,
        // so parity stays structural.
        const E = 10, ML = 70;
        markFurniture(pages);
        for (let i = 0; i < pdfPages.length; i++) {
          const P = pages[i];
          const page = pdfPages[i];
          const marginR = P.width - 80;
          const pageReport = { page: i + 1, appliedScale: requested, dialogueLines: P.lines.filter(l => l.cls === 'dialogue').length, warnings: [] };
          report.pages.push(pageReport);

          // a script page has dialogue on it; title pages, coverage, call
          // sheets and revision tables don't, and are never enlarged
          if (!pageReport.dialogueLines) {
            pageReport.appliedScale = 1;
            if (requested > 1.001) pageReport.warnings.push('no dialogue on this page: left at original size (title, coverage and call-sheet pages are not enlarged)');
            continue;
          }

          // split each line: body items scale; margin-mark items and
          // header/footer furniture don't. Item-level split by x thresholds
          // (NOT gap-based segments): left scene numbers sit closer than a
          // segment gap to the slug text and must never ride with the body.
          const body = [];
          const sRows = []; // all printed rows, for the line-spacing fit
          let bx0 = Infinity, bx1 = -Infinity;
          for (const L of P.lines) {
            if (!L.items.length) continue;
            const bs = L.furn ? [] : L.items.filter(t => t.x + t.w > ML && t.x < marginR);
            if (!bs.length) { L.ax0 = L.ax1 = null; sRows.push({ L, fixed: true }); continue; }
            L.ax0 = Math.min(...bs.map(t => t.x));
            L.ax1 = Math.max(...bs.map(t => t.x + t.w));
            const lm = L.items.filter(t => t.x + t.w <= ML);
            const rm = L.items.filter(t => t.x >= marginR);
            L.leftStop = lm.length ? Math.max(...lm.map(t => t.x + t.w)) + 4 : E;
            L.rightStop = rm.length ? Math.min(...rm.map(t => t.x)) - 4 : P.width - E;
            bx0 = Math.min(bx0, L.ax0); bx1 = Math.max(bx1, L.ax1);
            body.push(L);
            sRows.push({ L, fixed: false });
          }
          if (!body.length) { pageReport.appliedScale = 1; continue; }

          // spacing limit: descender above + ascender below <= baseline gap
          // (Courier metrics ~0.157/0.629 em, held slightly safe). Fixed rows
          // (furniture, margin marks) don't scale, so only the scaled side of
          // a mixed pair consumes the gap.
          let sV = requested;
          sRows.sort((p, q) => q.L.y - p.L.y);
          for (let k = 0; k + 1 < sRows.length; k++) {
            const gap = sRows[k].L.y - sRows[k + 1].L.y;
            if (gap < 6) continue; // same visual row (dual columns etc.)
            const du = 0.16 * (median(sRows[k].L.items.map(t => t.size)) || 12);
            const al = 0.64 * (median(sRows[k + 1].L.items.map(t => t.size)) || 12);
            let lim = Infinity;
            if (!sRows[k].fixed && !sRows[k + 1].fixed) lim = gap / (du + al);
            else if (sRows[k].fixed && !sRows[k + 1].fixed) lim = al > 0.01 ? (gap - du) / al : Infinity;
            else if (!sRows[k].fixed && sRows[k + 1].fixed) lim = du > 0.01 ? (gap - al) / du : Infinity;
            sV = Math.min(sV, lim);
          }

          // every body line becomes an eligible "dialogue" proxy spanning its
          // body extent, carrying its own horizontal stops
          const proxies = body.map(L => ({
            y: L.y, x0: L.ax0, x1: L.ax1, dx0: L.ax0, dx1: L.ax1,
            cls: 'dialogue', leftStop: L.leftStop, rightStop: L.rightStop,
          }));
          const resolved = ctx.lookup(page.node.get(N('Contents')));
          const streams = [];
          if (resolved instanceof PDFLib.PDFArray) {
            for (let k = 0; k < resolved.size(); k++) streams.push(ctx.lookup(resolved.get(k)));
          } else if (resolved) streams.push(resolved);
          let latin = '';
          for (const st of streams) latin += latinOf(decodeStream(st)) + '\n';
          const pageRes = page.node.Resources ? page.node.Resources() : ctx.lookup(page.node.get(N('Resources')));

          // the horizontal map is x' = s*x + t; find the largest s (then a t)
          // that keeps every body line inside its stops
          const tRange = s => {
            let lo = -Infinity, hi = Infinity;
            for (const pr of proxies) {
              lo = Math.max(lo, pr.leftStop - s * pr.dx0);
              hi = Math.min(hi, pr.rightStop - s * pr.dx1);
            }
            return [lo, hi];
          };
          const maxFeasible = () => {
            let loS = 1, hiS = requested;
            const r = tRange(hiS);
            if (r[0] <= r[1] + 1e-6) return hiS;
            for (let it = 0; it < 24; it++) {
              const mid = (loS + hiS) / 2;
              const rm = tRange(mid);
              if (rm[0] <= rm[1] + 1e-6) loS = mid; else hiS = mid;
            }
            return loS;
          };
          const sGeoNoClip = maxFeasible();

          // clip limit (measure pass): text must never grow out of its clip
          // rect (table cells, row bands) or it gets cut off invisibly. Clips
          // tighten the per-line stops before the final fit.
          let clipBlocked = false;
          if (requested > 1.001) {
            const constraints = [];
            const mstats = { scaledOps: 0, warnings: [] };
            rewriteLevel(latin, [1, 0, 0, 1, 0, 0], pageRes, proxies, requested, 0, mstats, new Set(), constraints);
            for (const c of constraints) {
              if (c.clipUnknown) { clipBlocked = true; break; }
              if (c.clipLo > -Infinity) c.L.leftStop = Math.max(c.L.leftStop, c.clipLo + 0.5);
              if (c.clipHi < Infinity) c.L.rightStop = Math.min(c.L.rightStop, c.clipHi - 0.5);
            }
          }
          const sGeo = clipBlocked ? 1 : maxFeasible();

          let s = Math.max(1, Math.floor(Math.min(requested, sV, sGeo) * 100) / 100);
          if (pageSharedTextForm[i]) {
            s = 1;
            pageReport.appliedScale = 1;
            if (requested > 1.001) pageReport.warnings.push('text on this page lives in a container shared with other pages — left unscaled for safety');
          }
          pageReport.appliedScale = s;
          if (s < requested - 0.005 && !pageSharedTextForm[i]) {
            pageReport.warnings.push(sGeo < sGeoNoClip - 0.005 && sGeo <= sV
              ? `clipped layout (table cells) limits enlargement to ${s.toFixed(2)}x on this page`
              : (sV <= sGeo
                ? `line spacing limits enlargement to ${s.toFixed(2)}x on this page`
                : `text reaches the page edge at ${s.toFixed(2)}x on this page`));
          }

          if (s > 1.001) {
            // place the map: center the grown body in its feasible band, and
            // express s*x + t as the equivalent anchor A = t/(1-s) so the
            // rewriter, highlights and verifier share one form
            const [tLo, tHi] = tRange(s);
            const tCenter = P.width / 2 - s * (bx0 + bx1) / 2;
            const t = Math.min(Math.max(tCenter, tLo), tHi);
            const anchor = t / (1 - s);
            pageReport.anchor = Math.round(anchor * 100) / 100;

            const stats = { scaledOps: 0, warnings: [] };
            const res = rewriteLevel(latin, [1, 0, 0, 1, 0, 0], pageRes, proxies, s, anchor, stats, visitedForms);
            for (const w of stats.warnings) if (pageReport.warnings.indexOf(w) === -1) pageReport.warnings.push(w);
            if (!stats.scaledOps) {
              pageReport.warnings.push('rewriter matched no text — page left unchanged');
              pageReport.appliedScale = 1;
            } else if (res.changed && !res.bail && res.out != null) {
              const ref = ctx.register(ctx.flateStream(bytesOfLatin(res.out)));
              page.node.set(N('Contents'), ref);
            }

            if (wantHl) {
              const rects = highlightRectsForPage(P, cal, pageReport.appliedScale, hl, anchor);
              if (rects.length) {
                paintHighlights(page, rects);
                pageReport.highlighted = rects.map(r => r.name);
              }
            }
          } else if (wantHl) {
            const rects = highlightRectsForPage(P, cal, 1, hl, 0);
            if (rects.length) {
              paintHighlights(page, rects);
              pageReport.highlighted = rects.map(r => r.name);
            }
          }
          if (wantHl && (P.dualNames || []).some(n => hl[n] != null)) {
            pageReport.warnings.push('a highlighted character appears in a dual-dialogue block on this page — dual dialogue is not highlighted');
          }
        }
        const outBytes = await pdfDoc.save({ useObjectStreams: false });
        return { bytes: outBytes, report };
      }

      for (let i = 0; i < pdfPages.length; i++) {
        const P = pages[i];
        const page = pdfPages[i];
        const pageReport = { page: i + 1, appliedScale: requested, dialogueLines: P.lines.filter(l => l.cls === 'dialogue').length, warnings: [] };
        report.pages.push(pageReport);
        // Say what the page actually is. A call sheet's column grid also trips
        // the dual-cue heuristic, so without this it reports itself as a
        // dual-dialogue block instead of a non-script page.
        if (!pageReport.dialogueLines) {
          if (requested > 1.001) pageReport.warnings.push('no dialogue on this page: left at original size (title, coverage and call-sheet pages are not enlarged)');
        } else if (P.hasDual) pageReport.warnings.push('dual-dialogue block detected — left at original size');
        pageReport.enlargedLines = P.lines.filter(l => l.cls === 'dialogue' && l.enlarge !== false).length;
        if (!pageReport.enlargedLines) pageReport.appliedScale = 1;

        if (pageReport.enlargedLines && pageSharedTextForm[i]) {
          pageReport.appliedScale = 1;
          if (requested > 1.001) pageReport.warnings.push('text on this page lives in a container shared with other pages — left unscaled for safety');
        } else if (pageReport.enlargedLines) {
          const s = pageScale(P, requested, colW, cal.dialX);
          pageReport.appliedScale = s;
          if (s < requested - 0.005) pageReport.warnings.push(`enlarged dialogue would not fit — backed off to ${s.toFixed(2)}x on this page`);
          if (s <= 1.001) {
            if (requested > 1.001) pageReport.warnings.push('no enlargement possible without overflowing the page');
            pageReport.appliedScale = 1;
          } else {
            // gather decoded page content (may be an array of streams)
            const resolved = ctx.lookup(page.node.get(N('Contents')));
            const streams = [];
            if (resolved instanceof PDFLib.PDFArray) {
              for (let k = 0; k < resolved.size(); k++) streams.push(ctx.lookup(resolved.get(k)));
            } else if (resolved) streams.push(resolved);
            let latin = '';
            for (const st of streams) latin += latinOf(decodeStream(st)) + '\n';

            const pageRes = page.node.Resources ? page.node.Resources() : ctx.lookup(page.node.get(N('Resources')));
            const dialogLines = P.lines.filter(l => l.cls === 'dialogue' || l.cls === 'cue' || l.cls === 'more' || l.cls === 'dual');
            const stats = { scaledOps: 0, warnings: [] };
            const res = rewriteLevel(latin, [1, 0, 0, 1, 0, 0], pageRes, dialogLines, s, anchorC, stats, visitedForms);
            for (const w of stats.warnings) if (pageReport.warnings.indexOf(w) === -1) pageReport.warnings.push(w);

            if (!stats.scaledOps) {
              pageReport.warnings.push('classifier found dialogue but rewriter matched none — page left unchanged');
              pageReport.appliedScale = 1;
            } else if (res.changed && !res.bail && res.out != null) {
              // Text may have lived inside form XObjects (mutated in place
              // already); only replace the page content stream if the page
              // level itself changed.
              const newStream = ctx.flateStream(bytesOfLatin(res.out));
              const ref = ctx.register(newStream);
              page.node.set(N('Contents'), ref);
            }
          }
        }

        // Highlights compose with enlargement but don't depend on it — they
        // paint at whatever scale this page actually got (including 1.0).
        if (wantHl) {
          const rects = highlightRectsForPage(P, cal, pageReport.appliedScale, hl);
          if (rects.length) {
            paintHighlights(page, rects);
            pageReport.highlighted = rects.map(r => r.name);
          }
          if ((P.dualNames || []).some(n => hl[n] != null)) {
            pageReport.warnings.push('a highlighted character appears in a dual-dialogue block on this page — dual dialogue is not highlighted');
          }
        }
      }

      const outBytes = await pdfDoc.save({ useObjectStreams: false });
      return { bytes: outBytes, report };
    }

    // reader(bytes, opts) -> { elements, report }: Reader mode as a function.
    // The reflowed script as an ordered element stream (break / slug / action
    // / cue / paren / dialogue / transition), each with speaker name, source
    // page, scene and resolved highlight, for consumers that draw the reader
    // themselves (Sides Helper). opts: { highlights, watermarkText }.
    async function reader(bytes, opts = {}) {
      return process(bytes, { highlights: opts.highlights, watermarkText: opts.watermarkText, mode: 'reader', emit: 'elements' });
    }
    // renderReaderPdf(elements, scale, highlights) -> Uint8Array: the Reader
    // PDF from an element stream reader() returned (or a subset of it).
    async function renderReaderPdf(elements, scale, highlights) {
      const requested = Math.min(1.5, Math.max(1.0, scale || 1.25));
      const hl = {};
      for (const k of Object.keys(highlights || {})) {
        const idx = highlights[k]; const n = normalizeCueName(k);
        if (n && idx != null && PALETTE[idx]) hl[n] = idx;
      }
      return renderReader(elements, requested, hl, { readerBreaks: [] });
    }

    return {
      process, extract, analyze, reader, renderReaderPdf, PALETTE,
      // .sceneline interchange (spec v2)
      parseSceneline, unionShows, reconcile, buildSidesBlock, buildScenelineExport, normalizeCueName,
      // the shared name gate on a normalized name, and the compiled scriptparse
      // policy interpreter itself (tools/conformance_check.mjs runs the hub's
      // corpus against it; the UI reads .version)
      cueGateOk, policy: POL,
    };
  };
});
