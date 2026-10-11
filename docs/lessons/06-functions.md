# Lesson 6. Functions

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/06-functions.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

A function is a named piece of a program that can be called many times.

## Declaring and calling

```hla
extern puts

fn greet() {
    puts("Hello from a function!")
}

fn main() {
    greet()
    greet()
}
```

```text
Hello from a function!
Hello from a function!
```

The order of declarations doesn't matter: you can call a function above the place where it is written.

## Parameters and the result

Parameters are listed in parentheses. The result is returned with `return`.

```hla
extern printf(fmt, ...)

fn square(n) {
    return n * n
}

fn add3(a, b, c) {
    return a + b + c
}

fn main() {
    printf("square(7) = %ld\n", square(7))
    let s = add3(1, 2, 3)
    printf("add3(1, 2, 3) = %ld\n", s)
    printf("together: %ld\n", square(add3(1, 1, 1)))
}
```

```text
square(7) = 49
add3(1, 2, 3) = 6
together: 9
```

How it works. Under the Apple ARM64 calling convention (both C and HLA64 follow it):

- arguments are passed in registers `x0, x1, x2, … x7`, in order;
- the result is returned in `x0`.

That's why a parameter without a register is just a **name for a register**: in `add3` the name `a`
means `x0`, `b` means `x1`, and `c` means `x2`. And `return a + b + c` puts the sum into `x0`.

## Early `return`

`return` can be placed anywhere — the function ends immediately.

```hla
extern printf(fmt, ...)

fn sign(x) {
    if x > 0 { return 1 }
    if x < 0 { return -1 }
    return 0
}

fn main() {
    printf("%ld %ld %ld\n", sign(-5), sign(0), sign(12))
}
```

```text
-1 0 1
```

## The main trap: calls clobber registers

A called function is allowed to change registers `x0 … x17` — it uses them for its own work.
So after **any** call, the values in these registers may be different. And that is exactly where
a function's parameters live. You **must not** write it like this:

```hla
fn show_twice(n) {               // n is x0
    printf("%ld\n", n)
    printf("%ld\n", n)           // ERROR: the first printf has already clobbered x0
}
```

There are two ways to fix this.

**1. Copy the parameter into a "long-lived" variable.** `let` variables without a register live in
the callee-saved registers `x19 … x28`, and every function is obliged to return them untouched:

```hla
extern printf(fmt, ...)

fn show_twice(n) {
    let keep = n                 // keep goes into x19 — it survives calls
    printf("%ld\n", keep)
    printf("%ld\n", keep)
}

fn main() {
    show_twice(42)
}
```

```text
42
42
```

**2. Declare the parameter "long-lived" right away**: `n: auto` — on entry to the function the
translator copies `x0` into a free callee-saved register.

```hla
extern printf(fmt, ...)

fn show_twice(n: auto) {
    printf("%ld\n", n)
    printf("%ld\n", n)
}

fn main() {
    show_twice(7)
}
```

```text
7
7
```

And you don't need to save and restore `x19 … x28` in your function — the translator sees which of
them you use and adds this to the beginning and end of the function itself.

The translator can also spot the same trap in expressions: if you write `f(x) + a`, where `a` lives in
`x0 … x17`, it reports an error with an explanation.

## Recursion

A function can call itself. Factorial: `n! = n · (n−1)!`, and `1! = 1`.

```hla
extern printf(fmt, ...)

fn factorial(n: auto) {          // auto: n is needed after the recursive call
    if n <= 1 { return 1 }
    let rest = factorial(n - 1)
    return n * rest
}

fn main() {
    for k in 1..=10 {
        printf("%ld! = %ld\n", k, factorial(k))
    }
}
```

```text
1! = 1
2! = 2
3! = 6
4! = 24
5! = 120
6! = 720
7! = 5040
8! = 40320
9! = 362880
10! = 3628800
```

Fibonacci numbers — two recursive calls:

```hla
extern printf(fmt, ...)

fn fib(n: auto) {
    if n < 2 { return n }
    let a = fib(n - 1)           // a is in a callee-saved register — it survives the second call
    let b = fib(n - 2)
    return a + b
}

fn main() {
    printf("fib(25) = %ld\n", fib(25))
}
```

