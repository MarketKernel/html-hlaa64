# HLA64 — ассемблер с синтаксическим сахаром для Apple Silicon и Windows x64, целиком на TypeScript

<!-- languages -->
<h3 align="center">
<a href="../../README.md">🇬🇧 English</a> ·
<b>🇷🇺 Русский</b>
</h3>
<!-- /languages -->

**HLA64 — это ассемблер, а не новый язык программирования.** Программа на HLA64 — обычный
ассемблерный листинг: `ldr`, `bfi`, `csel`, `umulh`, `b.lt` (на x64 — `mov`, `cmovg`, `mul`, `jl`)
пишутся прямо в коде, как есть. Сахар — `for`, `if`, `a = b + c * 4`, `numbers[i]`, `printf(...)` —
добавлен поверх, чтобы не набирать вручную десятки строк `stp/adrp/ldr/b.lt` там, где они
очевидны. Каждая строка сахара раскрывается в несколько инструкций, которые видно в листинге,
а в любом месте функции можно вернуться к инструкциям.

Чем он отличается:

1. **Весь тулчейн — один HTML-файл.** Транслятор, ассемблер, линковщик и эмулятор умещаются на одной
   странице, которая работает без сети. Откройте [онлайн-версию](https://marketkernel.github.io/html-hlaa64/)
   или скачайте `hla64-vX.Y.Z.html` из
   [последнего релиза](https://github.com/MarketKernel/html-hlaa64/releases/latest): файл работает
   в любом современном браузере на macOS, Windows, Linux и даже на телефоне, не требует установки
   и интернета, и его можно носить с собой на флешке.
2. **Тулчейн собирает сам себя.** Среди примеров есть **Translator in HLA64 (hla → s)** и
   **Assembler in HLA64 (s → executable)** — транслятор и ассемблер, написанные на самом HLA64
   ([selfhost/](../../selfhost/README.ru.md)). TypeScript-тулчейн собирает из них нативные исполняемые
   файлы (Mach-O для macOS или `.exe` для Windows), а те, в свою очередь, пересобирают сами себя
   из тех же исходников — побайтно.
3. **Курс из 14 уроков** — от «Hello, world» до игры «Жизнь» и вызова HLA64 из C. В каждом уроке есть
   программы, которые можно запустить, и упражнения, а инструкции процессора появляются с первого
   урока, рядом с сахаром, поэтому курс подходит для обучения ассемблеру.
   [Список уроков](#уроки) — ниже.

Это не попытка повторить C: нет скрытого рантайма, нет оптимизатора, который переставляет код,
у регистров нет типов (ширину и знак задают сами инструкции и `i32[...]`, `u8[p]` при обращении
к памяти). Регистры принадлежат вам: переменная — это имя регистра (`let i: x19`), а инструкции
видят переменные, параметры, данные и метки по имени.

```hla
fn clamp(v, lo, hi) {            // параметры — это x0, x1, x2
    cmp v, lo                    // инструкции процессора как есть
    csel v, lo, v, lt
    cmp v, hi
    csel x0, hi, v, gt           // результат уже в x0
}

fn length(s) {
    let p: x9 = s                // сахар: переменная = регистр x9
    do {
        ldrb w10, [p], #1        // инструкция: байт по адресу p, затем p += 1
    } while w10 != 0             // сахар: одна cbnz
    return p - s - 1
}
```

Листинг `length` — ваша инструкция на месте, сахар вокруг неё; пролог и эпилог дописал транслятор:

```asm
_length:
    stp x29, x30, [sp, #-16]!
    mov x29, sp
    mov x9, x0                   // let p: x9 = s
Llength.body2:
    ldrb w10, [x9], #1           // строка из исходника, p заменено на x9
    cbnz w10, Llength.body2      // } while w10 != 0
    sub x0, x9, x0               // return p - s - 1
    sub x0, x0, #1
    ldp x29, x30, [sp], #16
    ret
```

Инструкции пишутся в синтаксисе платформы (Apple-диалект AArch64, Intel/LLVM для x86-64).
Встроенный ассемблер понимает ≈140 мнемоник AArch64 и основные целочисленные и SSE-инструкции
x86-64 (пока без SIMD-векторов); с `--clang` сборку делает `clang`, и тогда доступно всё, что
знает он. Полный пример — [examples/mixed.hla](../../examples/mixed.hla).

Переосмысление hlaa64, [высокоуровневого ассемблера](https://en.wikipedia.org/wiki/High-level_assembler), на TypeScript.

Весь конвейер написан на TypeScript без внешних зависимостей во время выполнения и работает
и в Node, и **в браузере оффлайн**:

```
 program.hla ──► транслятор ──► ассемблер AArch64 ──► кодировщик + линковщик ──► Mach-O (arm64, подписан) ──► запуск
                 src/lang          (текст, Apple-диалект)   src/asm                        на macOS или в эмуляторе src/emu
```

| Компонент | Что делает |
|---|---|
| `src/lang` | лексер, парсер и генератор кода HLA64 → ассемблер AArch64 |
| `src/asm` | ассемблер (≈140 мнемоник + все `b.cond`, директивы, числовые метки); объектные файлы `.o` с релокациями, статические `.a` и динамические `.dylib` библиотеки; линковщик Mach-O: GOT/стабы для libSystem, rebase/bind опкоды dyld, таблица символов, **ad-hoc подпись кода** (SHA-256 CodeDirectory — без неё ядро не запустит arm64-бинарник) |
| `src/emu` | эмулятор ARM64: загружает получившийся Mach-O, применяет bind-опкоды, подставляет libSystem на JS (`printf`, `puts`, `malloc`, `qsort` с обратным вызовом и т. д.) и исполняет машинный код |
| `web/` → `dist/hla64.html` | один самодостаточный HTML-файл: редактор с подсветкой, живая трансляция, листинг машинного кода с разбором битов, инспектор Mach-O / PE, консоль эмулятора, сборка программы или библиотеки для C (`.a` / `.dylib` или `.lib` / `.dll` + `.h`) и скачивание результата; платформа переключается в самом верху |
| `src/lang/x64`, `src/asm/x64`, `src/asm/coff`, `src/emu/x64` | вторая платформа — **Windows x64**: генератор кода Win64, ассемблер x86-64 (Intel, диалект LLVM), объектные файлы COFF, линковщик PE (`.exe`/`.dll`), статические библиотеки и библиотеки импорта `.lib`, эмулятор x64 с загрузчиком PE. Подробно — [docs/windows.md](windows.md) |

## Быстрый старт

```sh
npm install                                    # только инструменты разработки (typescript, esbuild)

node src/cli.ts run examples/showcase.hla      # транслировать + собрать своим ассемблером + запустить
node src/cli.ts compile examples/hello.hla     # показать сгенерированный ассемблер
node src/cli.ts build examples/hello.hla -o hello && ./hello
node src/cli.ts build examples/hello.hla -o hello --zip   # + hello.zip: внутри файл с битом +x
node src/cli.ts run examples/hello.hla --clang # то же через clang (для сравнения)
node src/cli.ts emu examples/mandelbrot.hla    # запустить во встроенном эмуляторе (macOS не нужна)
node src/cli.ts asm hello.s -o hello           # собрать обычный .s встроенным ассемблером
node src/cli.ts lib mathlib.hla                # библиотека для C: mathlib.h + .o + .a + .dylib
node src/cli.ts obj app.hla                    # объектный файл, чтобы скомпоновать с кодом на C

node src/cli.ts run examples/hello.hla --target x64-windows    # Windows x64 (вне Windows — в эмуляторе x64)
node src/cli.ts build examples/hello.hla --target x64-windows  # hello.exe

npm run build:web                              # собрать dist/hla64.html и PWA в dist/pages/
open dist/hla64.html                           # работает с file://, без сети

./build.sh                                     # то же одной командой (сам ставит инструменты, если их нет)
./build.sh check open                          # + typecheck и тесты CI перед сборкой, затем открыть страницу
```

Онлайн страница живёт на GitHub Pages как устанавливаемое приложение (PWA): после первого
открытия service worker держит её в кэше, и она работает без сети. Готовый файл `hla64-vX.Y.Z.html`
прикладывается к каждому [релизу](https://github.com/MarketKernel/html-hlaa64/releases).

Слева на странице — панель как в IDE: **Files** (файлы открытого проекта; главный помечен `main`,
остальные подключаются через `include`; файлы можно создавать, переименовывать — `include` следуют
за файлом, — удалять и перетаскивать с диска), **Projects** (свои проекты для текущей платформы)
и **Examples** (встроенные примеры; изменённый пример помечен точкой и сбрасывается к оригиналу).
Проекты хранятся в IndexedDB этого браузера, **Download project .zip** скачивает все файлы проекта.
Программа с `include "std/file.hla"` (одинаковые функции файлов для macOS и Windows) читает файлы
проекта, а записанные ею файлы появляются в панели.

Нужен Node 24+ (запускает `.ts` напрямую). На странице кнопка **Download executable** отдаёт
готовый Mach-O; браузер снимает бит исполнения и ставит карантин, поэтому страница показывает
команду для Terminal (`chmod +x … && xattr -d com.apple.quarantine … ; ./…`) и предлагает
вариант `.zip`: в архиве файл записан с режимом `0755`, поэтому после распаковки (Finder или `unzip`)
он сразу исполняемый. Если zip получен через браузер, macOS переносит пометку карантина на
распакованный файл, и Gatekeeper его не запустит, пока не выполнить `xattr -d com.apple.quarantine <файл>`
(обойти это может только подпись Developer ID с нотаризацией). Кнопка **Copy Terminal command**
обходится без скачивания: команда воссоздаёт файл из base64 прямо в Terminal, без карантина.

## Сахар крупным планом

Сахар — сокращения для того, что пришлось бы писать инструкциями: циклы, условия, выражения,
обращения к массивам, вызовы по ABI. Где удобнее инструкция, пишется инструкция:

```hla
extern printf(fmt, ...)

data numbers: i32[8] = [42, -7, 19, 3, 88, 0, -15, 61]

fn sort_numbers() {                         // сортировка вставками
    for i: x9 in 1..8 {
        let key: w10 = numbers[i]
        let j: x11 = i - 1
        while j >= 0 && numbers[j] > key {
            w12 = numbers[j]
            numbers[j + 1] = w12
            j--
        }
        numbers[j + 1] = key
    }
}

fn fib(n: auto) {                           // n переживает рекурсивный вызов
    if n < 2 { return n }
    let a = fib(n - 1)
    x0 = fib(n - 2)
    add x0, x0, a                           // инструкция вместо return a + x0
}

fn main() {
    sort_numbers()
    printf("fib(20) = %ld, smallest = %d\n", fib(20), numbers[0])
}
```

Во что превращается `while j >= 0 && numbers[j] > key`:

```asm
Lsort_numbers.next5:
    cmp x11, #0
    b.lt Lsort_numbers.skip7
    adrp x17, _numbers@PAGE
    add x17, x17, _numbers@PAGEOFF
    ldr w16, [x17, x11, lsl #2]
    cmp w16, w10
    b.gt Lsort_numbers.body6
```

Полный справочник: **[docs/language.md](language.md)**. Большая программа, задействующая
почти всё: [examples/showcase.hla](../../examples/showcase.hla).

## Уроки

Курс для начинающих, от «Hello, world» до игры «Жизнь»: **[docs/lessons](lessons/README.md)**.
Инструкции процессора появляются в нём с первого урока, рядом с сахаром.

| # | Урок | О чём |
|---|---|---|
| 1 | [Hello, world](lessons/01-hello-world.md) | первая программа, функция `main`, комментарии, первая команда процессора в коде |
| 2 | [Регистры и переменные](lessons/02-registers-and-variables.md) | что такое регистр, `let`, `alias`, константы, печать чисел |
| 3 | [Арифметика и выражения](lessons/03-arithmetic.md) | операторы, приоритеты, биты и сдвиги, 32 и 64 бита |
| 4 | [Условия](lessons/04-conditions.md) | `if / elif / else`, сравнения, `&&` `\|\|` `!`, тернарный оператор |
| 5 | [Циклы](lessons/05-loops.md) | `while`, `do … while`, `loop`, `for … in`, `break` и `continue` |
| 6 | [Функции](lessons/06-functions.md) | параметры, `return`, рекурсия, какие регистры портятся при вызове |
| 7 | [Данные и массивы](lessons/07-data-and-arrays.md) | `data`, `rodata`, строки, массивы, `len` и `sizeof` |
| 8 | [Память и указатели](lessons/08-memory-and-pointers.md) | адреса, `u8[p]`, `[p++]`, локальные буферы на стеке |
| 9 | [Структуры и перечисления](lessons/09-structs-and-enums.md) | `struct`, `enum`, массивы структур, связный список |
| 10 | [Библиотека C и система](lessons/10-c-library-and-syscalls.md) | `extern`, `printf`, `malloc`, `qsort` и указатели на функции, `syscall` |
| 11 | [Числа с плавающей точкой](lessons/11-floating-point.md) | регистры `d` и `s`, `float()` и `int()`, `sqrt` |
| 12 | [Под капотом](lessons/12-under-the-hood.md) | блоки `asm { }` и числовые метки, `naked`, `push`/`pop`, как устроен вызов функции |
| 13 | [Проект: игра «Жизнь»](lessons/13-project-game-of-life.md) | всё вместе в одной программе |
| 14 | [Библиотека для C](lessons/14-c-library.md) | `export`, типы параметров, `.h`/`.o`/`.a`/`.dylib`, вызовы C ↔ HLA64 (нужен Mac с `clang`) |

## Библиотеки для C

Функции с `export` и типами параметров можно вызывать из C: `node src/cli.ts lib mathlib.hla`
генерирует заголовок и библиотеки, дальше — обычный `clang main.c libmathlib.a`. Работает и наоборот:
программа на HLA64 вызывает функции на C через `extern`. Пошагово — в [уроке 14](lessons/14-c-library.md).
На странице `dist/hla64.html` то же самое делает переключатель **Build as: Program / Static lib .a / Dynamic lib .dylib**:
заголовок на вкладке **C header**, zip с `.h`, библиотекой и `main.c` или команда для Terminal, которая всё собирает `clang` и запускает.

## Примеры

| Файл | О чём |
|---|---|
| [mixed.hla](../../examples/mixed.hla) | инструкции и сахар в одних функциях: `ldrb` с пост-инкрементом внутри `do … while`, `bfi`/`ubfx`, `cmp`+`csel` без переходов, `umulh` после xorshift на сахаре, цикл на метке и `b.lt` (для Windows — [tests/x64/cases/mixed.hla](../../tests/x64/cases/mixed.hla) с `cmovg`, `mul`, `jl`) |
| [hello.hla](../../examples/hello.hla) | минимальная программа |
| [showcase.hla](../../examples/showcase.hla) | тур по языку: структуры, enum, массивы, строки, рекурсия, qsort с колбэком, FP, syscall, naked-функции, push/pop, goto |
| [mandelbrot.hla](../../examples/mandelbrot.hla) | множество Мандельброта на d-регистрах: выражения с плавающей точкой рядом с `fmul` |
| [fizzbuzz.hla](../../examples/fizzbuzz.hla) | `for … in`, `if/elif/else` |
| [bare-metal.hla](../../examples/bare-metal.hla) | без libc: `svc #0x80`, печать чисел в стековый буфер, встроенный ассемблер с числовыми метками |

## Тулчейн на самом HLA64 (`selfhost/`)

В [selfhost/](../../selfhost/README.ru.md) лежат транслятор и ассемблер, написанные на HLA64:
`hlc-arm`/`hlc-x64` переводят HLA64 (без регистров) в ассемблер AArch64 или x86-64,
`hlas-arm`/`hlas-x64` собирают из него подписанный Mach-O или `.exe`. После раскрутки
TypeScript-версией они пересобирают сами себя побайтно, а их исполняемые файлы совпадают
с результатом линковщиков из `src/asm`. Проверка — `selfhost/test.sh`.

## Тесты

```sh
npm test                 # все примеры и tests/cases × {clang, свой ассемблер, эмулятор}: 54 прогона
npm run test:lessons     # 108 программ из уроков + сборка урока 14 с clang (--native: программы ещё и на macOS)
npm run test:encoding    # 248 форм инструкций: кодировка бит-в-бит совпадает с clang
npm run fuzz             # дифференциальный фаззер: ~1200 случайных выражений, натив и эмулятор против BigInt-эталона
npm run check:web        # открыть страницу в headless Chrome, прогнать примеры обеих платформ, сделать скриншоты
npm run check:pwa        # dist/pages/ по http в headless Chrome: service worker, манифест, перезагрузка без сети
npm run typecheck

npm run test:x64         # Windows x64: программы для x64 + переносимые программы уроков в эмуляторе x64 (на Windows — ещё и нативно)
npm run test:x64-clang   #   … и тот же ассемблер через clang + lld-link
npm run test:x64-encoding  # 987 форм x86-64: бит-в-бит с clang
npm run test:coff        # COFF-объект против clang, lld-link, свой линковщик PE
npm run test:x64-lib     # C ↔ HLA64 на Windows: .lib, .dll + библиотека импорта (clang и lld-link; на Windows — ещё MSVC и SEH)
npm run test:all         # всё подряд
npm run test:ci          # то, что гоняет CI на Linux (части, которым нужны macOS или clang, пропускаются сами)
```

Каждая программа из `examples/` и `tests/cases/` с файлом `.expected` проверяется трижды:
собранная `clang`, собранная встроенным ассемблером и запущенная на macOS, и исполненная в эмуляторе.
`codesign -v` считает подпись бинарников валидной.

### Сборка в GitHub Actions

- [pages.yml](../../.github/workflows/pages.yml) — на каждый push в `main`: проверка типов, `test:ci`,
  сборка, `check:pwa` и публикация `dist/pages/` на GitHub Pages
  (в настройках репозитория: Settings → Pages → Source: **GitHub Actions**).
- [release.yml](../../.github/workflows/release.yml) — на тег `v*`: те же проверки, затем релиз с
  `hla64-vX.Y.Z.html` и `SHA256SUMS.txt`. Версия берётся только из `package.json`, тег должен
  с ней совпадать: `npm version 0.2.0 && git push --follow-tags`. Можно запустить и вручную
  (Run workflow, указать тег) — файлы существующего релиза будут заменены.

## Устройство

### Транслятор (`src/lang`)
- `lexer.ts`, `parser.ts` → AST (`ast.ts`); операторный приоритет как в Go.
- Строка, которая не разбирается как сахар, — инструкция: она идёт в листинг как есть, с заменой
  имён переменных, параметров, констант, данных и меток на регистры и символы.
- `codegen.ts` — генерация с учётом режимов адресации и форм инструкций AArch64:
  иммедиаты add/sub (12 бит, `lsl #12`), логические bitmask-иммедиаты, `movz/movk/movn`,
  сдвинутые и расширенные операнды, `madd/msub`, `csel/cset`, `cbz/tbz/tst`, пост-инкремент,
  масштабированные индексы. Скретч-регистры `x16/x17` (+ свободные callee-saved, затем
  не названные в функции `x9..x15`), пролог сохраняет ровно те callee-saved регистры, которые
  встретились в теле функции; `let` сверх свободных регистров вытесняется в кадр.

### Ассемблер и линковщик (`src/asm`)
- `parse.ts` — разбор строк, операндов и выражений (`sym@PAGE`, `sym@GOTPAGEOFF`, `#imm`, `[x1, w2, sxtw #2]`).
- `encode.ts` — кодировщик инструкций; поля, зависящие от адресов, отдаются линковщику как fixup'ы.
- `assembler.ts` — секции, символы, директивы (`.section`, `.p2align`, `.asciz`, `.quad`, `.zerofill`, …).
- `macho-object.ts` — объектные файлы `MH_OBJECT` (релокации `BRANCH26`, `PAGE21`, `PAGEOFF12`, `GOT_LOAD_*`, `UNSIGNED`);
  `archive.ts` — статические библиотеки (`ar` с оглавлением `__.SYMDEF SORTED`).
- `macho.ts` — исполняемые файлы и `.dylib` (`LC_ID_DYLIB`, таблица экспорта); раскладка `__PAGEZERO / __TEXT / __DATA / __LINKEDIT`, стабы и GOT для импортов
  из `libSystem.B.dylib`, rebase/bind-опкоды (`LC_DYLD_INFO_ONLY`), `LC_MAIN`, symtab/dysymtab,
  export trie, `LC_BUILD_VERSION`, UUID и ad-hoc подпись (`sha256.ts`).

### Эмулятор (`src/emu`)
- `cpu.ts` — интерпретатор AArch64 (целочисленные, загрузки/сохранения всех режимов, ветвления,
  условные операции, FP); декодированные инструкции кэшируются как замыкания. ~8–15 млн инструкций/с.
- `macho-loader.ts` — загрузчик Mach-O, применение bind-опкодов, «libSystem» на JS, syscalls.
- `printf.ts` — форматирование `printf` (флаги, ширина, точность, `%d %u %x %s %c %p %f %e %g`).

## Структура проекта

```
src/lang/      транслятор HLA64 (frontend.ts — общая часть, codegen.ts — AArch64, x64/ — Windows x64)
src/asm/       ассемблер + линковщик Mach-O; x64/ — ассемблер x86-64; coff/ — COFF, PE, .lib
src/emu/       эмулятор ARM64; x64/ — эмулятор x86-64 и загрузчик PE
src/cli.ts     командная строка
web/           исходники страницы (template.html, main.ts, worker.ts; sw.js — service worker PWA)
assets/        иконка (icon.svg) и PNG-иконки PWA (npm run build:icons пересобирает их из SVG)
dist/hla64.html  собранная страница (не коммитится: npm run build:web)
dist/pages/    PWA для GitHub Pages: index.html, hla64.html, sw.js, манифест, иконки
examples/      примеры (.hla + .expected)
tests/         run.ts, encoding.ts, fuzz.ts, cases/; x64.ts, x64-lib.ts, encoding-x64.ts, coff-x64.ts, x64/
docs/          справочник языка, уроки (docs/lessons), Windows x64 (docs/windows.md)
```
