// A faster drop-in for make.fun's csv-reader 1.0.0: run(input) returns exactly
// csv-reader's answer {columns, rows, errors} for every input {text, header},
// under the same broken-row policy as the oracle (see the trial solve.js header
// for the full policy text; nothing about the policy changes here).
//
// Where the trial reader scanned charCodeAt in a tight loop and returned a
// fresh {value, ended, added} object per field, this reader:
//   - keeps its helpers at module level over one state object, so V8 keeps one
//     set of feedback and compiled code across every case of a run;
//   - jumps between special characters with String.indexOf (the engine's own
//     search) instead of walking character by character: a quoted field is
//     located by its closing quote; an unquoted field is cut at its next
//     comma and its line break, if any, is looked for inside that one slice,
//     so no search ever runs past the field it is reading;
//   - hands field results back through state slots, so no object is allocated
//     per field;
//   - takes the common quoted field (no doubled quote, no CR inside) as one
//     slice with no concatenation at all.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Counts the LFs in t[a..b). Embedded LFs are rare; each indexOf hop is the
// engine's own search and the hops stay inside the range.
function countLF(t, a, b) {
  let count = 0;
  let i = t.indexOf('\n', a);
  while (i !== -1 && i < b) {
    count += 1;
    i = t.indexOf('\n', i + 1);
  }
  return count;
}

// Reads unquoted characters onto `value` up to the next comma or line break:
// a CR not followed by LF is dropped (stray_cr). Sets S.pos past the field and
// its terminator, S.fEnd to how it ended and S.fAdded to the characters kept.
function readUnquoted(S, value) {
  const t = S.t;
  const n = S.n;
  const errors = S.errors;
  let pos = S.pos;
  let added = 0;
  for (;;) {
    // The field ends at the next comma, unless a line break or a stray CR
    // comes first; both are looked for inside the field's own slice, so no
    // search ever runs past the field (the trial design searched the whole
    // text for the next LF, most of a line past most fields).
    let c = t.indexOf(',', pos);
    if (c === -1) c = n + 1;
    const seg = t.slice(pos, c > n ? n : c);
    const li = seg.indexOf('\n');
    const ri = seg.indexOf('\r');
    if (li === -1 && ri === -1) {
      value = value === '' ? seg : value + seg;
      added += seg.length;
      if (c === n + 1) {
        S.pos = n;
        S.fEnd = END;
      } else {
        S.pos = c + 1;
        S.fEnd = COMMA;
      }
      S.fAdded = added;
      return value;
    }
    if (li !== -1 && (ri === -1 || li < ri)) {
      // The field ends at an LF inside the segment.
      const keep = t.slice(pos, pos + li);
      value = value === '' ? keep : value + keep;
      added += li;
      S.pos = pos + li + 1;
      S.line += 1;
      S.fEnd = LINE_BREAK;
      S.fAdded = added;
      return value;
    }
    if (li !== -1 && ri === li - 1) {
      // The field ends at a CRLF inside the segment.
      const keep = t.slice(pos, pos + ri);
      value = value === '' ? keep : value + keep;
      added += ri;
      S.pos = pos + li + 1;
      S.line += 1;
      S.fEnd = LINE_BREAK;
      S.fAdded = added;
      return value;
    }
    // A stray CR inside the segment (before any LF, and not the CR of a
    // CRLF): keep what precedes it, record it, and read on from past it.
    const keep = t.slice(pos, pos + ri);
    value = value === '' ? keep : value + keep;
    added += ri;
    errors.push({ code: 'stray_cr', line: S.recordLine, row: S.recordRow });
    pos = pos + ri + 1;
  }
}

