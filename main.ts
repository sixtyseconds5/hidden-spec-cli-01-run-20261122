// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Ctx {
  strict: boolean;
  moves: [string, string][];
}

type Edit = (tree: Tree, ctx: Ctx) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 3: files as lines ----

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---- Section 5: matching lines at three tiers ----

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function eqTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

function occurrencesAt(fileLines: string[], O: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= fileLines.length; i += 1) {
    if (eofOnly && i + O.length !== fileLines.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!eqTier(fileLines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), with its occurrence positions, or null. */
function findOccurrences(
  fileLines: string[],
  O: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAt(fileLines, O, tier, from, eofOnly);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** Re-indent one non-context new line at tier 2 (section 5). */
function reindent(line: string, F: string, P: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

interface NLine {
  text: string;
  /** Index into O when this line is a context line, else null. */
  o: number | null;
}

/** The lines written when N replaces the matched lines at `pos` (context lines keep the file's own text). */
function writtenLines(fileLines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const F = tier === 2 ? leadingWs(fileLines[pos]!) : '';
  const P = tier === 2 ? leadingWs(O[0]!) : '';
  return N.map((n) => {
    if (n.o !== null) return fileLines[pos + n.o]!;
    return tier === 2 ? reindent(n.text, F, P) : n.text;
  });
}

function spliceLines(fileLines: string[], pos: number, remove: number, written: string[]): string[] {
  return [...fileLines.slice(0, pos), ...written, ...fileLines.slice(pos + remove)];
}

// ---- Hunk / chunk bodies (sections 6 and 8) ----

type BodyKind = 'ctx' | 'del' | 'add' | 'bs';

interface BodyEntry {
  kind: BodyKind;
  text: string;
}

interface ON {
  O: string[];
  N: NLine[];
  /** A `\` line immediately follows the body's last context or `+` line. */
  bsAfterLastCtxAdd: boolean;
  /** A `\` line immediately follows the body's last `+` line. */
  bsAfterLastAdd: boolean;
  hasAdd: boolean;
}

function buildON(body: BodyEntry[]): ON {
  const O: string[] = [];
  const N: NLine[] = [];
  let lastCtxAdd = -1;
  let lastAdd = -1;
  body.forEach((e, i) => {
    if (e.kind === 'ctx') {
      N.push({ text: e.text, o: O.length });
      O.push(e.text);
      lastCtxAdd = i;
    } else if (e.kind === 'del') {
      O.push(e.text);
    } else if (e.kind === 'add') {
      N.push({ text: e.text, o: null });
      lastCtxAdd = i;
      lastAdd = i;
    }
  });
  return {
    O,
    N,
    bsAfterLastCtxAdd: lastCtxAdd >= 0 && body[lastCtxAdd + 1]?.kind === 'bs',
    bsAfterLastAdd: lastAdd >= 0 && body[lastAdd + 1]?.kind === 'bs',
    hasAdd: lastAdd >= 0,
  };
}

function bodyEntry(line: string): BodyEntry {
  if (line === '') return { kind: 'ctx', text: '' };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'del', text: line.slice(1) };
  if (c === '+') return { kind: 'add', text: line.slice(1) };
  return { kind: 'bs', text: line.slice(1) };
}

// ---- Section 6: unified diffs ----

interface UHunk {
  A: number;
  body: BodyEntry[];
}

interface USection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  minus: string | null | undefined;
  plus: string | null | undefined;
  pairSeen: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  hunks: UHunk[];
  headerDone: boolean;
}

function newUSection(): USection {
  return {
    gitOld: undefined,
    gitNew: undefined,
    minus: undefined,
    plus: undefined,
    pairSeen: false,
    renameFrom: undefined,
    renameTo: undefined,
    isNew: false,
    isDeleted: false,
    hunks: [],
    headerDone: false,
  };
}

/** The path of a `--- `/`+++ ` line: after the four characters, up to the first tab, spaces removed; /dev/null is null. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function renamePath(line: string, prefix: string): string {
  let p = line.slice(prefix.length);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}

const isDiffGitLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Drop trailing body entries that came from literally empty patch lines. `body` was built from the
 * patch lines ending just before index `end`, one entry per line, in order. A ` ` line (a space)
 * is a real context line and stays.
 */
function trailingEmptyFix(body: BodyEntry[], lines: string[], end: number): BodyEntry[] {
  let n = body.length;
  let src = end;
  while (n > 0) {
    src -= 1;
    if (src < 0 || lines[src] !== '') break;
    n -= 1;
  }
  return body.slice(0, n);
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isDiffGitLine(line)) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newUSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.headerDone = true;
      const body: BodyEntry[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bodyEntry(bl));
          i += 1;
        } else break;
      }
      cur.hunks.push({ A: Number(m[1]!), body: trailingEmptyFix(body, lines, i) });
      continue;
    }
    if (line.startsWith('--- ')) {
      const followed = (lines[i + 1] ?? '').startsWith('+++ ');
      if (cur !== null && !cur.headerDone) {
        if (!followed) throw new Exit2(`error: parse ${i + 2}`);
        if (!cur.pairSeen) {
          cur.minus = headerPath(line);
          cur.plus = headerPath(lines[i + 1]!);
          cur.pairSeen = true;
          i += 2;
          continue;
        }
        // A second pair in the header starts a new section (falls through).
      }
      if (followed) {
        cur = newUSection();
        cur.minus = headerPath(line);
        cur.plus = headerPath(lines[i + 1]!);
        cur.pairSeen = true;
        sections.push(cur);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (cur !== null && !cur.headerDone) {
      if (line.startsWith('rename from ')) cur.renameFrom = renamePath(line, 'rename from ');
      else if (line.startsWith('rename to ')) cur.renameTo = renamePath(line, 'rename to ');
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored.
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s));
}

