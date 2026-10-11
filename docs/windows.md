# HLA64 for Windows x64

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="ru/windows.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

The same language, a second platform: the translator emits x86-64 assembly (Intel syntax in the
LLVM dialect, understood by `clang` and by the built-in assembler), followed by our own assembler,
COFF object files, a PE linker and an x64 emulator. Everything works both in Node and on the
`dist/hla64.html` page (the **Platform** switch at the very top).

```
prog.hla ─► src/lang/x64 ─► .s (Intel, .seh_*) ─► src/asm/x64 ─► COFF .obj ─► src/asm/coff/pe.ts ─► prog.exe
                                                                     │
                                                    .lib (static / import), .dll
```

## Command line

On Windows the default platform is `x64-windows`, on macOS — `arm64-macos`; to choose explicitly — `--target`:

```sh
node src/cli.ts run   examples/hello.hla --target x64-windows   # outside Windows — in the built-in x64 emulator
node src/cli.ts build examples/hello.hla --target x64-windows   # hello.exe
node src/cli.ts compile prog.hla --target x64-windows           # x86-64 assembly
node src/cli.ts obj   app.hla --target x64-windows              # app.obj for link.exe / lld-link
node src/cli.ts lib   mathlib.hla --target x64-windows          # mathlib.h, .obj, mathlib_static.lib, mathlib.dll, mathlib.lib
node src/cli.ts emu   prog.hla --target x64-windows             # x64 emulator
node src/cli.ts build prog.hla --target x64-windows --clang     # build via clang + lld-link (only LLVM is needed)
node src/cli.ts run   prog.hla -- one "two words"               # arguments after -- go to main(argc, argv) (in emu too)
```

`--clang` assembles the same assembly with clang and links it with lld-link using the same `hla_start`
entry point and the same DLLs as the built-in linker (the import libraries are written by
`writeImportLibrary`): Visual Studio and its C runtime are not needed.

## Registers and the calling convention (Win64)

| | |
|---|---|
| integer arguments | `rcx`, `rdx`, `r8`, `r9`, then the stack (after 32 bytes of shadow space) |
| FP arguments | `xmm0`–`xmm3` **by position**: `f(a, x: f64)` — `a` in `rcx`, `x` in `xmm1` |
| result | `rax` / `xmm0` |
| clobbered by a call | `rax rcx rdx r8–r11 xmm0–xmm5` |
| preserved | `rbx rbp rsi rdi r12–r15 xmm6–xmm15` — the prologue saves those that appear in the function |
| `let x = …` without a register | one of `rbx rsi rdi r12–r15 rbp` (8 of them; on ARM there are 10), then a slot in the frame |
| translator scratch | `r10`, `r11` (+ free preserved ones), `xmm5`, `xmm4` (+ free `xmm6`–`xmm15`) |

Registers can be named by their 64-bit (`rax`, `r12`) and 32-bit (`eax`, `r12d`) names — like
`x`/`w` on ARM: writing to a 32-bit register zeroes the upper half. Floating point lives in `xmm`,
always as `double`; an `f32` in memory is read and written with conversion.

```hla
extern printf(fmt, ...)

fn hypot(a: xmm0, b: xmm1) {
    return sqrt(a * a + b * b)
}

fn main() {
    let r: xmm6 = 2.0
    xmm0 = hypot(3.0, r * 2.0)
    printf("%.1f\n", xmm0)
}
```

The function's frame is addressed from `rsp` (without `rbp`), space for outgoing arguments is
allocated once in the prologue, and `.seh_*` directives are generated for every function — from them
the assembler builds `.pdata`/`.xdata`, without which Windows can't unwind the stack (exceptions,
debugger). `push`/`pop` in HLA64 on x64 write to frame slots instead of changing `rsp`. A frame
larger than 4 KB (`local buf: u8[20000]`) is first "probed" page by page in the prologue, like
`__chkstk`: Windows grows the stack one guard page at a time, and jumping over it is an access
violation (the emulator models this the same way).

## How it differs from ARM64

- **`printf("%ld")` prints 32 bits**: on Windows `long` is 32-bit. For 64-bit numbers use `%lld`
  (works on macOS too). Lesson programs with `%ld` are correct as long as the numbers fit in 32 bits.
