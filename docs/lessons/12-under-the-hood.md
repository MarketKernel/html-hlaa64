# Lesson 12. Under the hood

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/12-under-the-hood.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

HLA64 is an assembler with sugar, and since the first lesson you have been writing processor instructions
next to `if`, `for` and expressions. This lesson goes into more detail: how the translator tells an
instruction from sugar, `asm { }` blocks and numeric labels, functions with no sugar at all, the stack and
how calls work.

## From text to program

```
program.hla ──► translator ──► assembler (text) ──► machine code ──► Mach-O file ──► processor
```

1. The **translator** turns HLA64 into AArch64 assembly: `node src/cli.ts compile program.hla`.
2. The **assembler** turns each instruction into 4 bytes of machine code. For example, `add x0, x1, x2`
   is the number `0x8b020020`. On the **Machine code** tab in the browser you can click any instruction
   and see all 32 of its bits.
3. The **linker** packs the code, the data and the loader tables into a **Mach-O** executable —
   the macOS program format — and signs it. You can explore its structure on the **Mach-O** tab.

With macOS's built-in tools you can disassemble the built program: `otool -tv program`.

## Processor instructions: the rules

Any line that doesn't look like an HLA64 construct is treated as an assembler instruction and goes
into the output as is. Names of variables, parameters, constants, data, labels and functions in it
are replaced with registers and addresses. The first word of the line is always the instruction name: it is never
replaced, even if it matches a variable name.

```hla
extern printf(fmt, ...)

fn main() {
    let a = 6, b = 7
    mul x9, a, b                 // a and b are replaced with x19 and x20
    printf("6 * 7 = %ld\n", x9)
    let big: x10 = 0
    movz big, #0xbeef            // load 16 bits
    movk big, #0xdead, lsl #16   // and 16 more bits above, leaving the low ones untouched
    printf("big = %lx\n", big)
}
```

```text
6 * 7 = 42
big = deadbeef
```

Several instructions in a row are convenient to write as an `asm { }` block. Inside it you can place labels and jump
to them; **numeric labels** (`1:`) can be repeated, and the reference `1b` means "the nearest label 1 backward",
`1f` — "forward":

```hla
extern printf(fmt, ...)

fn sum_to(n) {
    asm {
        mov x9, #0          // sum
    1:
        cbz n, 2f           // n == 0 -> exit
        add x9, x9, n
        sub n, n, #1
        b 1b                // back to label 1
    2:
        mov x0, x9          // the function's result goes in x0
    }
}

fn main() {
    printf("1 + ... + 100 = %ld\n", sum_to(100))
}
```

```text
1 + ... + 100 = 5050
```

The `sum_to` function doesn't `return`: the result is already in `x0`, and the epilogue doesn't touch it.

A more involved example — maximum without a single branch: `cmp` sets the flags, and `csel` picks
one of the registers based on a condition:

```hla
extern printf(fmt, ...)

fn max_branchless(a, b) {
    asm {
        cmp a, b
        csel x0, a, b, gt    // x0 = (a > b) ? a : b
    }
}

fn main() {
    printf("%ld %ld\n", max_branchless(3, 9), max_branchless(-1, -5))
}
```

```text
9 -1
```

**Careful:** the translator uses registers `x16`, `x17` and `d29 … d31` for its own intermediate
calculations. You can use them within a single instruction or `asm` block, but don't count on
their value surviving to the next HLA64 line.

## "Naked" functions

Normally the translator adds a prologue and an epilogue to a function. The `naked` keyword turns them off: you get
exactly the instructions you wrote and are responsible for everything yourself — including the `ret` at the end.

```hla
extern printf(fmt, ...)

naked fn times_ten(v) {      // v is x0
    add x9, x0, x0, lsl #2   // x9 = v + v*4 = 5v
    lsl x0, x9, #1           // x0 = 10v
    ret
}

fn main() {
    printf("times_ten(42) = %ld\n", times_ten(42))
}
```

```text
times_ten(42) = 420
```

