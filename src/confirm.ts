import { Events, type Client, type Message } from '@fluxerjs/core';
import { hasRole } from './roles.js';

/*
 * Reaction-based yes/no prompts: post `text`, add ✅ ❌, and wait for an answer from someone allowed to
 * give it (the command's author, or any bot root). Uses raw reaction events (the library's collector drops
 * repeat reactions).
 */

const YES = '✅';
const NO = '❌';
// Gateway emoji names may drop the variation selector (U+FE0F); compare without it.
const same = (a: string | null | undefined, b: string) => (a ?? '').replace(/️/g, '') === b.replace(/️/g, '');

type AskOptions = {
  client: Client;
  /** Posts the prompt (a reply, a channel message, a DM) and returns it. */
  send: (text: string) => Promise<Message>;
  /** Whose ✅/❌ counts. Other reactions are ignored. */
  mayAnswer: (userId: string) => boolean | Promise<boolean>;
  timeoutMs?: number;
};

/**
 * Post a prompt and wait. `answer`: true on ✅, false on ❌, null on timeout; `by`: who answered.
 * `noReactions`: the reactions couldn't be added (no Add Reactions permission); the prompt is edited to
 * say so and nothing listens, so put another way through in `text`.
 */
export async function ask(text: string, { client, send, mayAnswer, timeoutMs = 120_000 }: AskOptions) {
  const wait = timeoutMs >= 3_600_000 ? `${Math.round(timeoutMs / 3_600_000)}h` : `${Math.round(timeoutMs / 1000)}s`;
  const prompt = await send(`${text}\n\n${YES} to go ahead, ${NO} to cancel (${wait}).`);
  try {
    await prompt.react(YES);
    await prompt.react(NO);
  } catch {
    await prompt.edit({ content: `${text}\n\n(I can't add reactions here, so this can't be answered with ✅/❌.)` }).catch(() => {});
    return { answer: null, by: null, prompt, noReactions: true };
  }

  const result = await new Promise<{ answer: boolean | null; by: string | null }>((resolve) => {
    let settled = false;
    const done = (answer: boolean | null, by: string | null) => {
      if (settled) return;
      settled = true;
      client.off(Events.MessageReactionAdd, onAdd);
      client.off(Events.MessageReactionAddMany, onMany);
      clearTimeout(timer);
      resolve({ answer, by });
    };
    const check = async (messageId: string, userId: string, emoji: string | null) => {
      if (messageId !== prompt.id || userId === client.user?.id) return;
      const yes = same(emoji, YES);
      if (!yes && !same(emoji, NO)) return;
      if (!(await Promise.resolve(mayAnswer(userId)).catch(() => false))) return;
      done(yes, userId);
    };
    const onAdd = (p: { messageId: string; userId: string; emoji: { name: string | null } }) =>
      void check(p.messageId, p.userId, p.emoji.name);
    const onMany = (p: { messageId: string; reactions: { userId: string; emoji: { name: string | null } }[] }) =>
      p.reactions.forEach((r) => void check(p.messageId, r.userId, r.emoji.name));
    const timer = setTimeout(() => done(null, null), timeoutMs);
    client.on(Events.MessageReactionAdd, onAdd);
    client.on(Events.MessageReactionAddMany, onMany);
  });

  await prompt.removeAllReactions().catch(() => {});
  return { ...result, prompt, noReactions: false };
}

/** Anyone holding bot root. */
export const anyRoot = (client: Client) => (userId: string) => hasRole({ id: userId, client }, 'root');

/** Ask the author of `message` to confirm. Resolves true on ✅; false on ❌ or after the timeout. */
export async function confirm(message: Message, text: string, { timeoutMs = 120_000 } = {}) {
  const { answer, prompt } = await ask(text, {
    client: message.client,
    send: (t) => message.reply(t),
    mayAnswer: (userId) => userId === message.author.id,
    timeoutMs,
  });
  return { ok: answer === true, prompt };
}
