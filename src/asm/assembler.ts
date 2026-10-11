// Assembler pass: turns assembly text into sections with bytes, symbols and fixups.
import { AsmError, parseOperand, parseSource, parseStringLiteral, parseValue, splitOperands } from './parse.ts';
import { encode, type Fixup } from './encode.ts';

export interface Section {
  seg: string;
  name: string;
  flags: number;          // Mach-O section type/attributes
  align: number;          // log2
  data: number[];         // bytes (empty for zerofill)
  size: number;           // == data.length unless zerofill
  zerofill: boolean;
  fixups: SectFixup[];
  insns: { off: number; line: number }[];   // instruction offsets with their source lines
  // assigned by the linker
  addr: number;
  fileOff: number;
}

export interface SectFixup {
  off: number;
  line: number;
  fix: Fixup | { kind: 'abs64'; sym: string; add: bigint };
}

export interface SymDef {
  name: string;
  sect: Section;
  off: number;
  global: boolean;
  line: number;
}

export interface Assembly {
  sections: Section[];
  symbols: Map<string, SymDef>;
  globals: Set<string>;
  lines: number;          // instruction count, for statistics
}

const S_REGULAR = 0x0, S_ZEROFILL = 0x1, S_CSTRING_LITERALS = 0x2, S_4BYTE_LITERALS = 0x3, S_8BYTE_LITERALS = 0x4,
  S_16BYTE_LITERALS = 0xe;
const S_ATTR_PURE_INSTRUCTIONS = 0x80000000, S_ATTR_SOME_INSTRUCTIONS = 0x400;

function sectionFlags(seg: string, name: string, type: string | undefined): number {
  if (seg === '__TEXT' && name === '__text') return S_REGULAR | S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS;
  switch (type ?? '') {
    case 'cstring_literals': return S_CSTRING_LITERALS;
    case '4byte_literals': return S_4BYTE_LITERALS;
    case '8byte_literals': return S_8BYTE_LITERALS;
    case '16byte_literals': return S_16BYTE_LITERALS;
    case 'zerofill': return S_ZEROFILL;
    case 'regular': case '': break;
    default:
      if (type!.includes('pure_instructions')) return S_REGULAR | S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS;
  }
  if (name === '__cstring') return S_CSTRING_LITERALS;
  if (name === '__literal8') return S_8BYTE_LITERALS;
  if (name === '__literal4') return S_4BYTE_LITERALS;
  if (name === '__literal16') return S_16BYTE_LITERALS;
  if (name === '__bss' || name === '__common') return S_ZEROFILL;
  return S_REGULAR;
}

