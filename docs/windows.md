# HLA64 для Windows x64

Тот же язык, вторая платформа: транслятор выдаёт ассемблер x86-64 (синтаксис Intel в диалекте
LLVM, его понимают `clang` и встроенный ассемблер), дальше — свой ассемблер, объектные файлы COFF,
линковщик PE и эмулятор x64. Всё работает и в Node, и на странице `dist/hla64.html`
(переключатель **Platform** в самом верху).

```
prog.hla ─► src/lang/x64 ─► .s (Intel, .seh_*) ─► src/asm/x64 ─► COFF .obj ─► src/asm/coff/pe.ts ─► prog.exe
                                                                     │
                                                    .lib (статическая / импорт), .dll
```

## Командная строка

На Windows платформа по умолчанию `x64-windows`, на macOS — `arm64-macos`; явно — `--target`:

```sh
node src/cli.ts run   examples/hello.hla --target x64-windows   # вне Windows — во встроенном эмуляторе x64
node src/cli.ts build examples/hello.hla --target x64-windows   # hello.exe
node src/cli.ts compile prog.hla --target x64-windows           # ассемблер x86-64
node src/cli.ts obj   app.hla --target x64-windows              # app.obj для link.exe / lld-link
node src/cli.ts lib   mathlib.hla --target x64-windows          # mathlib.h, .obj, mathlib_static.lib, mathlib.dll, mathlib.lib
node src/cli.ts emu   prog.hla --target x64-windows             # эмулятор x64
node src/cli.ts build prog.hla --target x64-windows --clang     # собрать через clang (нужны MSVC/SDK)
```

## Регистры и соглашение о вызовах (Win64)

| | |
|---|---|
| целые аргументы | `rcx`, `rdx`, `r8`, `r9`, дальше — стек (после 32 байт shadow space) |
| FP-аргументы | `xmm0`–`xmm3` **по позиции**: `f(a, x: f64)` — `a` в `rcx`, `x` в `xmm1` |
| результат | `rax` / `xmm0` |
| портятся при вызове | `rax rcx rdx r8–r11 xmm0–xmm5` |
| сохраняются | `rbx rbp rsi rdi r12–r15 xmm6–xmm15` — пролог сохраняет те, что встретились в функции |
| `let x = …` без регистра | один из `rbx rsi rdi r12–r15 rbp` (8 штук; на ARM их 10) |
| скретч транслятора | `r10`, `r11` (+ свободные сохраняемые), `xmm5`, `xmm4` (+ свободные `xmm6`–`xmm15`) |

Регистры можно называть 64-битными (`rax`, `r12`) и 32-битными (`eax`, `r12d`) именами — как
`x`/`w` на ARM: запись в 32-битный регистр обнуляет старшую половину. Плавающая точка — в `xmm`,
всегда `double`; `f32` в памяти читается и пишется с преобразованием.

```hla
extern printf(fmt, ...)

fn hypot(a: xmm0, b: xmm1) {
    return sqrt(a * a + b * b)
}

fn main() {
    let r: xmm6 = 2.0
    xmm0 = hypot(3.0, r * 2.0)
    printf("%.1f\n", xmm0)
}
```

Кадр функции адресуется от `rsp` (без `rbp`), место под исходящие аргументы выделяется один раз в
прологе, для каждой функции генерируются директивы `.seh_*` — по ним ассемблер строит `.pdata`/`.xdata`,
без которых Windows не может раскрутить стек (исключения, отладчик). `push`/`pop` в HLA64 на x64 пишут
в слоты кадра, а не меняют `rsp`. Кадр больше 4 КБ (`local buf: u8[20000]`) пролог сначала
«прощупывает» постранично, как `__chkstk`: Windows выделяет стек по одной guard-странице, и прыжок
через неё — access violation (эмулятор моделирует это так же).

## Чем отличается от ARM64

- **`printf("%ld")` печатает 32 бита**: в Windows `long` 32-битный. Для 64-битных чисел — `%lld`
  (работает и на macOS). Программы из уроков с `%ld` верны, пока числа влезают в 32 бита.
