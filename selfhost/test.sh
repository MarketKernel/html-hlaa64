#!/bin/sh
# Builds the HLA64 toolchain written in HLA64 and checks it on macOS (Apple Silicon).
#   ./test.sh          AArch64 and x86-64 (the x86-64 programs run in the built-in emulator)
#   ./test.sh arm      AArch64 only
#
# AArch64 / macOS — hlc (HLA64 -> assembly) and hlas (assembly -> signed Mach-O executable):
#   1. hlc1, hlas1 = hlc-arm.hla, hlas-arm.hla built by the TypeScript toolchain (node ../src/cli.ts)
#   2. hlc2, hlas2 = both sources translated by hlc1 and assembled by hlas1; hlas1's executables
#      must be byte for byte those of the TypeScript linker
#   3. hlc2 and hlas2 rebuild themselves: the same bytes again (no TypeScript involved)
#   4. tests/**/*.hla with a .expected file: hlc2 + hlas2, run, compared;
#      with a .error file: hlc2 must stop with exactly that message;
#      hello.s (the input of the assembler example in the workbench) is what hlc2 makes of hello.hla
# x86-64 / Windows — the same tools for Windows, made and checked on macOS:
#   5. hlcx, hlasx = hlc-x64.hla, hlas-x64.hla built by hlc2 + hlas2: they run here and write
#      x86-64 assembly / Windows executables; hello-x64.s is what hlcx makes of hello.hla
#   6. hlc.exe, hlas.exe = both sources translated by hlcx, assembled by hlasx: byte for byte the
#      executables of the TypeScript PE linker
#   7. the tests: hlcx + hlasx, the .exe run in the x86-64 emulator
#   8. in the emulator, hlc.exe translates hlc-x64.hla and hlas.exe assembles hlas-x64's assembly:
#      the same bytes again (the Windows tools rebuild themselves)
#   9. all four tools built for Windows by the TypeScript toolchain (as the workbench example does),
#      run in the emulator on hello.hla: the same files as the tools built here
# Everything goes to build/.
set -e
cd "$(dirname "$0")"
HLA="node $(cd .. && pwd)/src/cli.ts"
mkdir -p build
pass=0
fail=0

ok() { echo "   ok   $1"; pass=$((pass + 1)); }
bad() { echo "   FAIL $1"; fail=$((fail + 1)); }

# run_tests HLC TARGET: every test with a .expected file
run_tests() {
  for src in $(find tests -name '*.hla' | sort); do
    exp="${src%.hla}.expected"
    [ -f "$exp" ] || continue
    name=$(echo "${src%.hla}" | tr '/' '_')-$2
    if ! "$1" "$src" "build/$name.s" > "build/$name.out" 2>&1; then
      bad "$src: $(head -1 "build/$name.out")"
      continue
    fi
    if [ "$2" = arm ]; then
      if ! ./build/hlas2 "build/$name.s" "build/$name" > "build/$name.out" 2>&1; then
        bad "$src (hlas): $(head -1 "build/$name.out")"
        continue
      fi
      mkdir -p build/ts
      $HLA asm "build/$name.s" -o "build/ts/$name"
      if ! cmp -s "build/$name" "build/ts/$name"; then
        bad "$src: hlas and the TypeScript linker made different executables"
        continue
      fi
      ./build/"$name" > "build/$name.out" 2>&1 || true
    else
      if ! ./build/hlasx "build/$name.s" "build/$name.exe" > "build/$name.out" 2>&1; then
        bad "$src (hlas-x64): $(head -1 "build/$name.out")"
        continue
      fi
      mkdir -p build/ts
      $HLA asm "build/$name.s" --target x64-windows -o "build/ts/$name.exe"
      if ! cmp -s "build/$name.exe" "build/ts/$name.exe"; then
        bad "$src: hlas-x64 and the TypeScript linker made different executables"
        continue
      fi
      $HLA emu "build/$name.exe" > "build/$name.out" 2>/dev/null || true
    fi
    if cmp -s "build/$name.out" "$exp"; then ok "$src"; else bad "$src: the output differs (diff build/$name.out $exp)"; fi
  done
}

echo "1. hlc1, hlas1: built by the TypeScript toolchain"
$HLA build hlc-arm.hla -o build/hlc1
$HLA build hlas-arm.hla -o build/hlas1

echo "2. hlc2, hlas2: translated by hlc1, assembled by hlas1"
mkdir -p build/s2 build/s3 build/ts
for tool in hlc hlas; do
  ./build/hlc1 $tool-arm.hla build/s2/$tool.s
  ./build/hlas1 build/s2/$tool.s build/s2/$tool
  $HLA asm build/s2/$tool.s -o build/ts/$tool
  if cmp -s build/s2/$tool build/ts/$tool; then ok "$tool: the same bytes as the TypeScript linker"; else bad "$tool: build/s2/$tool and build/ts/$tool differ"; fi
