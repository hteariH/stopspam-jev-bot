// Python's f"{x:.Nf}", which rounds an exact tie to even where
// Number.prototype.toFixed rounds it up (0.125 -> "0.12" in Python, "0.13"
// in JS). Risk scores and day counts are shown to admins and asserted in
// tests, so the two must agree.
export function fixed(x, digits) {
  const value = Number(x);
  if (!Number.isFinite(value)) return String(value);
  const negative = value < 0 || Object.is(value, -0);
  const [whole, fraction] = Math.abs(value).toFixed(digits + 25).split('.');
  if (fraction.slice(digits) !== '5' + '0'.repeat(24)) {
    const text = Math.abs(value).toFixed(digits);
    return negative ? `-${text}` : text;
  }
  // An exact tie: round half to even on the last kept digit.
  const scale = 10 ** digits;
  const kept = Number(whole) * scale + Number(fraction.slice(0, digits) || '0');
  const rounded = kept % 2 === 0 ? kept : kept + 1;
  const text = (rounded / scale).toFixed(digits);
  return negative ? `-${text}` : text;
}
