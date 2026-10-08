// The Python bot's logging.getLogger(name), over the platform's console.

// Python's "%s" formatting, so log calls port without rewording.
function format(message, args) {
  let i = 0;
  return message.replace(/%(\.\d+f|d|s|r)/g, (_m, spec) => {
    const value = args[i++];
    if (spec === 'd') return String(Math.trunc(Number(value)));
    if (spec === 'r') return JSON.stringify(value);
    if (spec.endsWith('f')) return Number(value).toFixed(Number(spec.slice(1, -1)));
    return value instanceof Error ? value.message : String(value);
  });
}

// Tests only: when set, records go here instead of the console.
let captured = null;

export function _capture(sink) {
  captured = sink;
}

function emit(name, level, message, args) {
  const text = format(message, args);
  if (captured) {
    captured.push({ name, level, message: text });
    return;
  }
  const line = `[${name}] ${text}`;
  if (level === 'error') console.error(line);
  else if (level === 'warning') console.warn(line);
  else console.info(line);
}

export function logger(name) {
  return {
    info: (message, ...args) => emit(name, 'info', message, args),
    warning: (message, ...args) => emit(name, 'warning', message, args),
    error: (message, ...args) => emit(name, 'error', message, args),
  };
}
