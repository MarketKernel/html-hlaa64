# HLA64 for Linux x86-64

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="ru/linux.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

The same language, a third native platform: the translator emits x86-64 assembly for the System V ABI
(Intel syntax in the LLVM dialect, understood by `clang`, `gcc` and the built-in assembler), followed by
our own ELF object files, an ELF linker that links dynamically against glibc, and the x64 emulator with an
ELF loader. Everything works both in Node and on the `dist/hla64.html` page (**Platform: Linux**).

```
prog.hla ─► src/lang/x64 ─► .s (Intel, System V) ─► src/asm/x64 ─► ELF .o ─► src/asm/elf/link.ts ─► prog (ELF, libc.so.6)
                                                                     │
                                                     libname.a (ar), libname.so
```

## Command line

On Linux the default platform is `x64-linux`; elsewhere choose it with `--target x64-linux`:

```sh
node src/cli.ts run   examples/hello.hla --target x64-linux   # outside Linux x86-64 — in the built-in x64 emulator
node src/cli.ts build examples/hello.hla --target x64-linux   # hello (an ELF executable, chmod +x already)
node src/cli.ts compile prog.hla --target x64-linux           # x86-64 assembly
node src/cli.ts obj   app.hla --target x64-linux              # app.o for gcc / clang / ld
node src/cli.ts lib   mathlib.hla --target x64-linux          # mathlib.h, mathlib.o, libmathlib.a, libmathlib.so
node src/cli.ts emu   prog --target x64-linux                 # an ELF file built anywhere (gcc too) in the emulator
node src/cli.ts build prog.hla --target x64-linux --clang     # build via cc on Linux, zig cc elsewhere
node src/cli.ts run   prog.hla -- one "two words"             # arguments after -- go to main(argc, argv) (in emu too)
```

