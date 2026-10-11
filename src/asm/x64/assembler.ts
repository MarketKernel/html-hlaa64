// x86-64 assembler pass (Intel syntax, LLVM/COFF dialect): sections, symbols,
// branch relaxation (short/near jumps) and Windows unwind info from .seh_* directives.
import { AsmError, parseSource, parseStringLiteral, parseValue, splitOperands, type Value } from '../parse.ts';
import { encodeX, parseXOperands, type XFixup } from './encode.ts';
import { xreg } from './regs.ts';

// COFF section characteristics
export const SCN_CODE = 0x20, SCN_IDATA = 0x40, SCN_UDATA = 0x80, SCN_EXEC = 0x20000000, SCN_READ = 0x40000000, SCN_WRITE = 0x80000000;

export interface XSectFixup {
  off: number;              // offset of the field in the section
  size: 1 | 4 | 8;
  kind: 'rel' | 'abs' | 'rva';
  sym: string;
  add: bigint;
  end: number;              // rel: section offset of the end of the instruction (the rip value)
  line: number;
}

export interface XSection {
  name: string;
  flags: number;            // COFF characteristics without alignment bits
  align: number;            // bytes
  data: number[];
  size: number;
  zerofill: boolean;
  fixups: XSectFixup[];
  insns: { off: number; len: number; line: number }[];
  addr: number;             // assigned by writers
}

export interface XSym { name: string; sect: XSection; off: number; global: boolean; line: number; func: boolean }

export interface XAssembly {
  sections: XSection[];
  symbols: Map<string, XSym>;
  globals: Set<string>;
  lines: number;            // number of instructions
}

type Item =
  | { k: 'label'; name: string; line: number }
  | { k: 'bytes'; bytes: number[]; fixups: XFixup[]; line: number; insn: boolean }
  | { k: 'jump'; cond: number | null; target: Value; line: number; long: boolean }
  | { k: 'align'; to: number; code: boolean }
  | { k: 'space'; n: number };

interface SehFn {
  name: string;
  start: string;            // labels (resolved after layout)
  end: string | null;
  prologEnd: string | null;
  codes: { label: string; op: 'push' | 'alloc' | 'setframe' | 'savereg' | 'savexmm'; reg: number; off: number }[];
  frame: { reg: number; off: number } | null;
  line: number;
}

// multi-byte NOPs, the same sequences LLVM uses for code alignment
const NOPS: number[][] = [
  [], [0x90], [0x66, 0x90], [0x0f, 0x1f, 0x00], [0x0f, 0x1f, 0x40, 0x00], [0x0f, 0x1f, 0x44, 0x00, 0x00],
  [0x66, 0x0f, 0x1f, 0x44, 0x00, 0x00], [0x0f, 0x1f, 0x80, 0x00, 0x00, 0x00, 0x00],
  [0x0f, 0x1f, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00], [0x66, 0x0f, 0x1f, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x66, 0x2e, 0x0f, 0x1f, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00],
];
function nopFill(n: number): number[] {
  const out: number[] = [];
  while (n > 0) { const k = Math.min(n, 10); out.push(...NOPS[k]); n -= k; }
  return out;
}

