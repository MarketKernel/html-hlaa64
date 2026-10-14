# HLA64 — an assembler with syntactic sugar for Apple Silicon, Windows x64, Linux x64 and WebAssembly, written entirely in TypeScript

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="docs/ru/README.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

**HLA64 is an assembler, not a new programming language.** An HLA64 program is an ordinary
assembly listing: `ldr`, `bfi`, `csel`, `umulh`, `b.lt` (on x64 — `mov`, `cmovg`, `mul`, `jl`, on
WebAssembly — `local.get`, `i64.add`, `br_if`) are written right in the code, as they are. The sugar — `for`, `if`, `a = b + c * 4`, `numbers[i]`,
`printf(...)` — is added on top so you don't have to type dozens of `stp/adrp/ldr/b.lt` lines by
hand where they are obvious. Each line of sugar expands into a few instructions that you can see in
the listing, and anywhere in a function you can go back to plain instructions.

What makes it different:

1. **The whole toolchain is one HTML file.** The translator, assembler, linker and emulator all fit
   in a single page that works offline. Open the
   [online version](https://marketkernel.github.io/html-hlaa64/) or download `hla64-vX.Y.Z.html`
   from the [latest release](../../releases/latest): it runs in any modern browser on macOS,
   Windows, Linux or a phone, needs no installation and no network, and can be carried around
   on a USB stick.
2. **The toolchain builds itself.** Among the examples are **Translator in HLA64 (hla → s)** and
   **Assembler in HLA64 (s → executable)**: a translator and an assembler written in HLA64 itself
   ([selfhost/](selfhost/README.md)). The TypeScript toolchain builds them into native executables
   (Mach-O for macOS or `.exe` for Windows), and those executables can in turn rebuild themselves
   from the same sources, byte for byte. Compiled to WebAssembly, the same tools run right in the
   page and make the same files.
3. **A course of 14 lessons** — from “Hello, world” to the Game of Life and calling HLA64 from C.
   Every lesson has programs you can run and exercises, and processor instructions appear right from
   the first one, next to the sugar, so the course works well for teaching assembly.
   See the [list of lessons](#lessons).

This is not an attempt to recreate C: there is no hidden runtime, no optimizer that reorders code,
and registers have no types (width and signedness are set by the instructions themselves and by
`i32[...]`, `u8[p]` when accessing memory). The registers belong to you: a variable is a name for a
register (`let i: x19`), and instructions see variables, parameters, data and labels by name.

```hla
fn clamp(v, lo, hi) {            // the parameters are x0, x1, x2
    cmp v, lo                    // processor instructions as they are
    csel v, lo, v, lt
    cmp v, hi
    csel x0, hi, v, gt           // the result is already in x0
}

fn length(s) {
    let p: x9 = s                // sugar: variable = register x9
    do {
        ldrb w10, [p], #1        // instruction: load the byte at address p, then p += 1
    } while w10 != 0             // sugar: a single cbnz
    return p - s - 1
}
```

The listing of `length` — your instruction in place, the sugar around it; the translator added the
prologue and epilogue:

```asm
_length:
    stp x29, x30, [sp, #-16]!
    mov x29, sp
    mov x9, x0                   // let p: x9 = s
Llength.body2:
    ldrb w10, [x9], #1           // the line from the source, p replaced with x9
    cbnz w10, Llength.body2      // } while w10 != 0
    sub x0, x9, x0               // return p - s - 1
    sub x0, x0, #1
    ldp x29, x30, [sp], #16
    ret
```

Instructions are written in the platform's syntax (the Apple dialect of AArch64, Intel/LLVM for
x86-64, the text format of WebAssembly). The built-in assembler understands ≈140 AArch64 mnemonics,
the main integer and SSE instructions of x86-64 (no SIMD vectors yet) and the WebAssembly
instructions without SIMD; with `--clang` the build is done by `clang`, and then everything it knows
is available. A complete example — [examples/mixed.hla](examples/mixed.hla).

A rethinking of hlaa64, a [high-level assembler](https://en.wikipedia.org/wiki/High-level_assembler), in TypeScript.

The whole pipeline is written in TypeScript with no external runtime dependencies and works
both in Node and **in the browser, offline**:

```
 program.hla ──► translator ──► AArch64 assembly ──► encoder + linker ──► Mach-O (arm64, signed) ──► run
                 src/lang        (text, Apple dialect)  src/asm                                     on macOS or in the src/emu emulator
```

| Component | What it does |
|---|---|
| `src/lang` | HLA64 lexer, parser and code generator → AArch64 assembly |
| `src/asm` | assembler (≈140 mnemonics + all `b.cond`, directives, numeric labels); `.o` object files with relocations, static `.a` and dynamic `.dylib` libraries; Mach-O linker: GOT/stubs for libSystem, dyld rebase/bind opcodes, symbol table, **ad-hoc code signature** (SHA-256 CodeDirectory — without it the kernel won't run an arm64 binary) |
| `src/emu` | ARM64 emulator: loads the resulting Mach-O, applies the bind opcodes, substitutes a JS libSystem (`printf`, `puts`, `malloc`, `qsort` with a callback, etc.) and executes the machine code |
| `web/` → `dist/hla64.html` | a single self-contained HTML file: an editor with syntax highlighting, live translation, a machine-code listing with bit-level breakdown, a Mach-O / PE / ELF inspector, the emulator console, building a program or a library for C (`.a` / `.dylib`, `.lib` / `.dll` or `.a` / `.so` + `.h`) and downloading the result; the platform is switched at the very top |
| `src/lang/x64`, `src/asm/x64`, `src/asm/coff`, `src/emu/x64` | the second platform — **Windows x64**: Win64 code generator, x86-64 assembler (Intel, LLVM dialect), COFF object files, PE linker (`.exe`/`.dll`), static libraries and `.lib` import libraries, x64 emulator with a PE loader. Details — [docs/windows.md](docs/windows.md) |
| `src/lang/x64` (System V), `src/asm/elf`, `src/emu/x64/elf-loader.ts` | **Linux x64**: the same x86-64 code generator with the System V convention and `syscall`, ELF object files, an ELF linker (executables and `.so`, dynamically linked against glibc), GNU `ar` static libraries, ELF loader with a JS glibc in the x64 emulator. Details — [docs/linux.md](docs/linux.md) |
| `src/lang/wasm`, `src/asm/wasm`, `src/wasm` | **WebAssembly (wasm32)**: code generator for the stack machine (registers are locals, loops are blocks), WAT assembler with type checking, a JavaScript runtime as the system (`printf`, `malloc`, `fopen`… as imports); programs run natively in the browser and in Node and download as `.wasm` + a page with a console. Details — [docs/wasm.md](docs/wasm.md) |

## Quick start

```sh
npm install                                    # development tools only (typescript, esbuild)

node src/cli.ts run examples/showcase.hla      # translate + build with our own assembler + run
node src/cli.ts compile examples/hello.hla     # show the generated assembly
node src/cli.ts build examples/hello.hla -o hello && ./hello
node src/cli.ts build examples/hello.hla -o hello --zip   # + hello.zip: contains the file with the +x bit
node src/cli.ts run examples/hello.hla --clang # the same via clang (for comparison)
node src/cli.ts emu examples/mandelbrot.hla    # run in the built-in emulator (no macOS needed)
node src/cli.ts asm hello.s -o hello           # build a regular .s with the built-in assembler
node src/cli.ts lib mathlib.hla                # a library for C: mathlib.h + .o + .a + .dylib
node src/cli.ts obj app.hla                    # an object file to link with C code

node src/cli.ts run examples/hello.hla --target x64-windows    # Windows x64 (outside Windows — in the x64 emulator)
node src/cli.ts build examples/hello.hla --target x64-windows  # hello.exe
node src/cli.ts run examples/hello.hla --target x64-linux      # Linux x64 (outside Linux x86-64 — in the x64 emulator)
node src/cli.ts build examples/hello.hla --target x64-linux    # hello (ELF, linked against glibc)
node src/cli.ts run examples/hello.hla --target wasm32         # WebAssembly: run in Node's engine
node src/cli.ts build examples/hello.hla --target wasm32       # hello.wasm + hello.html (console page) + hello.mjs (Node)

npm run build:web                              # build dist/hla64.html and the PWA in dist/pages/
open dist/hla64.html                           # works over file://, no network needed

./build.sh                                     # the same in one command (installs the tools itself if missing)
./build.sh check open                          # + typecheck and CI tests before the build, then open the page
```

The online page lives on GitHub Pages as an installable app (PWA): after the first visit the
service worker keeps it in the cache, and it works without a network. A ready-made
`hla64-vX.Y.Z.html` file is attached to every [release](../../releases).

On the left of the page is an IDE-like panel: **Files** (the files of the open project; the main one
is marked `main`, the others are pulled in via `include`; files can be created, renamed — `include`s
follow the file — deleted and dragged in from disk), **Projects** (your own projects for the current
platform) and **Examples** (built-in examples; a modified example is marked with a dot and can be
reset to the original). Projects are stored in this browser's IndexedDB; **Download project .zip**
downloads all the project's files. A program with `include "std/file.hla"` (the same file functions
for macOS, Windows and Linux) reads the project's files, and the files it writes appear in the panel.

Node 24+ is required (it runs `.ts` directly). On the page, the **Download executable** button gives
you a ready Mach-O; the browser strips the executable bit and sets quarantine, so the page shows
a command for Terminal (`chmod +x … && xattr -d com.apple.quarantine … ; ./…`) and offers a
`.zip` option: in the archive the file is stored with mode `0755`, so after unpacking (Finder or
`unzip`) it is executable right away. If the zip was obtained via a browser, macOS carries the
quarantine flag over to the unpacked file, and Gatekeeper won't run it until you execute
`xattr -d com.apple.quarantine <file>` (only a Developer ID signature with notarization can get
around this). The **Copy Terminal command** button needs no download: the command recreates the
file from base64 right in Terminal, without quarantine.

## Sugar up close

Sugar is shorthand for what you would otherwise write as instructions: loops, conditions,
expressions, array access, ABI calls. Where an instruction is more convenient, you write an
instruction:

```hla
extern printf(fmt, ...)

data numbers: i32[8] = [42, -7, 19, 3, 88, 0, -15, 61]

fn sort_numbers() {                         // insertion sort
    for i: x9 in 1..8 {
        let key: w10 = numbers[i]
        let j: x11 = i - 1
        while j >= 0 && numbers[j] > key {
            w12 = numbers[j]
            numbers[j + 1] = w12
            j--
        }
        numbers[j + 1] = key
    }
}

fn fib(n: auto) {                           // n survives the recursive call
    if n < 2 { return n }
    let a = fib(n - 1)
    x0 = fib(n - 2)
    add x0, x0, a                           // an instruction instead of return a + x0
}

fn main() {
    sort_numbers()
    printf("fib(20) = %ld, smallest = %d\n", fib(20), numbers[0])
}
```

What `while j >= 0 && numbers[j] > key` turns into:

```asm
Lsort_numbers.next5:
    cmp x11, #0
    b.lt Lsort_numbers.skip7
    adrp x17, _numbers@PAGE
    add x17, x17, _numbers@PAGEOFF
    ldr w16, [x17, x11, lsl #2]
    cmp w16, w10
    b.gt Lsort_numbers.body6
```

The full reference: **[docs/language.md](docs/language.md)**. A big program that uses
almost everything: [examples/showcase.hla](examples/showcase.hla).

## Lessons

A course for beginners, from “Hello, world” to the Game of Life: **[docs/lessons](docs/lessons/README.md)**.
Processor instructions appear in it from the first lesson, alongside the sugar.

| # | Lesson | What it covers |
|---|---|---|
| 1 | [Hello, world](docs/lessons/01-hello-world.md) | first program, the `main` function, comments, the first processor instruction in code |
| 2 | [Registers and variables](docs/lessons/02-registers-and-variables.md) | what a register is, `let`, `alias`, constants, printing numbers |
| 3 | [Arithmetic and expressions](docs/lessons/03-arithmetic.md) | operators, precedence, bits and shifts, 32 and 64 bits |
| 4 | [Conditions](docs/lessons/04-conditions.md) | `if / elif / else`, comparisons, `&&` `\|\|` `!`, the ternary operator |
| 5 | [Loops](docs/lessons/05-loops.md) | `while`, `do … while`, `loop`, `for … in`, `break` and `continue` |
| 6 | [Functions](docs/lessons/06-functions.md) | parameters, `return`, recursion, which registers a call clobbers |
| 7 | [Data and arrays](docs/lessons/07-data-and-arrays.md) | `data`, `rodata`, strings, arrays, `len` and `sizeof` |
| 8 | [Memory and pointers](docs/lessons/08-memory-and-pointers.md) | addresses, `u8[p]`, `[p++]`, local buffers on the stack |
| 9 | [Structs and enums](docs/lessons/09-structs-and-enums.md) | `struct`, `enum`, arrays of structs, a linked list |
| 10 | [The C library and the system](docs/lessons/10-c-library-and-syscalls.md) | `extern`, `printf`, `malloc`, `qsort` and function pointers, `syscall` |
| 11 | [Floating-point numbers](docs/lessons/11-floating-point.md) | `d` and `s` registers, `float()` and `int()`, `sqrt` |
| 12 | [Under the hood](docs/lessons/12-under-the-hood.md) | `asm { }` blocks and numeric labels, `naked`, `push`/`pop`, how a function call works |
| 13 | [Project: the Game of Life](docs/lessons/13-project-game-of-life.md) | everything together in one program |
| 14 | [A library for C (and C for HLA64)](docs/lessons/14-c-library.md) | `export`, parameter types, `.h`/`.o`/`.a`/`.dylib`, C ↔ HLA64 calls (needs a Mac with `clang`) |

## Libraries for C

Functions with `export` and parameter types can be called from C: `node src/cli.ts lib mathlib.hla`
generates a header and libraries, then it's the usual `clang main.c libmathlib.a`. It also works the
other way round: an HLA64 program calls C functions via `extern`. Step by step — in [lesson 14](docs/lessons/14-c-library.md).
On the `dist/hla64.html` page the same is done by the **Build as: Program / Static lib .a / Dynamic lib .dylib** switch:
the header is on the **C header** tab, plus a zip with the `.h`, the library and `main.c`, or a Terminal command that builds everything with `clang` and runs it.

## Examples

| File | What it's about |
|---|---|
| [mixed.hla](examples/mixed.hla) | instructions and sugar in the same functions: `ldrb` with post-increment inside `do … while`, `bfi`/`ubfx`, `cmp`+`csel` without branches, `umulh` after a sugar xorshift, a loop on a label with `b.lt` (for Windows — [tests/x64/cases/mixed.hla](tests/x64/cases/mixed.hla) with `cmovg`, `mul`, `jl`; for WebAssembly — [tests/wasm/cases/mixed.hla](tests/wasm/cases/mixed.hla) with `local.get`, `select`, `br_if`) |
| [hello.hla](examples/hello.hla) | a minimal program |
| [showcase.hla](examples/showcase.hla) | a tour of the language: structs, enums, arrays, strings, recursion, qsort with a callback, FP, syscall, naked functions, push/pop, goto |
| [mandelbrot.hla](examples/mandelbrot.hla) | the Mandelbrot set on d registers: floating-point expressions next to `fmul` |
| [fizzbuzz.hla](examples/fizzbuzz.hla) | `for … in`, `if/elif/else` |
| [bare-metal.hla](examples/bare-metal.hla) | no libc: `svc #0x80`, printing numbers into a stack buffer, inline assembly with numeric labels |

## A toolchain in HLA64 itself (`selfhost/`)

[selfhost/](selfhost/README.md) contains a translator and an assembler written in HLA64:
`hlc-arm`/`hlc-x64` translate HLA64 (without registers) into AArch64 or x86-64 assembly,
`hlas-arm`/`hlas-x64` build a signed Mach-O or an `.exe` from it. After bootstrapping with
the TypeScript version they rebuild themselves byte for byte, and their executables match
the output of the linkers in `src/asm`. To check — `selfhost/test.sh`. Built for wasm32, all four
tools run in the browser and produce the same files (`npm run test:wasm` checks it).

## Tests

```sh
npm test                 # all examples and tests/cases × {clang, own assembler, emulator}: 54 runs
npm run test:lessons     # 108 programs from the lessons + building lesson 14 with clang (--native: programs also on macOS)
npm run test:encoding    # 248 instruction forms: encoding matches clang bit for bit
npm run fuzz             # differential fuzzer: ~1200 random expressions, native and emulator vs. a BigInt reference
npm run check:web        # open the page in headless Chrome, run the examples of every platform, take screenshots
npm run check:pwa        # dist/pages/ over http in headless Chrome: service worker, manifest, reload without network
npm run typecheck

npm run test:x64         # Windows x64: x64 programs + portable lesson programs in the x64 emulator (on Windows — natively too)
npm run test:x64-clang   #   … and the same assembly via clang + lld-link
npm run test:x64-encoding  # 987 x86-64 forms: bit for bit with clang
npm run test:coff        # COFF object vs. clang, lld-link, own PE linker
npm run test:x64-lib     # C ↔ HLA64 on Windows: .lib, .dll + import library (clang and lld-link; on Windows — also MSVC and SEH)
npm run test:linux       # Linux x64: Linux and x64 programs + portable lesson programs in the x64 emulator (on Linux — natively too)
npm run test:linux-clang #   … and the same assembly via clang + lld (zig cc outside Linux), and our .o linked by lld
npm run test:linux-lib   # C ↔ HLA64 on Linux: .a, .so (PIE and not, copy relocations), cc -shared from our .o, HLA64 calling C
npm run test:wasm        # WebAssembly: wasm32 programs + portable programs and lessons in Node's engine (+ binaryen wasm-as if installed)
npm run check:wasm-page  # the page of a downloaded program in headless Chrome: over http and from disk
npm run test:all         # everything in a row
npm run test:ci          # what CI runs on Linux (parts that need macOS or clang skip themselves)
```

Every program in `examples/` and `tests/cases/` with an `.expected` file is checked three times:
built with `clang`, built with the built-in assembler and run on macOS, and executed in the emulator.
`codesign -v` considers the binaries' signatures valid.

### Building in GitHub Actions

- [pages.yml](.github/workflows/pages.yml) — on every push to `main`: type checking, `test:ci`,
  build, `check:pwa` and publishing `dist/pages/` to GitHub Pages
  (in the repository settings: Settings → Pages → Source: **GitHub Actions**).
- [release.yml](.github/workflows/release.yml) — on a `v*` tag: the same checks, then a release with
  `hla64-vX.Y.Z.html` and `SHA256SUMS.txt`. The version is taken only from `package.json`, and the tag
  must match it: `npm version 0.2.0 && git push --follow-tags`. It can also be run manually
  (Run workflow, specify the tag) — the files of an existing release will be replaced.

## How it works

### Translator (`src/lang`)
- `lexer.ts`, `parser.ts` → AST (`ast.ts`); operator precedence as in Go.
- A line that doesn't parse as sugar is an instruction: it goes into the listing as is, with the
  names of variables, parameters, constants, data and labels replaced by registers and symbols.
- `codegen.ts` — code generation aware of AArch64 addressing modes and instruction forms:
  add/sub immediates (12 bits, `lsl #12`), logical bitmask immediates, `movz/movk/movn`,
  shifted and extended operands, `madd/msub`, `csel/cset`, `cbz/tbz/tst`, post-increment,
  scaled indexes. Scratch registers `x16/x17` (+ free callee-saved ones, then
  `x9..x15` not named in the function); the prologue saves exactly those callee-saved registers
  that appear in the function body; `let`s beyond the free registers are spilled to the stack frame.

### Assembler and linker (`src/asm`)
- `parse.ts` — parsing of lines, operands and expressions (`sym@PAGE`, `sym@GOTPAGEOFF`, `#imm`, `[x1, w2, sxtw #2]`).
- `encode.ts` — instruction encoder; address-dependent fields are handed to the linker as fixups.
- `assembler.ts` — sections, symbols, directives (`.section`, `.p2align`, `.asciz`, `.quad`, `.zerofill`, …).
- `macho-object.ts` — `MH_OBJECT` object files (relocations `BRANCH26`, `PAGE21`, `PAGEOFF12`, `GOT_LOAD_*`, `UNSIGNED`);
  `archive.ts` — static libraries (`ar` with a `__.SYMDEF SORTED` table of contents).
- `macho.ts` — executables and `.dylib`s (`LC_ID_DYLIB`, export table); the `__PAGEZERO / __TEXT / __DATA / __LINKEDIT` layout, stubs and GOT for imports
  from `libSystem.B.dylib`, rebase/bind opcodes (`LC_DYLD_INFO_ONLY`), `LC_MAIN`, symtab/dysymtab,
  export trie, `LC_BUILD_VERSION`, UUID and the ad-hoc signature (`sha256.ts`).

### Emulator (`src/emu`)
- `cpu.ts` — AArch64 interpreter (integer ops, loads/stores in all modes, branches,
  conditional operations, FP); decoded instructions are cached as closures. ~8–15 million instructions/s.
- `macho-loader.ts` — Mach-O loader, applying bind opcodes, a JS “libSystem”, syscalls.
- `printf.ts` — `printf` formatting (flags, width, precision, `%d %u %x %s %c %p %f %e %g`).

## Project structure

```
src/lang/      HLA64 translator (frontend.ts — shared part, codegen.ts — AArch64, x64/ — Windows and Linux x64, wasm/ — WebAssembly)
src/asm/       assembler + Mach-O linker; x64/ — x86-64 assembler; coff/ — COFF, PE, .lib; elf/ — ELF .o, linker, .a, glibc exports; wasm/ — WAT → .wasm
src/emu/       ARM64 emulator; x64/ — x86-64 emulator, PE and ELF loaders
src/wasm/      the system of WebAssembly programs: JavaScript runtime, the C functions it gives, the page of a downloaded program
src/cli.ts     command line
web/           page sources (template.html, main.ts, worker.ts; sw.js — the PWA service worker)
assets/        icon (icon.svg) and PWA PNG icons (npm run build:icons regenerates them from the SVG)
dist/hla64.html  the built page (not committed: npm run build:web)
dist/pages/    PWA for GitHub Pages: index.html, hla64.html, sw.js, manifest, icons
examples/      examples (.hla + .expected)
tests/         run.ts, encoding.ts, fuzz.ts, cases/; x64.ts, x64-lib.ts, encoding-x64.ts, coff-x64.ts, x64/; linux.ts, linux-lib.ts, linux/; wasm.ts, wasm/
docs/          language reference, lessons (docs/lessons), Windows x64 (docs/windows.md), Linux x64 (docs/linux.md), WebAssembly (docs/wasm.md)
```