- Нет `syscall(...)`: системные вызовы Windows не документированы, вместо них — функции WinAPI
  (`extern GetStdHandle, WriteFile`), см. [tests/x64/cases/showcase.hla](../tests/x64/cases/showcase.hla).
- Нет `rbit()` (нет такой инструкции); `clz()` использует `lzcnt` (Haswell и новее).
- 8 регистров для `let` вместо 10 — в больших функциях переиспользуйте переменные или берите `local`.
- `extern`-функции вызываются напрямую (`call printf`); для функций из DLL линковщик вставляет
  переходник `jmp [__imp_printf]`, для статически скомпонованного кода на C — прямой вызов.
- Встроенный ассемблер — синтаксис Intel: `mov r8, v` / `and r8, 1` / `add count, r8`; псевдонимы
  подставляются так же. Комментарии в `asm { }` — `//` (`;` в LLVM-диалекте разделяет команды).
- Программа начинается с `hla_start`: он вызывает `main` и завершает процесс через `exit()` из
  `msvcrt.dll` (буферы `printf` сбрасываются). Импорты: `kernel32.dll` для WinAPI, `msvcrt.dll` для
  остального.

## Библиотеки для C

`lib --target x64-windows` создаёт:

| файл | для чего |
|---|---|
| `name.h` | заголовок; `#define NAME_DLL` перед `#include` — объявления с `__declspec(dllimport)` для DLL |
| `name_static.lib` | статическая библиотека (архив MS с `name.obj`) |
| `name.dll` + `name.lib` | DLL с таблицей экспорта и библиотека импорта для неё (байт-в-байт как у `llvm-lib /def`) |
| `name.obj` | объектный файл |

```bat
clang main.c mathlib_static.lib -o demo.exe                  :: статически
clang -DMATHLIB_DLL main.c mathlib.lib -o demo.exe           :: через DLL (mathlib.dll рядом с demo.exe)
cl /DMATHLIB_DLL main.c mathlib.lib                          :: то же с MSVC
```

Наоборот, программа на HLA64 вызывает C: `node src/cli.ts obj app.hla --target x64-windows`,
затем `clang app.obj helpers.c -o app.exe` (точка входа — `main` из CRT или `hla_start` с `/entry:hla_start`).
Пример целиком: [tests/x64/lib](../tests/x64/lib).

## Страница

Переключатель **Platform: macOS / Windows** в самом верху меняет примеры, конвейер и вкладки:
**PE / COFF** (секции, импорты по DLL, экспорт), машинный код побайтно (префиксы, REX, opcode,
ModRM…), консоль эмулятора x64. **Download .exe** — неподписанный файл; Windows помечает
скачанное «Mark of the Web», SmartScreen может спросить (Подробнее → Выполнить в любом случае) или
`Unblock-File .\prog.exe`. **Copy PowerShell command** кладёт в буфер команду, которая воссоздаёт
файлы из base64 прямо в PowerShell — без скачивания и без пометки. Для библиотек — zip с `.h`,
`.lib`/`.dll`, `main.c` и `build.bat` (clang или cl).

## Что проверено и как

| | |
|---|---|
| кодировка | 987 форм инструкций бит-в-бит с `clang --target=x86_64-pc-windows-msvc` (`npm run test:x64-encoding`) |
| объектные файлы | секции, релокации и unwind-информация совпадают с clang; линкуются `lld-link` (`npm run test:coff`) |
| программы | 5 программ для x64 + 66 переносимых программ из уроков в эмуляторе; `--clang`: тот же ассемблер через clang + lld-link (`npm run test:x64`) |
| фаззер | каждое случайное выражение считается на ARM (натив и эмулятор) и в эмуляторе x64 (`npm run fuzz`) |
| C | C от clang + наша статическая библиотека / DLL + библиотека импорта через lld-link; программа на HLA64, вызывающая C (`npm run test:x64-lib`) |

Всё это — на macOS через эмулятор. На самой Windows тесты дополнительно запускают `.exe` нативно
(`tests/x64.ts`, `tests/x64-lib.ts` сравнивают вывод с эмулятором).
