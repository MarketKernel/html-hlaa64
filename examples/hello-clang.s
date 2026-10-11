.global _main
.align 2

_main:
    stp x29, x30, [sp, #-16]!
    mov x29, sp

    adrp x0, message@PAGE
    add x0, x0, message@PAGEOFF
    bl _puts

    mov w0, #0

    ldp x29, x30, [sp], #16
    ret

.section __TEXT,__cstring
message:
    .asciz "Hello from ARM64 assembly!"