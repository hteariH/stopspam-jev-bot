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

export function logger(name) {
  const prefix = `[${name}]`;
  return {
    info: (message, ...args) => console.info(prefix, format(message, args)),
    warning: (message, ...args) => console.warn(prefix, format(message, args)),
    error: (message, ...args) => console.error(prefix, format(message, args)),
  };
}
