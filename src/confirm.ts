import { Events, type Message } from '@fluxerjs/core';

/*
 * Reaction-based yes/no prompts: reply with `text`, add ✅ ❌, and wait for the command's author.
 * Uses raw reaction events (the library's collector drops repeat reactions).
 */

const YES = '✅';
const NO = '❌';
// Gateway emoji names may drop the variation selector (U+FE0F); compare without it.
const same = (a: string | null | undefined, b: string) => (a ?? '').replace(/️/g, '') === b.replace(/️/g, '');

/** Ask the author of `message` to confirm. Resolves true on ✅; false on ❌ or after the timeout. */
export async function confirm(message: Message, text: string, { timeoutMs = 120_000 } = {}) {
  const prompt = await message.reply(`${text}\n\n${YES} to go ahead, ${NO} to cancel (${Math.round(timeoutMs / 1000)}s).`);
  await prompt.react(YES);
  await prompt.react(NO);

  const client = message.client;
  const ok = await new Promise<boolean>((resolve) => {
    const done = (answer: boolean) => {
      client.off(Events.MessageReactionAdd, onAdd);
      client.off(Events.MessageReactionAddMany, onMany);
      clearTimeout(timer);
      resolve(answer);
    };
    const check = (messageId: string, userId: string, emoji: string | null) => {
      if (messageId !== prompt.id || userId !== message.author.id) return;
      if (same(emoji, YES)) done(true);
      else if (same(emoji, NO)) done(false);
    };
    const onAdd = (p: { messageId: string; userId: string; emoji: { name: string | null } }) =>
      check(p.messageId, p.userId, p.emoji.name);
    const onMany = (p: { messageId: string; reactions: { userId: string; emoji: { name: string | null } }[] }) =>
      p.reactions.forEach((r) => check(p.messageId, r.userId, r.emoji.name));
    const timer = setTimeout(() => done(false), timeoutMs);
    client.on(Events.MessageReactionAdd, onAdd);
    client.on(Events.MessageReactionAddMany, onMany);
  });

  await prompt.removeAllReactions().catch(() => {});
  return { ok, prompt };
}
