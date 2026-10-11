# HLA64 для Windows x64

<!-- languages -->
<h3 align="center">
<a href="../windows.md">🇬🇧 English</a> ·
<b>🇷🇺 Русский</b>
</h3>
<!-- /languages -->

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
node src/cli.ts build prog.hla --target x64-windows --clang     # собрать через clang + lld-link (нужен только LLVM)
node src/cli.ts run   prog.hla -- one "two words"               # аргументы после -- получает main(argc, argv) (и в emu)
```

`--clang` собирает тот же ассемблер clang'ом и линкует lld-link с той же точкой входа `hla_start`
и теми же DLL, что и встроенный линковщик (библиотеки импорта пишет `writeImportLibrary`): Visual
Studio и её C runtime не нужны.

## Регистры и соглашение о вызовах (Win64)

| | |
|---|---|
| целые аргументы | `rcx`, `rdx`, `r8`, `r9`, дальше — стек (после 32 байт shadow space) |
| FP-аргументы | `xmm0`–`xmm3` **по позиции**: `f(a, x: f64)` — `a` в `rcx`, `x` в `xmm1` |
| результат | `rax` / `xmm0` |
| портятся при вызове | `rax rcx rdx r8–r11 xmm0–xmm5` |
| сохраняются | `rbx rbp rsi rdi r12–r15 xmm6–xmm15` — пролог сохраняет те, что встретились в функции |
| `let x = …` без регистра | один из `rbx rsi rdi r12–r15 rbp` (8 штук; на ARM их 10), дальше — слот в кадре |
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
  (`extern GetStdHandle, WriteFile`), см. [tests/x64/cases/showcase.hla](../../tests/x64/cases/showcase.hla).
  Для файлов проще `include "std/file.hla"`: `read_file`, `write_file`, `file_open` … называются и
  работают одинаково на Windows и macOS (поверх C runtime, в двоичном режиме — `\n` остаётся `\n`),
  см. [справочник](language.md#файлы-stdfilehla).
- Нет `rbit()` (нет такой инструкции); `clz()` использует `lzcnt` (Haswell и новее).
- 8 регистров для `let` вместо 10: в больших функциях лишние переменные вытесняются в кадр
  (`// x -> frame` в ассемблере) и читаются операндами из памяти (`add r10, qword ptr [rsp + …]`).
- `extern`-функции вызываются напрямую (`call printf`); для функций из DLL линковщик вставляет
  переходник `jmp [__imp_printf]`, для статически скомпонованного кода на C — прямой вызов.
- Инструкции в коде — синтаксис Intel: `mov r8, v` / `and r8, 1` / `add count, r8` /
  `cmovg rax, hi` / `lea rcx, [rip + text]` + `call puts`; псевдонимы, параметры и метки
  подставляются так же. `call имя(…)` со скобками — вызов из сахара (форма hlaa64), без скобок —
  инструкция. Комментарии в `asm { }` — `//` (`;` в LLVM-диалекте разделяет команды). Пример —
  [tests/x64/cases/mixed.hla](../../tests/x64/cases/mixed.hla).
