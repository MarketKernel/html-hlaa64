# HLA64 lessons

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/README.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

A course for those who are seeing HLA64 — and maybe assembly in general — for the first time. We start
with "Hello, world" and step by step work up to structs, pointers, floating point and how function calls
work. Every lesson consists of examples you can run and an explanation of what happens inside the CPU.

## HLA64 in a nutshell

The Apple M1/M2/M3/M4 processor (the **AArch64** architecture, also known as ARM64) can execute simple
instructions: "add two registers", "load a number from memory", "jump to another instruction". An assembly
program is a list of such instructions. Writing it by hand takes a long time: even a simple loop takes
five or six lines.

**HLA64 is an assembler, not a new language.** Any processor instruction can be written right in the
program, as is: `add x9, x9, #1`, `cmp a, b`, `b.lt again`. On top of the instructions there is syntactic
sugar — `for`, `if`, `a = b + c * 4`, `printf(...)`: the translator expands each such line into several
ordinary instructions, and you can always look at them. You still work with **registers** and **memory**
directly; the sugar only spares you the routine, and instructions and sugar can be freely mixed in one
function.

That is why in the lessons the sugar always stands next to the assembly: what an HLA64 line turned into
and how to write the same thing with instructions yourself. Starting from the very first lesson.

## How to run the examples

There are three ways; pick whichever suits you.

**1. In the browser.** Open https://marketkernel.github.io/html-hlaa64/ or build the page yourself
(`npm run build:web`) and open `dist/hla64.html` — it works offline. Paste the program into the left
pane and press **Run** — the program runs in the built-in processor emulator, and on the right you can
see the generated assembly and machine code.

**2. In the macOS terminal.** Save the program to a file, for example `hello.hla`, and run:

```sh
node src/cli.ts run hello.hla        # translate, assemble and run
node src/cli.ts compile hello.hla    # show the resulting assembly
node src/cli.ts build hello.hla -o hello && ./hello   # build an executable
```

**3. In the emulator from the terminal** (works on non-Macs too): `node src/cli.ts emu hello.hla`.

## Lessons

| # | Lesson | What it covers |
|---|---|---|
| 1 | [Hello, world](01-hello-world.md) | first program, the `main` function, comments, the first processor instruction in code |
| 2 | [Registers and variables](02-registers-and-variables.md) | what a register is, `let`, `alias`, constants, printing numbers |
| 3 | [Arithmetic and expressions](03-arithmetic.md) | operators, precedence, bits and shifts, 32 and 64 bits |
| 4 | [Conditions](04-conditions.md) | `if / elif / else`, comparisons, `&&` `\|\|` `!`, the ternary operator |
| 5 | [Loops](05-loops.md) | `while`, `do … while`, `loop`, `for … in`, `break` and `continue` |
| 6 | [Functions](06-functions.md) | parameters, `return`, recursion, which registers a call clobbers |
| 7 | [Data and arrays](07-data-and-arrays.md) | `data`, `rodata`, strings, arrays, `len` and `sizeof` |
| 8 | [Memory and pointers](08-memory-and-pointers.md) | addresses, `u8[p]`, `[p++]`, local buffers on the stack |
| 9 | [Structs and enums](09-structs-and-enums.md) | `struct`, `enum`, arrays of structs, a linked list |
| 10 | [The C library and the system](10-c-library-and-syscalls.md) | `extern`, `printf`, `malloc`, `qsort` and function pointers, `syscall` |
| 11 | [Floating-point numbers](11-floating-point.md) | `d` and `s` registers, `float()` and `int()`, `sqrt` |
| 12 | [Under the hood](12-under-the-hood.md) | `asm { }` blocks and numeric labels, `naked`, `push`/`pop`, how a function call works |
| 13 | [Project: the Game of Life](13-project-game-of-life.md) | everything together in one program |
| 14 | [A library for C (and C for HLA64)](14-c-library.md) | `export`, parameter types, `.h`/`.o`/`.a`/`.dylib`, C ↔ HLA64 calls (needs a Mac with `clang`) |

Each lesson builds on the previous ones, so it is best to go in order. At the end of the lessons there
are exercises — try to solve them yourself first, then check against the solution.

The complete language reference without explanations is in [../language.md](../language.md). It also
covers what the lessons don't: a program made of [multiple files](../language.md#multiple-files)
(`include`) and [reading and writing files](../language.md#files-stdfilehla) with the same functions
on macOS and Windows (`include "std/file.hla"`).
