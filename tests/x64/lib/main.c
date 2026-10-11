// main.c — a C program that uses the HLA64 library (Windows; no SDK headers needed)
#include "mathlib.h"

int printf(const char *fmt, ...);
int _fltused;                            // normally provided by the C runtime library

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
