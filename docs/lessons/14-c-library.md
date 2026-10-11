# Lesson 14. A library for C (and C for HLA64)

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/14-c-library.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

C and HLA64 programs follow the same **calling convention** (lesson 6 and the cheat sheet
in lesson 12): arguments in `x0 … x7` and `d0 … d7`, the result in `x0` or `d0`, registers `x19 … x28`
are preserved. So a function written in HLA64 is a perfectly ordinary function for C, and vice versa.
All that's left is to tell the C compiler what these functions are and to build everything together.

In this lesson we will:

1. write a library of math functions in HLA64 and call it from a C program — with static
   and with dynamic linking;
2. do the reverse: an HLA64 program will call functions written in C.

This lesson has to be done on a Mac: the C part needs the `clang` compiler (the command
`xcode-select --install` installs it along with the command-line tools). All the lesson's files are in
the [`14-library`](14-library/) folder, and [`build.sh`](14-library/build.sh) builds and runs everything at once.

To keep the commands short, create an alias in the terminal (from the project root):

```sh
alias hla="node $PWD/src/cli.ts"
```

## How it works

A C program is built from several **object files** (`.o`): the compiler translates each source
file into machine code, but it doesn't know the addresses of other files' functions yet, so it leaves
notes in the code — **relocations** ("put the address of `_gcd` here"). Then the **linker** (`ld`)
glues the object files and libraries into a program and fills in all the notes.

HLA64's built-in assembler can produce the same kind of object files, and from them, two kinds of
libraries:

| kind | file | how it's linked |
|---|---|---|
| static | `libmathlib.a` | the library code is **copied** into the program at build time |
| dynamic | `libmathlib.dylib` | the program only stores a reference, and the code is loaded at startup |

The C compiler also needs a **header**, `mathlib.h`: it records which functions exist, what their
parameters are and what they return. HLA64 generates it by itself.

## Step 1. What to export

By default, the functions and data of an HLA64 program are visible only inside it. The `export`
keyword makes them available from outside:

| HLA64 | in the C header |
|---|---|
| `export fn gcd(a: i64, b: i64) -> i64` | `int64_t gcd(int64_t a, int64_t b);` |
| `export data call_count: i64 = 0` | `extern int64_t call_count;` |
| `export struct Vec2 { x: f64, y: f64 }` | `typedef struct Vec2 { double x; double y; } Vec2;` |
| `export enum Shape { Circle, Square }` | `enum Shape { Shape_Circle = 0, Shape_Square = 1 };` |
| `export const VERSION = 3` | `#define VERSION 3` |

The C compiler cares about **types**, so it's worth specifying them for the parameters of exported
functions — after the colon, where you used to write a register:

| HLA64 type | C type | where it arrives |
|---|---|---|
| `i64`, `u64` | `int64_t`, `uint64_t` (`long`) | an `x` register |
| `i32`, `u32` | `int32_t`, `uint32_t` (`int`) | the low 32 bits of an `x` register |
| `i16`, `u16`, `i8`, `u8` | `int16_t` … `uint8_t` (`short`, `char`) | the low bits |
| `ptr` | `void *` (any pointer, strings, arrays) | an `x` register |
| `f64`, `f32` | `double`, `float` | a `d`/`s` register |

The result type goes after the arrow: `-> i64`, `-> i32`, `-> f64`, `-> ptr`. If there's no arrow but
the function returns a value, the header will say `int64_t`; if it doesn't return anything, `void`.

**Why types matter.** When C passes an `int` (32 bits), it puts the number only in the lower half of
the register, and the upper 32 bits may contain anything. For a parameter `v: i32`, HLA64 **extends**
it to a proper 64-bit value on entry to the function (with the `sxtw` instruction), and from then on
you can work with it as usual. Without a type (`v` or `v: x0`), garbage in the upper bits would break
comparisons.

Here is the whole library:

