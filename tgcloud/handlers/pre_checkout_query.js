// Telegram delivers every `pre_checkout_query` update here; the payload is the PreCheckoutQuery.
// Routing lives in lib/dispatch.js.
import { dispatchPreCheckoutQuery, guarded } from '../lib/dispatch.js';

export default async function (payload, ctx) {
  await guarded('pre_checkout_query', ctx, () => dispatchPreCheckoutQuery(payload));
}
