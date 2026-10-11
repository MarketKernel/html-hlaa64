#!/bin/sh
# Lesson 14: build and run both examples. Run it from this directory: sh build.sh
set -e
HLA=${HLA:-"node ../../../src/cli.ts"}

# 1. an HLA64 library used from C
$HLA lib mathlib.hla                 # -> mathlib.h, mathlib.o, libmathlib.a, libmathlib.dylib
clang -Wall main.c libmathlib.a -o demo_static
clang -Wall main.c -L. -lmathlib -Wl,-rpath,@executable_path -o demo_dynamic
./demo_static
./demo_dynamic | tail -1

# 2. an HLA64 program that calls C
$HLA obj app.hla                     # -> app.o
clang app.o helpers.c -o app
./app
