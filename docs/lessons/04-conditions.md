# Lesson 4. Conditions

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/04-conditions.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

## `if`

`if` runs a block only if the condition is true:

```hla
extern printf(fmt, ...)

fn main() {
    let temperature = 31
    if temperature > 30 {
        printf("hot: %ld degrees\n", temperature)
    }
    printf("done\n")
}
```

```text
hot: 31 degrees
done
```

The curly braces are required, even if there is only one statement inside. Parentheses around the
condition are optional: you can write them (`if (temperature > 30) {`) or leave them out.

## Comparisons

| syntax | meaning |
|---|---|
| `a == b` | equal |
| `a != b` | not equal |
| `a < b`, `a <= b` | less than, less than or equal |
| `a > b`, `a >= b` | greater than, greater than or equal |

Don't confuse `==` (comparison) with `=` (assignment).

## `else` and `elif`

```hla
extern printf(fmt, ...)

fn main() {
    let score = 74
    if score >= 90 {
        printf("excellent\n")
    } elif score >= 70 {
        printf("good\n")
    } elif score >= 50 {
        printf("satisfactory\n")
    } else {
        printf("try again\n")
    }
}
```

```text
good
```

The checks go from top to bottom; the first matching branch runs, and the rest are skipped.
Instead of `elif` you can write `else if` — it's the same thing.

## AND, OR, NOT

- `a && b` — true if both conditions are true;
- `a || b` — true if at least one is true;
- `!a` — negation.

Example — a leap year: divisible by 4 but not by 100, or divisible by 400.

```hla
extern printf(fmt, ...)

fn main() {
    let year = 2024
    if year % 4 == 0 && year % 100 != 0 || year % 400 == 0 {
        printf("%ld is a leap year\n", year)
    } else {
        printf("%ld is a common year\n", year)
    }
    year = 1900
    if year % 4 == 0 && year % 100 != 0 || year % 400 == 0 {
        printf("%ld is a leap year\n", year)
    } else {
        printf("%ld is a common year\n", year)
    }
}
```

```text
2024 is a leap year
1900 is a common year
```

`&&` binds tighter than `||`, so no parentheses are needed around the first pair.

**Short-circuit evaluation.** If the left side already decides the result, the right side is not
evaluated. This lets you guard against division by zero:

```hla
extern printf(fmt, ...)

fn main() {
    let a = 10, b = 0
    if b != 0 && a / b > 2 {          // a / b won't run: b == 0
        printf("greater than two\n")
    } else {
        printf("can't divide or the result is small\n")
    }
}
```

```text
can't divide or the result is small
```

## A number as a condition

Any number can be used as a condition: zero is false, everything else is true.
`if n { }` means the same as `if n != 0 { }`.

```hla
extern printf(fmt, ...)

fn main() {
    let items = 3
    if items {
        printf("the cart is not empty\n")
    }
    if !items {
        printf("the cart is empty\n")
    }
}
```

```text
the cart is not empty
```

## A condition as a number

A comparison is a value in itself: 1 (true) or 0 (false). You can store it in a variable:

```hla
extern printf(fmt, ...)

fn main() {
    let n = 42
    let even = n % 2 == 0
    let big = n > 100
    printf("even: %ld, big: %ld\n", even, big)
}
```

```text
even: 1, big: 0
```

## The ternary operator

`condition ? if_yes : if_no` picks one of two values:

```hla
extern printf(fmt, ...)

fn main() {
    let a = 15, b = 9
    let biggest = a > b ? a : b
    let sign = a - b > 0 ? 1 : (a - b < 0 ? -1 : 0)
    printf("bigger: %ld, sign of the difference: %ld\n", biggest, sign)
}
```

```text
bigger: 15, sign of the difference: 1
```

## What the processor does

The processor has no "if" instruction. It has the compare instruction `cmp`, which sets **flags**
("the result is zero", "less than", and so on), and conditional branch instructions, such as `b.lt` —
"branch if less than". The condition `if temperature > 30 { ... }` turns into:

```asm
    cmp x19, #30            // compare
    b.le Lmain.endif0       // if "less than or equal" — jump over the body
    ...                     // body of the if
Lmain.endif0:
```

Notice: the branch uses the **opposite** condition — we jump over the body when the condition is false.
For common cases the translator picks shorter instructions: `if x == 0` becomes `cbz`
("branch if zero"), and `if x & 4` becomes `tbnz x, #2` ("branch if bit 2 is set").

## Branching by hand

You can write the same `cmp` and `b.le` yourself. The place to jump to is marked with a **label** — a
name followed by a colon on its own line. HLA64 labels and branch instructions understand each other:

```hla
extern printf(fmt, ...)

fn main() {
    let temperature = 31
    cmp temperature, #30         // compare, set the flags
    b.le not_hot                 // if "less than or equal" — jump over the printing
    printf("hot: %ld degrees\n", temperature)
not_hot:
    let a = 7, b = 12
    cmp a, b
    csel x9, a, b, gt            // x9 = a if a > b, otherwise b — without a single branch
    if x9 > 10 {                 // and sugar again
        printf("bigger: %ld\n", x9)
    }
}
```

```text
hot: 31 degrees
bigger: 12
```

`csel` ("conditional select") picks one of two registers based on the flags set by `cmp`.
A branch is expensive for the processor when it is hard to predict, so in hot spots such instructions
are written by hand. The flags live only until the next instruction that changes them — between `cmp`
and `b.le`/`csel` there must be no sugar lines that do their own comparisons (for example, `if`).

## Exercises

1. Print whether a number is positive, negative or zero.
2. Find the largest of three numbers without the `max` function.
3. Find the largest of three numbers with two `cmp` + `csel` pairs, without a single `if`.

<details>
<summary>Solution to exercise 2</summary>

```hla
extern printf(fmt, ...)

fn main() {
    let a = 12, b = 47, c = 30
    let m = a
    if b > m { m = b }
    if c > m { m = c }
    printf("largest: %ld\n", m)
}
```

```text
largest: 47
```

</details>

Next: [Lesson 5. Loops](05-loops.md)