// The general interior of a quoted field: t[start..q) with the closing quote
// known to sit at q. Every quote inside is one half of a doubled pair; each
// CRLF or lone CR becomes one LF; LFs are counted onto S.line.
function quotedInterior(S, start, q) {
  const inner = S.t.slice(start, q);
  const m = inner.length;
  let value = '';
  let seg = 0;
  for (;;) {
    let mq = inner.indexOf('"', seg);
    if (mq === -1) mq = m + 1;
    let mr = inner.indexOf('\r', seg);
    if (mr === -1) mr = m + 1;
    const at = mq < mr ? mq : mr;
    if (at > m) {
      value += inner.slice(seg, m);
      S.line += countLF(inner, seg, m);
      return value;
    }
    value += inner.slice(seg, at);
    S.line += countLF(inner, seg, at);
    if (mr < mq) {
      value += '\n';
      S.line += 1;
      seg = at + 1 + (inner.charCodeAt(at + 1) === 10 ? 1 : 0);
    } else {
      value += '"';
      seg = at + 2;
    }
  }
}

// Reads a quoted field whose opening quote is at S.pos. Sets S.pos, S.fEnd
// and S.fAdded like readUnquoted (fAdded is unused for quoted fields).
function readQuoted(S) {
  const t = S.t;
  const n = S.n;
  const open = S.pos;
  const openLine = S.line;
  const start = open + 1;
  // The closing quote is the first quote that is not doubled.
  let q = t.indexOf('"', start);
  const firstQ = q;
  while (q !== -1 && t.charCodeAt(q + 1) === 34) q = t.indexOf('"', q + 2);
  if (q === -1) {
    // The quote never closes: it is a literal character, and the text after
    // it is read again as an unquoted field.
    S.pos = start;
    S.line = openLine;
    S.errors.push({ code: 'unterminated_quote', line: S.recordLine, row: S.recordRow });
    return readUnquoted(S, '"');
  }
  let value;
  if (q === firstQ) {
    // No doubled quote inside: the interior is one slice unless it holds a
    // CR (which would have to become an LF).
    const seg = t.slice(start, q);
    if (seg.indexOf('\r') === -1) {
      S.line += countLF(seg, 0, seg.length);
      value = seg;
    } else {
      value = quotedInterior(S, start, q);
    }
  } else {
    value = quotedInterior(S, start, q);
  }
  const pos = q + 1;
  if (pos >= n) {
    S.pos = n;
    S.fEnd = END;
    return value;
  }
  const code = t.charCodeAt(pos);
  if (code === 44) {
    S.pos = pos + 1;
    S.fEnd = COMMA;
    return value;
  }
  if (code === 10) {
    S.pos = pos + 1;
    S.line += 1;
    S.fEnd = LINE_BREAK;
    return value;
  }
  if (code === 13 && t.charCodeAt(pos + 1) === 10) {
    S.pos = pos + 2;
    S.line += 1;
    S.fEnd = LINE_BREAK;
    return value;
  }
  // What follows the closing quote is appended as it stands, up to the next
  // comma or line break.
  S.pos = pos;
  const junk = readUnquoted(S, value);
  if (S.fAdded > 0) S.errors.push({ code: 'quote_junk', line: S.recordLine, row: S.recordRow });
  return junk;
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const S = {
    t: text,
    n: text.length,
    pos: 0,
    line: 1,
    errors: [],
    recordLine: 1,
    recordRow: null,
    fEnd: END,
    fAdded: 0,
  };
  const errors = S.errors;
  const rows = [];
  let columns = null;
  let width = -1;

  if (text.charCodeAt(0) === 0xfeff) S.pos = 1;

  for (;;) {
    // Lines with no characters are no records.
    let pos = S.pos;
    while (pos < S.n) {
      const code = text.charCodeAt(pos);
      if (code === 10) {
        pos += 1;
        S.line += 1;
      } else if (code === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        S.line += 1;
      } else {
        break;
      }
    }
    S.pos = pos;
    if (pos >= S.n) break;

    S.recordLine = S.line;
    S.recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    for (;;) {
      quoted = text.charCodeAt(S.pos) === 34;
      fields.push(quoted ? readQuoted(S) : readUnquoted(S, ''));
      if (S.fEnd !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: S.recordLine, row: S.recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: S.recordLine, row: S.recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
