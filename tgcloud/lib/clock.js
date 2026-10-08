// Time, in the one format the database has ever stored.
//
// The Python bot wrote datetime.isoformat(timespec="seconds") in UTC -
// "2026-01-01T00:00:00+00:00" - and the SQL compares those strings directly
// (expires_at < now). Date.toISOString() would write "...00.000Z", which sorts
// differently against imported rows, so stamp() reproduces the Python form.

let override = null;

export function now() {
  return override ? override() : new Date();
}

export function stamp(date = now()) {
  return date.toISOString().slice(0, 19) + '+00:00';
}

// datetime.fromisoformat for the stamps we write and the ones Python wrote;
// null for anything unreadable, which callers treat as absent.
export function parse(value) {
  if (!value || typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)) {
    return null;
  }
  let normalized = value.replace(' ', 'T');
  // A naive stamp is read as UTC, as nothing here ever wrote local time.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(normalized)) {
    normalized += normalized.length === 10 ? 'T00:00:00Z' : 'Z';
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDays(date, days) {
  return addSeconds(date, days * 86400);
}

// Tests only: pins now() to a fixed Date, or restores the real clock.
export function _setNow(value) {
  if (value === null) override = null;
  else if (typeof value === 'function') override = value;
  else override = () => new Date(value.getTime());
}
