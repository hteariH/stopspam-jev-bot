// The command menu the Python bot set at every start. There is no "start"
// on the platform, so it is set once after deploying.
//
//   npx tgcloud run endpoints/ops_set_commands '{}' --ctx '{ops: true}'
import { api } from 'sdk';

import { makeBot } from '../lib/bot.js';
import { requireOps } from '../lib/ops.js';

export const COMMANDS = [
  { command: 'chats', description: 'Configure your groups' },
  { command: 'setlog', description: 'Send review cards to this chat (group admins)' },
  { command: 'privacy', description: 'What data the bot sends and keeps' },
  { command: 'help', description: 'How this bot works' },
];

export default async function (_input, ctx) {
  requireOps(ctx);
  await makeBot(api).setMyCommands(COMMANDS);
  return { ok: true, commands: COMMANDS.map((c) => c.command) };
}
