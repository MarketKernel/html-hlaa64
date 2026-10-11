# Lesson 5. Loops

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/05-loops.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

A loop repeats a block of statements. HLA64 has several kinds of them, for different situations.

## `while` — as long as the condition is true

```hla
extern printf(fmt, ...)

fn main() {
    let n = 5
    while n > 0 {
        printf("%ld... ", n)
        n--
    }
    printf("liftoff!\n")
}
```

```text
5... 4... 3... 2... 1... liftoff!
```

The condition is checked **before** each repetition. If it is false from the very start, the body never runs.

The sum of the numbers from 1 to 100:

```hla
extern printf(fmt, ...)

fn main() {
    let sum = 0
    let i = 1
    while i <= 100 {
        sum += i
        i++
    }
    printf("1 + 2 + ... + 100 = %ld\n", sum)
}
```

```text
1 + 2 + ... + 100 = 5050
```

## `do … while` — at least once

Here the condition is checked **after** the body, so the body runs at least once. This is handy, for
example, for counting the digits of a number: zero has one digit too.

```hla
extern printf(fmt, ...)

fn main() {
    let n = 90210
    let digits = 0
    do {
        digits++
        n /= 10
    } while n != 0
    printf("digits: %ld\n", digits)
}
```

```text
digits: 5
```

## `loop`, `break` and `continue`

`loop { }` repeats forever. `break` gets you out of it — it ends the loop immediately.
`continue` skips the rest of the body and goes straight to the next repetition. Both work
in any loop.

The Collatz conjecture: if a number is even, halve it; if it is odd, multiply it by 3 and add 1.
Sooner or later you get 1.

```hla
extern printf(fmt, ...)

fn main() {
    let n = 27
    let steps = 0
    loop {
        if n == 1 { break }
        if n % 2 == 0 {
            n /= 2
        } else {
            n = 3 * n + 1
        }
        steps++
    }
    printf("27 reached 1 in %ld steps\n", steps)
}
```

```text
27 reached 1 in 111 steps
```

## `for … in` — over a range

The most convenient loop for counting. `a..b` means the numbers from `a` to `b`, **not including** `b`;
`a..=b` includes it.

```hla
extern printf(fmt, ...)

fn main() {
    for i in 0..5 { printf("%ld ", i) }
    printf("\n")
    for i in 1..=5 { printf("%ld ", i) }
    printf("\n")
    for i in 0..=20 step 5 { printf("%ld ", i) }     // step 5
    printf("\n")
    for i in 10..0 step -3 { printf("%ld ", i) }     // counting down
    printf("\n")
}
```

```text
0 1 2 3 4 
1 2 3 4 5 
0 5 10 15 20 
10 7 4 1 
```

The loop variable (`i`) is created automatically and disappears after the loop. If you need it to
live in a specific register, specify it: `for i: x9 in 0..10 { }`.

The range bound can be a variable:

```hla
extern printf(fmt, ...)

fn main() {
    let n = 6
    let factorial = 1
    for k in 2..=n {
        factorial *= k
    }
    printf("%ld! = %ld\n", n, factorial)
}
```

```text
6! = 720
```

## C-style `for`

If you need an unusual step or condition, there is the classic form: init; condition; step.

```hla
extern printf(fmt, ...)

fn main() {
    for (let p = 1; p < 1000; p *= 3) {
        printf("%ld ", p)
    }
    printf("\n")
}
```

```text
1 3 9 27 81 243 729 
```

## Nested loops

A multiplication table. In the format `%4ld` the number 4 is the field width: the number is padded
with spaces on the left.

```hla
extern printf(fmt, ...)

fn main() {
    for row in 1..=5 {
        for col in 1..=5 {
            printf("%4ld", row * col)
        }
        printf("\n")
    }
}
```

```text
   1   2   3   4   5
   2   4   6   8  10
   3   6   9  12  15
   4   8  12  16  20
   5  10  15  20  25
```

## Example: prime numbers

A number is prime if it is not divisible by any number from 2 up to its square root.
`continue` isn't needed here, but `break` saves unnecessary checks:

```hla
extern printf(fmt, ...)

fn main() {
    for n in 2..50 {
        let prime = 1
        for d in 2..n {
            if d * d > n { break }      // no point in checking further
            if n % d == 0 {
                prime = 0
                break
            }
        }
        if prime { printf("%ld ", n) }
    }
    printf("\n")
}
```

```text
2 3 5 7 11 13 17 19 23 29 31 37 41 43 47 
```

## Loop labels

`break` and `continue` apply to the innermost loop. To exit several nested loops at once,
give the outer loop a **label** and name it:

```hla
extern printf(fmt, ...)

fn main() {
    // find the first pair a*b == 391 where a <= b
    search: for a in 2..100 {
        for b in a..100 {
            if a * b == 391 {
                printf("%ld * %ld = 391\n", a, b)
                break search            // exit both loops
            }
            if a * b > 391 { continue search }   // b only gets bigger from here
        }
    }
}
```

```text
17 * 23 = 391
```

## `goto`

You can put a label anywhere in a function and jump to it with `goto`. HLA64 programs rarely need
this — loops are almost always clearer — but this is exactly how the processor works.

```hla
extern printf(fmt, ...)

fn main() {
    let k = 0
again:
    k++
    if k < 3 { goto again }
    printf("k = %ld\n", k)
}
```

```text
k = 3
```

## What the processor does

A loop is a comparison and a branch backwards. The translator puts the condition check **at the end**
of the loop: that way each repetition executes only one branch. For example,
`while i <= 100 { sum += i; i++ }`:

```asm
    b Lmain.next1           // first jump to the check
Lmain.body2:
    add x19, x19, x20       // sum += i
    add x20, x20, #1        // i++
Lmain.next1:
    cmp x20, #100
    b.le Lmain.body2        // while i <= 100 — back to the body
```

## A loop made of instructions

You can also build a loop out of instructions — a label, a body, a branch back. Or you can mix them:
a sugar loop with instructions inside.

```hla
extern printf(fmt, ...)

fn main() {
    let sum = 0
    let i = 100
again:
    add sum, sum, i              // the body is an instruction
    subs i, i, #1                // i -= 1 and set the flags right away
    b.ne again                   // until i becomes zero — go back
    printf("1 + ... + 100 = %ld\n", sum)

    for k in 1..=3 {             // a sugar loop…
        lsl x9, k, #4            // …with an instruction inside: x9 = k * 16
        printf("%ld * 16 = %ld\n", k, x9)
    }
}
```

```text
1 + ... + 100 = 5050
1 * 16 = 16
2 * 16 = 32
3 * 16 = 48
```

`subs` is a `sub` that also sets the flags, like `cmp`. So a separate comparison isn't needed:
a counter going down to zero takes two instructions per repetition instead of three.

## Exercises

1. Print all even numbers from 2 to 20 in three ways: `while`, `for … in` with `step`, and `for … in` with `continue`.
2. Find the sum of the digits of 987654321.
3. Draw a triangle of asterisks of height 5 (row number k has k asterisks).
4. Compute 2¹⁰ with a loop made of instructions: `lsl` for doubling, `subs` and `b.ne` for the counter.

<details>
<summary>Solution to exercise 3</summary>

```hla
extern printf(fmt, ...)

fn main() {
    for k in 1..=5 {
        for s in 0..k { printf("*") }
        printf("\n")
    }
}
```

```text
*
**
***
****
*****
```

</details>

Next: [Lesson 6. Functions](06-functions.md)
