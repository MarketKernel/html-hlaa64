# Lesson 7. Data and arrays

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/07-data-and-arrays.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

There are only about thirty registers, but gigabytes of memory. Everything that doesn't fit in
registers (tables, texts, large arrays) is stored in **memory**. Memory is a long tape of bytes,
and every byte has a number — its **address**.

## Global variables

`data` declares a variable in the program's memory. It exists for the whole time the program runs
and is visible from all functions.

```hla
extern printf(fmt, ...)

data counter: i64 = 0

fn tick() {
    counter += 1
}

fn main() {
    tick()
    tick()
    tick()
    printf("counter = %ld\n", counter)
}
```

```text
counter = 3
```

`counter += 1` looks like working with a register, but the translator does three steps: it loads
the value from memory into a register, adds one and writes it back.

## Data types

A variable in memory has a type — how many bytes it takes and whether it is signed:

| type | bytes | range |
|---|---|---|
| `i8` / `u8` | 1 | −128…127 / 0…255 |
| `i16` / `u16` | 2 | −32 768…32 767 / 0…65 535 |
| `i32` / `u32` | 4 | ±2.1 billion / 0…4.2 billion |
| `i64` / `u64` | 8 | ±9.2·10¹⁸ / 0…1.8·10¹⁹ |
| `ptr` | 8 | address |
| `f32` / `f64` | 4 / 8 | fractional numbers (lesson 11) |

`i` means signed (integer), `u` means unsigned, and the number is the number of bits.

```hla
extern printf(fmt, ...)

data small: u8 = 200
data temp: i8 = -40

fn main() {
    printf("small = %ld, temp = %ld\n", small, temp)
    small += 100                 // 300 doesn't fit in a byte: 300 - 256 = 44 remains
    printf("small = %ld\n", small)
}
```

```text
small = 200, temp = -40
small = 44
```

## Arrays

An array is several values of the same type in a row. The type is written as `type[count]`, and
elements are numbered from zero.

```hla
extern printf(fmt, ...)

data scores: i32[5] = [72, 95, 64, 88, 79]

fn main() {
    printf("first: %ld, last: %ld\n", scores[0], scores[4])
    scores[2] = 70                         // corrected a score
    let sum = 0
    for i in 0..len(scores) {              // len(scores) = 5
        sum += scores[i]
    }
    printf("sum: %ld, average: %ld\n", sum, sum / len(scores))
}
```

```text
first: 72, last: 79
sum: 404, average: 80
```

- `len(array)` is the number of elements, `sizeof(array)` is the size in bytes (here 5 · 4 = 20).
  Both are computed at translation time.
- If there are fewer elements in `[ ]` than the array size, the rest will be zeros.
- An array without values (`data buffer: u8[1000]`) is entirely filled with zeros and takes no space in the program file.

**Important:** the processor doesn't check for going past the end of an array. `scores[10] = 1`
will write the number somewhere into neighboring memory. If the index is a constant, the translator
will warn you, but in a loop you have to watch the bounds yourself.

## Finding the maximum and sorting

```hla
extern printf(fmt, ...)

const N = 8
data values: i64[N] = [34, -2, 71, 0, 15, 71, -40, 8]

fn print_values() {
    for i in 0..N {
        printf("%ld ", values[i])
    }
    printf("\n")
}

fn main() {
    let best = values[0]
    let where = 0
    for i in 1..N {
        if values[i] > best {
            best = values[i]
            where = i
        }
    }
    printf("maximum %ld at position %ld\n", best, where)

    // bubble sort: swap neighbors that are in the wrong order
    for pass in 0..N - 1 {
        for i in 0..N - 1 - pass {
            if values[i] > values[i + 1] {
                let t = values[i]
                values[i] = values[i + 1]
                values[i + 1] = t
            }
        }
    }
    print_values()
}
```

```text
maximum 71 at position 2
-40 -2 0 8 15 34 71 71 
```

## Strings

