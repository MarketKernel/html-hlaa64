# Hand-written Windows x64 program used to check the assembler, the COFF writer,
# the PE linker and the emulator against clang/lld-link.
.intel_syntax noprefix
.text

.globl main
.seh_proc main
main:
    push rbp
    .seh_pushreg rbp
    push rbx
    .seh_pushreg rbx
    sub rsp, 56
    .seh_stackalloc 56
    movaps xmmword ptr [rsp + 32], xmm6
    .seh_savexmm xmm6, 32
    .seh_endprologue
    lea rcx, [rip + hello]
    call qword ptr [rip + __imp_puts]
    xor ebx, ebx
.Lloop:                              # short backward jump
    lea rcx, [rip + fmt]
    mov rdx, rbx
    mov r8, rbx
    imul r8, rbx
    imul r8, qword ptr [rip + squares + 8*0]
    call qword ptr [rip + __imp_printf]
    inc rbx
    cmp rbx, 5
    jl .Lloop
    call sum_table
    lea rcx, [rip + fmt_sum]
    mov rdx, rax
    call qword ptr [rip + __imp_printf]
    mov rax, qword ptr [rip + ptrs + 8]
    mov rcx, rax
    call qword ptr [rip + __imp_puts]
    inc qword ptr [rip + counter]
    cmp qword ptr [rip + counter], 1
    jne .Lfar                        # long forward jump over the padding
    .p2align 4
    .space 200, 0x90
.Lfar:
    mov rax, qword ptr [rip + counter]
    movaps xmm6, xmmword ptr [rsp + 32]
    add rsp, 56
    pop rbx
    pop rbp
    ret
.seh_endproc

# leaf function: no unwind info needed
sum_table:
    xor eax, eax
    xor ecx, ecx
1:
    add rax, qword ptr [rip + table + 8*0]
    lea rdx, [rip + table]
    add rax, qword ptr [rdx + 8*rcx]
    inc ecx
    cmp ecx, 4
    jb 1b
    ret

.section .rdata,"dr"
hello:   .asciz "hello from x64"
fmt:     .asciz "%lld^2 = %lld\n"
fmt_sum: .asciz "sum = %lld\n"
first:   .asciz "first"
second:  .asciz "second"
.p2align 3
squares: .quad 1

.data
.p2align 3
table:   .quad 10, 20, 30, 40
ptrs:    .quad first, second
counter: .quad 0

.bss
buffer:  .zero 64
