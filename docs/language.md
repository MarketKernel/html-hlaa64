# HLA64 — language reference

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="ru/language.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

HLA64 is an AArch64 (Apple Silicon, macOS), x86-64 (Windows) and WebAssembly assembler with syntactic sugar,
not a separate language. Every line of a function is either a **processor instruction**, which goes
into the listing as is (`csel x0, a, b, gt`, `ldrb w9, [p], #1`), or **sugar**, which the translator
expands into instructions: `if`, `while`, `for`, expressions `a = b + c * 4`, memory accesses
`numbers[i]`, calls `printf(...)`. Both kinds of lines mix freely within one function, and
instructions see variables, parameters, constants, data and labels by name — see
[Processor instructions in code](#processor-instructions-in-code).

Registers haven't gone anywhere: you still decide what lives in `x19` and what lives in `d8`.
Sugar gives registers names, expressions operators, and code structure, while the translator writes
the prologue/epilogue, register saving and ABI calls for you.

The translator emits ordinary Apple-dialect assembly, which can be assembled both by `clang` and by
the built-in HLA64 assembler (see the [README](../README.md)).

---

## Lexical structure

- Comments: `// to end of line`, `/* block */`.
- Statements are separated by a newline or `;` (the semicolon is optional).
- A binary operator at the end of a line continues the expression on the next line.
- Numbers: `42`, `-7`, `0xFF`, `0b1010`, `0o17`, `1_000_000`, characters `'a'`, `'\n'`; fractional `1.5`, `2.0e-3`.
- Strings: `"Hello\n"` (escapes: `\n \t \r \0 \\ \" \xHH`).

## Registers and aliases

Any register can be used by name: `x0..x30`, `w0..w30`, `sp`, `wsp`, `xzr`, `wzr`, `fp` (= x29), `lr` (= x30),
`d0..d31`, `s0..s31`.

`sp` and `wsp` are integer stack-pointer registers. Simple copies and immediate
addition/subtraction can use them directly:

```hla
x29 = sp + 0x50       // add x29, sp, #0x50
sp = sp - 0x60        // sub sp, sp, #0x60
x0 = sp              // mov x0, sp
```

These forms obey the processor's operand restrictions; SP is not a substitute for
a general register in every operation. Manual frame setup normally belongs in a
`naked fn`, with the stack and saved registers restored before returning.

```hla
alias count = x19          // alias — as in hlaa64 (`alias a = X1;` works too)
let i: x20 = 0             // alias + initial value
let sum = 0                // the register is picked automatically from x19..x28
let unsigned n = x0        // unsigned: hi/lo comparisons, udiv division, logical >> shift
let a = 7, b = 5           // several at once
let half: w9 = 100         // 32-bit view of a register
let pi: d8 = 3.14159       // floating-point register
```

- `let` without a register takes a **free callee-saved** register (x19..x28) that isn't mentioned
  explicitly in the function. That's why such variables survive function calls.
- When there are no free callee-saved registers left (10 on ARM, 8 on x64), the variable
  **spills to the frame**: it lives in an 8-byte stack slot, like `local x: i64`, and works in all
  expressions, assignments (including `x = f()` and `x += f()`), `for … in` loops and as a function
  pointer. It's slower than a register; in the assembly you can see it by the comment `// x -> frame`.
  Such a variable can't be used inside `asm { }` — the translator will ask you to give it a register.
- If an expression runs out of scratch registers because all callee-saved registers are taken by
  variables, the translator regenerates that function and moves one variable to the frame, taking its
  register for expressions. This repeats until the expressions fit. Functions that have enough
  registers don't change.
- Aliases are visible until the end of the `{ }` block; an automatic register is freed on leaving the block.
- A top-level `alias` is a **global register variable**: it's visible in all functions and
  isn't saved/restored (except in `main`).

**Reserved by the translator**: `x16`, `x17` (IP0/IP1) and `d29..d31` — scratch registers for
evaluating expressions. If they aren't enough, the translator takes free callee-saved registers, and
then `x9..x15` that the function doesn't name explicitly (intermediate values never live across a call).

## Assignment and expressions

```hla
x0 = 5
a = b + c * 4 - (d >> 1)
a += 1;  a -= b;  a *= 3;  a /= 2;  a %= 7
a &= 0xFF;  a |= 1;  a ^= b;  a <<= 2;  a >>= 1;  a >>>= 1
i++;  i--
flag = a < b               // 0 or 1 (cset)
big = a > b ? a : b        // csel, if the branches are simple
```

Operator precedence is as in Go (bitwise operations bind tighter than comparisons,
so `x & 1 == 0` means `(x & 1) == 0`):

| level | operators |
|---|---|
| 5 | `*  /  %  <<  >>  >>>  &` |
| 4 | `+  -  \|  ^` |
| 3 | `==  !=  <  <=  >  >=` |
| 2 | `&&` |
| 1 | `\|\|` |
| 0 | `c ? a : b` |
| unary | `-  ~  !  &` (take address) |

- `>>` is an arithmetic shift for signed values and a logical one for `unsigned`; `>>>` is always logical.
- `/` and `%` are signed (`sdiv`); for `unsigned` they are unsigned.
- The width of the computation is set by the destination register: `w` register → 32 bits, `x` → 64.
- Comparing an `x` register with a `w` register is done as `cmp x, w, sxtw` (or `uxtw` for unsigned).

The translator picks instructions itself: `add x0, x1, #imm`, `add x0, x1, x2, lsl #3`,
`madd`/`msub` for `a + b*c`, `bic` for `a & ~b`, `lsl` for multiplying by a power of two,
`movz/movk/movn` or bitmask `mov` for any 64-bit constant, `cbz`/`tbnz`/`tst` for conditions.

## Memory

```hla
x0 = [x1]              // 64-bit load (size taken from the destination register)
w0 = [x1 + 8]          // 32-bit
w0 = u8[x1 + x2]       // ldrb (zero-extend)
x0 = i8[p]             // ldrsb (sign-extend)
x0 = i32[base + i*4]   // ldrsw x0, [base, i, lsl #2]
u16[p + 2] = w3        // strh
[sp + 16] = x19        // str
w0 = u8[p++]           // post-increment: ldrb w0, [p], #1
```

Access types: `i8 u8 i16 u16 i32 u32 i64 u64 ptr f32 f64`.
The address is mapped onto AArch64 addressing modes (`[base, #imm]`, `[base, idx, lsl #s]`,
`[base, w, sxtw #s]`); anything more complex is computed into a scratch register.

### Paired memory transfers (AArch64)

```hla
u64[sp + 0x60] = (x29, x30)   // stp x29, x30, [sp, #96]
(x29, x30) = u64[sp + 0x60]   // ldp x29, x30, [sp, #96]
u32[x10] = (w0, w1)           // two 4-byte elements
(d0, d1) = f64[x10]           // two 8-byte FP elements
u64[sp - 0x70]! = (x29, x30)  // pre-index: use sp - 112, then write it back to sp
(x0, x1) = u64[x10++]         // post-index: read the pair, then advance x10 by 16
f32[x10--] = (s0, s1)         // write the pair, then decrease x10 by 8
```

Each pair statement emits one `stp` or `ldp`, with no scratch registers or scalar
replacement. The first register uses the displayed address; the second uses that
address plus one element size. Without `!`, `++` or `--`, the base does not change.
Pair `++`/`--` advances by **two** elements; scalar memory `++`/`--` advances by one.

Both registers must have the same class and width, matching the element type.
Integer elements may use `i32/u32`, `i64/u64/ptr`; FP elements use `f32/f64`.
Omitting the type infers it from the registers. Register aliases are supported.
The address must be an X register or SP plus a constant byte offset: a multiple of
4 in -256..252 for 32-bit elements, or of 8 in -512..504 for 64-bit elements.
Post-increment/decrement requires a bare base register. `!` is supported only for
pair assignments and cannot be combined with post-increment/decrement.

SP/WSP cannot be transferred as values. Pair load destinations must differ, and
integer writeback must not overlap either transferred register. Invalid forms are
compile errors. These are instruction statements, not general tuple expressions;
the x86-64 and WebAssembly targets reject them. Other forms can use inline assembly.

For a standard 16-byte stack save/restore, `push x29, x30` and `pop x29, x30` already
emit `stp x29, x30, [sp, #-16]!` and `ldp x29, x30, [sp], #16`.

## Data

```hla
const N = 10                               // translation-time constant
const MASK = 0xFF00FF00FF00FF00
data counter: i64 = 0                      // __DATA,__data
data numbers: i32[N] = [42, -7, 19, 3]     // the rest is filled with zeros
data greeting = "Hello"                    // string (asciz)
rodata names: ptr = ["zero", "one"]        // array of pointers to strings (read-only)
data buffer: u8[4096]                      // no initializer → __bss (zerofill)
data pi: f64 = 3.141592653589793
```

Usage:

```hla
counter += 1               // load/operate/store via adrp + ldr/str
x0 = numbers[i]            // ldrsw with a scaled index
numbers[i + 1] = w12       // the constant part of the index goes into the base address
x0 = &numbers              // address (adrp + add)
x1 = &numbers[3]
puts(greeting)             // arrays and strings used as a value give their address
x2 = len(greeting)         // 5 (elements; for strings — without the terminating zero)
x3 = sizeof(numbers)       // 40 (bytes)
```

String literals in expressions (`puts("hi")`) go into `__TEXT,__cstring` automatically.

### Structs and enums

A struct is a set of offsets (natural alignment), just like in assembly, except the translator
computes them:

```hla
struct Point { x: i64, y: i64 }      // Point.x = 0, Point.y = 8, Point.size = 16
data points: Point[3]

let p = &points[2]                   // element address: base + i * 16
[p + Point.y] = 42
x0 = [p + Point.y]

enum Color { Red, Green, Blue = 5, Purple }   // 0, 1, 5, 6; Color.count = 7
```

### Local variables on the stack

```hla
fn f() {
    local buf: u8[64]        // space in the frame, addressed from x29
    local tmp: i64
    tmp = x0                 // str x0, [x29, #-8]
    buf[0] = 'A'
    let p = &buf[63]
    local total = 0          // i64 with an initial value
    local small: u8 = 250    // a write stores 8 bits
    for i in 0..10 { }       // if i is already declared (local or let), the loop uses it
}
```

`local` is a variable that **always lives in the stack frame**, while `let` lives in a register as
long as one is available. Reading a `local` is a load from the frame, writing is a store. A register
is needed only for the duration of the operation, so you can have as many such variables as you
like, and calls don't clobber them. The initial value is computed before the name becomes visible:
`local x = x * 2` reads the outer `x`. Only a single value can have an initial value, not an array
or a struct.

## Control flow

```hla
if a == 0 {
    ...
} elif a < 0 && a > -10 {         // `else if` too
    ...
} else {
    ...
}

while i < n { i++ }
do { i-- } while i > 0
loop { if done { break } }

for i in 0..10 { }                // 0..9
for i in 0..=10 step 2 { }        // 0, 2, ..., 10
for i in 10..0 step -1 { }        // 10..1
for i: x9 in 0..n { }             // loop variable in a given register
for (let k = 0; k < 10; k++) { }  // C style, parentheses are optional

outer: for a in 1..20 {           // loop labels
    for b in a..20 {
        if a * b == 91 { break outer }
        if b > a + 10 { continue outer }
    }
}

again:                            // label and goto
    k++
    if k < 3 { goto again }
```

In `for i in a..b`, `a` is evaluated first, then `b`, each once, before the first iteration.
Changing `b` inside the loop doesn't change the number of iterations. If the variable `i` is already
declared (`let` or `local`), the loop uses it, and after the loop it holds the last value.

### switch

```hla
switch c {
    case '0'..='9' { kind = DIGIT }          // range: ..= includes the end, .. doesn't
    case '+', '-', '*' { kind = OP }         // several values separated by commas
    case 'a'..='z', 'A'..='Z', '_' { kind = NAME }
    default { kind = OTHER }                 // optional; `else { }` too
}
```

`switch` is shorthand for an `if`/`elif` chain: conditions are checked top to bottom, the **first**
matching branch runs, and there's no fallthrough to the next one (no `break` needed). `break` and
`continue` inside a `switch` refer to the enclosing loop, just as inside `if`. Values in `case` can
be any expressions, usually constants, characters and `enum`s. If the expression being tested isn't
just a name (`switch next_char() { }`, `switch u8[p] { }`), it's evaluated once into a hidden variable.

Conditions are compiled into "jumping" code: `&&`/`||` short-circuit without computing 0/1,
`x == 0` → `cbz`, `x & 8` → `tbnz x, #3`, `x & mask` → `tst`. Loops are "rotated": the condition is at
the end, one branch per iteration.

## Functions

```hla
fn add3(a, b, c) {           // parameters without a register are aliases for x0, x1, x2
    return a + b + c
}

fn fact(n: auto) {           // n is copied into a free callee-saved register and survives calls
    if n <= 1 { return 1 }
    x0 = fact(n - 1)
    return x0 * n
}

fn hypot(a: d0, b: d1) {     // floating-point parameters — d0..d7
    return sqrt(a * a + b * b)
}

export fn api() { }          // .globl _api
naked fn twice(v) {          // no prologue/epilogue — everything by hand
    lsl x0, x0, #1
    ret
}
```

- A function named `foo` becomes the symbol `_foo` (C-compatible: the function can be passed to `qsort`).
- Prologue: `stp x29, x30, [sp, #-16]!`, space for local variables, saving **all callee-saved
  registers that appear in the body** (x19..x28, d8..d15).
- `return expr` puts the value into `x0` (or `d0` if the expression is floating-point).
- `main` without `return` returns 0.
- Command-line arguments: `fn main(argc: i32, argv: ptr)` — as in C, `argv` points to an
  array of pointers to strings, `argv[0]` is the program name. The parameters arrive in argument
  registers, so copy them before the first call: `let n = argc`. On Windows they're fetched by
  `hla_start` (`__getmainargs` from msvcrt.dll); in the CLI, arguments are passed after `--`:
  `node src/cli.ts run prog.hla -- one two` (and in `emu`). Example: `tests/cases/args.hla`.

### Calls

```hla
extern puts, malloc, free, qsort       // libSystem functions
extern printf(fmt, ...)                // variadic: arguments after fmt go on the stack (Apple ABI)

puts("Hello")
let p = malloc(64)                     // result from x0
printf("%ld + %ld = %ld\n", a, b, add3(a, b, 0))
qsort(&numbers, N, 4, cmp_i32)         // address of your own function
x9(x0)                                 // call through a pointer in a register (blr)
```

- Arguments are placed in `x0..x7` / `d0..d7`. If arguments depend on each other
  (`f(x1, x0)`), the translator shuffles them through the stack.
- Calls can appear anywhere in an expression: `f(a) + g(b)`, `[p + 8] = f(x)`,
  `g(f(1), f(2))`. The expression is evaluated left to right. If a call's result, or a value
  computed before it, won't survive the next call in registers, the translator stores it in a hidden
  stack frame slot and loads it back later. The address in a store `[addr] = f(x)` is computed before the call.
- Exceptions: the right-hand side of `&&`/`||`, the branches of `?:` and floating-point expressions.
  There the call must still be the first operand evaluated, otherwise the translator reports an error
  with a hint.

### System calls

```hla
syscall(SYS_write, 1, msg, len(msg))   // x16 = number, svc #0x80
syscall(SYS_exit, 0)
```

Predefined: `SYS_exit, SYS_read, SYS_write, SYS_open, SYS_close, SYS_getpid, SYS_mmap, ...`.

## Built-in functions

| function | code |
|---|---|
| `min(a,b)`, `max(a,b)`, `umin`, `umax` | `cmp` + `csel` |
| `abs(x)` | `cmp` + `cneg` |
| `clz(x)`, `rbit(x)`, `rev(x)` | instructions of the same name |
| `sext8/16/32(x)`, `zext8/16/32(x)` | `sxtb/sxth/sxtw`, `uxtb/uxth/mov w` |
| `float(x)` | `scvtf` (`ucvtf` for unsigned) |
| `int(d)` | `fcvtzs` |
| `sqrt(d)`, `fabs(d)` | `fsqrt`, `fabs` |
| `sizeof(x)`, `len(x)` | translation-time constants |
| `syscall(n, ...)` | `svc #0x80` |

## Floating point

```hla
let r: d8 = 2.0
d0 = pi * r * r              // fmul; constants — fmov #imm or a literal from __literal8
d1 = float(a) / 3.0
x0 = int(d1)
if d0 > 4.0 && d1 >= 0.5 { } // fcmp
s0 = fl                      // f32 from memory
```

## Processor instructions in code

Any line that doesn't look like a sugar construct is an assembly instruction; it goes into the
listing as is. Aliases, `let` variables, parameters, constants, labels and function/data names
are substituted:

```hla
fn popcount(v) {
    let count: x9 = 0
    while v != 0 {
        and x10, v, #1          // v -> x0
        add count, count, x10   // count -> x9
        v = v >>> 1
    }
    return count
}

asm {
    mov x9, value
1:  cbz x9, 2f              // numeric local labels
    sub x10, x9, #1
    and x9, x9, x10
    b 1b
2:
}
asm "dmb ish"
1:  add x9, x9, #1           // a numeric label is allowed outside an asm block too
push x19, x20                // stp x19, x20, [sp, #-16]!
pop x19, x20
```

The first word of a line is always a processor instruction (in `b 1b`, even an alias named `b` won't
be substituted). A `ret` instruction in an ordinary (non-`naked`) function skips the epilogue — the
translator will warn you; use `return`.

Instructions and sugar see the same things:

```hla
data counter: i64 = 41

fn main() {
    adrp x9, counter@PAGE        // data by name (the translator adds the '_' prefix)
    ldr x10, [x9, counter@PAGEOFF]
    let n = 4                    // a sugar variable — register x19…x28
again:                           // a sugar label — a target for b.cond
    add x10, x10, #1
    subs n, n, #1
    b.ne again
    if x10 > 44 { counter = x10 }  // sugar again: a condition on a register, a store to memory
}
```

- `asm { }` isn't required: it only groups instructions and lets you put labels at the start of a
  line inside the block. Individual instructions are written among sugar lines without a wrapper.
- If a function ends with an instruction that put the result into `x0` (`rax` on x64), no `return`
  is needed: the epilogue doesn't touch the result register.
- Sugar uses the scratch registers `x16`, `x17`, `d29…d31` (on x64 — `r10`, `r11`, `xmm4`,
  `xmm5`): their values aren't preserved between sugar lines.
- Instructions are written in the platform's syntax: the Apple dialect of AArch64 or Intel (LLVM) for
  x86-64. The built-in assembler understands ≈140 AArch64 mnemonics and the main integer and SSE
  instructions of x86-64; whatever it doesn't know (for example, `adc`, `crc32b`, SIMD) can be
  assembled with `--clang`.

## Multiple files

```hla
// main.hla — the build starts from this file
include "util/text.hla"      // path relative to the including file; '/' on Windows too
include "geometry.hla"
include "std/file.hla"       // built-in library (see below)

fn main() {
    say("hello")             // function from util/text.hla
}
```

```hla
// util/text.hla
extern puts

fn say(s) { puts(s) }
```

`include` substitutes the file's text in place of the line — the program is built as one big file.
Each file is included **once**: a repeated `include` of the same file and include cycles are
skipped, so every file can include whatever it needs itself. Example:
[tests/include](../tests/include).

- **Form.** `include "path"` — one per line; you can leave a `// comment` after it.
  Inclusion is textual, so it works anywhere in a file (even inside `{ }`), but it's usually
  written at the top.
- **Paths** are relative to the including file's directory: from `util/text.hla`, the line
  `include "fmt.hla"` looks for `util/fmt.hla`. The separator is `/` on all systems (`\` is understood
  too), `..` goes up one directory.
- **`std/…`** are files built into the translator (currently just one: `std/file.hla`). You don't
  need to put them in your project, and they can be included from any directory. A file with the same
  path in the project takes precedence over the built-in one — that's how you can replace the library
  with your own.
- **One namespace.** After merging, all top-level names (`fn`, `data`, `const`,
  `struct`, `enum`, global `alias`, `extern`) are visible in all files, including before the point of
  definition: `main` can call a function from a file included at the end. The same name
  in two files is an error: `'twice' is already defined`.
- **Errors and warnings** point to the real file and line: `util/text.hla:12:5: error: …`;
  a missing file gives `cannot find included file 'util/fmt.hla'` on the `include` line.
- **The CLI** takes only the main file and reads the rest from disk itself:
  `node src/cli.ts run main.hla` (likewise `build`, `emu`, `obj`, `lib`; the library is named after the main file).
- **On the web page**, project files are in the **Files** panel on the left. The main one is marked
  `main`; the ▶ button next to another `.hla` makes it the main one. Files can be created, renamed
  (`include` lines in other files are fixed automatically), deleted and dragged in from disk;
  **Download project .zip** downloads all files.

## Files: std/file.hla

A built-in library for reading and writing files. The functions are named and behave **the same on
macOS and Windows**, so a program using them moves between platforms unchanged — you need neither
macOS `syscall` nor WinAPI. You don't need to put it in your project or declare the functions with
`extern` — `include "std/file.hla"` is enough.

| function | what it does | result |
|---|---|---|
| `read_file(path, buf, size)` | reads the whole file, but no more than `size` bytes, into `buf` | bytes read; `-1` — the file didn't open |
| `write_file(path, buf, size)` | creates the file or replaces its contents with `size` bytes from `buf` | bytes written; `-1` — error |
| `append_file(path, buf, size)` | appends bytes to the end (creates the file if it doesn't exist) | bytes written; `-1` — error |
| `file_size(path)` | file size | bytes; `-1` — no such file |
| `file_open(path, mode)` | opens a file for step-by-step work: `"r"` read, `"w"` write (create/truncate), `"a"` append; `"r+"`, `"w+"`, `"a+"` — read and write | handle; `0` — error |
| `file_read(f, buf, size)` | reads the next bytes, no more than `size` | bytes read; `0` — end of file |
| `file_write(f, buf, size)` | writes `size` bytes from `buf` | bytes written |
| `file_close(f)` | closes the file | `0` — data written |

`path` and `mode` are zero-terminated strings (a literal `"input.txt"` or an address in `data`), `buf`
is the buffer address. `read_file` and `file_read` don't append a `0` after the data: to work with
what you read as a string, leave a byte for it — `read_file(p, buf, sizeof(buf) - 1)`, then `buf[n] = 0`.

```hla
include "std/file.hla"

data buf: u8[4096]

fn main() {
    let n = read_file("input.txt", buf, sizeof(buf))   // bytes read or -1
    write_file("copy.txt", buf, n)                      // create/replace; bytes written or -1
    append_file("log.txt", "done\n", 5)                 // append to the end (creates the file)
    let size = file_size("input.txt")                   // -1 if there's no such file

    let f = file_open("numbers.txt", "w")               // "r", "w", "a" (+ "r+" ...); 0 — error
    file_write(f, buf, 16)
    file_close(f)                                       // 0 — data is in the file
    f = file_open("numbers.txt", "r")
    let got = file_read(f, buf, 4)                      // 0 — end of file
    file_close(f)
}
```

Reading a file in chunks, to the end:

```hla
let f = file_open("data.bin", "r")
if f == 0 { return 1 }
loop {
    let got = file_read(f, buf, sizeof(buf))
    if got == 0 { break }
    // ... process got bytes from buf
}
file_close(f)
```

How it works:

- The functions are written in ordinary HLA64 (the source is in [src/lang/stdlib.ts](../src/lang/stdlib.ts))
  on top of `fopen`/`fread`/`fwrite`/`fclose`/`fseek`/`ftell` from the C runtime — they exist both in
  libSystem and in `msvcrt.dll`. The library doesn't name any registers, so the same source builds for
  both platforms. These C names (`fopen`, `fread`, …) are taken by the library: you can't define your
  own function with such a name, but you can call them directly.
- Files are always opened in binary mode (the translator adds `b` to `mode`), so on Windows
  `\n` doesn't turn into `\r\n`, and the bytes in the file are the same on both systems.
- Paths are relative to the program's current directory; `/` works on Windows too.
- Where the program sees files: natively and in `cli emu` — on disk; on the web page — the project
  files (they can be read, and files written by the program appear in the **Files** panel as text).
- `file_size` — up to 2 GB (`long` in C on Windows is 32-bit).

An example using all the functions: [tests/cases/files.hla](../tests/cases/files.hla).

## Libraries and interop with C

```hla
export const VERSION = 3                    // #define VERSION 3
export struct Vec2 { x: f64, y: f64 }       // typedef struct Vec2 { double x; double y; } Vec2;
export enum Shape { Circle, Square }        // enum Shape { Shape_Circle = 0, Shape_Square = 1 };
export data call_count: i64 = 0             // extern int64_t call_count;
export fn clamp(v: i32, lo: i32, hi: i32) -> i32 { ... }   // int32_t clamp(int32_t v, ...);
export fn length(v: ptr) -> f64 { ... }                    // double length(void *v);
```

- Instead of a register, a parameter can be given a type: `i8 u8 i16 u16 i32 u32 i64 u64 ptr f32 f64`.
  Integers narrower than 64 bits are extended to 64 bits on entry (`sxtw`, `uxtb`, …): C passes `int`
  and `char` only in the low bits. `f32`/`f64` arrive in `s`/`d` registers.
- `-> type` sets the result type for the header (`-> void`, `-> i64`, `-> f64`, …).
- `node src/cli.ts lib name.hla` creates `name.h`, `name.o`, `libname.a`, `libname.dylib`
  (install name `@rpath/libname.dylib`).
- `node src/cli.ts obj prog.hla` produces the program's object file so you can link it with C code:
  `clang prog.o helpers.c -o app`.
- For a call through a function pointer (`f(x)`, where `f` is a parameter in `x0 … x7`), the
  translator moves the pointer to a temporary register so the arguments don't overwrite it.

In detail, with examples: [lesson 14](lessons/14-c-library.md).

## Compatibility with hlaa64

The syntax of the original hlaa64 is accepted too: `alias a = X1;`, `set a = b + c;`,
`function name() { ... }`, `call name();`, `loop { ... break; }`, `if (a >= b) { } else { }`, `return;`.
`call` without parentheses after the name (`call puts`, `call rax`) is an x86-64 instruction.

## Platforms

One language, three code generators: AArch64 for macOS (the default on macOS), x86-64 for Windows
(`--target x64-windows`, the default on Windows) and WebAssembly (`--target wasm32`), which runs in
the browser and in Node. Everything that doesn't name registers explicitly (`let`, data, structs,
loops, C calls) carries over unchanged; register names, the built-in assembler and `syscall` are
specific to each platform. Registers, the Win64 convention and the differences are described in
[windows.md](windows.md); the registers `r0`–`r31`/`f0`–`f31`, the stack machine, structured control
flow and the JavaScript runtime of WebAssembly — in [wasm.md](wasm.md).

## Limitations

- Integer arithmetic is 64-bit by default; overflow behaves like the machine (wrap-around).
- Structs can't be initialized in `data` (zero-fill only) — fill them in code.
- No SIMD expressions (but `ld1`/`v` registers can be written in `asm` if the assembler understands
  them — the built-in one doesn't yet).
- AArch64: at most 8 register arguments per function (on x64, arguments after the fourth go on the stack).
