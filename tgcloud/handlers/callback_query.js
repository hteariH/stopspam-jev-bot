// Telegram delivers every `callback_query` update here; the payload is the CallbackQuery.
// Routing lives in lib/dispatch.js.
import { dispatchCallbackQuery, guarded } from '../lib/dispatch.js';

export default async function (payload, ctx) {
  await guarded('callback_query', ctx, () => dispatchCallbackQuery(payload));
}