```hla file=mathlib.hla
// mathlib.hla — a small library written in HLA64 and called from C

export const MATHLIB_VERSION = 3

export struct Vec2 {
    x: f64
    y: f64
}

export enum Shape { Circle, Square, Triangle }

// a global variable that C can read and write
export data call_count: i64 = 0

// greatest common divisor of two 64-bit numbers
export fn gcd(a: i64, b: i64) -> i64 {
    call_count++
    while b != 0 {
        let r: x9 = a % b
        a = b
        b = r
    }
    return a
}

// C `int` arguments arrive in the low 32 bits; the i32 type extends them correctly
export fn clamp(v: i32, lo: i32, hi: i32) -> i32 {
    call_count++
    return v < lo ? lo : (v > hi ? hi : v)
}

// strings: count the occurrences of a character in a C string
export fn count_char(s: ptr, ch: u8) -> i64 {
    call_count++
    let n: x9 = 0
    loop {
        w10 = u8[s++]
        if w10 == 0 { break }
        if w10 == ch { n++ }
    }
    return n
}

// arrays: sum of `count` int64_t values
export fn sum_i64(values: ptr, count: i64) -> i64 {
    call_count++
    let total: x9 = 0
    for i: x10 in 0..count {
        total += i64[values + i * 8]
    }
    return total
}

// structs: the length of a Vec2 passed by pointer
export fn vec2_length(v: ptr) -> f64 {
    call_count++
    d0 = f64[v + Vec2.x]
    d1 = f64[v + Vec2.y]
    return sqrt(d0 * d0 + d1 * d1)
}

// callbacks: replace every element with f(element), where f is a C function
export fn map_i64(values: ptr, count: i64, f: ptr) {
    call_count++
    let p = values               // callee-saved copies: f() may clobber x0..x17
    let n = count
    let func = f
    for i in 0..n {
        let r = func(i64[p + i * 8])
        i64[p + i * 8] = r
    }
}

// an area by shape kind, using the exported enum
export fn area(kind: i32, size: f64) -> f64 {
    call_count++
    if kind == Shape.Circle { return 3.141592653589793 * size * size }
    if kind == Shape.Square { return size * size }
    return size * size * 0.4330127018922193      // equilateral triangle: sqrt(3)/4
}
```

Things to note:

- `call_count` is a shared variable: the HLA64 functions increment it, and C can read it and even
  change it.
- `map_i64` receives a **pointer to a C function** and calls it for each element: `func(...)`.
  The parameters are immediately copied into "long-lived" variables (`let p = values`), because the
  call to `func` is allowed to clobber `x0 … x17`.
- `vec2_length` reads the struct fields at the offsets `Vec2.x` and `Vec2.y`. Struct layout in HLA64
  and in C is the same (natural alignment, lesson 9), and the header additionally checks this
  with `_Static_assert`.
- There is no `main` function in the library — it will be in the C program.

## Step 2. Build the library

```sh
cd docs/lessons/14-library
hla lib mathlib.hla
```

The command creates four files: `mathlib.h` (the header), `mathlib.o` (the object file),
`libmathlib.a` (the static library) and `libmathlib.dylib` (the dynamic one). Here's the header:

```c file=mathlib.h
// mathlib.h — generated by HLA64 from mathlib.hla. Do not edit.
#ifndef MATHLIB_H
#define MATHLIB_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MATHLIB_VERSION 3
typedef struct Vec2 {
    double x;   // offset 0
    double y;   // offset 8
} Vec2;
_Static_assert(sizeof(Vec2) == 16, "Vec2: layout differs from HLA64");

enum Shape {
    Shape_Circle = 0,
    Shape_Square = 1,
    Shape_Triangle = 2,
    Shape_count = 3
};

extern int64_t call_count;

int64_t gcd(int64_t a, int64_t b);
int32_t clamp(int32_t v, int32_t lo, int32_t hi);
int64_t count_char(void *s, uint8_t ch);
int64_t sum_i64(void *values, int64_t count);
double vec2_length(void *v);
void map_i64(void *values, int64_t count, void *f);
double area(int32_t kind, double size);

#ifdef __cplusplus
}
#endif

#endif // MATHLIB_H
```

