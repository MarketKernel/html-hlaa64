// Expansion of the 8-bit fmov immediate (shared by the emulator).
export function fpImm8Value(i: number): number {
  const sign = (i >> 7) & 1, b = (i >> 6) & 1, cd = (i >> 4) & 3, frac = i & 15;
  const exp = (b ? 0x3fc : 0x400) | cd;
  const bits = (BigInt(sign) << 63n) | (BigInt(exp) << 52n) | (BigInt(frac) << 48n);
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, bits);
  return dv.getFloat64(0);
}
