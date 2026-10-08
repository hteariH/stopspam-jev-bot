// Telegram delivers every `message` update here; the payload is the Message.
// Routing lives in lib/dispatch.js.
import { dispatchMessage, guarded } from '../lib/dispatch.js';

export default async function (payload, ctx) {
  await guarded('message', ctx, () => dispatchMessage(payload));
}
