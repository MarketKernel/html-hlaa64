# Урок 14. Библиотека для C (и C для HLA64)

<!-- languages -->
<h3 align="center">
<a href="../../lessons/14-c-library.md">🇬🇧 English</a> ·
<b>🇷🇺 Русский</b>
</h3>
<!-- /languages -->

Программы на C и на HLA64 соблюдают одно и то же **соглашение о вызовах** (урок 6 и шпаргалка
в уроке 12): аргументы в `x0 … x7` и `d0 … d7`, результат в `x0` или `d0`, регистры `x19 … x28`
сохраняются. Поэтому функция, написанная на HLA64, для C — самая обычная функция, и наоборот.
Остаётся объяснить компилятору C, что это за функции, и собрать всё вместе.

В этом уроке мы:

1. напишем на HLA64 библиотеку математических функций и вызовем её из программы на C — со статической
   и с динамической компоновкой;
2. сделаем наоборот: программа на HLA64 вызовет функции, написанные на C.

Этот урок нужно выполнять на Mac: для части на C понадобится компилятор `clang` (команда
`xcode-select --install` ставит его вместе с инструментами командной строки). Все файлы урока лежат в
папке [`14-library`](../../lessons/14-library/), а [`build.sh`](../../lessons/14-library/build.sh) собирает и запускает всё сразу.

Чтобы команды были короче, заведите в терминале сокращение (из корня проекта):

```sh
alias hla="node $PWD/src/cli.ts"
```

## Как это устроено

Программа на C собирается из нескольких **объектных файлов** (`.o`): компилятор переводит каждый
исходник в машинный код, но адреса чужих функций ещё не знает и оставляет в коде пометки —
**релокации** («сюда подставить адрес `_gcd`»). Затем **компоновщик** (`ld`) склеивает объектные файлы
и библиотеки в программу и заполняет все пометки.

Встроенный ассемблер HLA64 умеет делать такие же объектные файлы, а из них — библиотеки двух видов:

| вид | файл | как подключается |
|---|---|---|
| статическая | `libmathlib.a` | код библиотеки **копируется** в программу при сборке |
| динамическая | `libmathlib.dylib` | программа хранит только ссылку, а код загружается при запуске |

Ещё компилятору C нужен **заголовок** `mathlib.h`: в нём записано, какие функции есть, какие у них
параметры и что они возвращают. HLA64 создаёт его сам.

## Шаг 1. Что экспортировать

По умолчанию функции и данные программы HLA64 видны только внутри неё. Слово `export` делает их
доступными снаружи:

| HLA64 | в заголовке C |
|---|---|
| `export fn gcd(a: i64, b: i64) -> i64` | `int64_t gcd(int64_t a, int64_t b);` |
| `export data call_count: i64 = 0` | `extern int64_t call_count;` |
| `export struct Vec2 { x: f64, y: f64 }` | `typedef struct Vec2 { double x; double y; } Vec2;` |
| `export enum Shape { Circle, Square }` | `enum Shape { Shape_Circle = 0, Shape_Square = 1 };` |
| `export const VERSION = 3` | `#define VERSION 3` |

Компилятору C важны **типы**, поэтому у параметров экспортируемых функций их стоит указать — после
двоеточия, там, где раньше писался регистр:

| тип HLA64 | тип C | где приходит |
|---|---|---|
| `i64`, `u64` | `int64_t`, `uint64_t` (`long`) | `x`-регистр |
| `i32`, `u32` | `int32_t`, `uint32_t` (`int`) | младшие 32 бита `x`-регистра |
| `i16`, `u16`, `i8`, `u8` | `int16_t` … `uint8_t` (`short`, `char`) | младшие биты |
| `ptr` | `void *` (любой указатель, строки, массивы) | `x`-регистр |
| `f64`, `f32` | `double`, `float` | `d`/`s`-регистр |

Тип результата пишется после стрелки: `-> i64`, `-> i32`, `-> f64`, `-> ptr`. Если стрелки нет, а
функция возвращает значение, в заголовке будет `int64_t`; если не возвращает — `void`.

**Почему типы важны.** Когда C передаёт `int` (32 бита), он кладёт число только в младшую половину
регистра, а старшие 32 бита могут содержать что угодно. Параметр `v: i32` HLA64 при входе в функцию
**расширяет** до честного 64-битного значения (командой `sxtw`), и дальше с ним можно работать как
обычно. Без типа (`v` или `v: x0`) мусор в старших битах испортил бы сравнения.

Вот вся библиотека:

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

На что обратить внимание:

- `call_count` — общая переменная: функции HLA64 её увеличивают, а C может читать и даже менять.
- `map_i64` получает **указатель на функцию C** и вызывает её для каждого элемента: `func(...)`.
  Параметры сразу копируются в «долгие» переменные (`let p = values`), потому что вызов `func`
  имеет право испортить `x0 … x17`.
- `vec2_length` читает поля структуры по смещениям `Vec2.x` и `Vec2.y`. Раскладка структур в HLA64
  и в C одинаковая (естественное выравнивание, урок 9), а заголовок дополнительно проверяет это
  через `_Static_assert`.