- No `syscall(...)`: Windows system calls are undocumented; use WinAPI functions instead
  (`extern GetStdHandle, WriteFile`), see [tests/x64/cases/showcase.hla](../tests/x64/cases/showcase.hla).
  For files it's simpler to `include "std/file.hla"`: `read_file`, `write_file`, `file_open` … have the
  same names and behave the same on Windows and macOS (on top of the C runtime, in binary mode — `\n`
  stays `\n`), see the [reference](language.md#files-stdfilehla).
- No `rbit()` (there is no such instruction); `clz()` uses `lzcnt` (Haswell and newer).
- 8 registers for `let` instead of 10: in big functions the extra variables are spilled to the frame
  (`// x -> frame` in the assembly) and read as memory operands (`add r10, qword ptr [rsp + …]`).
- `extern` functions are called directly (`call printf`); for functions from a DLL the linker inserts
  a `jmp [__imp_printf]` thunk, for statically linked C code — a direct call.
- Instructions in code use Intel syntax: `mov r8, v` / `and r8, 1` / `add count, r8` /
  `cmovg rax, hi` / `lea rcx, [rip + text]` + `call puts`; aliases, parameters and labels are
  substituted the same way. `call name(…)` with parentheses is a sugar call (the hlaa64 form), without
  parentheses it's an instruction. Comments in `asm { }` are `//` (`;` separates instructions in the
  LLVM dialect). Example — [tests/x64/cases/mixed.hla](../tests/x64/cases/mixed.hla).
- A program starts at `hla_start`: it calls `main` and terminates the process via `exit()` from
  `msvcrt.dll` (the `printf` buffers are flushed). If `main` has parameters (`argc, argv, envp`),
  `hla_start` first gets them from `__getmainargs` in `msvcrt.dll`. The linker takes each `extern` function from the DLL
  that exports it: `msvcrt.dll`, `kernel32.dll` or `user32.dll` (the Windows 11 export lists are
  built in — `src/asm/coff/winapi.ts`, updated by `node tools/gen-winapi.ts`). A name that is neither
  in the program nor in these DLLs (a typo) is a build error with a line number, rather than an `.exe`
  that Windows will refuse to load.

## Libraries for C

`lib --target x64-windows` creates:

| file | what for |
|---|---|
| `name.h` | header; `#define NAME_DLL` before `#include` gives declarations with `__declspec(dllimport)` for the DLL |
| `name_static.lib` | static library (an MS archive with `name.obj`) |
| `name.dll` + `name.lib` | a DLL with an export table and an import library for it (byte for byte like `llvm-lib /def`) |
| `name.obj` | object file |

```bat
clang main.c mathlib_static.lib -o demo.exe                  :: statically
clang -DMATHLIB_DLL main.c mathlib.lib -o demo.exe           :: via the DLL (mathlib.dll next to demo.exe)
cl main.c mathlib_static.lib                                 :: the same with MSVC
cl /DMATHLIB_DLL main.c mathlib.lib
```

These commands work in the **x64 Native Tools Command Prompt** (or Developer PowerShell): `cl`
exists only there, and `clang` needs `INCLUDE`/`LIB` from there too — the headers and C runtime from
Visual Studio and the Windows SDK (clang 23 can't find Visual Studio 2026 by itself); besides, the
LLVM installer doesn't add `clang` to PATH. The `build.bat` from the page finds everything by itself
(`vswhere` → `vcvars64.bat`, `%ProgramFiles%\LLVM\bin`).

The header checks the struct layout (`MATHLIB_STATIC_ASSERT`): in C11 and clang it's
`_Static_assert`, in C++ — `static_assert`, and in `cl`'s default C mode (without `/std:c11`, where
there is no `_Static_assert`) — a negative-size array.

If the library itself calls a function defined by the C program (`extern guarded` in
[tests/x64/seh/seh.hla](../tests/x64/seh/seh.hla)), a DLL can't be built from it — on Windows a DLL
can't reference functions of the program that loaded it. `lib` then writes only the static library
and explains why there is no DLL.

The other way round, an HLA64 program calls C: `node src/cli.ts obj app.hla --target x64-windows`,
then `clang app.obj helpers.c -o app.exe` or `cl app.obj helpers.c` (the entry point is `main` from the CRT),
or `link /entry:hla_start app.obj helpers.obj msvcrt.lib`, where `msvcrt.lib` is the import library of
`msvcrt.dll` itself (`lib /def:msvcrt.def /machine:x64`; the `msvcrt.lib` from the SDK is the UCRT startup code).
The complete example: [tests/x64/lib](../tests/x64/lib).

