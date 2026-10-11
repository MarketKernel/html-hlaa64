// seh.c — structured exceptions thrown through HLA64 frames (see seh.hla); cl or clang, Windows x64
#include <windows.h>
#include <stdio.h>
#include "seh.h"

#define MY_EXCEPTION 0xE0484C41u          // "HLA"

typedef int64_t (*hla_fn)(void *);

static const char *name_of(DWORD64 begin, DWORD64 base);

// called by deep(): shows the call stack Windows sees, then raises
static void raise_cb(void) {
    void *pcs[32];
    USHORT n = RtlCaptureStackBackTrace(0, 32, pcs, NULL);
    printf("stack:");
    for (USHORT i = 0; i < n; i++) {
        DWORD64 base = 0;
        PRUNTIME_FUNCTION f = RtlLookupFunctionEntry((DWORD64)pcs[i], &base, NULL);
        const char *name = f ? name_of(base + f->BeginAddress, base) : NULL;
        if (name) printf(" %s", name);
    }
    printf("\n");
    RaiseException(MY_EXCEPTION, 0, 0, NULL);
}

static void return_cb(void) {}

// f(arg) under __try; the HLA64 function check() calls this
int64_t guarded(void *f, void *arg) {
    __try {
        int64_t r = ((hla_fn)f)(arg);
        printf("returned %lld\n", r);
        return 0;
    } __except (GetExceptionCode() == MY_EXCEPTION || GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION
                    ? EXCEPTION_EXECUTE_HANDLER : EXCEPTION_CONTINUE_SEARCH) {
        printf("caught %s\n", GetExceptionCode() == MY_EXCEPTION ? "RaiseException" : "access violation");
        return 1;
    }
}

int main(void) {
    printf("lost registers: %lld\n", check((void *)deep, (void *)raise_cb));
    printf("lost registers: %lld\n", check((void *)fault, NULL));
    printf("lost registers: %lld\n", check((void *)deep, (void *)return_cb));
    return 0;
}

// the functions on the expected stack, by start address (from their .pdata entries)
static const char *name_of(DWORD64 begin, DWORD64 base) {
    static const struct { void *fn; const char *name; } known[] = {
        { (void *)raise_cb, "raise_cb" }, { (void *)deep, "deep" }, { (void *)guarded, "guarded" },
        { (void *)check, "check" }, { (void *)main, "main" },
    };
    for (size_t i = 0; i < sizeof known / sizeof known[0]; i++) {
        DWORD64 b = 0;
        PRUNTIME_FUNCTION f = RtlLookupFunctionEntry((DWORD64)known[i].fn, &b, NULL);
        if (f && b == base && b + f->BeginAddress == begin) return known[i].name;
    }
    return NULL;
}