`extern "C"` is needed so that the library can also be used from C++.

## Step 3. The C program

```c file=main.c
// main.c — a C program that uses the HLA64 library
#include <stdio.h>
#include "mathlib.h"

static int64_t square(int64_t x) { return x * x; }

int main(void) {
    printf("mathlib version %d\n", MATHLIB_VERSION);
    printf("gcd(1071, 462) = %lld\n", gcd(1071, 462));
    printf("clamp(150, 0, 100) = %d, clamp(-5, 0, 100) = %d\n", clamp(150, 0, 100), clamp(-5, 0, 100));
    printf("count_char(\"hello, world\", 'o') = %lld\n", count_char("hello, world", 'o'));

    int64_t v[] = {1, 2, 3, 4, 5};
    printf("sum_i64 = %lld\n", sum_i64(v, 5));
    map_i64(v, 5, (void *)square);
    printf("after map_i64(square):");
    for (int i = 0; i < 5; i++) printf(" %lld", v[i]);
    printf("\n");

    Vec2 p = {3.0, 4.0};
    printf("vec2_length({3, 4}) = %.1f\n", vec2_length(&p));
    printf("area(Shape_Square, 2) = %.2f, area(Shape_Circle, 1) = %.5f\n",
           area(Shape_Square, 2.0), area(Shape_Circle, 1.0));

    printf("functions called: %lld\n", call_count);
    call_count = 0;                       // C can write the HLA64 variable too
    gcd(10, 4);
    printf("after reset: %lld\n", call_count);
    return 0;
}
```

`(void *)square` is the address of a C function, which we pass to `map_i64`.

**Static build** — the library code becomes part of the program:

```sh
clang -Wall main.c libmathlib.a -o demo_static
./demo_static
```

```text
mathlib version 3
gcd(1071, 462) = 21
clamp(150, 0, 100) = 100, clamp(-5, 0, 100) = 0
count_char("hello, world", 'o') = 2
sum_i64 = 15
after map_i64(square): 1 4 9 16 25
vec2_length({3, 4}) = 5.0
area(Shape_Square, 2) = 4.00, area(Shape_Circle, 1) = 3.14159
functions called: 9
after reset: 1
```

**Dynamic build** — the program only references `libmathlib.dylib`:

```sh
clang -Wall main.c -L. -lmathlib -Wl,-rpath,@executable_path -o demo_dynamic
./demo_dynamic
```

- `-L.` means look for libraries in the current folder, `-lmathlib` means link `libmathlib.dylib`
  (the compiler adds the `lib` prefix and the extension by itself).
- The library has its name, `@rpath/libmathlib.dylib`, recorded inside it. `-Wl,-rpath,@executable_path`
  says: "`@rpath` is the folder where the program itself is". So `demo_dynamic` and `libmathlib.dylib`
  must be next to each other.

You can see which libraries a program depends on with `otool -L demo_dynamic`:

```text
demo_dynamic:
	@rpath/libmathlib.dylib (compatibility version 1.0.0, current version 1.0.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1359.0.0)
```

If you rebuild `libmathlib.dylib` (say, to fix a bug in `gcd`), `demo_dynamic` immediately starts
using the new version without being rebuilt. The static program needs a new build for that.

## Step 4. The reverse: HLA64 calls C

C functions are linked the same way as functions from the system library — via `extern`:

```c file=helpers.c
// helpers.c — C functions called from an HLA64 program
#include <stdint.h>
#include <stdio.h>

int64_t c_fib(int64_t n) {
    return n < 2 ? n : c_fib(n - 1) + c_fib(n - 2);
}

void c_greet(const char *name) {
    printf("Hello from C, %s!\n", name);
}

double c_average(const double *values, int64_t count) {
    double sum = 0;
    for (int64_t i = 0; i < count; i++) sum += values[i];
    return count ? sum / count : 0;
}
```

