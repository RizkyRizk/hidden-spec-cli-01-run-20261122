// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It implements all of SPEC.md: the command line, output and exit codes, safe paths, format detection, JSON edits,
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), three-tier line matching
// (section 5), and the all-or-nothing write (section 10).
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
  readonly moves: Array<[string, string]> = [];
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
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

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

// ---------------------------------------------------------------------------
// Section 3: a file's lines, line break and final break.
// ---------------------------------------------------------------------------

interface Split {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

const trail = (s: string): string => s.replace(/[ \t]+$/, '');
const both = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** First tier (0, 1, 2) at which O occurs in `lines` at or after `from`, and its positions. */
function occurrences(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; pos: number[] } {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const key = t === 0 ? (s: string): string => s : t === 1 ? trail : both;
    const ok = o.map(key);
    // Key each file line once per tier instead of re-keying the same lines
    // at every candidate position.
    const keyed = lines.map(key);
    const pos: number[] = [];
    for (let i = from; i + ok.length <= lines.length; i++) {
      if (eofOnly && i + ok.length !== lines.length) continue;
      let good = true;
      for (let j = 0; j < ok.length; j++) {
        if (keyed[i + j]! !== ok[j]) {
          good = false;
          break;
        }
      }
      if (good) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return { tier: -1, pos: [] };
}

/** One line of N: `o` is its index in O when it is a context line, -1 otherwise. */
interface NLine {
  text: string;
  o: number;
}

/** Render N over the occurrence at `at`: context lines are the file's own lines, other lines are re-indented at tier 2. */
function renderN(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const f = lead(fileLines[at] ?? '');
  const p = o.length > 0 ? lead(o[0]!) : '';
  return n.map((l) => {
    if (l.o >= 0) return fileLines[at + l.o]!;
    if (tier === 2 && l.text !== '' && l.text.trim() !== '' && l.text.startsWith(p)) return f + l.text.slice(p.length);
    return l.text;
  });
}

// ---------------------------------------------------------------------------
// Shared body lines: context / old / new / backslash marker.
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'old' | 'new' | 'mark';
interface BodyLine {
  kind: BodyKind;
  text: string;
}

function bodyLine(l: string): BodyLine {
  if (l === '') return { kind: 'ctx', text: '' };
  const c = l[0]!;
  if (c === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (c === '-') return { kind: 'old', text: l.slice(1) };
  if (c === '+') return { kind: 'new', text: l.slice(1) };
  return { kind: 'mark', text: l.slice(1) };
}

/** Split a chunk/hunk body into O and N. */
function bodyON(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      n.push({ text: b.text, o: o.length });
      o.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, o: -1 });
    }
  }
  return { o, n };
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  hasDash: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function freshSection(): Section {
  return {
    gitOld: null,
    gitNew: null,
    dashOld: null,
    dashNew: null,
    hasDash: false,
    renameFrom: null,
    renameTo: null,
    create: false,
    del: false,
    hunks: [],
  };
}

/** Path after `--- ` / `+++ `: text after the four characters, up to the first tab, spaces removed, a/ or b/ stripped. */
function dashPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function hunkNoEol(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  }
  if (last < 0) return false;
  const nx = body[last + 1];
  return nx !== undefined && nx.kind === 'mark';
}

/**
 * Apply one hunk to the file state. Returns N.length - O.length (the drift it adds).
 * Throws Fail('no-match', path) when O is not found.
 */
