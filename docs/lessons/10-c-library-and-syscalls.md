# Lesson 10. The C library and the system

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/10-c-library-and-syscalls.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

macOS ships with **libSystem** — a library with thousands of ready-made C functions: printing,
strings, memory, math, sorting. HLA64 calls them directly, following the same rules as its own
functions: arguments in `x0 … x7`, the result in `x0`.

## Declaring them: `extern`

```hla
extern puts, putchar, strlen          // several, separated by commas
extern printf(fmt, ...)               // a function with a variable number of arguments
```

The ellipsis is required for functions like `printf` whose number of arguments isn't fixed:
on Apple ARM64 such arguments are passed on the stack rather than in registers, and the translator needs to know that.
The required parameters are listed before `...` (their names don't matter).

## More on `printf`

| format | what it prints | example |
|---|---|---|
| `%ld` | 64-bit signed integer | `-42` |
| `%lu` | 64-bit unsigned | `18446744073709551615` |
| `%d` | 32-bit integer (`w` registers, `i32`) | `7` |
| `%lx`, `%lX` | hexadecimal | `ff`, `FF` |
| `%c` | character by its code | `A` |
| `%s` | string at an address | `hello` |
| `%f`, `%.2f` | fractional number (lesson 11) | `3.14` |
| `%%` | percent sign | `%` |

You can set a field width between `%` and the letter:

```hla
extern printf(fmt, ...)

fn main() {
    let n = 42
    printf("[%ld] [%5ld] [%-5ld] [%05ld] [%lx] [%#lx]\n", n, n, n, n, n, n)
    printf("[%s] [%8s] [%-8s] [%c%c%c]\n", "hi", "hi", "hi", 'a', 'b', 'c')
}
```

```text
[42] [   42] [42   ] [00042] [2a] [0x2a]
[hi] [      hi] [hi      ] [abc]
```

## Working with strings

```hla
extern printf(fmt, ...)
extern strlen, strcmp, strcpy, strcat, atoi

data buffer: u8[64]

fn main() {
    strcpy(buffer, "Hello")
    strcat(buffer, ", HLA64")
    printf("%s (%ld characters)\n", buffer, strlen(buffer))

    w9 = strcmp("apple", "banana")         // < 0: the first string comes earlier alphabetically
    printf("strcmp: %s\n", w9 < 0 ? "apple comes first" : "banana comes first")

    w10 = atoi("1234")                     // text -> number
    printf("1234 + 1 = %d\n", w10 + 1)
}
```

```text
Hello, HLA64 (12 characters)
strcmp: apple comes first
1234 + 1 = 1235
```

**An important detail.** In C the `int` type is 32 bits. Functions that return `int` (`strcmp`, `atoi`,
`putchar` and many others) put the result in `w0` — the low 32 bits of `x0` — and the upper bits of
`x0` may contain anything. So store such a result in a `w` register (`w9 = strcmp(...)`)
and compare it in 32 bits. Functions that return sizes and addresses (`strlen`, `malloc`) return the full
64 bits — their result can go anywhere.

## Dynamic memory: `malloc` and `free`

`data` fixes the size of arrays in advance. If the size is only known while the program runs, you can
ask the system for memory: `malloc(n)` allocates `n` bytes and returns their address, `free(p)` gives them back.

```hla
extern printf(fmt, ...)
extern malloc, free

fn main() {
    let count = 10
    let squares = malloc(count * 8)        // 10 numbers of 8 bytes each
    if squares == 0 {
        printf("out of memory\n")
        return 1
    }
    for i in 0..count {
        i64[squares + i * 8] = i * i
    }
    for i in 0..count {
        printf("%ld ", i64[squares + i * 8])
    }
    printf("\n")
    free(squares)
}
```

```text
0 1 4 9 16 25 36 49 64 81 
```

`return 1` from `main` exits the program with code 1 — the usual way to report an error. You can see
the exit code of the last program in the terminal with `echo $?`.

## Function pointers

A function also lives in memory, and it has an address. You can put that address in a variable and
later call the function through it:

```hla
extern printf(fmt, ...)

fn add(a, b) { return a + b }
fn sub(a, b) { return a - b }
fn mul(a, b) { return a * b }

rodata ops: ptr = [&add, &sub, &mul]       // a table of function addresses
rodata names: ptr = ["+", "-", "*"]

fn main() {
    let op = add                           // a function name without parentheses is its address
    printf("op(3, 4) = %ld\n", op(3, 4))   // call through the address stored in a variable

    for i in 0..3 {
        let f = ops[i]
        let r = f(20, 5)
        printf("20 %s 5 = %ld\n", names[i], r)
    }
}
```

```text
op(3, 4) = 7
20 + 5 = 25
20 - 5 = 15
20 * 5 = 100
```

## Sorting with `qsort` and a comparison function

`qsort` from the C library sorts an array of any kind of elements. It doesn't know how to compare
the elements, so it asks you to pass a **comparison function**. `qsort` calls our function itself,
passing the addresses of two elements; the function returns a negative number, zero or a positive one.

```hla
extern printf(fmt, ...)
extern qsort

data values: i64[8] = [42, -7, 19, 3, 88, 0, -15, 61]

fn ascending(a, b) {
    x9 = [a]
    x10 = [b]
    return x9 < x10 ? -1 : (x9 > x10 ? 1 : 0)
}

fn descending(a, b) {
    x9 = [a]
    x10 = [b]
    return x9 > x10 ? -1 : (x9 < x10 ? 1 : 0)
}

fn show(title) {
    printf("%s:", title)
    for i in 0..len(values) { printf(" %ld", values[i]) }
    printf("\n")
}

fn main() {
    qsort(values, len(values), 8, ascending)       // array, count, element size, function
    show("ascending")
    qsort(values, len(values), 8, descending)
    show("descending")
}
```

```text
ascending: -15 -7 0 3 19 42 61 88
descending: 88 61 42 19 3 0 -7 -15
```

In assembly, HLA64 functions are named `_ascending`, `_descending` — following C's rules. That's why
C code can call them without any glue code.

## System calls

Beneath the library sits the operating system **kernel**. A program talks to it with the instruction
`svc #0x80` ("supervisor call"): the operation number goes in `x16`, the arguments in `x0 … x5`.
HLA64 has `syscall(number, arguments...)` for this, plus ready-made constants `SYS_write`, `SYS_exit`, `SYS_read` and others.

```hla
data message = "Hello straight from the kernel!\n"

fn main() {
    syscall(SYS_write, 1, message, len(message))   // 1 is standard output
    syscall(SYS_exit, 0)                           // exit the program with code 0
}
```

```text
Hello straight from the kernel!
```

The same program works on Linux x86-64 (`--target x64-linux`): there the instruction is `syscall`, the
number goes in `rax` and the arguments in `rdi`, `rsi`, `rdx`, and `SYS_write`, `SYS_exit` hold Linux's
numbers (1 and 60 instead of macOS's 4 and 1). Windows has no `syscall()`: programs there talk to the
system through WinAPI functions.

`write` needs the number of **bytes**. For a string, `len(message)` gives exactly the number of bytes
without the terminating zero (in UTF-8 a non-Latin letter, such as a Cyrillic one, takes 2 bytes, so a
string can have fewer characters than bytes). `sizeof(message)` is the same plus one byte for the zero.

**Be careful when mixing them.** `printf` collects output in a buffer and hands it to the kernel in chunks, while `syscall(SYS_write, ...)`
writes immediately. If you mix them, lines may come out in the wrong order. You can flush the buffer
before a system call: `extern fflush` and `fflush(0)`.

## Exercises

1. Read a number from the string `"  250"` with `atoi` and print it doubled.
2. Sort an `i32` array with `qsort` (element size 4, load with `w9 = i32[a]`).
3. Make a calculator: an array of operation characters `"+-*/"` and a table of functions; apply each one to the pair 84 and 4.

Next: [Lesson 11. Floating-point numbers](11-floating-point.md)
