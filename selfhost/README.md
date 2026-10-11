# selfhost — an HLA64 toolchain written in HLA64

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="README.ru.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

This directory contains an HLA64 translator and assembler written in HLA64 itself. They build
themselves and finished programs for two platforms, without the TypeScript version from `src/`:

| program | what it does | source |
|---|---|---|
| `hlc-arm` | HLA64 → AArch64 assembly (macOS) | [hlc-arm.hla](hlc-arm.hla) |
| `hlc-x64` | HLA64 → x86-64 assembly (Windows) | [hlc-x64.hla](hlc-x64.hla) |
| `hlas-arm` | AArch64 assembly → a signed Mach-O executable | [hlas-arm.hla](hlas-arm.hla) |
| `hlas-x64` | x86-64 assembly → a PE executable (`.exe`) | [hlas-x64.hla](hlas-x64.hla) |

```sh
hlc-arm  prog.hla prog.s      # translator
hlas-arm prog.s   prog        # assembler and linker: a finished program for macOS
./prog
```

The platform a tool runs on and the platform it writes code for are unrelated.
Any of the four can be built both for macOS and for Windows: for example, `hlc-x64` built for
macOS writes assembly for Windows.

## In the browser

In the workbench (`./build.sh open`) both platforms have two examples. Each tool there is a
project with its own sources:

| example | main file | arguments | result |
|---|---|---|---|
| **Translator in HLA64 (hla → s)** | `hlc-arm.hla` | `hello.hla hello.s` | `hello.s` appears in the project |
| | `hlc-x64.hla` | `hello.hla hello-x64.s` | `hello-x64.s` |
| **Assembler in HLA64 (s → executable)** | `hlas-arm.hla` | `hello.s hello` | a macOS executable |
| | `hlas-x64.hla` | `hello-x64.s hello.exe` | a Windows executable |

- When opened, an example immediately runs its tool in the emulator on the project's files.
- The other tool of the pair becomes the main one via ▶ in the Files list. The command line is set
  in the Arguments field above the console.
- Text files written by a tool become project files. Binary files are shown in the console with
  Run (run in the emulator) and Download buttons.
- Download executable (on Windows Download .exe) saves the tool itself, built for the
  selected platform.
- `hello.s` and `hello-x64.s` in the assembler example were made by `hlc` from `hello.hla`. `test.sh`
  checks that they are not out of date.

`npm run check:selfhost-web` goes through both chains on both platforms in headless Chrome.

## How to build and test

```sh
./test.sh         # everything: macOS and Windows (Windows programs run in the built-in x64 emulator)
./test.sh arm     # AArch64 only
```

Node 24+ is needed — only for the first build (bootstrapping) and as a reference for comparison.
Everything goes into `build/`. The script checks:

1. **Bootstrapping.** `hlc1` and `hlas1` are built by the TypeScript toolchain (`node ../src/cli.ts build`).
2. **Own toolchain.** `hlc1` translates `hlc-arm.hla` and `hlas-arm.hla`, and `hlas1` builds
   `hlc2` and `hlas2` from that. The executables **match byte for byte** the output of the
   TypeScript linker.
3. **Fixed point.** `hlc2` and `hlas2` rebuild themselves and produce the same bytes. From this
   point on TypeScript is no longer needed.
4. **Tests** `tests/**/*.hla`: `hlc2` + `hlas2`, run, compare with `.expected`. For each
   program the executable is once more checked against the TypeScript linker. `.error` files
   specify the expected error message.
5–8. **Windows.** The same tools for x86-64: `hlc.exe` and `hlas.exe` are byte-for-byte equal to
   the output of the TypeScript PE linker. The tests run in the x64 emulator. In the emulator
   `hlc.exe` and `hlas.exe` rebuild themselves and produce the same bytes.
9. **Workbench example.** The TypeScript translator builds all four tools for Windows, just as
   the example in the browser does. In the emulator they build `hello.hla`, and the result matches
   the output of the tools here byte for byte.

On real Windows the `.exe`s from `build/w/` run as is: `hlc.exe prog.hla prog.s`,
`hlas.exe prog.s prog.exe`.

## How it works