function unifiedEdit(s: USection): Edit {
  return (tree, ctx) => {
    const oldPath: string | null = s.minus !== undefined ? s.minus : (s.renameFrom ?? s.gitOld ?? null);
    const newPath: string | null = s.plus !== undefined ? s.plus : (s.renameTo ?? s.gitNew ?? null);
    const isCreation = (oldPath === null || s.isNew) && newPath !== null;
    const isDeletion = !isCreation && (newPath === null || s.isDeleted) && oldPath !== null;
    const isMove = !isCreation && !isDeletion && oldPath !== null && newPath !== null && oldPath !== newPath;
    if (isCreation) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const fileLines: string[] = [];
      let bs = false;
      for (const h of s.hunks) {
        const on = buildON(h.body);
        for (const e of h.body) if (e.kind === 'add') fileLines.push(e.text);
        if (on.hasAdd) bs = on.bsAfterLastAdd;
      }
      tree.now.set(p, joinFile(fileLines, '\n', !bs));
      return;
    }
    if (isDeletion) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const src = isMove ? oldPath! : (newPath ?? oldPath ?? '');
    if (isMove) {
      if (!safe(oldPath!)) throw new Fail('unsafe', oldPath!);
      if (!safe(newPath!)) throw new Fail('unsafe', newPath!);
    } else if (!safe(src)) {
      throw new Fail('unsafe', src);
    }
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (isMove && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    const f = splitFile(before);
    let fileLines = f.lines;
    let final = f.final;
    let d = 0;
    for (const h of s.hunks) {
      const on = buildON(h.body);
      if (on.O.length > 0) {
        const found = findOccurrences(fileLines, on.O, ctx.strict);
        if (found === null) throw new Fail('no-match', src);
        const target = h.A - 1 + d;
        let pos = found.occ[0]!;
        for (const o of found.occ) {
          if (Math.abs(o - target) < Math.abs(pos - target)) pos = o;
        }
        const runsToEnd = pos + on.O.length === fileLines.length;
        const written = writtenLines(fileLines, pos, on.O, on.N, found.tier);
        fileLines = spliceLines(fileLines, pos, on.O.length, written);
        if (runsToEnd) final = !on.bsAfterLastCtxAdd;
        d += on.N.length - on.O.length;
      } else {
        const pos = Math.max(0, Math.min(h.A + d, fileLines.length));
        const atEnd = pos === fileLines.length;
        const written = on.N.map((n) => n.text);
        fileLines = spliceLines(fileLines, pos, 0, written);
        if (atEnd) final = !on.bsAfterLastCtxAdd;
        d += on.N.length;
      }
    }
    const result = joinFile(fileLines, f.br, final);
    if (isMove) {
      tree.now.set(newPath!, result);
      tree.now.set(oldPath!, null);
      ctx.moves.push([oldPath!, newPath!]);
    } else {
      tree.now.set(src, result);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_EQ = '=======';
const SR_REPLACE = '>>>>>>> REPLACE';

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let boundary = 0; // first line index after the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SR_SEARCH) {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === SR_EQ) {
        eq = j;
        break;
      }
      if (t === SR_REPLACE || t === SR_SEARCH) break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === SR_REPLACE) {
        rep = j;
        break;
      }
      if (t === SR_SEARCH) break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let p = searchLine - 1; p >= boundary; p -= 1) {
      const l = lines[p]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree, ctx) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(newLines, '\n', true));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findOccurrences(f.lines, oldLines, ctx.strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const N: NLine[] = newLines.map((t) => ({ text: t, o: null }));
      const written = writtenLines(f.lines, pos, oldLines, N, found.tier);
      tree.now.set(p, joinFile(spliceLines(f.lines, pos, oldLines.length, written), f.br, f.final));
    });
    prevPath = path;
    boundary = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  body: BodyEntry[];
  eof: boolean;
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