A string is an array of bytes (`u8`) with a zero at the end, which library functions use to tell
where it ends. In `printf`, a string is printed with `%s`.

```hla
extern printf(fmt, ...)

data name = "Ada Lovelace"

fn main() {
    printf("name: %s, length: %ld\n", name, len(name))   // len doesn't count the terminating zero
    printf("first letter: %c\n", name[0])
    // to upper case: lowercase Latin letters have codes 'a'..'z', the difference from capitals is 32
    for i in 0..len(name) {
        if name[i] >= 'a' && name[i] <= 'z' {
            name[i] = name[i] - 32
        }
    }
    printf("%s\n", name)
}
```

```text
name: Ada Lovelace, length: 12
first letter: A
ADA LOVELACE
```

The `len` of a string is the number of **bytes** without the terminating zero. For Latin text this
is the same as the number of letters, but a Cyrillic letter takes 2 bytes in UTF-8: `len("кот")` is 6.

When an array (or a string) is used as a value — for example, passed to `printf` — its **address**
is passed, not its contents.

## Read-only data

`rodata` is the same as `data`, but it can't be changed: the translator won't let you write to it,
and the processor keeps such data in write-protected memory. It's a good fit for tables and texts.

```hla
extern printf(fmt, ...)

rodata days_in_month: u8[12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
rodata month_names: ptr = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"]

fn main() {
    let total = 0
    for m in 0..12 {
        total += days_in_month[m]
    }
    printf("days in a year: %ld\n", total)
    x9 = month_names[9]                        // address of the tenth string
    printf("the tenth month is %s, it has %ld days\n", x9, days_in_month[9])
}
```

```text
days in a year: 365
the tenth month is October, it has 31 days
```

`month_names` is an array of string **addresses** (type `ptr`). Each string lies in memory
separately, and the array holds only its address.

## Example: a histogram

```hla
extern printf(fmt, ...)

rodata rolls: u8[20] = [3, 6, 1, 3, 4, 6, 2, 3, 5, 3, 6, 1, 4, 3, 2, 6, 3, 5, 4, 3]
data counts: i64[7]          // counters for values 1..6 (index zero is unused)

fn main() {
    for i in 0..len(rolls) {
        x9 = rolls[i]
        counts[x9] += 1
    }
    for face in 1..=6 {
        printf("%ld: ", face)
        for k in 0..counts[face] { printf("#") }
        printf(" (%ld)\n", counts[face])
    }
}
```

```text
1: ## (2)
2: ## (2)
3: ####### (7)
4: ### (3)
5: ## (2)
6: #### (4)
```

## What the processor does

To read `scores[i]`, the processor needs an address: the address of the start of the array plus
`i · 4` (the elements are 4 bytes each). First two instructions get the address of the array, then
a single load instruction multiplies the index by 4 itself (with the `lsl #2` shift) and adds it:

```asm
    adrp x17, _scores@PAGE                 // the memory page where the array lies
    add x17, x17, _scores@PAGEOFF          // + offset within the page = address of scores
    ldrsw x16, [x17, x20, lsl #2]          // x16 = 32-bit number at address x17 + i*4
```

`ldrsw` means "load a signed 32-bit word and extend it to 64 bits".

## Exercises

1. Count how many negative numbers there are in an array.
2. Reverse an array (the first element is swapped with the last, and so on).
3. Count the vowels `a e i o u` in the string `"programming in assembly"`.

<details>
<summary>Solution to exercise 2</summary>

```hla
extern printf(fmt, ...)

data a: i64[7] = [1, 2, 3, 4, 5, 6, 7]

fn main() {
    let i = 0
    let j = len(a) - 1
    while i < j {
        let t = a[i]
        a[i] = a[j]
        a[j] = t
        i++
        j--
    }
    for k in 0..len(a) { printf("%ld ", a[k]) }
    printf("\n")
}
```

```text
7 6 5 4 3 2 1 
```

</details>

Next: [Lesson 8. Memory and pointers](08-memory-and-pointers.md)
