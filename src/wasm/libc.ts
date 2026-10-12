// The system of a wasm32 program: the C library functions the JavaScript runtime (src/wasm/runtime.ts)
// gives the module as imports. The translator checks `extern` names against this list (a typo is a
// build error, like an unknown DLL export on Windows) and takes the result type from it.
//
// Calling convention of an import:
//   * every argument is an i64 (integers, pointers) or an f64 (floating point), in source order;
//   * a function declared with `...` (`extern printf(fmt, ...)`) is imported from the module "va":
//     the fixed arguments come first, then one i32 — the address of the variadic arguments, written
//     by the caller into its frame, 8 bytes each (f64 values as their bits), like clang's wasm32 ABI;
//   * functions without `...` are imported from "env" and get all their arguments directly;
//   * the result is an i64, or an f64 for the functions in FLOAT_RESULT.

/** C functions the runtime implements */
export const LIBC = [
  // output, files
  'puts', 'putchar', 'putc', 'fputc', 'fputs', 'printf', 'fprintf', 'dprintf', 'sprintf', 'snprintf', 'fflush',
  'fopen', 'fclose', 'fread', 'fwrite', 'fseek', 'ftell', 'feof', 'write', 'read', 'getchar',
  // process
  'exit', '_exit', 'abort', 'getenv', 'system', 'time', 'clock', 'sleep', 'usleep',
  // strings and memory
  'strlen', 'strcmp', 'strncmp', 'strcpy', 'strncpy', 'strcat', 'strchr', 'memcpy', 'memmove', 'memset', 'bzero', 'memcmp',
  'malloc', 'calloc', 'realloc', 'free', 'atoi', 'atol', 'strtol', 'atof', 'abs', 'labs', 'qsort',
  'rand', 'srand', 'arc4random', 'arc4random_uniform', 'toupper', 'tolower', 'isdigit', 'isalpha', 'isspace',
  // math
  'sqrt', 'sin', 'cos', 'tan', 'atan', 'atan2', 'exp', 'log', 'log10', 'pow', 'floor', 'ceil', 'round', 'fabs', 'fmod',
] as const;

/** functions that return a double */
export const FLOAT_RESULT = new Set<string>([
  'sqrt', 'sin', 'cos', 'tan', 'atan', 'atan2', 'exp', 'log', 'log10', 'pow', 'floor', 'ceil', 'round', 'fabs', 'fmod', 'atof',
]);

export const LIBC_SET = new Set<string>(LIBC);

/** the arguments of each function as C declares them: i = an integer or a pointer (i64), F = a double
 *  (f64), ... = variadic. A call through the sugar takes its types from the arguments instead; this is
 *  for `call puts` written as an instruction. */
export const PARAMS: Record<string, string> = {
  puts: 'i', putchar: 'i', putc: 'ii', fputc: 'ii', fputs: 'ii', printf: 'i...', fprintf: 'ii...', dprintf: 'ii...',
  sprintf: 'ii...', snprintf: 'iii...', fflush: 'i', fopen: 'ii', fclose: 'i', fread: 'iiii', fwrite: 'iiii', fseek: 'iii',
  ftell: 'i', feof: 'i', write: 'iii', read: 'iii', getchar: '', exit: 'i', _exit: 'i', abort: '', getenv: 'i', system: 'i',
  time: 'i', clock: '', sleep: 'i', usleep: 'i', strlen: 'i', strcmp: 'ii', strncmp: 'iii', strcpy: 'ii', strncpy: 'iii',
  strcat: 'ii', strchr: 'ii', memcpy: 'iii', memmove: 'iii', memset: 'iii', bzero: 'ii', memcmp: 'iii', malloc: 'i',
  calloc: 'ii', realloc: 'ii', free: 'i', atoi: 'i', atol: 'i', strtol: 'iii', atof: 'i', abs: 'i', labs: 'i', qsort: 'iiii',
  rand: '', srand: 'i', arc4random: '', arc4random_uniform: 'i', toupper: 'i', tolower: 'i', isdigit: 'i', isalpha: 'i',
  isspace: 'i', sqrt: 'F', sin: 'F', cos: 'F', tan: 'F', atan: 'F', atan2: 'FF', exp: 'F', log: 'F', log10: 'F', pow: 'FF',
  floor: 'F', ceil: 'F', round: 'F', fabs: 'F', fmod: 'FF',
};

/** linear memory layout of a program */
export const DATA_BASE = 1024;              // addresses below are never used (0 is NULL)
export const STACK_SIZE = 1 << 20;          // the shadow stack (frames: local arrays, variadic arguments)
