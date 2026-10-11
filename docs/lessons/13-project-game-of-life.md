# Lesson 13. Project: the Game of Life

<!-- languages -->
<h3 align="center">
<b>🇬🇧 English</b> ·
<a href="../ru/lessons/13-project-game-of-life.md">🇷🇺 Русский</a>
</h3>
<!-- /languages -->

Let's put everything together in one program — the "Game of Life" cellular automaton invented by the
mathematician John Conway. The board is made of cells, each either alive or dead. On every step:

- a live cell with 2 or 3 live neighbours survives, otherwise it dies;
- a dead cell with exactly 3 live neighbours comes to life.

A cell has eight neighbours: horizontally, vertically and diagonally. We'll make the board "wrap
around": the right edge neighbours the left one, the bottom edge neighbours the top.

We'll need: constants (lesson 2), arithmetic with remainders (3), conditions (4), nested loops (5),
functions (6), arrays (7).

## Step 1. The board and drawing

We store the `W × H` board in a byte array: 1 is a live cell, 0 is a dead one. Cell `(x, y)` lives
in element `y * W + x` — the rows follow one another.

```hla
extern putchar

const W = 12
const H = 6

data grid: u8[W * H]

fn set_alive(x, y) {
    grid[y * W + x] = 1
}

fn draw() {
    for y in 0..H {
        for x in 0..W {
            putchar(grid[y * W + x] ? '#' : '.')
        }
        putchar('\n')
    }
}

fn main() {
    // a "glider": a shape that crawls diagonally
    set_alive(2, 1)
    set_alive(3, 2)
    set_alive(1, 3)
    set_alive(2, 3)
    set_alive(3, 3)
    draw()
}
```

```text
............
..#.........
...#........
.###........
............
............
```

`grid[y * W + x] ? '#' : '.'` is the ternary operator: if the byte is non-zero, we print a hash,
otherwise a dot. Inside `set_alive` and `draw` there are no calls that would clobber the parameters —
except `putchar` in `draw`, but the loop variables `x` and `y` are created by `for` and live in
callee-saved registers.

## Step 2. Neighbours

To make the board wrap around, we take the coordinates modulo the size: for `x = -1` we get
`(−1 + W) % W = W − 1` — the last column.

```hla
fn cell_at(x, y) {
    let cx: x9 = (x + W) % W
    let cy: x10 = (y + H) % H
    return grid[cy * W + cx]
}

fn neighbours(x: auto, y: auto) {
    let count = 0
    for dy in -1..=1 {
        for dx in -1..=1 {
            if dx == 0 && dy == 0 { continue }   // the cell itself is not a neighbour
            count += cell_at(x + dx, y + dy)
        }
    }
    return count
}
```

- `cell_at` calls nobody, so its parameters (`x0`, `x1`) and the temporaries `x9`, `x10` are safe.
- `neighbours` calls `cell_at` eight times, so `x` and `y` are declared as `auto` — otherwise the very
  first call would clobber them (lesson 6).

## Step 3. One generation

We can't write the new state straight into `grid`: the neighbouring cells still have to be counted
using the old one. So we add a second array, `next_grid`, and copy it back at the end.

```hla
fn step() {
    for y in 0..H {
        for x in 0..W {
            let n = neighbours(x, y)
            let me = grid[y * W + x]
            let live = 0
            if me == 1 && (n == 2 || n == 3) { live = 1 }   // survives
            if me == 0 && n == 3 { live = 1 }               // is born
            next_grid[y * W + x] = live
        }
    }
    for i in 0..W * H {
        grid[i] = next_grid[i]
    }
}
```

## Step 4. The whole program

Let's add a live-cell counter and a loop over the generations:

