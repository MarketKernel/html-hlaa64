# copyrel.s — code that is not position independent uses the library's variable call_count directly,
# so the linker copies it into the program (an R_X86_64_COPY relocation): libmathlib.so must then use
# the program's copy, which it reaches through its GOT
.intel_syntax noprefix
.text
.globl main
main:
    push rbx
    mov qword ptr [rip + call_count], 100     # the program's copy
    mov edi, 12
    mov esi, 18
    call gcd                                  # the library counts in the same variable
    mov rsi, rax
    mov rdx, qword ptr [rip + call_count]
    lea rdi, [rip + fmt]
    xor eax, eax
    call printf
    mov qword ptr [rip + counter], 10         # libcounter.so: a variable and a table with its address
    call bump
    call same
    mov rdx, rax
    mov rsi, qword ptr [rip + counter]
    lea rdi, [rip + fmt2]
    xor eax, eax
    call printf
    xor eax, eax
    pop rbx
    ret

.section .rodata
fmt:
    .asciz "gcd = %ld, call_count = %ld\n"
fmt2:
    .asciz "counter = %ld, the table points at it: %ld\n"

.section .note.GNU-stack,"",@progbits