export function assemble(src: string): Assembly {
  const sections: Section[] = [];
  const symbols = new Map<string, SymDef>();
  const globals = new Set<string>();
  let count = 0;

  const getSection = (seg: string, name: string, type?: string): Section => {
    let s = sections.find((x) => x.seg === seg && x.name === name);
    if (!s) {
      const flags = sectionFlags(seg, name, type);
      s = {
        seg, name, flags, align: name === '__text' ? 2 : 0, data: [], size: 0, zerofill: (flags & 0xff) === S_ZEROFILL,
        fixups: [], insns: [], addr: 0, fileOff: 0,
      };
      sections.push(s);
    }
    return s;
  };
  let cur = getSection('__TEXT', '__text');

  const defineSym = (name: string, sect: Section, off: number, line: number) => {
    if (symbols.has(name)) throw new AsmError(`symbol '${name}' is already defined`, line);
    symbols.set(name, { name, sect, off, global: false, line });
  };

  const emitBytes = (bytes: number[], line: number) => {
    if (cur.zerofill) {
      if (bytes.some((b) => b !== 0)) throw new AsmError('cannot put data into a zerofill section', line);
      cur.size += bytes.length;
      return;
    }
    for (const b of bytes) cur.data.push(b & 0xff);
    cur.size = cur.data.length;
  };

  const align = (p2: number, line: number) => {
    if (p2 > 15) throw new AsmError('alignment too large', line);
    cur.align = Math.max(cur.align, p2);
    const a = 1 << p2;
    const isCode = (cur.flags & S_ATTR_PURE_INSTRUCTIONS) !== 0;
    while (cur.size % a !== 0) {
      if (isCode && cur.size % 4 === 0 && cur.size + 4 <= Math.ceil(cur.size / a) * a) emitBytes([0x1f, 0x20, 0x03, 0xd5], line);
      else emitBytes([0], line);
    }
  };

  const dataValues = (args: string, size: number, line: number) => {
    for (const a of splitOperands(args)) {
      const v = parseValue(a, line);
      if (v.reloc) throw new AsmError('relocation modifiers are not allowed in data', line);
      if (v.sym) {
        if (size !== 8) throw new AsmError('symbol addresses need a 64-bit data directive (.quad)', line);
        cur.fixups.push({ off: cur.size, line, fix: { kind: 'abs64', sym: v.sym, add: v.add } });
        emitBytes([0, 0, 0, 0, 0, 0, 0, 0], line);
        continue;
      }
      const n = BigInt.asUintN(size * 8, v.add);
      const bytes: number[] = [];
      for (let i = 0; i < size; i++) bytes.push(Number((n >> BigInt(8 * i)) & 0xffn));
      emitBytes(bytes, line);
    }
  };

  for (const st of parseSource(src)) {
    const line = st.line;
    if (st.k === 'label') {
      defineSym(st.name, cur, cur.size, line);
      continue;
    }
    if (st.k === 'dir') {
      const a = st.args;
      switch (st.name) {
        case '.text': cur = getSection('__TEXT', '__text'); break;
        case '.data': cur = getSection('__DATA', '__data'); break;
        case '.cstring': cur = getSection('__TEXT', '__cstring', 'cstring_literals'); break;
        case '.const': cur = getSection('__TEXT', '__const'); break;
        case '.const_data': cur = getSection('__DATA', '__const'); break;
        case '.literal8': cur = getSection('__TEXT', '__literal8', '8byte_literals'); break;
        case '.literal4': cur = getSection('__TEXT', '__literal4', '4byte_literals'); break;
        case '.bss': cur = getSection('__DATA', '__bss', 'zerofill'); break;
        case '.section': {
          const parts = a.split(',').map((x) => x.trim());
          if (parts.length < 2) throw new AsmError('.section needs SEGMENT,SECTION', line);
          if (parts[0].length > 16 || parts[1].length > 16) throw new AsmError('segment/section names are limited to 16 characters', line);
          cur = getSection(parts[0], parts[1], parts[2]);
          break;
        }
        case '.globl': case '.global':
          for (const n of a.split(',')) globals.add(n.trim());
          break;
        case '.private_extern': case '.weak_definition': case '.weak_reference': case '.no_dead_strip':
        case '.subsections_via_symbols': case '.build_version': case '.macosx_version_min': case '.file': case '.loc':
        case '.cfi_startproc': case '.cfi_endproc': case '.cfi_def_cfa': case '.cfi_offset': case '.cfi_def_cfa_offset':
        case '.ident': case '.p2alignl': case '.type': case '.size': case '.local':
          break;
        case '.p2align': case '.align': {
          const p2 = Number(parseValue(splitOperands(a)[0], line).add);
          align(p2, line);
          break;
        }
        case '.balign': {
          const n = Number(parseValue(splitOperands(a)[0], line).add);
          if (n & (n - 1)) throw new AsmError('.balign needs a power of two', line);
          align(Math.log2(n), line);
          break;
        }
        case '.byte': dataValues(a, 1, line); break;
        case '.short': case '.hword': case '.2byte': dataValues(a, 2, line); break;
        case '.long': case '.word': case '.int': case '.4byte': dataValues(a, 4, line); break;
        case '.quad': case '.xword': case '.8byte': case '.dword': dataValues(a, 8, line); break;
        case '.double': case '.float': case '.single': {
          for (const x of splitOperands(a)) {
            const v = parseFloat(x);
            if (Number.isNaN(v)) throw new AsmError(`bad float '${x}'`, line);
            const dv = new DataView(new ArrayBuffer(8));
            if (st.name === '.double') { dv.setFloat64(0, v, true); emitBytes([...new Uint8Array(dv.buffer)], line); }
            else { dv.setFloat32(0, v, true); emitBytes([...new Uint8Array(dv.buffer, 0, 4)], line); }
          }
          break;
        }
        case '.ascii': case '.asciz': case '.string': {
          for (const s of splitOperands(a)) {
            const bytes = parseStringLiteral(s, line);
            if (st.name !== '.ascii') bytes.push(0);
            emitBytes(bytes, line);
          }
          break;
        }
        case '.space': case '.skip': case '.zero': {
          const ops = splitOperands(a);
          const n = Number(parseValue(ops[0], line).add);
          const fill = ops[1] ? Number(parseValue(ops[1], line).add) : 0;
          if (n < 0 || n > 1 << 28) throw new AsmError('bad .space size', line);
          if (cur.zerofill && fill === 0) cur.size += n;
          else emitBytes(new Array(n).fill(fill), line);
          break;
        }
        case '.zerofill': {
          // .zerofill SEG,SECT,sym,size,align
          const p = a.split(',').map((x) => x.trim());
          const s = getSection(p[0], p[1], 'zerofill');
          if (!s.zerofill) throw new AsmError(`${p[0]},${p[1]} is not a zerofill section`, line);
          if (p[2]) {
            const p2 = p[4] ? Number(p[4]) : 0;
            s.align = Math.max(s.align, p2);
            s.size = Math.ceil(s.size / (1 << p2)) * (1 << p2);
            defineSym(p[2], s, s.size, line);
            s.size += Number(parseValue(p[3] ?? '0', line).add);
          }
          break;
        }
        case '.set': case '.equ': {
          throw new AsmError(`${st.name} is not supported (use HLA64 constants)`, line);
        }
        default:
          throw new AsmError(`unknown directive '${st.name}'`, line);
      }
      continue;
    }
    // instruction
    if (cur.zerofill || !(cur.flags & S_ATTR_PURE_INSTRUCTIONS)) {
      throw new AsmError(`instruction '${st.mn}' outside of a code section`, line);
    }
    if (cur.size % 4) throw new AsmError('misaligned instruction', line);
    const ops = st.ops ? splitOperands(st.ops).map((o) => parseOperand(o, line)) : [];
    const enc = encode(st.mn, ops, line);
    if (enc.fixup) cur.fixups.push({ off: cur.size, line, fix: enc.fixup });
    cur.insns.push({ off: cur.size, line });
    const w = enc.word >>> 0;
    emitBytes([w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff], line);
    count++;
  }
  for (const g of globals) if (symbols.has(g)) symbols.get(g)!.global = true;
  return { sections: sections.filter((s) => s.size > 0 || s.name === '__text'), symbols, globals, lines: count };
}
