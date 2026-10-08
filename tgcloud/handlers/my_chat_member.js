// Telegram delivers every `my_chat_member` update here; the payload is the ChatMemberUpdated.
// Routing lives in lib/dispatch.js.
import { dispatchMyChatMember, guarded } from '../lib/dispatch.js';

export default async function (payload, ctx) {
  await guarded('my_chat_member', ctx, () => dispatchMyChatMember(payload));
}