```text
fib(25) = 75025
```

Each call gets its own **stack frame**, where its registers are saved, so every level of recursion
has its own `n`, `a` and `b`.

## Euclid's algorithm

The greatest common divisor is a classic example of a function with a loop:

```hla
extern printf(fmt, ...)

fn gcd(a, b) {
    while b != 0 {
        let r: x9 = a % b        // x9 is fine: there are no calls inside the loop
        a = b
        b = r
    }
    return a
}

fn main() {
    printf("gcd(1071, 462) = %ld\n", gcd(1071, 462))
    printf("gcd(17, 5) = %ld\n", gcd(17, 5))
}
```

```text
gcd(1071, 462) = 21
gcd(17, 5) = 1
```

Here it is safe to use the parameters `a` and `b` (that is, `x0` and `x1`): there are no calls inside
the function, so nothing can clobber them.

## A parameter in a chosen register

You can specify the register explicitly: `fn f(n: x20)` — on entry the value is copied from `x0` to `x20`.
Functions that return nothing can be ended with an empty `return`.

## What the processor does

A call is the `bl` instruction ("branch with link"): it jumps to the function and writes the return
address into register `x30`. A return is the `ret` instruction, which jumps to the address in `x30`.
Since a function may itself call another one (and `x30` gets overwritten), the translator saves
`x29` and `x30` on the stack at the start of every function and restores them at the end. Here is
what we got for `factorial`:

```asm
_factorial:
    stp x29, x30, [sp, #-16]!   // save fp and the return address
    mov x29, sp
    sub sp, sp, #16             // room for callee-saved registers
    stp x19, x20, [sp]          // save the caller's x19, x20
    mov x19, x0                 // n: auto -> x19
    cmp x19, #1
    b.gt Lfactorial.endif0
    mov x0, #1
    b Lfactorial.ret
Lfactorial.endif0:
    sub x0, x19, #1             // argument n - 1
    bl _factorial               // recursive call
    mov x20, x0                 // rest
    mul x0, x19, x20            // return n * rest
Lfactorial.ret:
    sub sp, x29, #16
    ldp x19, x20, [sp]          // restore x19, x20 as they were
    mov sp, x29
    ldp x29, x30, [sp], #16
    ret
```

## A function made of instructions, a call made of instructions

A function body can consist of instructions only: the parameters are registers `x0`, `x1`, …, and
their names work in instructions. If the last instruction put the result into `x0`, no `return` is
needed — the epilogue doesn't touch `x0`. Such a function can be called with sugar or with instructions:

```hla
extern printf(fmt, ...)

fn average(a, b) {               // a is x0, b is x1
    add x9, a, b
    asr x0, x9, #1               // the result goes into x0
}

fn main() {
    printf("average(10, 20) = %ld\n", average(10, 20))   // a call with sugar
    mov x0, #7                   // a call with instructions: arguments in x0 and x1…
    mov x1, #8
    bl average                   // …and bl
    printf("average(7, 8) = %ld\n", x0)
}
```

```text
average(10, 20) = 15
average(7, 8) = 7
```

`asr` is an arithmetic shift right: division by 2 rounding down. The call `bl average` is no
different from what the translator wrote for `average(10, 20)` — check the listing.

## Exercises

1. Write `power(base, exp)` — raising to a power with a loop.
2. Write a recursive `sum_digits(n)`: the sum of digits is `n % 10 + sum_digits(n / 10)`.
3. Write `square(n)` with a single `mul` instruction and call it with the `mov` and `bl` instructions.

<details>
<summary>Solution to exercise 2</summary>

```hla
extern printf(fmt, ...)

fn sum_digits(n: auto) {
    if n == 0 { return 0 }
    let rest = sum_digits(n / 10)
    return n % 10 + rest
}

fn main() {
    printf("%ld\n", sum_digits(987654321))
}
```

```text
45
```

</details>

Next: [Lesson 7. Data and arrays](07-data-and-arrays.md)
