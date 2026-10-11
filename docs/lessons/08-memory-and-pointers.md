# Lesson 8. Memory and pointers

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/08-memory-and-pointers.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

## Address

Every byte of memory has a number — its address. You can get the address of a variable with the
`&` operator:

```hla
extern printf(fmt, ...)

data numbers: i64[3] = [10, 20, 30]

fn main() {
    let p = &numbers                       // address of the start of the array
    let q = &numbers[2]                    // address of the third element
    printf("from the start to numbers[2]: %ld bytes\n", q - p)
}
```

```text
from the start to numbers[2]: 16 bytes
```

An address is an ordinary 64-bit number: you can keep it in a register, add to it and subtract
from it. A variable that holds an address is called a **pointer**. `i64` elements take 8 bytes
each, so `numbers[2]` starts 16 bytes after the beginning.

## Reading and writing at an address

Square brackets mean "the memory at this address". The type is written before the brackets — how
many bytes to read and how to interpret them:

```hla
extern printf(fmt, ...)

data numbers: i64[3] = [10, 20, 30]

fn main() {
    let p = &numbers
    printf("%ld %ld %ld\n", i64[p], i64[p + 8], i64[p + 16])
    i64[p + 8] = 99                        // write 99 into the second element
    printf("numbers[1] = %ld\n", numbers[1])
}
```

```text
10 20 30
numbers[1] = 99
```

The types are the same as for data: `u8 i8 u16 i16 u32 i32 u64 i64 ptr f32 f64`. Without a type
(`[p]`) the size is taken from the register: `x9 = [p]` reads 8 bytes, `w9 = [p]` reads 4.

**Note:** inside square brackets you count **bytes**. An array index `numbers[i]` is multiplied by
the element size automatically, but in `i64[p + i * 8]` you have to multiply yourself.

## An array as a function parameter

You can't pass a whole array to a function, but you can pass its address and length:

```hla
extern printf(fmt, ...)

data a: i64[5] = [3, 1, 4, 1, 5]
data b: i64[3] = [100, 200, 300]

fn sum(arr, count) {
    let total: x9 = 0
    for i: x10 in 0..count {
        total += i64[arr + i * 8]           // element number i
    }
    return total
}

fn main() {
    printf("sum(a) = %ld\n", sum(a, len(a)))
    printf("sum(b) = %ld\n", sum(b, len(b)))
}
```

```text
sum(a) = 14
sum(b) = 600
```

`sum` doesn't call any other functions, so the parameters can stay in `x0`, `x1`, and the variables
can live in the temporary `x9`, `x10`.

## Walking a string with a pointer

A string ends with a zero byte. To count its length, we move a pointer until we hit the zero.
`u8[p++]` reads the byte at address `p` and **after that** increases `p` by the element size (here 1):

```hla
extern printf(fmt, ...)

fn my_strlen(s) {
    let p: x9 = s
    loop {
        w10 = u8[p++]
        if w10 == 0 { break }
    }
    return p - s - 1          // p went one byte past the zero
}

fn count_char(s, ch) {
    let n: x9 = 0
    loop {
        w10 = u8[s++]         // a pointer parameter can be moved too
        if w10 == 0 { break }
        if w10 == ch { n++ }
    }
    return n
}

fn main() {
    let text = "hello, world"
    printf("length: %ld\n", my_strlen(text))
    printf("letters 'o': %ld\n", count_char(text, 'o'))
}
```

```text
length: 12
letters 'o': 2
```

`let text = "hello, world"` puts the string's **address** into the variable — the string itself
lies in the program's memory.

Post-increment is a single processor instruction: `ldrb w10, [x9], #1` ("load the byte at address
x9, then add one to x9").

You can also write load and store instructions yourself — for example, when you need a specific
addressing mode. Here sugar checks the conditions, while the `ldrb` and `strb` instructions read
and write memory:

```hla
extern printf(fmt, ...)

data text = "hello, world"

fn upcase(s) {                   // lowercase Latin letters -> capitals, in place
    loop {
        ldrb w10, [s]            // read the byte at address s
        if w10 == 0 { break }
        if w10 >= 'a' && w10 <= 'z' {
            sub w10, w10, #32    // 'a' - 'A' = 32
        }
        strb w10, [s], #1        // write the byte and move s by 1
    }
}

fn main() {
    upcase(text)
    printf("%s\n", text)
}
```

```text
HELLO, WORLD
```

`[s]` means "at the address in register s", `[s], #1` means the same, and after the access add one
to `s`. There are other forms too: `[s, #8]` is the address `s + 8`, `[s, x9]` is the address `s + x9`.

## Copying and filling memory

```hla
extern printf(fmt, ...)

data src: i32[6] = [1, 2, 3, 4, 5, 6]
data dst: i32[6]

fn copy_i32(to, from, count) {
    for i: x9 in 0..count {
        w10 = i32[from + i * 4]
        i32[to + i * 4] = w10
    }
}

fn fill_i32(to, count, value) {
    for i: x9 in 0..count {
        i32[to + i * 4] = value
    }
}

fn main() {
    copy_i32(dst, src, 6)
    fill_i32(&dst[4], 2, -1)                // overwrite the last two
    for i in 0..6 { printf("%ld ", dst[i]) }
    printf("\n")
}
```

```text
1 2 3 4 -1 -1 
```

## Local buffers on the stack

`data` is global memory. Sometimes a buffer is needed only while a function runs. That's what
`local` is for: the space is allocated on the **stack** when the function is entered and freed
when it exits.

An example is converting a number to a string. The digits come out from the end (as remainders of
division by 10), so we fill the buffer from right to left:

```hla
extern puts

fn print_number(value: auto) {
    local buf: u8[24]
    let p = &buf[23]
    u8[p] = 0                       // end of the string
    let negative = value < 0
    if negative { value = -value }
    do {
        p--
        u8[p] = value % 10 + '0'    // digit as a character: '0' + d
        value /= 10
    } while value != 0
    if negative {
        p--
        u8[p] = '-'
    }
    puts(p)
}

fn main() {
    print_number(2026)
    print_number(-417)
    print_number(0)
}
```

```text
2026
-417
0
```

A single variable can be local too: `local total: i64` lives in stack memory, but you work with it
like an ordinary variable (`total = x0`, `total += 5`).

The **stack** is a memory area that grows downward. Each called function occupies its own section
of it (a stack frame), which holds saved registers and local buffers. When the function returns,
its frame is freed. That's why **you must not return the address of a local buffer** — after
`return`, that memory will be used by the next function that is called.

## Exercises

1. Write `reverse_string(s)`, which reverses a string in place (use two pointers: one to the start
   and one to the end).
2. Write `index_of(arr, count, value)` — the index of the first element of an `i64` array equal to `value`, or −1.

<details>
<summary>Solution to exercise 1</summary>

```hla
extern printf(fmt, ...)

data word = "assembly"

fn reverse_string(s) {
    let end: x9 = s
    while u8[end] != 0 { end++ }      // find the end
    end--                             // the last character
    while s < end {
        w10 = u8[s]
        w11 = u8[end]
        u8[s] = w11
        u8[end] = w10
        s++
        end--
    }
}

fn main() {
    reverse_string(word)
    printf("%s\n", word)
}
```

```text
ylbmessa
```

</details>

Next: [Lesson 9. Structs and enums](09-structs-and-enums.md)