```hla file=app.hla
// app.hla — an HLA64 program that calls functions written in C
extern printf(fmt, ...)
extern c_fib, c_greet, c_average

data samples: f64[4] = [2.5, 3.5, 4.0, 6.0]

fn main() {
    c_greet("HLA64")
    printf("c_fib(20) = %ld\n", c_fib(20))
    d8 = c_average(samples, len(samples))      // a double comes back in d0
    printf("c_average = %.2f\n", d8)
}
```

The HLA64 program is built into an object file with the `hla obj` command, and `clang` compiles the
C file and links both together:

```sh
hla obj app.hla                  # -> app.o
clang app.o helpers.c -o app
./app
```

```text
Hello from C, HLA64!
c_fib(20) = 6765
c_average = 4.00
```

`c_average` returns a `double`, so the result arrives in `d0` (lesson 11), and we immediately move
it into the callee-saved `d8` — the next `printf` would clobber `d0`.

## All at once: build.sh

```sh file=build.sh
#!/bin/sh
# Lesson 14: build and run both examples. Run it from this directory: sh build.sh
set -e
HLA=${HLA:-"node ../../../src/cli.ts"}

# 1. an HLA64 library used from C
$HLA lib mathlib.hla                 # -> mathlib.h, mathlib.o, libmathlib.a, libmathlib.dylib
clang -Wall main.c libmathlib.a -o demo_static
clang -Wall main.c -L. -lmathlib -Wl,-rpath,@executable_path -o demo_dynamic
./demo_static
./demo_dynamic | tail -1

# 2. an HLA64 program that calls C
$HLA obj app.hla                     # -> app.o
clang app.o helpers.c -o app
./app
```

Run `sh build.sh` in the lesson folder — it builds both parts and runs the programs.

## The same in the browser

On the `dist/hla64.html` page, choose the example **Library for C: mathlib (lesson 14)** and set the
**Build as** switch to **Static lib .a** or **Dynamic lib .dylib**:

- the **C header** tab shows the generated `mathlib.h`, an example `main.c` and the build command;
- the **Mach-O** tab shows the library's contents: for `.a` — the object file, the exports and the
  number of relocations, for `.dylib` — the segments, the export table and the signature;
- **Download .zip** gives you a folder with `mathlib.h`, the library, `main.c` and `build.sh`;
- **Copy Terminal command** copies a command that creates this folder in the terminal, builds `main.c`
  with `clang` and runs the program — no download and no quarantine flag.

The build mode can be switched for any example or for your own code: functions marked `export` go into
the library and the header.

## What's inside an object file

An object file is the same Mach-O as a program, just with notes for the linker. You can
examine it with the standard macOS tools:

```sh
nm mathlib.o            # symbols: T — code, D — data, s — internal
otool -rv mathlib.o     # relocations
```

```text
00000000000001b4 T _area
0000000000000220 D _call_count
0000000000000038 T _clamp
0000000000000000 T _gcd
...
address  pcrel length extern type    scattered symbolnum/value
000001cc False long   True   PAGOF12 False     _call_count
...
```

- Branches within a single function (loops, `if`) are resolved by the assembler itself — the distance
  between instructions won't change during linking.
- `adrp`/`add`/`ldr` accessing data get `PAGE21` and `PAGEOFF12` relocations: the final address of
  `_call_count` will only be known to the linker.
- Calls to external functions (`bl _printf`) get a `BR26` relocation.

Instead of relocations, a dynamic library has an **export table**, which the `dyld` loader uses to
find functions when the program starts: `dyld_info -exports libmathlib.dylib`.

## Exercises

1. Add a function `export fn is_prime(n: i64) -> i32` to the library and call it from C in a loop
   from 1 to 50.
2. Export a `rodata` table of squares `squares: i64[10]` and print it from C.
3. Write a C function `int64_t c_max(int64_t a, int64_t b)` and use it from HLA64 to find
   the maximum in an array.
4. Use `hla compile mathlib.hla` to see what the parameter `v: i32` of the `clamp` function turned into
   (look for the `sxtw` instruction).

Next: the [course summary](13-project-game-of-life.md#course-summary) and the [language reference](../language.md).