const isVHeader = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
const isBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';

function v4aEdits(lines: string[]): Edit[] {
  const begin = lines.findIndex((l) => !blank(l));
  if (begin < 0) throw new Exit2('error: parse 1');
  if (lines[begin]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${begin + 1}`);
  let end = lines.length - 1;
  while (end >= 0 && blank(lines[end]!)) end -= 1;
  if (end <= begin || lines[end]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = begin + 1;
  while (i < end) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const head = lines[i]!;
    if (!isVHeader(head)) throw new Exit2(`error: parse ${i + 1}`);
    const headIdx = i;
    const raw: { idx: number; text: string }[] = [];
    i += 1;
    while (i < end && !isVHeader(lines[i]!)) {
      raw.push({ idx: i, text: lines[i]! });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (head.startsWith(V_ADD)) {
      const p = head.slice(V_ADD.length).trim();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(fileLines, '\n', true));
      });
    } else if (head.startsWith(V_DEL)) {
      const p = head.slice(V_DEL.length).trim();
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = head.slice(V_UPD.length).trim();
      let moveTo: string | null = null;
      let start = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith(V_MOVE)) {
        moveTo = raw[0]!.text.slice(V_MOVE.length).trim();
        start = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (let k = start; k < raw.length; k += 1) {
        const r = raw[k]!;
        if (r.text.startsWith('@@')) {
          const anchor = r.text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
        } else if (r.text.trim() === '*** End of File' && !isBodyLine(r.text)) {
          if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
          cur.eof = true;
          cur = null;
        } else if (isBodyLine(r.text)) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.idx + 1}`);
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(bodyEntry(r.text));
        } else {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headIdx + 1}`);
      const mv = moveTo;
      edits.push((tree, ctx) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const f = splitFile(before);
        let fileLines = f.lines;
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const foundA = findOccurrences(fileLines, [chunk.anchor], ctx.strict, cursor);
            if (foundA === null) throw new Fail('no-match', p);
            cursor = foundA.occ[0]! + 1;
          }
          const on = buildON(chunk.body);
          if (on.O.length > 0) {
            const found = findOccurrences(fileLines, on.O, ctx.strict, cursor, chunk.eof);
            if (found === null) throw new Fail('no-match', p);
            const pos = found.occ[0]!;
            const written = writtenLines(fileLines, pos, on.O, on.N, found.tier);
            fileLines = spliceLines(fileLines, pos, on.O.length, written);
            cursor = pos + written.length;
          } else {
            const pos = chunk.eof ? fileLines.length : cursor;
            const written = on.N.map((n) => n.text);
            fileLines = spliceLines(fileLines, pos, 0, written);
            cursor = pos + written.length;
          }
        }
        const result = joinFile(fileLines, f.br, f.final);
        if (mv !== null) {
          tree.now.set(mv, result);
          tree.now.set(p, null);
          ctx.moves.push([p, mv]);
        } else {
          tree.now.set(p, result);
        }
      });
    }
  }
  return edits;
}

// ---- Section 9: JSON edits ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines)
            : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { strict, moves: [] };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rows = new Map<string, { key: string; text: string }>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.set(p, { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const claimedOld = new Set<string>();
  const claimedNew = new Set<string>();
  const seenPairs = new Set<string>();
  for (const [oldP, newP] of ctx.moves) {
    const pairKey = `${oldP}\0${newP}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    if (claimedOld.has(oldP) || claimedNew.has(newP)) continue;
    if (tree.original(oldP) === null || tree.get(oldP) !== null) continue;
    if (tree.original(newP) !== null || tree.get(newP) === null) continue;
    if (!rows.has(oldP) || !rows.has(newP)) continue;
    rows.delete(oldP);
    rows.delete(newP);
    rows.set(newP, { key: newP, text: `R ${oldP} -> ${newP}` });
    claimedOld.add(oldP);
    claimedNew.add(newP);
  }
  const rowList = [...rows.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rowList.map((r) => r.text), `ok: ${rowList.length} ${rowList.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
