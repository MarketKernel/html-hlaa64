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