function applyHunk(st: Split, h: Hunk, strict: boolean, d: number, path: string): number {
  const { o, n } = bodyON(h.body);
  if (o.length === 0) {
    const oldLen = st.lines.length;
    const at = Math.min(h.a + d, oldLen);
    st.lines.splice(at, 0, ...n.map((l) => l.text));
    if (at === oldLen) st.fin = !h.noEol;
    return n.length;
  }
  const occ = occurrences(st.lines, o, strict);
  if (occ.pos.length === 0) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = occ.pos[0]!;
  for (const p of occ.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const at = best;
  const endsAtEnd = at + o.length === st.lines.length;
  const rep = renderN(st.lines, at, o, n, occ.tier);
  st.lines.splice(at, o.length, ...rep);
  if (endsAtEnd) st.fin = !h.noEol;
  return n.length - o.length;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.hasDash ? sec.dashOld : sec.renameFrom ?? sec.gitOld;
    const newP = sec.hasDash ? sec.dashNew : sec.renameTo ?? sec.gitNew;
    for (const p of [oldP, newP]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    const isCreate = sec.create || oldP === null;
    const isDelete = !isCreate && (sec.del || newP === null);
    if (isCreate) {
      const np = newP;
      if (np === null) return;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const b of h.body) {
          if (b.kind === 'new') {
            plus.push(b.text);
            hasPlus = true;
          }
        }
        if (hasPlus) noEol = h.noEol;
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    if (op !== np) {
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const st = splitFile(cur);
      let d = 0;
      for (const h of sec.hunks) d += applyHunk(st, h, strict, d, op);
      tree.now.set(np, joinFile(st.lines, st.br, st.fin));
      tree.now.set(op, null);
      tree.recordMove(op, np);
      return;
    }
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    const st = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(st, h, strict, d, op);
    tree.now.set(op, joinFile(st.lines, st.br, st.fin));
  };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const startSection = (): Section => {
    const s = freshSection();
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bodyLine(bl));
          j++;
        } else {
          break;
        }
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a, body, noEol: hunkNoEol(body) });
      inHeader = false;
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur !== null && inHeader && !cur.hasDash) {
          cur.dashOld = dashPath(line);
          cur.dashNew = dashPath(lines[i + 1]!);
          cur.hasDash = true;
        } else {
          const s = startSection();
          s.dashOld = dashPath(line);
          s.dashNew = dashPath(lines[i + 1]!);
          s.hasDash = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const st = splitFile(cur);
    const occ = occurrences(st.lines, oldLines, strict);
    if (occ.pos.length === 0) throw new Fail('no-match', path);
    if (occ.pos.length > 1) throw new Fail('ambiguous', path);
    const at = occ.pos[0]!;
    const rep = renderN(
      st.lines,
      at,
      oldLines,
      newLines.map((t) => ({ text: t, o: -1 })),
      occ.tier,
    );
    st.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile(st.lines, st.br, st.fin));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type VKind = 'add' | 'del' | 'upd';
interface VSection {
  kind: VKind;
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
}

function vSectionStart(l: string): { kind: VKind; path: string } | null {
  const marks: Array<[VKind, string]> = [
    ['add', '*** Add File: '],
    ['del', '*** Delete File: '],
    ['upd', '*** Update File: '],
  ];
  for (const [kind, mark] of marks) {
    if (l.startsWith(mark)) return { kind, path: l.slice(mark.length).trim() };
  }
  return null;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const st = splitFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const a = occurrences(st.lines, [ch.anchor], strict, cursor);
        if (a.pos.length === 0) throw new Fail('no-match', sec.path);
        cursor = a.pos[0]! + 1;
      }
      const { o, n } = bodyON(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? st.lines.length : cursor;
        st.lines.splice(at, 0, ...n.map((l) => l.text));
        cursor = at + n.length;
        continue;
      }
      const occ = occurrences(st.lines, o, strict, cursor, ch.eof);
      if (occ.pos.length === 0) throw new Fail('no-match', sec.path);
      const at = occ.pos[0]!;
      const rep = renderN(st.lines, at, o, n, occ.tier);
      st.lines.splice(at, o.length, ...rep);
      cursor = at + rep.length;
    }
    const out = joinFile(st.lines, st.br, st.fin);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.recordMove(sec.path, sec.moveTo);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const st = vSectionStart(line);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && vSectionStart(lines[j]!) === null) j++;
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end--;
    const sec: VSection = { kind: st.kind, path: st.path, moveTo: null, lines: [], chunks: [] };
    if (st.kind === 'add') {
      for (let k = i + 1; k < end; k++) {
        const l = lines[k]!;
        if (l === '') sec.lines.push('');
        else if (l.startsWith('+')) sec.lines.push(l.slice(1));
        else throw new Exit2(`error: parse ${k + 1}`);
      }
    } else if (st.kind === 'del') {
      for (let k = i + 1; k < end; k++) {
        if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      }
    } else {
      let k = i + 1;
      if (k < end && lines[k]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      let curChunk: VChunk | null = null;
      const startChunk = (anchor: string | null): void => {
        curChunk = { anchor, eof: false, body: [] };
        sec.chunks.push(curChunk);
      };
      for (; k < end; k++) {
        const l = lines[k]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          startChunk(anchor === '' ? null : anchor);
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${k + 1}`);
          curChunk.eof = true;
          curChunk = null;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (sec.chunks.length === 0) startChunk(null);
            else throw new Exit2(`error: parse ${k + 1}`);
          }
          curChunk.body.push(bodyLine(l));
          continue;
        }
        throw new Exit2(`error: parse ${k + 1}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
    }
    edits.push(v4aEdit(sec, strict));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: invocation, output, order and atomicity.
// ---------------------------------------------------------------------------

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (rNew.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.now.get(oldP) === null && tree.now.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      rOld.add(oldP);
      rNew.add(newP);
    }
  }
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was !== null && now === null && rOld.has(p)) continue;
    if (was === null && now !== null && rNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  if (!check) {
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