`--clang` assembles the same assembly with the system C compiler and links it with the same entry point
(`cc -nostartfiles -Wl,-e,hla_start prog.s -lm`). Outside Linux it uses `zig cc -target x86_64-linux-gnu`,
which is clang and lld with stub glibc libraries: a Linux executable can be built on macOS or Windows
without a Linux system. `emu` runs any x86-64 Linux executable, also one built by gcc or clang; shared
libraries it needs (other than glibc's) are taken from the same directory.

## Registers and the calling convention (System V)

| | |
|---|---|
| integer arguments | `rdi`, `rsi`, `rdx`, `rcx`, `r8`, `r9`, then the stack |
| FP arguments | `xmm0`–`xmm7`, **counted apart from the integers**: `f(a, x: f64, b)` — `a` in `rdi`, `x` in `xmm0`, `b` in `rsi` |
| variadic calls | `al` = the number of xmm registers with arguments (`printf("%f", x)` sets `mov eax, 1`) |
| result | `rax` / `xmm0` |
| clobbered by a call | `rax rcx rdx rsi rdi r8–r11`, every xmm register |
| preserved | `rbx rbp r12–r15` — the prologue saves those that appear in the function |
| `let x = …` without a register | one of `rbx r12–r15 rbp` (6 of them; Windows has 8, ARM 10), then a slot in the frame |
| translator scratch | `r10`, `r11` (+ free preserved ones), `xmm15` down to `xmm8` that the function does not name (`xmm4`–`xmm7` carry arguments here) |

So that the same x64 code works on Windows and Linux, **`rsi`, `rdi` and `xmm6`–`xmm15` named in a
function keep their values across its calls on Linux too**: before each call (C, HLA64 or `syscall`) the
translator saves them in the frame and restores them after it — you see it in the assembly as
`// keep rsi, xmm6 across the call`. Variables in `rbx`, `r12`–`r15`, `rbp` (and every `let` without a
register) cost nothing; a parameter without a register stays in its argument register and, as on Windows
(`rcx`, `rdx`), does not survive a call — write `n: auto` to keep it.

```hla
extern printf(fmt, ...)

fn hypot(a: xmm0, b: xmm1) {
    return sqrt(a * a + b * b)
}

fn main() {
    let r: xmm6 = 2.0                    // kept across the calls below
    xmm0 = hypot(3.0, r * 2.0)
    printf("%.1f %.1f\n", xmm0, r)       // xmm0, xmm1 and al = 2
}
```

The frame is addressed from `rsp` (no `rbp`), space for outgoing arguments is allocated once in the
prologue, and `rsp` is 16-byte aligned at every call, as glibc requires. There is no `.seh_*` and no
shadow space.

## How it differs from Windows x64

- `printf("%ld")` prints 64 bits, like on macOS (`long` is 64-bit on Linux).
- **`syscall(number, ...)`** works: the number goes to `rax`, the arguments to `rdi`, `rsi`, `rdx`, `r10`,
  `r8`, `r9`, then the `syscall` instruction runs (the kernel changes `rax`, `rcx`, `r11`). The numbers are
  Linux's, not macOS's: `1` write, `0` read, `39` getpid, `60` exit, `231` exit_group. Example —
  [tests/linux/cases/syscall.hla](../tests/linux/cases/syscall.hla).
- Instructions written by hand follow System V: the first argument of a `naked` function is in `rdi`
  (`lea rax, [rdi + rdi]`), and a raw `call puts` needs the string in `rdi` and an aligned `rsp`.
  Example — [tests/linux/cases/mixed.hla](../tests/linux/cases/mixed.hla).
- `extern` functions are called directly (`call printf`); the linker turns the call into a stub
  `jmp qword ptr [rip + GOT]`. The address of an `extern` (a C function as a value, `stdout`, `environ`)
  comes from the GOT: `mov rax, qword ptr [rip + stdout@GOTPCREL]`. glibc's variables are reached that way
  only — the linker reports `call stdout` or `[rip + stdout]` as an error. Example —
  [tests/linux/cases/extern-data.hla](../tests/linux/cases/extern-data.hla).
- A program starts at `hla_start`: the kernel leaves `argc`, `argv`, `envp` on the stack, glibc is already
  initialized by the dynamic loader, `hla_start` registers the loader's `_dl_fini` (passed in `rdx`) with
  `__cxa_atexit`, as glibc's own start code does, so destructors of shared libraries run at exit, then calls
  `main(argc, argv, envp)` and ends the process with `exit()` (which flushes the `printf` buffers).
- The linker takes each `extern` from the library that exports it: `libc.so.6` or `libm.so.6` (`sin`, `pow`
  are in libm; the export lists of glibc 2.35 are built in — [src/asm/elf/glibc.ts](../src/asm/elf/glibc.ts),
  refreshed by `node tools/gen-glibc.ts`). A name that is in neither (a typo) is a build error with a line
  number. Every reference asks for the symbol's default version, as `ld` records it (`memcpy@GLIBC_2.14`,
  `realpath@GLIBC_2.3`; `.gnu.version_r`): without versions glibc would bind the oldest compatibility
  version of each function. Nothing newer than glibc 2.35 is asked for, so the program runs on Ubuntu 22.04
  and later.
- Assembly comments after code are written `# note`: GNU `as` (behind gcc) reads `//` there as a division;
  a whole-line `// note` stays.

## The executable

A non-PIE `ET_EXEC` at `0x400000`, dynamically linked against glibc through `/lib64/ld-linux-x86-64.so.2`:

| segment | contents |
|---|---|
| `R` | ELF header, program headers, `.interp`, `.hash`, `.dynsym`, `.dynstr`, `.gnu.version`, `.gnu.version_r`, `.rela.dyn` |
| `R X` | `.text` and the stubs of imported functions |
| `R` | `.rodata` (strings, constants, `double` literals) |
| `RW` | `.dynamic`, `.got`, `.data`, `.bss` |

Every segment starts on a new page in memory, but the file is contiguous (a hello world is about 3 KB).
`DT_FLAGS = BIND_NOW`: the dynamic loader fills the whole GOT (`R_X86_64_GLOB_DAT`) before the program
starts, there is no lazy binding. `PT_GNU_STACK` makes the stack non-executable. `.symtab` and section
headers are kept, so `nm`, `objdump -d` and `gdb` see the function names.

## Libraries for C

`lib --target x64-linux` creates:

| file | what for |
|---|---|
| `name.h` | header (plain C declarations, `_Static_assert` for struct layouts) |
| `libname.a` | static library (a GNU `ar` archive with `name.o`) |
| `libname.so` | shared library (`DT_SONAME libname.so`, position independent) |
| `name.o` | object file |