```
hello.hla   the program for the examples; hello.s, hello-x64.s — what hlc makes from it
lib/        portable layer and shared libraries
  sys.hla       OS: memory, files, output, exit — only C runtime functions that exist
                both in libSystem (macOS) and in msvcrt.dll (Windows)
  text.hla      strings, the growable buffer Buf, formatting (%d %s %c) without printf
  intern.hla    name table: each name is stored once and known by its number
  sha256.hla    SHA-256 (UUID and the Mach-O code signature)
front/      translator: the part shared by both platforms
  lexer.hla     text → tokens; include is handled here too (each file once)
  names.hla     keywords, types, meaning of top-level names
  ast.hla       syntax tree nodes
  parser.hla    tokens → tree; top-level declarations go straight into the name table
  consts.hla    constants, sizeof/len, data layout
  codegen.hla   tree → calls to the be_* backend (a stack machine with an accumulator)
  driver.hla    main: hlc input.hla output.s
arm/backend.hla   be_* for AArch64: x0 is the accumulator, x1 the second operand
x64/backend.hla   be_* for x86-64: rax and rcx, the Win64 convention, SEH directives, hla_start
asm/core.hla      shared by the assemblers: sections, symbols, fixups, line parsing, data directives
arm/encode.hla    AArch64 instructions → machine words
arm/macho.hla     Mach-O linking: stubs and GOT for libSystem, dyld bind/rebase, signature
x64/xenc.hla      x86-64 instructions → bytes (REX, ModRM, SIB — as LLVM does it)
x64/xasm.hla      COFF sections, short/long branch relaxation, .xdata/.pdata from .seh_*
x64/pe.hla        PE linking: imports from DLLs, jmp [IAT] stubs, base relocations
x64/winapi.hla    names exported by msvcrt/kernel32/user32 (generated by gen-winapi.ts)
```

The translator is a classic one: tokens → tree → code. The code generator (`front/codegen.hla`)
knows nothing about the processor: it calls `be_num`, `be_push`, `be_binop`, `be_call`… Every variable
(`let`, parameter) lives in an 8-byte slot of the stack frame, so values survive calls
without register allocation. The code comes out simple and predictable, but slower than that of
the TypeScript translator. The second backend is a single file with the same `be_*` functions.

## Which HLA64 hlc understands

A subset of the language without registers — exactly what the toolchain itself is written in:

- top level: `fn` (including `export fn`), `extern f, printf(fmt, ...)`, `const`, `enum`,
  `struct` (fields, nested structs, arrays), `data`/`rodata` (scalars, arrays, strings,
  tables of pointers to strings and functions), `include`;
- statements: `let`/`var`, `local name: type[N]`, `local name: type = value`, `local name = value`,
  assignments (`=`, `+=` … `>>>=`, `++`, `--`),
  `if`/`elif`/`else`, `while`, `do … while`, `loop`, `for i in a..b step k`, `break`,
  `continue`, `return`, `switch`/`case`/`default`;
- expressions: all operators with Go precedence, `?:`, calls (including through a variable
  holding a function address), `[addr]`, `u8[addr]` … `i64[addr]`, `array[i]`, `&x`, `sizeof`, `len`,
  `Struct.field`, `Enum.member`.

Not supported: register names and `asm`, floating point, `unsigned`, loop labels, built-in functions
(`min`, `abs` …), `std/…`. When it meets any of these, the translator reports an error with the file and line.

The assemblers understand everything the translators in this directory and the TypeScript version
write for such programs. In addition, `hlas-arm` knows `ldp/stp`, `csel`, `tst`, shifts and extensions,
and `hlas-x64` — `imul`, `movabs`, `cmovcc`, `push imm` and so on. ARM logical immediate masks
(`and x0, x1, #0xff`) and SSE are not supported yet.

## How to write code that both translators build

The sources here are also built by the TypeScript translator (for bootstrapping), so they follow its
rules:

- a parameter that is needed after a call is declared as `name: auto` (otherwise it lives in `x0…x7`
  and gets clobbered by the call);
- variable names don't coincide with the registers of either platform: `x1`, `s0`, `ch`, `si`, `cl`,
  `rsp`…
- a struct field can't be named `size` (that's `Struct.size`), and an enum member can't be named `count`.

Calls can be written anywhere in an expression (`[n + Node.a] = parse_expr()`, `f(a) + g(b)`),
expressions are evaluated left to right, and the bound of `for i in a..b` is evaluated once. Both
translators do this the same way.

While this directory was being written, two bugs were found and fixed in the TypeScript translator:
an `elif` or loop condition right after a body in which a variable spilled to the frame was modified,
and storing into narrow memory a value that needs all 64 bits (`u8[p] = n >>> 40`). In addition, the
x64 translator used to reject expressions like `[table + [p + 8] * 8]` in functions where all
callee-saved registers were taken by variables. Now it moves variables to the stack frame by itself
until the expressions fit. And `switch` was added to the language.
