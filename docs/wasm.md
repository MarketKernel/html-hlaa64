# HLA64 for WebAssembly (wasm32)

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="ru/wasm.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

The same language, a third platform: the translator emits WebAssembly text (WAT), the built-in
assembler turns it into a binary `.wasm` module, and the browser — or Node — runs it natively: no
emulator in between. A WebAssembly module has no operating system, so its system is a small
JavaScript runtime that gives it the C library (`printf`, `malloc`, `fopen`…) as imports.
Everything works both in Node and on the `dist/hla64.html` page (the **Platform** switch at the very top).

```
prog.hla ─► src/lang/wasm ─► .wat (flat instructions) ─► src/asm/wasm ─► prog.wasm ─► the engine of the browser / Node
                                                                                        │
                                                         imports: src/wasm/runtime.ts (printf, malloc, fopen, …)
```

## Command line

```sh
node src/cli.ts run     examples/hello.hla --target wasm32   # run it here, in Node's WebAssembly engine
node src/cli.ts compile examples/hello.hla --target wasm32   # the WebAssembly text
node src/cli.ts build   examples/hello.hla --target wasm32   # hello.wasm + hello.html + hello.mjs
node src/cli.ts build   prog.hla --target wasm32 --zip       # … and prog.zip with the three of them
node src/cli.ts asm     prog.wat                             # assemble a .wat written by hand
node src/cli.ts run     prog.wasm -- one "two words"         # a module built earlier; arguments after --
```

`build` writes the module and two ways to start it:

| file | what for |
|---|---|
| `prog.wasm` | the module: code, data, imports of the system |
| `prog.html` | a page with a console: it loads `prog.wasm` next to it and runs it in a worker; an arguments field, the exit code, the files the program wrote (to download) |
| `prog.mjs` | the same program in a terminal: `node prog.mjs one two` — real stdout, files of the current directory |

A page opened from disk (`file://`) is not allowed to read other files, so it asks once for
`prog.wasm` (choose it or drop it onto the page). Served over http (`python3 -m http.server`,
GitHub Pages, any web server) it loads the module by itself. On the workbench page
**Download .zip** gives the same three files in a folder.

## Registers and the calling convention

| | |
|---|---|
| integer registers | `r0`–`r31`: 64-bit (`i64` locals of the function) |
| floating point registers | `f0`–`f31`: `double` (`f64` locals) |
| parameters | by position: `fn f(a, x: f64)` — `a` in `r0`, `x` in `f1` (at most 16) |
| result | `r0`, or `f0` for a function that returns a double |
| clobbered by a call | nothing: every function has its own locals, a call cannot change the caller's registers |
| `let x = …` without a register | one of `r16`–`r31`, then a slot in the frame |
| global aliases (`alias g: r20` outside functions) | a WebAssembly global shared by all functions |

A function returns a double when it says so (`-> f64`) or when it returns a floating point
expression; the translator finds that out before it translates the calls. A double used as an
integer (`let n = hypot(6.0, 8.0)`) is converted like `int(...)`, an integer passed for a `double`
parameter like `float(...)`.

## Instructions in the code

WebAssembly is a stack machine: an instruction takes its operands from the stack and pushes its
result. `local.get` and `local.set` move values between the stack and the registers; variables,
parameters and data are substituted by name, as on the other platforms:

```hla
extern printf(fmt, ...)

// pack 0xRRGGBB on the stack
fn rgb(red, green, blue) {
    local.get red               // red is r0
    i64.const 16
    i64.shl
    local.get green
    i64.const 8
    i64.shl
    i64.or
    local.get blue
    i64.or
    local.set r0                // the result register: no return needed
}

fn main() {
    printf("0x%06lx\n", rgb(0x12, 0x34, 0x56))
}
```

- Memory addresses are 32-bit (wasm32): an address computed in a register is wrapped first —
  `local.get p`, `i32.wrap_i64`, `i64.load8_u`. The name of data is its address:
  `i64.const text`, `i64.load offset=counts`.
- `block`, `loop`, `if`, `else` and `end` are keywords of HLA64 too, so structured instructions go
  into `asm { }`; a branch names its block: `loop $sum` … `br_if $sum`.
- `call puts` calls a function of the system or of the program; the stack must be empty again at
  the end of every statement (`drop` what is left), the translator checks it and every type, like
  the engine does, and reports the line.
- Comments in instructions are `//` as everywhere in HLA64; in the generated `.wat` they are `;;`.

A complete example — [tests/wasm/cases/mixed.hla](../tests/wasm/cases/mixed.hla); floating point
next to `f64.mul` — [tests/wasm/cases/mandelbrot.hla](../tests/wasm/cases/mandelbrot.hla).

## Memory

```
0 ─ 1024        NULL area, never used
1024 ─ …        data: strings, data, rodata, zero-filled data
… ─ +1 MB       the stack: frames, grows down from its top (the global $sp)
… ─             the heap: malloc of the runtime (grows the memory)
```

