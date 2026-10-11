# Lesson 11. Floating-point numbers

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/11-floating-point.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

The integer `x` registers can't hold fractions: `7 / 2` in them equals 3. For fractional numbers the
processor has a separate set of 32 registers:

- `d0 … d31` — 64-bit double-precision numbers (`double` in C, `f64` in HLA64), about 15–16 significant digits;
- `s0 … s31` — 32-bit single-precision (`float`, `f32`), about 7 digits. `s5` is the lower half of `d5`.

## First calculations

```hla
extern printf(fmt, ...)

fn main() {
    let price: d8 = 19.99
    let count: d9 = 3.0
    let total: d10 = price * count
    printf("total: %f\n", total)
    printf("total: %.2f\n", total)       // two digits after the point
    printf("7 / 2 = %f\n", 7.0 / 2.0)
}
```

```text
total: 59.970000
total: 59.97
7 / 2 = 3.500000
```

For fractional variables you have to specify the register explicitly: `let x: d8 = ...`. Registers `d8 … d15`
are callee-saved (like `x19 … x28`): they survive function calls. Registers `d0 … d7` are used for
arguments and the result and get clobbered by calls.

`printf` prints fractional numbers: `%f` (6 digits after the point by default), `%.2f` (two digits),
`%e` (exponential notation), `%g` (short notation).

## Integers and fractions: `float()` and `int()`

You can't mix integers and fractions in one expression — the translator will ask you to convert explicitly:

- `float(n)` — integer to fractional;
- `int(d)` — fractional to integer, the fractional part is **dropped** (toward zero).

```hla
extern printf(fmt, ...)

fn main() {
    let total = 17, parts = 4
    let exact: d8 = float(total) / float(parts)
    printf("%ld / %ld = %.2f\n", total, parts, exact)
    printf("integer part: %ld\n", int(exact))
    let neg: d9 = -2.7
    printf("int(-2.7) = %ld\n", int(neg))
}
```

```text
17 / 4 = 4.25
integer part: 4
int(-2.7) = -2
```

Integer constants in a fractional expression are converted automatically: `d0 = d1 * 2` is the same as `d0 = d1 * 2.0`.

## Comparisons and built-in functions

```hla
extern printf(fmt, ...)

fn main() {
    let a: d8 = 3.0, b: d9 = 4.0
    let c: d10 = sqrt(a * a + b * b)          // hypotenuse
    printf("hypotenuse: %g\n", c)
    let x: d11 = -1.25
    printf("|x| = %g, min = %g, max = %g\n", fabs(x), min(a, x), max(a, x))
    if c > 4.5 && c < 5.5 {
        printf("about five\n")
    }
}
```

```text
hypotenuse: 5
|x| = 1.25, min = -1.25, max = 3
about five
```

## Floating-point instructions directly

Sugar covers ordinary arithmetic, but the processor has more floating-point instructions. You can write
them alongside expressions — with the same `d` registers and variable names:

```hla
extern printf(fmt, ...)

fn main() {
    let a: d8 = 3.0, b: d9 = 4.0, c: d10 = 0.5
    fmadd d0, a, b, c            // d0 = a * b + c in a single instruction
    printf("3 * 4 + 0.5 = %g\n", d0)
    let half: d11 = 2.5
    frintn d12, half             // to nearest, ties to even: 2
    frinta d13, half             // to nearest, ties away from zero: 3
    printf("frintn: %g, frinta: %g\n", d12, d13)
}
```

```text
3 * 4 + 0.5 = 12.5
frintn: 2, frinta: 3
```

`fmadd` ("fused multiply-add") rounds the result once rather than after the multiplication and again after the addition,
so it is both faster and more precise than the sugar `d0 = a * b + c` — that one turns into two instructions,
`fmul` and `fadd`, and keeps the usual rounding after each. The `frint…` instructions round
to an integer, but the result stays a fractional number in a `d` register.

## Precision

Fractional numbers are stored in binary, and many decimal fractions (0.1, 0.2) can only be written
in it approximately. That's why comparing fractional numbers for exact equality is dangerous:

