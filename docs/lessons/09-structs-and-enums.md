# Lesson 9. Structs and enums

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/09-structs-and-enums.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

## Why structs

Suppose we store points on a plane: each has an `x` and a `y`. We can put them in memory in pairs:
`x` at offset 0, `y` at offset 8. Then for a point at address `p` the coordinates are `i64[p]` and
`i64[p + 8]`. It works, but you have to remember the numbers 0 and 8, and recompute them when you
add a new field.

A **struct** describes such a layout once, and the translator computes the offsets:

```hla
extern printf(fmt, ...)

struct Point {
    x: i64
    y: i64
}

fn main() {
    printf("Point.x = %ld, Point.y = %ld, size = %ld\n", Point.x, Point.y, sizeof(Point))
}
```

```text
Point.x = 0, Point.y = 8, size = 16
```

In HLA64 a struct is not a new "variable type" but a set of **offset constants**: `Point.x`,
`Point.y` and `Point.size` (the same as `sizeof(Point)`). That's exactly how structs work at the
processor level.

## An array of structs

```hla
extern printf(fmt, ...)

struct Point {
    x: i64
    y: i64
}

data points: Point[4]              // 4 points of 16 bytes each, filled with zeros

fn main() {
    for i in 0..4 {
        let p = &points[i]         // address of the i-th point: start + i * 16
        [p + Point.x] = i * 10
        [p + Point.y] = i * i
    }
    for i in 0..4 {
        let p = &points[i]
        printf("points[%ld] = (%ld, %ld)\n", i, [p + Point.x], [p + Point.y])
    }
}
```

```text
points[0] = (0, 0)
points[1] = (10, 1)
points[2] = (20, 4)
points[3] = (30, 9)
```

`[p + Point.y]` without a type reads 8 bytes — that's enough for `i64` fields. For fields of other
sizes, write the type: `i32[p + Item.qty]`, `u8[p + Item.flags]`.

## Alignment

The processor prefers an 8-byte number to lie at an address that is a multiple of 8. So the
translator **aligns** fields: there may be empty space before a field.

```hla
extern printf(fmt, ...)

struct Item {
    flags: u8          // offset 0, 1 byte
    count: i32         // offset 4  (1..3 are empty bytes)
    price: i64         // offset 8
}

fn main() {
    printf("flags=%ld count=%ld price=%ld size=%ld\n", Item.flags, Item.count, Item.price, Item.size)
}
```

```text
flags=0 count=4 price=8 size=16
```

## Functions that work with structs

A struct is passed to a function by address. Here's an example — a warehouse of products, each
with a name (a string address), a quantity and a price:

```hla
extern printf(fmt, ...)

struct Product {
    name: ptr
    qty: i32
    price: i64          // price in cents
}

data stock: Product[3]

fn set_product(p, name, qty, price) {
    [p + Product.name] = name
    i32[p + Product.qty] = qty
    [p + Product.price] = price
}

fn total_value(p) {
    w9 = i32[p + Product.qty]
    x10 = [p + Product.price]
    return x9 * x10
}

fn main() {
    set_product(&stock[0], "pencil", 120, 1550)
    set_product(&stock[1], "notebook", 40, 8900)
    set_product(&stock[2], "eraser", 75, 2000)
    let sum = 0
    for i in 0..3 {
        let p = &stock[i]
        let value = total_value(p)
        x9 = [p + Product.name]
        printf("%s: %d pcs worth %ld cents\n", x9, i32[p + Product.qty], value)
        sum += value
    }
    printf("total: %ld dollars %ld cents\n", sum / 100, sum % 100)
}
```

```text
pencil: 120 pcs worth 186000 cents
notebook: 40 pcs worth 356000 cents
eraser: 75 pcs worth 150000 cents
total: 6920 dollars 0 cents
```

`%d` prints a 32-bit number — exactly what the `qty` field is.

## Nested structs

A field can itself be a struct. The offset of a nested field is the sum of the offsets:

```hla
extern printf(fmt, ...)

struct Point { x: i64, y: i64 }
struct Rect {
    top_left: Point
    bottom_right: Point
}

data r: Rect

fn area(rect) {
    let w: x9 = [rect + Rect.bottom_right + Point.x] - [rect + Rect.top_left + Point.x]
    let h: x10 = [rect + Rect.bottom_right + Point.y] - [rect + Rect.top_left + Point.y]
    return w * h
}

fn main() {
    let p = &r
    [p + Rect.top_left + Point.x] = 2
    [p + Rect.top_left + Point.y] = 3
    [p + Rect.bottom_right + Point.x] = 12
    [p + Rect.bottom_right + Point.y] = 8
    printf("Rect size: %ld, area: %ld\n", sizeof(Rect), area(p))
}
```

```text
Rect size: 32, area: 50
```

Fields can also be listed on one line, separated by commas, as in `Point`.

## A linked list

A list element stores a value and the **address of the next element**; the last one has address
zero. To walk the list, we follow the addresses until we hit zero:

```hla
extern printf(fmt, ...)

struct Node {
    value: i64
    next: ptr
}

data nodes: Node[5]

fn main() {
    // link the elements in reverse order: 4 -> 3 -> 2 -> 1 -> 0
    for i in 0..5 {
        let n = &nodes[i]
        [n + Node.value] = (i + 1) * 100
        if i == 0 {
            [n + Node.next] = 0
        } else {
            let prev = &nodes[i - 1]
            [n + Node.next] = prev
        }
    }
    let node = &nodes[4]                 // head of the list
    while node != 0 {
        printf("%ld ", [node + Node.value])
        node = [node + Node.next]        // go to the next one
    }
    printf("\n")
}
```

```text
500 400 300 200 100 
```

## Enums

`enum` gives names to consecutive numbers — handy for states, kinds, directions:

```hla
extern printf(fmt, ...)

enum Light { Red, Yellow, Green }
enum Http { Ok = 200, NotFound = 404, Teapot = 418 }

rodata light_names: ptr = ["red", "yellow", "green"]

fn next_light(l) {
    if l == Light.Red { return Light.Green }
    if l == Light.Green { return Light.Yellow }
    return Light.Red
}

fn main() {
    let l = Light.Red
    for step in 0..4 {
        x9 = light_names[l]
        printf("%s ", x9)
        l = next_light(l)
    }
    printf("\ntotal lights: %ld, teapot code: %ld\n", Light.count, Http.Teapot)
}
```

```text
red green yellow red 
total lights: 3, teapot code: 418
```

Values go in order starting from zero; you can set your own (`Ok = 200`), and the following ones
continue from it. `Light.count` is the count (more precisely, the value after the last one).

## Exercises

1. Describe the struct `Student { age: u8, grade: i32, id: i64 }` and print the field offsets and
   the size. Explain where the empty bytes came from.
2. Make an array of 3 `Rect` rectangles and find the one with the largest area.

Next: [Lesson 10. The C library and the system](10-c-library-and-syscalls.md)
