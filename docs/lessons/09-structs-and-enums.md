# Урок 9. Структуры и перечисления

## Зачем нужны структуры

Допустим, мы храним точки на плоскости: у каждой есть `x` и `y`. Можно положить их в память парами:
`x` по смещению 0, `y` по смещению 8. Тогда для точки по адресу `p` координаты — это `i64[p]` и
`i64[p + 8]`. Работает, но числа 0 и 8 приходится помнить, а при добавлении нового поля — пересчитывать.

**Структура** описывает такую раскладку один раз, а смещения считает транслятор:

```hla
extern printf(fmt, ...)

struct Point {
    x: i64
    y: i64
}

fn main() {
    printf("Point.x = %ld, Point.y = %ld, размер = %ld\n", Point.x, Point.y, sizeof(Point))
}
```

```text
Point.x = 0, Point.y = 8, размер = 16
```

В HLA64 структура — это не новый «тип переменной», а набор **констант-смещений**: `Point.x`, `Point.y`
и `Point.size` (то же, что `sizeof(Point)`). Так структуры и устроены на уровне процессора.

## Массив структур

```hla
extern printf(fmt, ...)

struct Point {
    x: i64
    y: i64
}

data points: Point[4]              // 4 точки по 16 байт, заполнены нулями

fn main() {
    for i in 0..4 {
        let p = &points[i]         // адрес i-й точки: начало + i * 16
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

`[p + Point.y]` без типа читает 8 байт — для полей `i64` этого достаточно. Для полей другого размера
пишите тип: `i32[p + Item.qty]`, `u8[p + Item.flags]`.

## Выравнивание

Процессору удобнее, когда число из 8 байт лежит по адресу, кратному 8. Поэтому транслятор
**выравнивает** поля: перед полем может оказаться пустое место.

```hla
extern printf(fmt, ...)

struct Item {
    flags: u8          // смещение 0, 1 байт
    count: i32         // смещение 4  (1..3 — пустые байты)
    price: i64         // смещение 8
}

fn main() {
    printf("flags=%ld count=%ld price=%ld size=%ld\n", Item.flags, Item.count, Item.price, Item.size)
}
```

```text
flags=0 count=4 price=8 size=16
```

## Функции, работающие со структурами

Структуру передают в функцию по адресу. Пример — склад товаров, у каждого есть название (адрес строки),
количество и цена:

```hla
extern printf(fmt, ...)

struct Product {
    name: ptr
    qty: i32
    price: i64          // цена в копейках
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
    set_product(&stock[0], "карандаш", 120, 1550)
    set_product(&stock[1], "тетрадь", 40, 8900)
    set_product(&stock[2], "ластик", 75, 2000)
    let sum = 0
    for i in 0..3 {
        let p = &stock[i]
        let value = total_value(p)
        x9 = [p + Product.name]
        printf("%s: %d шт. на %ld коп.\n", x9, i32[p + Product.qty], value)
        sum += value
    }
    printf("итого: %ld руб. %ld коп.\n", sum / 100, sum % 100)
}
```

```text
карандаш: 120 шт. на 186000 коп.
тетрадь: 40 шт. на 356000 коп.
ластик: 75 шт. на 150000 коп.
итого: 6920 руб. 0 коп.
```

`%d` печатает 32-битное число — как раз такое поле `qty`.

## Вложенные структуры

Поле может само быть структурой. Смещение вложенного поля — сумма смещений:

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
    printf("размер Rect: %ld, площадь: %ld\n", sizeof(Rect), area(p))
}
```

```text
размер Rect: 32, площадь: 50
```

Поля можно перечислять и в одну строку через запятую, как в `Point`.

## Связный список

Элемент списка хранит значение и **адрес следующего элемента**; у последнего адрес равен нулю.
Чтобы пройти список, переходим по адресам, пока не встретим ноль:

```hla
extern printf(fmt, ...)

struct Node {
    value: i64
    next: ptr
}

data nodes: Node[5]

fn main() {
    // связать элементы в обратном порядке: 4 -> 3 -> 2 -> 1 -> 0
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
    let node = &nodes[4]                 // голова списка
    while node != 0 {
        printf("%ld ", [node + Node.value])
        node = [node + Node.next]        // перейти к следующему
    }
    printf("\n")
}
```

```text
500 400 300 200 100 
```

## Перечисления

`enum` даёт имена последовательным числам — удобно для состояний, видов, направлений:

```hla
extern printf(fmt, ...)

enum Light { Red, Yellow, Green }
enum Http { Ok = 200, NotFound = 404, Teapot = 418 }

rodata light_names: ptr = ["красный", "жёлтый", "зелёный"]

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
    printf("\nвсего сигналов: %ld, код чайника: %ld\n", Light.count, Http.Teapot)
}
```

```text
красный зелёный жёлтый красный 
всего сигналов: 3, код чайника: 418
```

Значения идут с нуля по порядку; можно задать своё (`Ok = 200`), следующие продолжат с него.
`Light.count` — количество (точнее, значение после последнего).

## Упражнения

1. Опишите структуру `Student { age: u8, grade: i32, id: i64 }` и напечатайте смещения полей и размер.
   Объясните, откуда взялись пустые байты.
2. Сделайте массив из 3 прямоугольников `Rect` и найдите тот, у которого площадь наибольшая.

Дальше: [Урок 10. Библиотека C и система](10-c-library-and-syscalls.md)
