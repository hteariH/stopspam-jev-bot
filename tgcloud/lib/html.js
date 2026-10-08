// Python's html.escape (quote=True) and string slicing, which the ported
// modules depend on character for character.

export function escape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Length and slicing in code points, as Python counts a str. JS strings are
// UTF-16, so an emoji would otherwise count twice and could be cut in half.
export function length(value) {
  return Array.from(value).length;
}

export function slice(value, start, end = undefined) {
  return Array.from(value).slice(start, end).join('');
}