- Программа начинается с `hla_start`: он вызывает `main` и завершает процесс через `exit()` из
  `msvcrt.dll` (буферы `printf` сбрасываются). Если у `main` есть параметры (`argc, argv, envp`),
  `hla_start` сначала получает их от `__getmainargs` из `msvcrt.dll`. Линковщик берёт каждую `extern`-функцию из той DLL,
  которая её экспортирует: `msvcrt.dll`, `kernel32.dll` или `user32.dll` (списки экспорта Windows 11
  встроены — `src/asm/coff/winapi.ts`, обновляет `node tools/gen-winapi.ts`). Имя, которого нет ни
  в программе, ни в этих DLL (опечатка), — ошибка сборки с номером строки, а не `.exe`, который
  Windows откажется загружать.

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
cl main.c mathlib_static.lib                                 :: то же с MSVC
cl /DMATHLIB_DLL main.c mathlib.lib
```

Эти команды работают в **x64 Native Tools Command Prompt** (или Developer PowerShell): `cl`
есть только там, а `clang` нужны оттуда же `INCLUDE`/`LIB` — заголовки и C runtime из Visual
Studio и Windows SDK (clang 23 сам не находит Visual Studio 2026), к тому же установщик LLVM не
добавляет `clang` в PATH. `build.bat` со страницы находит всё сам (`vswhere` → `vcvars64.bat`,
`%ProgramFiles%\LLVM\bin`).

Заголовок проверяет раскладку структур (`MATHLIB_STATIC_ASSERT`): в C11 и clang это
`_Static_assert`, в C++ — `static_assert`, а в режиме C у `cl` по умолчанию (без `/std:c11`, где
`_Static_assert` нет) — массив отрицательного размера.

Если библиотека сама вызывает функцию, которую определяет программа на C (`extern guarded` в
[tests/x64/seh/seh.hla](../../tests/x64/seh/seh.hla)), DLL из неё не собрать — в Windows DLL не может
ссылаться на функции загрузившей её программы. `lib` тогда пишет только статическую библиотеку и
объясняет, почему DLL нет.

Наоборот, программа на HLA64 вызывает C: `node src/cli.ts obj app.hla --target x64-windows`,
затем `clang app.obj helpers.c -o app.exe` или `cl app.obj helpers.c` (точка входа — `main` из CRT),
либо `link /entry:hla_start app.obj helpers.obj msvcrt.lib`, где `msvcrt.lib` — библиотека импорта
самого `msvcrt.dll` (`lib /def:msvcrt.def /machine:x64`; `msvcrt.lib` из SDK — это стартовый код UCRT).
Пример целиком: [tests/x64/lib](../../tests/x64/lib).

## Исключения (SEH)

Для каждой функции ассемблер строит `.pdata`/`.xdata` из директив `.seh_*`, поэтому структурные
исключения Windows проходят сквозь код на HLA64: `__try`/`__except` в C ловит `RaiseException` из
колбэка, вызванного функцией на HLA64, и access violation внутри неё самой; все сохраняемые регистры
(`rbx rbp rsi rdi r12–r15 xmm6–xmm15`) восстанавливаются, `RtlCaptureStackBackTrace` видит каждый
кадр. Тест — [tests/x64/seh](../../tests/x64/seh): кадры больше 4 КБ, все nonvolatile-регистры, сборка
C через `cl` (`/Od`, `/O2`) и `clang`; unwind-информация совпадает с clang байт-в-байт.

## Страница

Переключатель **Platform: macOS / Windows** в самом верху меняет примеры, проекты на панели слева
(у каждой платформы свои), конвейер и вкладки:
**PE / COFF** (секции, импорты по DLL, экспорт), машинный код побайтно (префиксы, REX, opcode,
ModRM…), консоль эмулятора x64. **Download .exe** — неподписанный файл; Chrome и Edge помечают
скачанное «Mark of the Web» (`Zone.Identifier`, `ZoneId=3`). При запуске из Проводника SmartScreen
может спросить (Подробнее → Выполнить в любом случае); из PowerShell файл запускается как есть,
`Unblock-File .\prog.exe` снимает пометку насовсем. **Copy PowerShell command** кладёт в буфер команду
(4–11 КБ для примеров), которая воссоздаёт файлы из base64 прямо в PowerShell 5.1 или 7 — без
скачивания и без пометки. Для библиотек — zip с `.h`, `.lib`/`.dll`, `main.c` и `build.bat`;
`build.bat` подключает окружение Visual Studio (`vswhere` → `vcvars64.bat`) и собирает clang'ом
или `cl`, поэтому работает из обычной консоли. PowerShell-команда для библиотеки пишет тот же
`build.bat` и запускает его.

## Что проверено и как

| | |
|---|---|
| кодировка | 987 форм инструкций бит-в-бит с `clang --target=x86_64-pc-windows-msvc` (`npm run test:x64-encoding`) |
| объектные файлы | секции, релокации и unwind-информация совпадают с clang; линкуются `lld-link` (`npm run test:coff`) |
| программы | 5 программ для x64 + 66 переносимых программ из уроков в эмуляторе; `--clang`: тот же ассемблер через clang + lld-link (`npm run test:x64`) |
| фаззер | каждое случайное выражение считается на ARM (натив и эмулятор) и в эмуляторе x64 (`npm run fuzz`) |
| C | C от clang + наша статическая библиотека / DLL + библиотека импорта через lld-link; программа на HLA64, вызывающая C (`npm run test:x64-lib`) |
| **Windows, нативно** | Windows 11 x64: все 71 программа `test:x64` запускаются как `.exe`, вывод и код возврата совпадают с эмулятором; C + `.lib`/`.dll`, HLA64 + C — тоже нативно |
| **MSVC** | Visual Studio 2026 (`cl` 19.51): `main.c` урока 14 (`<stdio.h>`, `/W4`) со статической библиотекой и DLL; `cl app.obj helpers.c`; `link /entry:hla_start` с нашей библиотекой импорта `msvcrt.dll`; `lib /list`, `dumpbin /exports /all /unwindinfo` — без предупреждений (`test:x64-lib`, MSVC находится через `vswhere`) |
| **SEH** | исключения сквозь кадры HLA64 ловятся `__except`, 18 сохраняемых регистров восстанавливаются, стек виден целиком; `.xdata` = clang (`test:x64-lib`) |
| **страница** | Chrome и Edge, `file://`: скачанные `.exe` и zip, `build.bat` (clang и cl) и PowerShell-команды всех примеров выполнены в PowerShell 5.1 и 7 из обычной консоли, в каталоге с пробелами; команда для DLL-библиотеки вставлена вручную в окно PowerShell (PSReadLine) — собирается и работает |
| **CLI** | `run`, `build`, `obj`, `lib`, `emu`, `compile`, `--clang` из обычной консоли; пути с пробелами |

На macOS всё проверяется через эмулятор; на Windows тесты дополнительно запускают `.exe` нативно
(`tests/x64.ts`, `tests/x64-lib.ts` сравнивают вывод с эмулятором) и, если установлена Visual Studio,
собирают C через MSVC. LLVM ищется в PATH и в `C:\Program Files\LLVM\bin`.