- Функции `main` в библиотеке нет — она будет в программе на C.

## Шаг 2. Собрать библиотеку

```sh
cd docs/lessons/14-library
hla lib mathlib.hla
```

Команда создаёт четыре файла: `mathlib.h` (заголовок), `mathlib.o` (объектный файл),
`libmathlib.a` (статическая библиотека) и `libmathlib.dylib` (динамическая). Заголовок получился такой:

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

`extern "C"` нужен, чтобы библиотеку можно было подключить и из C++.

## Шаг 3. Программа на C

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

`(void *)square` — адрес функции C, который мы передаём в `map_i64`.

**Статическая сборка** — код библиотеки становится частью программы:

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

**Динамическая сборка** — программа только ссылается на `libmathlib.dylib`:

```sh
clang -Wall main.c -L. -lmathlib -Wl,-rpath,@executable_path -o demo_dynamic
./demo_dynamic
```

- `-L.` — искать библиотеки в текущей папке, `-lmathlib` — подключить `libmathlib.dylib`
  (приставку `lib` и расширение компилятор добавляет сам).
- Внутри библиотеки записано её имя `@rpath/libmathlib.dylib`. `-Wl,-rpath,@executable_path` говорит:
  «`@rpath` — это папка, где лежит сама программа». Поэтому `demo_dynamic` и `libmathlib.dylib`
  должны лежать рядом.

Посмотреть, от каких библиотек зависит программа, можно командой `otool -L demo_dynamic`:

```text
demo_dynamic:
	@rpath/libmathlib.dylib (compatibility version 1.0.0, current version 1.0.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1359.0.0)
```

Если пересобрать `libmathlib.dylib` (например, исправить ошибку в `gcd`), `demo_dynamic` сразу начнёт
пользоваться новой версией без пересборки. Статической программе для этого нужна новая сборка.

## Шаг 4. Наоборот: HLA64 вызывает C

Функции на C подключаются так же, как функции из системной библиотеки, — через `extern`:

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

Программа на HLA64 собирается в объектный файл командой `hla obj`, а `clang` компилирует файл на C
и компонует оба вместе:

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

`c_average` возвращает `double`, поэтому результат приходит в `d0` (урок 11), и мы сразу переносим
его в сохраняемый `d8` — следующий `printf` испортил бы `d0`.

## Всё сразу: build.sh

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

Запустите `sh build.sh` в папке урока — он соберёт обе части и выполнит программы.

## То же самое в браузере

На странице `dist/hla64.html` выберите пример **Library for C: mathlib (lesson 14)** и переключатель
**Build as** в положение **Static lib .a** или **Dynamic lib .dylib**:

- вкладка **C header** показывает сгенерированный `mathlib.h`, пример `main.c` и команду сборки;
- вкладка **Mach-O** — содержимое библиотеки: для `.a` — объектный файл, экспорт и число релокаций,
  для `.dylib` — сегменты, таблицу экспорта и подпись;
- **Download .zip** отдаёт папку с `mathlib.h`, библиотекой, `main.c` и `build.sh`;
- **Copy Terminal command** копирует команду, которая в терминале создаёт эту папку, собирает `main.c`
  через `clang` и запускает программу — без скачивания и без пометки карантина.

Режим сборки можно переключить для любого примера или своего кода: функции с `export` попадут в
библиотеку и заголовок.

## Что внутри объектного файла

Объектный файл — это тот же Mach-O, что и программа, только с пометками для компоновщика. Его можно
разглядеть стандартными инструментами macOS:

```sh
nm mathlib.o            # символы: T — код, D — данные, s — внутренние
otool -rv mathlib.o     # релокации
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

- Переходы внутри одной функции (циклы, `if`) ассемблер вычисляет сам — расстояние между командами
  не изменится при компоновке.
- `adrp`/`add`/`ldr` к данным получают релокации `PAGE21` и `PAGEOFF12`: окончательный адрес
  `_call_count` станет известен только компоновщику.
- Вызовы чужих функций (`bl _printf`) получают релокацию `BR26`.

У динамической библиотеки вместо релокаций — **таблица экспорта**, по которой загрузчик `dyld`
находит функции при запуске программы: `dyld_info -exports libmathlib.dylib`.

## Упражнения

1. Добавьте в библиотеку функцию `export fn is_prime(n: i64) -> i32` и вызовите её из C в цикле
   от 1 до 50.
2. Экспортируйте `rodata` таблицу квадратов `squares: i64[10]` и напечатайте её из C.
3. Напишите на C функцию `int64_t c_max(int64_t a, int64_t b)` и используйте её из HLA64 при поиске
   максимума в массиве.
4. Посмотрите командой `hla compile mathlib.hla`, во что превратился параметр `v: i32` функции `clamp`
   (ищите команду `sxtw`).

Дальше — [итоги курса](13-project-game-of-life.md#итоги-курса) и [справочник языка](../language.md).