Registers and expressions stay in locals; only what needs an address lives in the frame on the
stack: `local` variables and arrays, `push`/`pop` slots and the variadic arguments of calls
(the local `$fp` points at the frame). A pointer is 8 bytes (`ptr`), like on the other platforms,
so structures have the same layout everywhere. A frame that does not fit into the 1 MB stack stops
the program with “stack overflow”, too deep recursion without frames is caught by the engine.

## Control flow

WebAssembly has no jumps, only blocks: `br` leaves a `block` or restarts a `loop`. The loops and
conditions of HLA64 become exactly that:

```wat
block $main.end0               ;; while i < 3 { … }
  loop $main.loop2
    local.get $r16
    i64.const 3
    i64.ge_s
    br_if $main.end0           ;; the condition is false: leave
    …                          ;; the body
    br $main.loop2             ;; again
  end
end
```

`break` and `continue` (also with a loop label) are `br` to the right block. `goto` works when it
stays in the statement list of its label (or goes out of blocks inside it): a jump forward becomes a
block that ends at the label, a jump backward a loop that starts at it — see
[tests/wasm/cases/goto.hla](../tests/wasm/cases/goto.hla). A `goto` into another block has no such
form and is a build error.

## The system

The module imports the C functions it calls from the runtime ([src/wasm/runtime.ts](../src/wasm/runtime.ts);
the list — [src/wasm/libc.ts](../src/wasm/libc.ts)):

- output and files: `puts putchar putc fputc fputs printf fprintf dprintf sprintf snprintf fflush fopen fclose fread fwrite fseek ftell feof write read getchar`
- process: `exit _exit abort getenv system time clock sleep usleep`
- strings and memory: `strlen strcmp strncmp strcpy strncpy strcat strchr memcpy memmove memset bzero memcmp malloc calloc realloc free atoi atol strtol atof abs labs qsort rand srand arc4random arc4random_uniform toupper tolower isdigit isalpha isspace`
- math: `sqrt sin cos tan atan atan2 exp log log10 pow floor ceil round fabs fmod`

Every argument is an `i64` or an `f64`. A function declared with `...` (`extern printf(fmt, ...)`)
is imported from the module `"va"`: the caller writes the variadic arguments into its frame, 8 bytes
each, and passes their address — like clang's wasm32 ABI. A name that is not in the list (a typo)
is a build error with the line. `printf("%ld")` prints 64 bits, as on macOS.

`include "std/file.hla"` works as on the other platforms: in the workbench the program reads the
project's files and what it writes appears in the panel; in `prog.mjs` it uses the files of the
current directory; on the downloaded page the files it writes are offered for download.
`main(argc, argv)` gets the command line; `qsort` calls back into the program through the table of
functions.

## How it differs from ARM64 and x64

- No `syscall(...)`, `rbit()`, `rev()`: there is no operating system and no such instructions.
- No labels in instructions and no assembler directives: the structure is `block`/`loop`/`if`.
- A program only: there are no static or dynamic libraries for C (a module is a whole program;
  `obj` and `lib` are not available).
- Errors are traps of the engine: an integer division by zero, a memory access outside the
  memory, an `unreachable` stop the program with a message that names the function
  (`divide by zero (in d, at 0x94 of the module)`); the offset is the address in the
  **Machine code** tab.
- Function pointers are indexes into the table of the module; `call_indirect` checks the signature.
- `naked` changes nothing: there is no prologue to leave out, a function always gets its locals and its block.

## The toolchain in HLA64, compiled to WebAssembly

The translator and the assembler written in HLA64 ([selfhost/](../selfhost/README.md)) use only the
C library, so they build for wasm32 as they are. On the WebAssembly page **Translator in HLA64** turns
`hello.hla` into the same `hello.s` as the native `hlc`, and **Assembler in HLA64** makes from it a
signed Mach-O byte for byte equal to the one of the TypeScript linker — inside the browser — which
then runs on a Mac.

## What has been tested and how

| | |
|---|---|
| programs | 4 wasm32 programs, the portable programs of `examples/`, `tests/cases/` and 132 lesson programs, run by Node's engine (`npm run test:wasm`) |
| binaryen | when `wasm-as` is installed, every module is also assembled from the same text by binaryen and must behave the same |
| self-hosted tools | `hlc-arm`, `hlc-x64`, `hlas-arm`, `hlas-x64` built for wasm32: the same `hello.s`, `hello-x64.s`, Mach-O and `.exe` as the reference files |
| fuzzer | every random expression is computed on ARM, x64 and WebAssembly and compared with a BigInt reference (`npm run fuzz`) |
| validation | the assembler checks every instruction's types and every block like the engine; errors name the line (`f64.neg: expected f64, found i64`) |
| the page | `npm run check:web`: every WebAssembly example in headless Chrome; `npm run check:wasm-page`: the downloaded page over http and from disk, arguments, exit code, files |