```hla
extern printf(fmt, ...)
extern putchar

const W = 12
const H = 6
const GENERATIONS = 4

data grid: u8[W * H]
data next_grid: u8[W * H]

fn set_alive(x, y) {
    grid[y * W + x] = 1
}

fn cell_at(x, y) {
    let cx: x9 = (x + W) % W
    let cy: x10 = (y + H) % H
    return grid[cy * W + cx]
}

fn neighbours(x: auto, y: auto) {
    let count = 0
    for dy in -1..=1 {
        for dx in -1..=1 {
            if dx == 0 && dy == 0 { continue }
            count += cell_at(x + dx, y + dy)
        }
    }
    return count
}

fn step() {
    for y in 0..H {
        for x in 0..W {
            let n = neighbours(x, y)
            let me = grid[y * W + x]
            let live = 0
            if me == 1 && (n == 2 || n == 3) { live = 1 }
            if me == 0 && n == 3 { live = 1 }
            next_grid[y * W + x] = live
        }
    }
    for i in 0..W * H {
        grid[i] = next_grid[i]
    }
}

fn population() {
    let total: x9 = 0
    for i: x10 in 0..W * H {
        total += grid[i]
    }
    return total
}

fn draw(generation: auto) {
    printf("generation %ld, live cells: %ld\n", generation, population())
    for y in 0..H {
        for x in 0..W {
            putchar(grid[y * W + x] ? '#' : '.')
        }
        putchar('\n')
    }
}

fn main() {
    // glider
    set_alive(2, 1)
    set_alive(3, 2)
    set_alive(1, 3)
    set_alive(2, 3)
    set_alive(3, 3)
    // "blinker": three cells in a row, flips every turn
    set_alive(8, 2)
    set_alive(9, 2)
    set_alive(10, 2)

    for g in 0..=GENERATIONS {
        draw(g)
        step()
    }
}
```

```text
generation 0, live cells: 8
............
..#.........
...#....###.
.###........
............
............
generation 1, live cells: 8
............
.........#..
.#.#.....#..
..##.....#..
..#.........
............
generation 2, live cells: 8
............
............
...#....###.
.#.#........
..##........
............
generation 3, live cells: 8
............
.........#..
..#......#..
...##....#..
..##........
............
generation 4, live cells: 8
............
............
...#....###.
....#.......
..###.......
............
```

In four generations the glider moved one cell right and down, and the blinker flipped twice.

## Running it with a bigger board

Change `W`, `H` and `GENERATIONS` — everything else adapts by itself: the array sizes are given by
the constant expressions `W * H`. Try a 40 × 20 board and 50 generations in the browser
(`dist/hla64.html`): the emulator will execute several million instructions in a fraction of a second.

## What can be improved

1. **Starting position from a string.** Describe a shape with a string `rodata pattern = ".#.|..#|###"` and
   parse it in a loop: `.` is dead, `#` is alive, `|` is the next row.
2. **No extra copying.** Instead of copying `next_grid` into `grid`, swap *pointers*
   to two buffers (lesson 8): pass the addresses `from` and `to` to `step`.
3. **Faster.** `cell_at` is called eight times per cell. Rewrite `neighbours` without calls:
   compute `x - 1` and `x + 1` modulo the size once and read the bytes directly.
4. **Stopping.** End the program when the board stops changing (compare `grid` and `next_grid`).
5. **Instructions where they're better.** Open the listing of `neighbours` and rewrite the hottest
   spot with instructions: for example, the sum of the eight neighbours as a chain of `add` or `ldrb`
   with `[x9, x10]` addressing, and the "survive/be born" rule with `cmp` and `csel` without branches.

The next, optional lesson is [how to make a library for C programs in HLA64](14-c-library.md).

## Course summary

You've gone from `puts("Hello, world!")` to a program with arrays, functions and recursion, all
without taking a single step away from the processor: you know which registers your variables live
in, why some registers survive calls and others don't, what a function's stack frame looks like and
what every `if` and `for` turns into. And most importantly: HLA64 is an assembler. Sugar saves lines,
but any of them can be replaced with processor instructions at any moment, without leaving the
program. Next:

- **[Language reference](../language.md)** — everything about the syntax in one place.
- **[examples/showcase.hla](../../examples/showcase.hla)** — a large program that brings together almost every feature.
- **[examples/mixed.hla](../../examples/mixed.hla)** — instructions and sugar mixed together in every function.
- The **Assembly** and **Machine code** tabs in the browser are the best way to understand what each line does.
