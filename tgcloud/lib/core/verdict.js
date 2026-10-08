// What Jev answered about one message. No I/O, no dependencies.

export const KINDS = ['crypto', 'job_mule', 'phishing', 'porn', 'channel_promo', 'impersonation', 'none'];

const FIELDS = ['is_spam', 'is_scam', 'solicits_contact', 'looks_like_member', 'kind',
  'severity', 'severity_confidence', 'model'];

export function Verdict(fields) {
  const v = {};
  for (const name of FIELDS) {
    if (!(name in fields)) throw new TypeError(`Verdict is missing ${name}`);
    v[name] = fields[name];
  }
  return Object.freeze(v);
}

// The verdict as the JSON object stored in reviews.verdict_json, in the
// Python dataclass field order.
export function asDict(v) {
  return Object.fromEntries(FIELDS.map((name) => [name, v[name]]));
}
