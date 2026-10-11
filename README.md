# HLA64 — ассемблер «чуть выше уровнем» для Apple Silicon и Windows x64, целиком на TypeScript

Переосмысление [hlaa64](../hlaa64) на TypeScript: язык, в котором вы по-прежнему управляете
регистрами, но пишете `for`, `if`, `a = b + c * 4`, `numbers[i]` и `printf(...)` вместо
десятков строк `stp/adrp/ldr/b.lt`.

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
| `src/lang/x64`, `src/asm/x64`, `src/asm/coff`, `src/emu/x64` | вторая платформа — **Windows x64**: генератор кода Win64, ассемблер x86-64 (Intel, диалект LLVM), объектные файлы COFF, линковщик PE (`.exe`/`.dll`), статические библиотеки и библиотеки импорта `.lib`, эмулятор x64 с загрузчиком PE. Подробно — [docs/windows.md](docs/windows.md) |

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
```

Онлайн страница живёт на GitHub Pages как устанавливаемое приложение (PWA): после первого
открытия service worker держит её в кэше, и она работает без сети. Готовый файл `hla64-vX.Y.Z.html`
прикладывается к каждому [релизу](../../releases).

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

## Как выглядит язык

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
    return a + x0
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

Уроки для начинающих, от «Hello, world» до игры «Жизнь»: **[docs/lessons](docs/lessons/README.md)**.
Полный справочник: **[docs/language.md](docs/language.md)**. Большая программа, задействующая
почти всё: [examples/showcase.hla](examples/showcase.hla).

## Библиотеки для C

Функции с `export` и типами параметров можно вызывать из C: `node src/cli.ts lib mathlib.hla`
генерирует заголовок и библиотеки, дальше — обычный `clang main.c libmathlib.a`. Работает и наоборот:
программа на HLA64 вызывает функции на C через `extern`. Пошагово — в [уроке 14](docs/lessons/14-c-library.md).
На странице `dist/hla64.html` то же самое делает переключатель **Build as: Program / Static lib .a / Dynamic lib .dylib**:
заголовок на вкладке **C header**, zip с `.h`, библиотекой и `main.c` или команда для Terminal, которая всё собирает `clang` и запускает.

## Примеры

| Файл | О чём |
|---|---|
| [hello.hla](examples/hello.hla) | минимальная программа |
| [showcase.hla](examples/showcase.hla) | тур по языку: структуры, enum, массивы, строки, рекурсия, qsort с колбэком, FP, syscall, naked-функции, push/pop, goto |
| [mandelbrot.hla](examples/mandelbrot.hla) | множество Мандельброта на d-регистрах |
| [fizzbuzz.hla](examples/fizzbuzz.hla) | `for … in`, `if/elif/else` |
| [bare-metal.hla](examples/bare-metal.hla) | без libc: `svc #0x80`, печать чисел в стековый буфер, встроенный ассемблер с числовыми метками |

## Тесты

```sh
npm test                 # все примеры и tests/cases × {clang, свой ассемблер, эмулятор}: 24 прогона
npm run test:lessons     # 100 программ из уроков + сборка урока 14 с clang (--native: программы ещё и на macOS)
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

- [pages.yml](.github/workflows/pages.yml) — на каждый push в `main`: проверка типов, `test:ci`,
  сборка, `check:pwa` и публикация `dist/pages/` на GitHub Pages
  (в настройках репозитория: Settings → Pages → Source: **GitHub Actions**).
- [release.yml](.github/workflows/release.yml) — на тег `v*`: те же проверки, затем релиз с
  `hla64-vX.Y.Z.html` и `SHA256SUMS.txt`. Версия берётся только из `package.json`, тег должен
  с ней совпадать: `npm version 0.2.0 && git push --follow-tags`. Можно запустить и вручную
  (Run workflow, указать тег) — файлы существующего релиза будут заменены.

## Устройство

### Транслятор (`src/lang`)
- `lexer.ts`, `parser.ts` → AST (`ast.ts`); операторный приоритет как в Go.
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