```sh
cc main.c libmathlib.a -o demo                                   # statically
cc main.c -L. -lmathlib -Wl,-rpath,'$ORIGIN' -o demo             # with libmathlib.so next to the program
```

A C program built without PIE that reads a variable of the library (`call_count` in lesson 14) gets its
own copy of it (a copy relocation). A Linux library made by HLA64 therefore reaches its exported
variables through its GOT, as `-fPIC` code does, and both sides use the same copy. The object file is
position independent too: `cc -shared name.o -o libname.so` works. A library may call a function the C
program defines (`extern guarded`): the dynamic loader finds it in the program when it starts.

The other way round, an HLA64 program calls C: `node src/cli.ts obj app.hla --target x64-linux`, then
`cc app.o helpers.c -o app` (the C runtime's entry point calls `main`) or
`cc -nostartfiles -Wl,-e,hla_start app.o helpers.c -o app`. The complete example:
[tests/linux/lib](../tests/linux/lib) with [tests/x64/lib](../tests/x64/lib).

## The emulator

The x64 emulator loads ELF executables and the shared libraries they need, applies the dynamic
relocations (`RELATIVE`, `GLOB_DAT`, `JUMP_SLOT`, `64`, `COPY`, TLS), builds the process stack the way the
kernel does (`argc`, `argv`, `envp`, `auxv`) and gives glibc's functions in JavaScript: `printf` and
friends, `FILE` streams and files, `malloc`, `qsort` with a callback, `math.h`, `rand()` with glibc's
own sequence, `__libc_start_main` for programs built by gcc or clang, `fs:` and a thread control block
(the stack protector reads its canary at `fs:0x28`). Like real library code, the emulator holds programs
to the ABI where native Linux would crash or print garbage, and says so:

- `rsp` must be 16-byte aligned at every call into the C library;
- a variadic call that passes doubles needs `al` > 0;
- library calls leave garbage in `rdi rsi rdx rcx r8–r11` and in every xmm register;
- a function called from C (a `qsort` callback) must preserve `rbx rbp r12–r15` and `rsp`.

## The page

**Platform: Linux** switches the examples (System V calls, `syscall`, the language tour with a system
call), the tabs (**ELF**: header, segments, sections, imports by library, exports of a `.so`) and the
downloads: **Download executable** gives an ELF file (`chmod +x` it, or use the `.zip`, which keeps the
bit), **Copy Terminal command** recreates the file from base64 in a Linux terminal. For libraries — a zip
with the `.h`, `.a` or `.so`, `main.c` and `build.sh`.

## What has been tested and how

| | |
|---|---|
| programs | 7 Linux programs, the x64 programs that do not call the Windows API, portable programs and lesson programs: 164 in the emulator (`npm run test:linux`) |
| clang + lld | the same assembly assembled by clang and linked by lld (`zig cc -target x86_64-linux-gnu`), and our `.o` linked by lld: the executables behave the same in the emulator (`npm run test:linux-clang`) |
| fuzzer | every random expression is computed on ARM (native and emulator), in the x64 emulator for Windows and for Linux, and in WebAssembly (`npm run fuzz`) |
| encoding | `syscall` among the 989 x86-64 forms checked against clang (`npm run test:x64-encoding`) |
| C | C with our `.a` and `.so` (PIE and not), a copy relocation from code that is not position independent, `cc -shared` from our `.o`, an HLA64 program calling C; `llvm-readelf` reads every file without warnings (`npm run test:linux-lib`) |
| page | headless Chrome: every Linux example runs, both library modes build, a downloaded executable runs with the same output (`npm run check:web`) |
| **Linux, native** | on Linux x86-64 `test:linux` and `test:linux-lib` also run every executable natively and compare the output and the exit code with the emulator; GitHub Actions (`ubuntu-latest`) runs `test:linux` with every push |
| **real glibc** | Debian 12 in Docker (x86-64, glibc 2.36, gcc 12 with GNU as and ld): `test:linux` — 164 programs natively, the same output and exit codes as the emulator; `test:linux --clang` — the same assembly through gcc, and our objects through GNU ld; `test:linux-lib` — every C case natively. Ubuntu 22.04 (glibc 2.35): the Linux programs run the same. The containers run x86-64 code through Rosetta, which does not fault on a misaligned `movaps`: stack alignment is checked by the emulator at every library call |