```hla
extern printf(fmt, ...)

fn main() {
    let a: d8 = 0.1, b: d9 = 0.2
    let sum: d10 = a + b
    printf("0.1 + 0.2 = %.17f\n", sum)
    if sum == 0.3 { printf("equal\n") } else { printf("not equal!\n") }
    let diff: d11 = fabs(sum - 0.3)
    if diff < 0.000001 { printf("but almost equal\n") }
}
```

```text
0.1 + 0.2 = 0.30000000000000004
not equal!
but almost equal
```

## Arrays of fractional numbers

```hla
extern printf(fmt, ...)

data measurements: f64[6] = [21.5, 22.1, 19.8, 23.4, 20.0, 22.7]

fn main() {
    let sum: d8 = 0.0
    let lo: d9 = measurements[0]
    let hi: d10 = measurements[0]
    for i in 0..len(measurements) {
        d0 = measurements[i]
        sum += d0
        lo = min(lo, d0)
        hi = max(hi, d0)
    }
    d1 = sum / float(len(measurements))
    printf("average %.2f, from %.1f to %.1f\n", d1, lo, hi)
}
```

```text
average 21.58, from 19.8 to 23.4
```

## Functions with fractional parameters

Fractional arguments are passed in `d0, d1, …`, and the result is returned in `d0`. To make a parameter
fractional, give it a `d` register:

```hla
extern printf(fmt, ...)

fn circle_area(r: d0) {
    return 3.141592653589793 * r * r
}

// square root by Newton's method: x = (x + n / x) / 2
fn newton_sqrt(n: d0) {
    let x: d1 = n
    for step in 0..20 {
        x = (x + n / x) * 0.5
    }
    return x
}

fn main() {
    d0 = circle_area(2.0)
    printf("area of circle r=2: %.4f\n", d0)
    d0 = newton_sqrt(2.0)
    printf("sqrt(2) by Newton: %.12f\n", d0)
    d1 = sqrt(2.0)
    printf("sqrt(2) by the CPU: %.12f\n", d1)
}
```

```text
area of circle r=2: 12.5664
sqrt(2) by Newton: 1.414213562373
sqrt(2) by the CPU: 1.414213562373
```

Grab the result of a fractional function into a `d` register right away (`d0 = circle_area(2.0)`).

## Math from the C library

Sines, powers and logarithms are available in libSystem:

```hla
extern printf(fmt, ...)
extern sin, cos, pow

fn main() {
    let angle: d8 = 3.141592653589793 / 6.0          // 30 degrees in radians
    d0 = sin(angle)
    printf("sin(30°) = %.3f\n", d0)
    d0 = cos(0.0)
    printf("cos(0) = %.3f\n", d0)
    d0 = pow(2.0, 10.0)
    printf("2^10 = %g\n", d0)
}
```

```text
sin(30°) = 0.500
cos(0) = 1.000
2^10 = 1024
```

## 32-bit numbers: the `s` registers

The `s` registers and the `f32` type work the same way, but take half the space and are less precise:

```hla
extern printf(fmt, ...)

fn main() {
    s8 = 1.0
    s9 = 3.0
    s10 = s8 / s9
    d11 = 1.0 / 3.0                     // d11, not d0: the first printf would clobber d0
    printf("float:  %.10f\n", s10)      // printf always receives a double: the translator converts it
    printf("double: %.10f\n", d11)
}
```

```text
float:  0.3333333433
double: 0.3333333333
```

## Example: compound interest

A deposit of 100,000 at 8% per year, with interest added once a year:

```hla
extern printf(fmt, ...)

fn main() {
    let money: d8 = 100000.0
    let rate: d9 = 0.08
    for year in 1..=5 {
        money = money * (1.0 + rate)
        printf("after %ld yr: %10.2f\n", year, money)
    }
}
```

```text
after 1 yr:  108000.00
after 2 yr:  116640.00
after 3 yr:  125971.20
after 4 yr:  136048.90
after 5 yr:  146932.81
```

## Exercises

1. Convert a temperature of 36.6 °C to degrees Fahrenheit (`F = C * 9 / 5 + 32`).
2. Find the sum of the series 1 + 1/2 + 1/4 + 1/8 + … (20 terms). What does it approach?
3. Solve the quadratic equation x² − 3x + 2 = 0 using the discriminant and `sqrt`.

Next: [Lesson 12. Under the hood](12-under-the-hood.md)