done
cp build/s2/hlc build/hlc2
cp build/s2/hlas build/hlas2

echo "3. hlc2 and hlas2 rebuild themselves"
for tool in hlc hlas; do
  ./build/hlc2 $tool-arm.hla build/s3/$tool.s
  ./build/hlas2 build/s3/$tool.s build/s3/$tool
  if cmp -s build/s3/$tool build/s2/$tool; then
    ok "$tool: the same executable ($(wc -c < build/s3/$tool | tr -d ' ') bytes)"
  else
    bad "$tool: build/s3/$tool and build/s2/$tool differ"
  fi
done

echo "4. tests (AArch64)"
run_tests ./build/hlc2 arm
for src in $(find tests -name '*.hla' | sort); do
  err="${src%.hla}.error"
  [ -f "$err" ] || continue
  if ./build/hlc2 "$src" build/error.s > build/error.out 2>&1; then
    bad "$src: no error"
  elif cmp -s build/error.out "$err"; then
    ok "$src (error)"
  else
    bad "$src: $(head -1 build/error.out)"
  fi
done
./build/hlc2 hello.hla build/hello-now.s
if cmp -s build/hello-now.s hello.s; then ok "hello.s is up to date"; else bad "hello.s is out of date: ./build/hlc2 hello.hla hello.s"; fi

if [ "$1" != arm ]; then
  echo "5. hlcx, hlasx: the Windows tools built to run here"
  mkdir -p build/w
  ./build/hlc2 hlc-x64.hla build/hlcx.s
  ./build/hlas2 build/hlcx.s build/hlcx
  ./build/hlc2 hlas-x64.hla build/hlasx.s
  ./build/hlas2 build/hlasx.s build/hlasx
  ./build/hlcx hello.hla build/hello-x64-now.s
  if cmp -s build/hello-x64-now.s hello-x64.s; then ok "hello-x64.s is up to date"; else bad "hello-x64.s is out of date: ./build/hlcx hello.hla hello-x64.s"; fi

  echo "6. hlc.exe, hlas.exe: translated by hlcx, assembled by hlasx"
  for tool in hlc hlas; do
    ./build/hlcx $tool-x64.hla build/w/$tool.s
    ./build/hlasx build/w/$tool.s build/w/$tool.exe
    $HLA asm build/w/$tool.s --target x64-windows -o build/ts/$tool.exe
    if cmp -s build/w/$tool.exe build/ts/$tool.exe; then ok "$tool.exe: the same bytes as the TypeScript linker"; else bad "$tool.exe: build/w/$tool.exe and build/ts/$tool.exe differ"; fi
  done

  echo "7. tests (x86-64, in the emulator)"
  run_tests ./build/hlcx x64

  echo "8. in the emulator: hlc.exe and hlas.exe rebuild themselves"
  mkdir -p build/w2
  (cd build/w && $HLA emu hlc.exe -- ../../hlc-x64.hla ../w2/hlc.s 2>/dev/null)
  if cmp -s build/w2/hlc.s build/w/hlc.s; then ok "hlc.exe: the same assembly ($(wc -l < build/w/hlc.s | tr -d ' ') lines)"; else bad "hlc.exe: build/w2/hlc.s and build/w/hlc.s differ"; fi
  (cd build/w && $HLA emu hlas.exe -- hlas.s ../w2/hlas.exe 2>/dev/null)
  if cmp -s build/w2/hlas.exe build/w/hlas.exe; then ok "hlas.exe: the same executable ($(wc -c < build/w/hlas.exe | tr -d ' ') bytes)"; else bad "hlas.exe: build/w2/hlas.exe and build/w/hlas.exe differ"; fi

  echo "9. every tool built for Windows by the TypeScript toolchain, run on hello.hla"
  mkdir -p build/h build/wts
  ./build/hlc2 hello.hla build/h/hello.s
  ./build/hlas2 build/h/hello.s build/h/hello
  ./build/hlcx hello.hla build/h/hello-x64.s
  ./build/hlasx build/h/hello-x64.s build/h/hello.exe
  cp hello.hla build/h/hello.s build/h/hello-x64.s build/wts/
  for step in "hlc-arm hello.hla hello.s" "hlas-arm hello.s hello" "hlc-x64 hello.hla hello-x64.s" "hlas-x64 hello-x64.s hello.exe"; do
    set -- $step
    $HLA build $1.hla --target x64-windows -o build/wts/$1.exe
    rm -f build/wts/$3
    (cd build/wts && $HLA emu $1.exe -- $2 $3 > /dev/null 2>&1)
    if cmp -s build/wts/$3 build/h/$3; then ok "$1.exe (TypeScript): $3 as made here"; else bad "$1.exe (TypeScript): build/wts/$3 and build/h/$3 differ"; fi
  done
fi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
