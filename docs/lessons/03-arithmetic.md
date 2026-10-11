# Lesson 3. Arithmetic and expressions

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/03-arithmetic.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

## The four operations and the remainder

```hla
extern printf(fmt, ...)

fn main() {
    let a = 17, b = 5
    printf("%ld + %ld = %ld\n", a, b, a + b)
    printf("%ld - %ld = %ld\n", a, b, a - b)
    printf("%ld * %ld = %ld\n", a, b, a * b)
    printf("%ld / %ld = %ld\n", a, b, a / b)   // integer division: the fractional part is dropped
    printf("%ld %% %ld = %ld\n", a, b, a % b)  // remainder of division; %% prints a % sign
}
```

```text
17 + 5 = 22
17 - 5 = 12
17 * 5 = 85
17 / 5 = 3
17 % 5 = 2
```

Division rounds **toward zero**, and the remainder has the sign of the dividend — just like in C:

```hla
extern printf(fmt, ...)

fn main() {
    let a = -17
    printf("%ld / 5 = %ld, remainder %ld\n", a, a / 5, a % 5)
}
```

```text
-17 / 5 = -3, remainder -2
```

## Expressions of any complexity

An expression can be written as in ordinary math, with parentheses. The translator breaks it down into
processor instructions by itself and uses temporary registers if needed.

```hla
extern printf(fmt, ...)

fn main() {
    let celsius = 36
    let fahrenheit = celsius * 9 / 5 + 32
    printf("%ld°C = %ld°F\n", celsius, fahrenheit)

    let x = 3, y = 4
    let r = (x + y) * (x - y) + x * x * y
    printf("(3+4)*(3-4) + 3*3*4 = %ld\n", r)
}
```

```text
36°C = 96°F
(3+4)*(3-4) + 3*3*4 = 29
```

## Compound assignment

Writing `a += 5` is the same as `a = a + 5`. This works with any operator. `i++` and `i--` add and
subtract one.

```hla
extern printf(fmt, ...)

fn main() {
    let n = 10
    n += 5       // 15
    n *= 2       // 30
    n -= 4       // 26
    n /= 3       // 8
    n %= 5       // 3
    n++          // 4
    printf("n = %ld\n", n)
}
```

```text
n = 4
```

## Example: the digits of a number

Dividing by 10 drops the last digit, and the remainder of dividing by 10 is the last digit itself.

```hla
extern printf(fmt, ...)

fn main() {
    let number = 2026
    let units = number % 10
    let tens = number / 10 % 10
    let hundreds = number / 100 % 10
    let thousands = number / 1000
    printf("%ld: thousands=%ld hundreds=%ld tens=%ld units=%ld\n", number, thousands, hundreds, tens, units)
}
```

```text
2026: thousands=2 hundreds=0 tens=2 units=6
```

## Bits

A number in a register is 64 bits (zeros and ones). These operators work with bits:

| operator | meaning | example (in binary) |
|---|---|---|
| `a & b` | AND: 1 where both are ones | `1100 & 1010 = 1000` |
| `a \| b` | OR: 1 where at least one is a one | `1100 \| 1010 = 1110` |
| `a ^ b` | exclusive OR: 1 where the bits differ | `1100 ^ 1010 = 0110` |
| `~a` | NOT: all bits flipped | |
| `a << n` | shift left by n bits (multiplication by 2ⁿ) | `0011 << 2 = 1100` |
| `a >> n` | shift right (division by 2ⁿ) | `1100 >> 2 = 0011` |
| `a >>> n` | shift right, always filling with zeros from the left | |

```hla
extern printf(fmt, ...)

const FLAG_READ = 1 << 0     // 0b001
const FLAG_WRITE = 1 << 1    // 0b010
const FLAG_EXEC = 1 << 2     // 0b100

fn main() {
    let flags = FLAG_READ | FLAG_EXEC          // turn on two flags
    printf("flags = %lx\n", flags)
    flags |= FLAG_WRITE                         // turn on one more
    flags &= ~FLAG_EXEC                         // turn off EXEC
    printf("flags = %lx\n", flags)
    printf("writable: %ld\n", (flags & FLAG_WRITE) != 0)
    printf("0xF0 >> 4 = %lx, 1 << 10 = %ld\n", 0xF0 >> 4, 1 << 10)
}
```

```text
flags = 5
flags = 3
writable: 1
0xF0 >> 4 = f, 1 << 10 = 1024
```

The comparison `(flags & FLAG_WRITE) != 0` gives 1 if the condition is true and 0 if it is false.

## Order of operations

Multiplication is done before addition, just like in school. The full table:

| first | operators |
|---|---|
| 1 | unary `-` `~` `!` |
| 2 | `*` `/` `%` `<<` `>>` `>>>` `&` |
| 3 | `+` `-` `\|` `^` |
| 4 | comparisons `==` `!=` `<` `<=` `>` `>=` |
| 5 | `&&` |
| 6 | `\|\|` |