function sectionFor(name: string, flagStr: string | undefined): { flags: number; zerofill: boolean } {
  if (flagStr !== undefined) {
    const f = flagStr.replace(/"/g, '');
    let flags = SCN_READ;
    if (f.includes('x')) flags |= SCN_CODE | SCN_EXEC;
    if (f.includes('b')) flags |= SCN_UDATA;
    else if (!f.includes('x')) flags |= SCN_IDATA;
    if (f.includes('w')) flags |= SCN_WRITE;
    return { flags, zerofill: f.includes('b') };
  }
  if (name === '.text' || name.startsWith('.text$')) return { flags: SCN_CODE | SCN_EXEC | SCN_READ, zerofill: false };
  if (name === '.bss' || name.startsWith('.bss$')) return { flags: SCN_UDATA | SCN_READ | SCN_WRITE, zerofill: true };
  if (name === '.rdata' || name === '.xdata' || name === '.pdata' || name.startsWith('.rdata$')) return { flags: SCN_IDATA | SCN_READ, zerofill: false };
  return { flags: SCN_IDATA | SCN_READ | SCN_WRITE, zerofill: false };
}

export function assembleX(src: string): XAssembly {
  const lists = new Map<string, { sect: XSection; items: Item[] }>();
  const order: string[] = [];
  const globals = new Set<string>();
  const funcs = new Set<string>();
  let count = 0;
  const seh: SehFn[] = [];
  let curSeh: SehFn | null = null;
  let sehLabel = 0;

  const getSection = (name: string, flagStr?: string) => {
    let l = lists.get(name);
    if (!l) {
      const { flags, zerofill } = sectionFor(name, flagStr);
      // default alignments as clang uses them: code 16, writable data and bss 4
      const align = flags & SCN_EXEC ? 16 : flags & SCN_WRITE ? 4 : 1;
      l = { sect: { name, flags, align, data: [], size: 0, zerofill, fixups: [], insns: [], addr: 0 }, items: [] };
      lists.set(name, l);
      order.push(name);
    }
    return l;
  };
  let cur = getSection('.text');
  const isCode = () => (cur.sect.flags & SCN_EXEC) !== 0;
  const push = (it: Item) => cur.items.push(it);
  const marker = () => { const n = `.Lseh$${sehLabel++}`; push({ k: 'label', name: n, line: 0 }); return n; };

  const dataValues = (args: string, size: 1 | 2 | 4 | 8, line: number) => {
    for (const a of splitOperands(args)) {
      const v = parseValue(a, line);
      if (v.sym) {
        if (size !== 8 && size !== 4) throw new AsmError('symbol addresses need .quad (or .long for an RVA)', line);
        push({ k: 'bytes', bytes: new Array(size).fill(0), fixups: [{ off: 0, size, kind: 'abs', sym: v.sym, add: v.add }], line, insn: false });
        continue;
      }
      const u = BigInt.asUintN(size * 8, v.add);
      const bytes: number[] = [];
      for (let i = 0; i < size; i++) bytes.push(Number((u >> BigInt(8 * i)) & 0xffn));
      push({ k: 'bytes', bytes, fixups: [], line, insn: false });
    }
  };

  for (const st of parseSource(src, { hashComments: true })) {
    const line = st.line;
    if (st.k === 'label') { push({ k: 'label', name: st.name, line }); continue; }
    if (st.k === 'dir') {
      const a = st.args;
      switch (st.name) {
        case '.intel_syntax': case '.att_syntax':
          if (st.name === '.att_syntax') throw new AsmError('only Intel syntax is supported (.intel_syntax noprefix)', line);
          break;
        case '.text': cur = getSection('.text'); break;
        case '.data': cur = getSection('.data'); break;
        case '.bss': cur = getSection('.bss'); break;
        case '.section': {
          const parts = splitOperands(a);
          cur = getSection(parts[0], parts[1]);
          break;
        }
        case '.globl': case '.global': for (const n of a.split(',')) globals.add(n.trim()); break;
        case '.def': case '.scl': case '.endef': case '.file': case '.ident': case '.addrsig': case '.addrsig_sym':
        case '.p2alignl': case '.size': case '.local': case '.weak': case '.cfi_startproc': case '.cfi_endproc':
          break;
        case '.type': {
          if (/\b32\b/.test(a)) { /* function */ }
          break;
        }
        case '.p2align': {
          const p2 = Number(parseValue(splitOperands(a)[0], line).add);
          cur.sect.align = Math.max(cur.sect.align, 1 << p2);
          push({ k: 'align', to: 1 << p2, code: isCode() });
          break;
        }
        case '.align': case '.balign': {
          const n = Number(parseValue(splitOperands(a)[0], line).add);
          if (n & (n - 1)) throw new AsmError('alignment must be a power of two', line);
          cur.sect.align = Math.max(cur.sect.align, n);
          push({ k: 'align', to: n, code: isCode() });
          break;
        }
        case '.byte': dataValues(a, 1, line); break;
        case '.short': case '.word': case '.2byte': case '.value': dataValues(a, 2, line); break;
        case '.long': case '.int': case '.4byte': dataValues(a, 4, line); break;
        case '.quad': case '.8byte': dataValues(a, 8, line); break;
        case '.rva': {
          for (const x of splitOperands(a)) {
            const v = parseValue(x, line);
            if (!v.sym) throw new AsmError('.rva needs a symbol', line);
            push({ k: 'bytes', bytes: [0, 0, 0, 0], fixups: [{ off: 0, size: 4, kind: 'abs', sym: '@rva:' + v.sym, add: v.add }], line, insn: false });
          }
          break;
        }
        case '.double': case '.float': {
          for (const x of splitOperands(a)) {
            const dv = new DataView(new ArrayBuffer(8));
            if (st.name === '.double') dv.setFloat64(0, parseFloat(x), true); else dv.setFloat32(0, parseFloat(x), true);
            push({ k: 'bytes', bytes: [...new Uint8Array(dv.buffer, 0, st.name === '.double' ? 8 : 4)], fixups: [], line, insn: false });
          }
          break;
        }
        case '.ascii': case '.asciz': case '.string':
          for (const s of splitOperands(a)) {
            const b = parseStringLiteral(s, line);
            if (st.name !== '.ascii') b.push(0);
            push({ k: 'bytes', bytes: b, fixups: [], line, insn: false });
          }
          break;
        case '.space': case '.zero': case '.skip': {
          const ops = splitOperands(a);
          const n = Number(parseValue(ops[0], line).add);
          const fill = ops[1] ? Number(parseValue(ops[1], line).add) : 0;
          if (fill) push({ k: 'bytes', bytes: new Array(n).fill(fill), fixups: [], line, insn: false });
          else push({ k: 'space', n });
          break;
        }
        case '.comm': case '.lcomm': {
          // .comm sym, size[, align]
          const p = splitOperands(a);
          const save = cur;
          cur = getSection('.bss');
          const al = p[2] ? Number(parseValue(p[2], line).add) : 8;
          cur.sect.align = Math.max(cur.sect.align, al);
          push({ k: 'align', to: al, code: false });
          push({ k: 'label', name: p[0], line });
          push({ k: 'space', n: Number(parseValue(p[1], line).add) });
          if (st.name === '.comm') globals.add(p[0]);
          cur = save;
          break;
        }
        // ---------------------------------------------------------- Windows unwind info
        case '.seh_proc': {
          const name = a.trim();
          funcs.add(name);
          curSeh = { name, start: name, end: null, prologEnd: null, codes: [], frame: null, line };
          seh.push(curSeh);
          break;
        }
        case '.seh_pushreg': case '.seh_stackalloc': case '.seh_setframe': case '.seh_savereg': case '.seh_savexmm': {
          if (!curSeh) throw new AsmError(`${st.name} outside of .seh_proc`, line);
          const p = splitOperands(a);
          const label = marker();
          const regOf = (t: string) => {
            const r = xreg(t);
            if (!r || (st.name !== '.seh_savexmm' && (r.xmm || r.size !== 8))) throw new AsmError(`bad register '${t}' in ${st.name}`, line);
            return r.n;
          };
          if (st.name === '.seh_pushreg') curSeh.codes.push({ label, op: 'push', reg: regOf(p[0]), off: 0 });
          else if (st.name === '.seh_stackalloc') curSeh.codes.push({ label, op: 'alloc', reg: 0, off: Number(parseValue(p[0], line).add) });
          else if (st.name === '.seh_setframe') {
            const off = Number(parseValue(p[1], line).add);
            if (off % 16 || off > 240) throw new AsmError('frame offset must be a multiple of 16, at most 240', line);
            curSeh.frame = { reg: regOf(p[0]), off };
            curSeh.codes.push({ label, op: 'setframe', reg: regOf(p[0]), off });
          } else if (st.name === '.seh_savereg') curSeh.codes.push({ label, op: 'savereg', reg: regOf(p[0]), off: Number(parseValue(p[1], line).add) });
          else curSeh.codes.push({ label, op: 'savexmm', reg: regOf(p[0]), off: Number(parseValue(p[1], line).add) });
          break;
        }
        case '.seh_endprologue':
          if (!curSeh) throw new AsmError('.seh_endprologue outside of .seh_proc', line);
          curSeh.prologEnd = marker();
          break;
        case '.seh_endproc':
          if (!curSeh) throw new AsmError('.seh_endproc without .seh_proc', line);
          curSeh.end = marker();
          curSeh = null;
          break;
        case '.seh_handler': case '.seh_handlerdata': case '.seh_endepilogue': case '.seh_startepilogue': case '.seh_unwindversion':
          break;
        case '.set': case '.equ': case '.macro':
          throw new AsmError(`${st.name} is not supported`, line);
        default:
          throw new AsmError(`unknown directive '${st.name}'`, line);
      }
      continue;
    }
    if (!isCode()) throw new AsmError(`instruction '${st.mn}' outside of a code section`, line);
    const enc = encodeX(st.mn, parseXOperands(st.ops, line), line);
    count++;
    if (enc.jump) push({ k: 'jump', cond: enc.jump.cond, target: enc.jump.target, line, long: false });
    else push({ k: 'bytes', bytes: enc.bytes, fixups: enc.fixups, line, insn: true });
  }
  if (curSeh) throw new AsmError(`.seh_proc ${curSeh.name} is not closed with .seh_endproc`, curSeh.line);

  // ------------------------------------------------------------------ layout with branch relaxation
  const symbols = new Map<string, XSym>();
  const where = new Map<string, { list: string; off: number }>();
  for (const name of order) {
    const l = lists.get(name)!;
    for (const it of l.items) {
      if (it.k === 'label') {
        if (where.has(it.name)) throw new AsmError(`symbol '${it.name}' is already defined`, it.line);
        where.set(it.name, { list: name, off: 0 });
      }
    }
  }
  const jumpLen = (it: Extract<Item, { k: 'jump' }>) => (it.long ? (it.cond === null ? 5 : 6) : 2);
  for (const name of order) {
    const l = lists.get(name)!;
    // jumps to symbols outside this section are always near (rel32)
    for (const it of l.items) {
      if (it.k === 'jump') {
        const w = it.target.sym ? where.get(it.target.sym) : null;
        if (!w || w.list !== name) it.long = true;
      }
    }
    for (let iter = 0; iter < 1000; iter++) {
      let off = 0;
      const offs: number[] = [];
      for (const it of l.items) {
        offs.push(off);
        switch (it.k) {
          case 'label': where.get(it.name)!.off = off; break;
          case 'bytes': off += it.bytes.length; break;
          case 'jump': off += jumpLen(it); break;
          case 'align': off = Math.ceil(off / it.to) * it.to; break;
          case 'space': off += it.n; break;
        }
      }
      let changed = false;
      l.items.forEach((it, i) => {
        if (it.k !== 'jump' || it.long) return;
        const t = where.get(it.target.sym!)!.off + Number(it.target.add);
        const d = t - (offs[i] + 2);
        if (d < -128 || d > 127) { it.long = true; changed = true; }
      });
      if (!changed) break;
    }
  }
  // ------------------------------------------------------------------ emit bytes
  for (const name of order) {
    const { sect, items } = lists.get(name)!;
    const out = sect.data;
    const fix = (f: XFixup, base: number, end: number, line: number) => {
      const rva = f.sym.startsWith('@rva:');
      sect.fixups.push({
        off: base + f.off, size: f.size, kind: rva ? 'rva' : f.kind, sym: rva ? f.sym.slice(5) : f.sym, add: f.add, end, line,
      });
    };
    let size = 0;
    for (const it of items) {
      switch (it.k) {
        case 'label':
          symbols.set(it.name, { name: it.name, sect, off: size, global: globals.has(it.name), line: it.line, func: funcs.has(it.name) });
          break;
        case 'bytes': {
          if (sect.zerofill) {
            if (it.bytes.some((b) => b)) throw new AsmError('cannot put data into a zerofill section', it.line);
            size += it.bytes.length;
            break;
          }
          for (const f of it.fixups) fix(f, size, size + it.bytes.length, it.line);
          if (it.insn) sect.insns.push({ off: size, len: it.bytes.length, line: it.line });
          out.push(...it.bytes);
          size += it.bytes.length;
          break;
        }
        case 'jump': {
          const start = size;
          let bytes: number[];
          if (it.long) bytes = it.cond === null ? [0xe9, 0, 0, 0, 0] : [0x0f, 0x80 + it.cond, 0, 0, 0, 0];
          else bytes = it.cond === null ? [0xeb, 0] : [0x70 + it.cond, 0];
          if (!it.target.sym) throw new AsmError('jump needs a label', it.line);
          const fsize = it.long ? 4 : 1;
          sect.fixups.push({ off: start + bytes.length - fsize, size: fsize as 1 | 4, kind: 'rel', sym: it.target.sym, add: it.target.add, end: start + bytes.length, line: it.line });
          sect.insns.push({ off: start, len: bytes.length, line: it.line });
          out.push(...bytes);
          size += bytes.length;
          break;
        }
        case 'align': {
          const pad = (it.to - (size % it.to)) % it.to;
          if (sect.zerofill) size += pad;
          else { out.push(...(it.code ? nopFill(pad) : new Array(pad).fill(0))); size += pad; }
          break;
        }
        case 'space':
          if (!sect.zerofill) out.push(...new Array(it.n).fill(0));
          size += it.n;
          break;
      }
    }
    sect.size = size;
  }
  for (const g of globals) if (symbols.has(g)) symbols.get(g)!.global = true;

  // ------------------------------------------------------------------ unwind info: .xdata + .pdata
  if (seh.length) {
    const xdata = getSection('.xdata').sect;
    const pdata = getSection('.pdata').sect;
    xdata.align = Math.max(xdata.align, 4);
    pdata.align = Math.max(pdata.align, 4);
    const posOf = (label: string) => {
      const s = symbols.get(label);
      if (!s) throw new AsmError(`unknown symbol '${label}' in unwind info`, 0);
      return s;
    };
    for (const f of seh) {
      const start = posOf(f.start);
      const prolog = f.prologEnd ? posOf(f.prologEnd).off - start.off : 0;
      if (prolog > 255) throw new AsmError(`prologue of ${f.name} is longer than 255 bytes`, f.line);
      // unwind codes, newest first
      const slots: number[] = [];
      for (const c of [...f.codes].reverse()) {
        const at = posOf(c.label).off - start.off;
        const code = (op: number, info: number) => slots.push(at | ((op | (info << 4)) << 8));
        switch (c.op) {
          case 'push': code(0, c.reg); break;
          case 'alloc':
            if (c.off % 8) throw new AsmError('.seh_stackalloc must be a multiple of 8', f.line);
            if (c.off <= 128) code(2, c.off / 8 - 1);
            else if (c.off <= 512 * 1024 - 8) { code(1, 0); slots.push(c.off / 8); }
            else { code(1, 1); slots.push(c.off & 0xffff, c.off >>> 16); }
            break;
          case 'setframe': code(3, 0); break;
          case 'savereg': code(4, c.reg); slots.push(c.off / 8); break;
          case 'savexmm': code(8, c.reg); slots.push(c.off / 16); break;
        }
      }
      const xo = xdata.data.length;
      const fr = f.frame ? f.frame.reg | ((f.frame.off / 16) << 4) : 0;
      xdata.data.push(1, prolog, slots.length, fr);
      for (const s of slots) xdata.data.push(s & 0xff, (s >> 8) & 0xff);
      if (slots.length % 2) xdata.data.push(0, 0);
      const xlabel = `$unwind$${f.name}`;
      symbols.set(xlabel, { name: xlabel, sect: xdata, off: xo, global: false, line: f.line, func: false });
      const po = pdata.data.length;
      pdata.data.push(...new Array(12).fill(0));
      pdata.fixups.push({ off: po, size: 4, kind: 'rva', sym: f.start, add: 0n, end: 0, line: f.line });
      pdata.fixups.push({ off: po + 4, size: 4, kind: 'rva', sym: f.end!, add: 0n, end: 0, line: f.line });
      pdata.fixups.push({ off: po + 8, size: 4, kind: 'rva', sym: xlabel, add: 0n, end: 0, line: f.line });
    }
    xdata.size = xdata.data.length;
    pdata.size = pdata.data.length;
  }
  const sections = order.map((n) => lists.get(n)!.sect).filter((s) => s.size > 0 || s.name === '.text');
  return { sections, symbols, globals, lines: count };
}
