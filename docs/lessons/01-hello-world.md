# Lesson 1. Hello, world

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/01-hello-world.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

By tradition, the first program prints a greeting. Here it is in full:

```hla
extern puts

fn main() {
    puts("Hello, world!")
}
```

```text
Hello, world!
```

Let's go through it line by line.

- `extern puts` — we tell the translator: "there is an external function `puts`, someone wrote it
  before us". It lives in the macOS system library (libSystem) and prints a string followed by a newline.
  Everything we take from a library has to be declared with `extern`.
- `fn main() { ... }` — declares a function named `main`. Every program starts executing from it.
  The function body is written inside curly braces.
- `puts("Hello, world!")` — a call to the function `puts` with one argument — a string in quotes.

When `main` finishes, the program exits with code 0 ("all good").

> **HLA64 is an assembler.** Lines like `puts("Hello, world!")` are syntactic sugar: the translator
> expands each one into several processor instructions. But the instructions themselves haven't gone
> anywhere: any of them can be written right in the program, next to the sugar. How — at the end of this
> lesson.

## Comments

Everything after `//` to the end of the line is a comment; the translator skips it. A long comment can
be wrapped in `/* ... */`.

```hla
extern puts

/* A program that
   says hello twice */
fn main() {
    puts("Grüß dich!")   // non-English letters work too
    puts("Hello again")  // each string is printed on a new line
}
```

```text
Grüß dich!
Hello again
```

You don't need a semicolon at the end of a line: a statement ends together with the line. If you really
want to put two statements on one line, separate them with `;`:

```hla
extern puts

fn main() {
    puts("one"); puts("two")
}
```

```text
one
two
```

## Special characters in strings

Inside quotes, a backslash `\` starts a special character:

| notation | meaning |
|---|---|
| `\n` | newline |
| `\t` | tab |
| `\"` | double quote |
| `\\` | the backslash itself |

```hla
extern puts

fn main() {
    puts("line 1\nline 2")
    puts("name:\t\"HLA64\"")
}
```

```text
line 1
line 2
name:	"HLA64"
```

## What it turned into

The translator converted our program into assembly. You can view it with the command
`node src/cli.ts compile hello.hla` or on the **Assembly** tab in the browser. For the first example
you get this (without the housekeeping lines):

```asm
_main:
    stp x29, x30, [sp, #-16]!       // save two special registers on the stack
    mov x29, sp                     // mark the start of the function's "frame"
    adrp x0, Lstr.0@PAGE            // x0 = address of the string (in two steps:
    add x0, x0, Lstr.0@PAGEOFF      //   memory page + offset within it)
    bl _puts                        // call puts
    mov w0, #0                      // return code 0
    ldp x29, x30, [sp], #16         // restore the special registers
    ret                             // return

Lstr.0:
    .asciz "Hello, world!"          // the string itself, with a zero at the end
```

The main rule is already visible: **a function argument is passed in register `x0`**. The string lives
in memory, and `x0` receives its address. What registers are — in the next lesson. The `stp`/`ldp`/`ret`
lines are the function's prologue and epilogue: HLA64 writes them for you.

## You can write instructions yourself

The three middle lines of the listing — `adrp`, `add`, `bl` — are the call to `puts`. You can write them
in the program by hand: a line that doesn't look like an HLA64 construct is treated as a processor
instruction and goes into the output as is.

```hla
extern puts

rodata hello = "Hello from instructions!"

fn main() {
    puts("Hello from sugar!")    // sugar: one line
    adrp x0, hello@PAGE          // instructions: x0 = address of the string hello
    add x0, x0, hello@PAGEOFF
    bl puts                      // call puts
}
```

```text
Hello from sugar!
Hello from instructions!
```

- `rodata hello = "..."` places the string in the program's memory and gives it a name (more on this
  in lesson 7).
- `adrp` and `add` compute the address of the string from its name; `bl` ("branch with link") calls a
  function. The translator turns the names `hello` and `puts` into `_hello` and `_puts` by itself, as
  macOS requires.
- In the listing both halves of the program look the same: the sugar expanded into exactly the same
  instructions that we wrote by hand.

This is how all of HLA64 works: where the instruction is obvious and boring, you write sugar; where you
need a specific instruction, you write it. In the following lessons, every new construct will be shown
along with what it turns into and how to write the same thing with instructions.

On Windows the instructions are different — the x86-64 processor has its own instruction set
(`lea rcx, [hello]`, `call puts`); the sugar, however, is the same on both platforms.

## Exercises

1. Print your name and city on two lines with a single `puts` call.
2. Print a three-line box: `+-----+`, `| Hi! |`, `+-----+`.
3. Print the same box, calling `puts` with the `adrp`/`add`/`bl` instructions for each line.

<details>
<summary>Solution to exercise 2</summary>

```hla
extern puts

fn main() {
    puts("+-----+")
    puts("| Hi! |")
    puts("+-----+")
}
```

```text
+-----+
| Hi! |
+-----+
```

</details>

Next: [Lesson 2. Registers and variables](02-registers-and-variables.md)
