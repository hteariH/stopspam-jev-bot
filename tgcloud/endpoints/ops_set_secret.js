// Writes the TypeSafe API key, which the platform has no environment for.
//
//   npx tgcloud run endpoints/ops_set_secret '{value: "ts_..."}' --ctx '{ops: true}'
//
// The value is never logged and never returned.
import { EndpointError } from 'sdk';

import { requireOps } from '../lib/ops.js';
import * as settings from '../lib/storage/settings.js';

export default async function (input, ctx) {
  requireOps(ctx);
  const value = input && typeof input.value === 'string' ? input.value.trim() : '';
  if (!value || /\s/.test(value)) {
    throw new EndpointError('value must be a non-empty key with no whitespace', { code: 'BAD_VALUE' });
  }
  await settings.set(settings.TYPESAFE_API_KEY, value);
  return { ok: true, length: value.length };
}