## Exceptions (SEH)

For every function the assembler builds `.pdata`/`.xdata` from the `.seh_*` directives, so Windows
structured exceptions pass through HLA64 code: `__try`/`__except` in C catches a `RaiseException` from
a callback called by an HLA64 function, and an access violation inside the function itself; all
preserved registers (`rbx rbp rsi rdi r12–r15 xmm6–xmm15`) are restored, and `RtlCaptureStackBackTrace`
sees every frame. The test — [tests/x64/seh](../tests/x64/seh): frames larger than 4 KB, all nonvolatile
registers, building C with `cl` (`/Od`, `/O2`) and `clang`; the unwind information matches clang byte for byte.

## The page

The **Platform: macOS / Windows** switch at the very top changes the examples, the projects in the left
panel (each platform has its own), the pipeline and the tabs:
**PE / COFF** (sections, imports by DLL, exports), machine code byte by byte (prefixes, REX, opcode,
ModRM…), the x64 emulator console. **Download .exe** gives an unsigned file; Chrome and Edge mark
downloads with the "Mark of the Web" (`Zone.Identifier`, `ZoneId=3`). When launched from Explorer,
SmartScreen may ask (More info → Run anyway); from PowerShell the file runs as is, and
`Unblock-File .\prog.exe` removes the mark for good. **Copy PowerShell command** puts a command on the
clipboard (4–11 KB for the examples) that recreates the files from base64 right in PowerShell 5.1 or 7 —
without a download and without the mark. For libraries — a zip with the `.h`, `.lib`/`.dll`, `main.c`
and `build.bat`; `build.bat` sets up the Visual Studio environment (`vswhere` → `vcvars64.bat`) and
builds with clang or `cl`, so it works from a regular console. The PowerShell command for a library
writes the same `build.bat` and runs it.

## What has been tested and how

| | |
|---|---|
| encoding | 987 instruction forms bit for bit with `clang --target=x86_64-pc-windows-msvc` (`npm run test:x64-encoding`) |
| object files | sections, relocations and unwind information match clang; they link with `lld-link` (`npm run test:coff`) |
| programs | 5 x64 programs + 66 portable lesson programs in the emulator; `--clang`: the same assembly via clang + lld-link (`npm run test:x64`) |
| fuzzer | every random expression is computed on ARM (native and emulator) and in the x64 emulator (`npm run fuzz`) |
| C | C from clang + our static library / DLL + import library via lld-link; an HLA64 program calling C (`npm run test:x64-lib`) |
| **Windows, native** | Windows 11 x64: all 71 `test:x64` programs run as `.exe`, output and exit code match the emulator; C + `.lib`/`.dll`, HLA64 + C — natively as well |
| **MSVC** | Visual Studio 2026 (`cl` 19.51): lesson 14's `main.c` (`<stdio.h>`, `/W4`) with the static library and the DLL; `cl app.obj helpers.c`; `link /entry:hla_start` with our `msvcrt.dll` import library; `lib /list`, `dumpbin /exports /all /unwindinfo` — no warnings (`test:x64-lib`, MSVC is located via `vswhere`) |
| **SEH** | exceptions through HLA64 frames are caught by `__except`, 18 preserved registers are restored, the whole stack is visible; `.xdata` = clang (`test:x64-lib`) |
| **page** | Chrome and Edge, `file://`: downloaded `.exe`s and zips, `build.bat` (clang and cl) and the PowerShell commands of all examples run in PowerShell 5.1 and 7 from a regular console, in a directory with spaces; the command for the DLL library pasted by hand into a PowerShell window (PSReadLine) — builds and works |
| **CLI** | `run`, `build`, `obj`, `lib`, `emu`, `compile`, `--clang` from a regular console; paths with spaces |

On macOS everything is checked via the emulator; on Windows the tests additionally run the `.exe`s
natively (`tests/x64.ts`, `tests/x64-lib.ts` compare the output with the emulator) and, if Visual Studio
is installed, build the C code with MSVC. LLVM is looked up in PATH and in `C:\Program Files\LLVM\bin`.