Note: the bitwise `&` binds tighter than comparison. So `x & 1 == 0` means `(x & 1) == 0` — "x is even",
as intended. (In C this is a common mistake; in HLA64 it can't happen.) When in doubt, use parentheses.

## Overflow

A register isn't infinite. If a result doesn't fit into 64 bits, the extra high bits are simply dropped
and the number "wraps around":

```hla
extern printf(fmt, ...)

const MAX = 0x7FFFFFFFFFFFFFFF   // the largest signed 64-bit number

fn main() {
    let big = MAX
    printf("%ld\n", big)
    big += 1
    printf("%ld\n", big)          // became the smallest negative number
}
```

```text
9223372036854775807
-9223372036854775808
```

## Signed and unsigned numbers

The same 64 bits can be read in two ways. For example, all ones is −1 if the number is **signed**, and
18 446 744 073 709 551 615 if it is **unsigned**. By default variables are signed. The word `unsigned`
changes the meaning of division, the `>>` shift and comparisons:

```hla
extern printf(fmt, ...)

fn main() {
    let s = -16                 // signed
    let unsigned u = -16        // the same bits, but unsigned
    printf("signed:   %ld / 2 = %ld,  >> 2 = %ld\n", s, s / 2, s >> 2)
    printf("unsigned: %lu / 2 = %lu,  >> 2 = %lu\n", u, u / 2, u >> 2)
    printf("s > 0: %ld,  u > 0: %ld\n", s > 0, u > 0)
}
```

```text
signed:   -16 / 2 = -8,  >> 2 = -4
unsigned: 18446744073709551600 / 2 = 9223372036854775800,  >> 2 = 4611686018427387900
s > 0: 0,  u > 0: 1
```

`%lu` prints a number as unsigned.

## 32 bits: `w` registers

If an expression is written to a `w` register, it is computed in 32 bits. This is handy when you work
with 32-bit data (for example, from an `i32` array, lesson 7). To print a 32-bit number, use `%d`.

```hla
extern printf(fmt, ...)

fn main() {
    w9 = 0xFFFFFFFF          // all 32 bits are ones
    w9 = w9 + 1              // in 32 bits this overflows: the result is 0
    x10 = 0xFFFFFFFF
    x10 = x10 + 1            // in 64 bits there is enough room
    printf("w9 = %d, x10 = %ld\n", w9, x10)
}
```

```text
w9 = 0, x10 = 4294967296
```

## Useful built-in functions

```hla
extern printf(fmt, ...)

fn main() {
    let a = -7, b = 3
    printf("min=%ld max=%ld abs=%ld\n", min(a, b), max(a, b), abs(a))
    printf("clz(1)=%ld — the number of zeros before the first one\n", clz(1))
}
```

```text
min=-7 max=3 abs=7
clz(1)=63 — the number of zeros before the first one
```

## How the translator picks instructions

The translator tries to choose short instructions. A few examples of what you get:

| HLA64 | assembly |
|---|---|
| `a = b + 5` | `add x19, x20, #5` |
| `a = b * 8` | `lsl x19, x20, #3` (a shift instead of a multiplication) |
| `a = b + c * d` | `madd x19, x21, x22, x20` (multiply and add in one instruction) |
| `a = b & ~c` | `bic x19, x20, x21` |
| `a = 0x123456789` | `movz` + `movk` — a large number is built 16 bits at a time |

You can check for yourself: `node src/cli.ts compile file.hla`.

## When there's no operator, write the instruction

The processor has instructions for which the sugar has no operator. You don't need to replace them with
anything: you write the instruction on its own line, as in lesson 1, and then use its result in the
sugar.

```hla
extern printf(fmt, ...)

fn main() {
    let a = 0x1234_5678_9abc_def0
    ror x9, a, #16               // rotate: bits that fall off on the right come back in on the left
    printf("ror: %lx\n", x9)

    let big = 10_000_000_000     // 10^10, the product big * big doesn't fit into 64 bits
    mul x10, big, big            // the lower 64 bits of the product
    umulh x11, big, big          // the upper 64 bits: there's no operator for them
    printf("10^20 = %lu * 2^64 + %lu\n", x11, x10)
}
```

```text
ror: def0123456789abc
10^20 = 5 * 2^64 + 7766279631452241920
```

`umulh` computes the upper half of a 128-bit product — this is used, for example, to detect
multiplication overflow or to divide by a constant without a division instruction.

## Exercises

1. Convert 100,000 seconds into hours, minutes and seconds.
2. Check whether a number is a power of two: for such numbers `n & (n - 1) == 0`.
3. Compute `a * 10 + b` with a single `madd` instruction (its form: `madd dest, x, y, z` = `x * y + z`;
   put the ten into a register with a `mov` instruction).

<details>
<summary>Solution to exercise 1</summary>

```hla
extern printf(fmt, ...)

fn main() {
    let total = 100_000
    let hours = total / 3600
    let minutes = total % 3600 / 60
    let seconds = total % 60
    printf("%ld s = %ld h %ld min %ld s\n", total, hours, minutes, seconds)
}
```

```text
100000 s = 27 h 46 min 40 s
```

</details>

Next: [Lesson 4. Conditions](04-conditions.md)
