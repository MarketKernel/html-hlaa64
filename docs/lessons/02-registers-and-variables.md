# Lesson 2. Registers and variables

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/02-registers-and-variables.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

## What a register is

The processor doesn't compute directly in memory but in **registers** — small storage cells inside it.
AArch64 has 31 general-purpose ones: `x0`, `x1`, … `x30`. Each holds one 64-bit integer, that is,
roughly from −9.2·10¹⁸ to 9.2·10¹⁸.

A register can be used as a variable: put a number into it, add, print.

```hla
extern printf(fmt, ...)

fn main() {
    x9 = 42
    printf("register x9 holds %ld\n", x9)
}
```

```text
register x9 holds 42
```

`printf` is the printing function from the C language. The first argument is a format string in which
`%ld` means "put an integer here". Writing `printf(fmt, ...)` in `extern` tells the translator that the
format string may be followed by any number of arguments (Apple requires them to be passed in a special
way, and the translator does that for you).

## Names for registers

Writing `x9`, `x10`, `x11` is inconvenient: five lines later you can no longer remember what is where.
That is why a register can be given a **name** (an alias):

```hla
extern printf(fmt, ...)

fn main() {
    alias apples = x9
    alias pears = x10
    apples = 5
    pears = 7
    x11 = apples + pears
    printf("fruit in total: %ld\n", x11)
}
```

```text
fruit in total: 12
```

`alias` doesn't create anything new: `apples` is simply a second name for register `x9`.

The same thing is written more briefly with `let` — the name, the register and the initial value at once:

```hla
extern printf(fmt, ...)

fn main() {
    let width: x9 = 8
    let height: x10 = 3
    let area: x11 = width * height
    printf("%ld x %ld = %ld\n", width, height, area)
}
```

```text
8 x 3 = 24
```

## Let the translator pick the register

Most of the time it doesn't matter which register a variable lives in. Then you can leave the register
out:

```hla
extern printf(fmt, ...)

fn main() {
    let a = 10, b = 20       // several variables separated by commas
    let sum = a + b
    printf("a=%ld b=%ld sum=%ld\n", a, b, sum)
}
```

```text
a=10 b=20 sum=30
```

The translator picks free registers from `x19 … x28` by itself and writes a comment in the assembly
saying what went where:

```asm
// a -> x19
    mov x19, #10
// b -> x20
    mov x20, #20
// sum -> x21
    add x21, x19, x20
```

Why `x19 … x28` in particular? These are **callee-saved** registers: any function we call (for example,
`printf`) must return them exactly as it received them. So the values in them survive calls. More on
this in the lesson about functions.

## The same thing with instructions

The assignment `x9 = 7` is sugar for the instruction `mov x9, #7`, and the addition `x10 = a + b` is
sugar for `add x10, a, b`. These instructions can be written right in the program, mixed with sugar,
and you can refer to variables in them by name — the translator substitutes their registers:

```hla
extern printf(fmt, ...)

fn main() {
    let apples = 5               // sugar: the translator picks x19 and writes mov x19, #5
    mov x9, #7                   // instruction: x9 = 7
    add x10, apples, x9          // instruction: x10 = apples + x9, i.e. add x10, x19, x9
    printf("total: %ld\n", x10)
}
```

```text
total: 12
```

How to read an instruction: first its name (`mov`, `add`), then the register **where** the result goes,
then what it is computed **from**. A number in an instruction is written with a hash sign: `#7`. In the
listing, the lines `mov x9, #7` and `add x10, x19, x9` will appear exactly as you wrote them.

## Kinds of registers

| registers | purpose |
|---|---|
| `x0 … x7` | function arguments and result (`x0`); **clobbered** by function calls |
| `x8 … x15` | temporary, also **clobbered** by function calls |
| `x16`, `x17` | used by the translator for intermediate computations — don't touch |
| `x18` | reserved by macOS — don't use |
| `x19 … x28` | callee-saved: survive function calls |
| `x29` (`fp`), `x30` (`lr`) | special: function frame and return address |
| `sp` | stack pointer |
| `xzr` | always zero |

A simple rule to start with: **declare variables with `let` without a register**, and use specific
registers (`x0`, `x9`, …) only for short-lived temporary values between two lines.

## Register halves: `w`

Every `x` register has a lower 32-bit half named `w`: `w9` is the lower 32 bits of `x9`. Writing to `w9`
zeroes the upper 32 bits. More about 32 and 64 bits in the next lesson.

```hla
extern printf(fmt, ...)

fn main() {
    x9 = 0x1122334455667788
    printf("x9 = %lx\n", x9)
    w9 = 5                      // we write only to the lower half...
    printf("x9 = %lx\n", x9)    // ...and the upper half got zeroed
}
```

```text
x9 = 1122334455667788
x9 = 5
```

`%lx` prints a number in hexadecimal.

## Writing numbers

```hla
extern printf(fmt, ...)

fn main() {
    let dec = 1_000_000         // underscores for readability
    let hex = 0xFF              // hexadecimal
    let bin = 0b1010            // binary
    let oct = 0o17              // octal
    let ch = 'A'                // character code
    let neg = -42
    printf("%ld %ld %ld %ld %ld %ld\n", dec, hex, bin, oct, ch, neg)
    printf("character: %c\n", ch)  // %c prints a number as a character
}
```

```text
1000000 255 10 15 65 -42
character: A
```

## Constants

If a number never changes, give it a name with `const`. A constant exists only during translation: the
program will contain the number itself instead, and no register is used.

```hla
extern printf(fmt, ...)

const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const SECONDS_PER_DAY = 24 * MINUTES_PER_HOUR * SECONDS_PER_MINUTE

fn main() {
    let days = 7
    printf("a week has %ld seconds\n", days * SECONDS_PER_DAY)
}
```

```text
a week has 604800 seconds
```

The translator computed `24 * 60 * 60` by itself — the program will contain just `86400`.

## Where a variable lives

A variable declared inside `{ }` exists until the closing brace. After it, the name disappears and the
register is freed for other variables.

```hla
extern printf(fmt, ...)

fn main() {
    let a = 1
    {
        let b = 2                         // b is visible only inside these braces
        printf("inside: a=%ld b=%ld\n", a, b)
    }
    let c = 3                             // c may get the same register that b had
    printf("outside: a=%ld c=%ld\n", a, c)
}
```

```text
inside: a=1 b=2
outside: a=1 c=3
```

## Exercises

1. Declare the variables `price = 250` and `count = 4` and print the total cost of the purchase.
2. Swap the values of two variables `a = 1` and `b = 2` using a third one.
3. Do the same with three `mov` instructions (use `x9` for the temporary value).

<details>
<summary>Solution to exercise 2</summary>

```hla
extern printf(fmt, ...)

fn main() {
    let a = 1, b = 2
    let tmp = a
    a = b
    b = tmp
    printf("a=%ld b=%ld\n", a, b)
}
```

```text
a=2 b=1
```

</details>

Next: [Lesson 3. Arithmetic and expressions](03-arithmetic.md)