These are the fastest functions, but they can't call other functions (nobody saved the return address
in `x30`) and can't use the callee-saved registers `x19 … x28` without saving them yourself.

## The stack: `push` and `pop`

The stack is an area of memory where you can temporarily "set aside" registers. `push` puts registers on
top of the stack, and `pop` takes them back off. This way you can save a scratch register across a call:

```hla
extern printf(fmt, ...)

fn main() {
    x9 = 123
    x10 = 456
    push x9, x10                 // set aside (printf will clobber x9 and x10)
    printf("some call\n")
    pop x9, x10                  // restore
    printf("x9 = %ld, x10 = %ld\n", x9, x10)
}
```

```text
some call
x9 = 123, x10 = 456
```

`pop` lists the registers in the same order as `push`. On ARM64 the stack pointer must be a multiple
of 16 bytes, so even a single register takes 16 bytes on the stack — `push` takes care of that itself.

## How a function's stack frame is laid out

Let's look at what the translator does with a function that has a local buffer and callee-saved registers:

```hla
extern printf(fmt, ...)

fn demo(n: auto) {
    local buf: u8[16]
    let i = 0
    while i < n {
        buf[i] = 'a' + i
        i++
    }
    buf[n] = 0
    printf("%s\n", &buf)
}

fn main() {
    demo(5)
}
```

```text
abcde
```

The prologue and epilogue of `demo`:

```asm
_demo:
    stp x29, x30, [sp, #-16]!   // 1. save fp and the return address, sp -= 16
    mov x29, sp                 // 2. x29 = start of the frame
    sub sp, sp, #32             // 3. space: 16 bytes of buf + 16 bytes for x19, x20
    stp x19, x20, [sp]          // 4. save the registers the function will change
    mov x19, x0                 //    n: auto -> x19
    ...
    sub sp, x29, #32            // 5. put sp back (in case it moved)
    ldp x19, x20, [sp]          // 6. restore the registers
    mov sp, x29                 // 7. free the frame
    ldp x29, x30, [sp], #16     // 8. restore fp and the return address
    ret                         // 9. return to the address in x30
```

The frame in memory (addresses grow upward):

```
        higher addresses
   ┌──────────────────────┐
   │  the caller's frame  │
   │                      │
   ├──────────────────────┤ ◄── x29 + 16
   │ x30 (return address) │
   │ x29 (old fp)         │
   ├──────────────────────┤ ◄── x29
   │ buf: 16 bytes        │     buf is at address x29 - 16
   ├──────────────────────┤
   │ x20                  │
   │ x19                  │
   └──────────────────────┘ ◄── sp
        lower addresses
```

## Calling convention — cheat sheet

| what | where |
|---|---|
| integer arguments | `x0 … x7` |
| fractional arguments | `d0 … d7` |
| `printf` arguments after the format | on the stack, 8 bytes each (an Apple quirk) |
| result | `x0` (integer), `d0` (fractional) |
| clobbered by a call | `x0 … x17`, `d0 … d7`, `d16 … d31` |
| don't touch | `x18` (reserved by macOS) |
| preserved | `x19 … x28`, `d8 … d15`, `x29`, `sp` |
| return address | `x30` |

Everything the translator does around calls is simply careful compliance with this table.

## Exercises

1. Look at the assembly of any program from the previous lessons (`node src/cli.ts compile`) and find
   the prologue, the epilogue and the place where the loop condition is evaluated.
2. Write `naked fn abs_value(v)` using the instructions `cmp` and `cneg x0, x0, mi` ("negate if
   negative").
3. Rewrite `sum_to` so the loop runs from 1 to n, using `cmp` and `b.le`.

<details>
<summary>Solution to exercise 2</summary>

```hla
extern printf(fmt, ...)

naked fn abs_value(v) {
    cmp x0, #0
    cneg x0, x0, mi
    ret
}

fn main() {
    printf("%ld %ld\n", abs_value(-15), abs_value(8))
}
```

```text
15 8
```

</details>

Next: [Lesson 13. Project: the Game of Life](13-project-game-of-life.md)
