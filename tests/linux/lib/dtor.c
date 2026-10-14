// dtor.c — a C shared library with a destructor: the dynamic loader runs it at exit (through _dl_fini,
// which the program's entry point registers with atexit)
#include <stdio.h>

int dtor_hello(void) { return 42; }

__attribute__((destructor)) static void bye(void) { puts("destructor of libdtor.so"); }
