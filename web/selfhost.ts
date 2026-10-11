// Two examples made of the sources of selfhost/ (the HLA64 toolchain written in HLA64):
//   the translator (hlc: HLA64 -> assembly) and the assembler with its linker (hlas: assembly ->
//   executable). Either tool of a pair can be the main file; `args` are the command line each one
//   runs with in the emulator.
import hlcArm from '../selfhost/hlc-arm.hla';
import hlcX64 from '../selfhost/hlc-x64.hla';
import hlasArm from '../selfhost/hlas-arm.hla';
import hlasX64 from '../selfhost/hlas-x64.hla';
import hello from '../selfhost/hello.hla';
import helloArm from '../selfhost/hello.s';
import helloX64 from '../selfhost/hello-x64.s';
import libSys from '../selfhost/lib/sys.hla';
import libText from '../selfhost/lib/text.hla';
import libIntern from '../selfhost/lib/intern.hla';
import libSha256 from '../selfhost/lib/sha256.hla';
import frontNames from '../selfhost/front/names.hla';
import frontLexer from '../selfhost/front/lexer.hla';
import frontAst from '../selfhost/front/ast.hla';
import frontParser from '../selfhost/front/parser.hla';
import frontConsts from '../selfhost/front/consts.hla';
import frontCodegen from '../selfhost/front/codegen.hla';
import frontDriver from '../selfhost/front/driver.hla';
import armBackend from '../selfhost/arm/backend.hla';
import armEncode from '../selfhost/arm/encode.hla';
import armMacho from '../selfhost/arm/macho.hla';
import asmCore from '../selfhost/asm/core.hla';
import x64Backend from '../selfhost/x64/backend.hla';
import x64Xenc from '../selfhost/x64/xenc.hla';
import x64Xasm from '../selfhost/x64/xasm.hla';
import x64Pe from '../selfhost/x64/pe.hla';
import x64Winapi from '../selfhost/x64/winapi.hla';

const LIB = {
  'lib/sys.hla': libSys,
  'lib/text.hla': libText,
  'lib/intern.hla': libIntern,
};

/** hlc: hello.hla -> hello.s (AArch64) or hello-x64.s (x86-64) */
export const TRANSLATOR = {
  files: {
    'hlc-arm.hla': hlcArm,
    'hlc-x64.hla': hlcX64,
    'hello.hla': hello,
    ...LIB,
    'front/names.hla': frontNames,
    'front/lexer.hla': frontLexer,
    'front/ast.hla': frontAst,
    'front/parser.hla': frontParser,
    'front/consts.hla': frontConsts,
    'front/codegen.hla': frontCodegen,
    'front/driver.hla': frontDriver,
    'arm/backend.hla': armBackend,
    'x64/backend.hla': x64Backend,
  } as Record<string, string>,
  args: { 'hlc-arm.hla': 'hello.hla hello.s', 'hlc-x64.hla': 'hello.hla hello-x64.s' } as Record<string, string>,
};

/** hlas: hello.s -> hello (Mach-O), hello-x64.s -> hello.exe (PE) */
export const ASSEMBLER = {
  files: {
    'hlas-arm.hla': hlasArm,
    'hlas-x64.hla': hlasX64,
    'hello.s': helloArm,
    'hello-x64.s': helloX64,
    ...LIB,
    'lib/sha256.hla': libSha256,
    'asm/core.hla': asmCore,
    'arm/encode.hla': armEncode,
    'arm/macho.hla': armMacho,
    'x64/xenc.hla': x64Xenc,
    'x64/xasm.hla': x64Xasm,
    'x64/pe.hla': x64Pe,
    'x64/winapi.hla': x64Winapi,
  } as Record<string, string>,
  args: { 'hlas-arm.hla': 'hello.s hello', 'hlas-x64.hla': 'hello-x64.s hello.exe' } as Record<string, string>,
};
