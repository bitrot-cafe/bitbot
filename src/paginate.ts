import { Events, type EmbedBuilder, type Message } from '@fluxerjs/core';

/*
 * Reaction paging for an embed reply: ⬅️ / ➡️ turn the page, for whoever ran the command. Adding or
 * removing either reaction counts as a press, so it works without permission to clear the user's
 * reactions. Uses raw reaction events (the library's collector drops repeat reactions; see confirm.ts).
 */

const PREV = '⬅️';
const NEXT = '➡️';
const same = (a: string | null | undefined, b: string) => (a ?? '').replace(/️/g, '') === b.replace(/️/g, '');

/** Split items into pages of `size` (at least one page, possibly empty). */
export function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages.length ? pages : [[]];
}

/**
 * Reply with `render(page)` and let the author page through `count` pages. `render` gets the page index
 * and whether reactions work, for its footer hint. Starts at `start` (0-based, clamped).
 */
export async function paginate(
  message: Message,
  count: number,
  render: (page: number, reactions: boolean) => EmbedBuilder,
  { start = 0, timeoutMs = 120_000 } = {},
) {
  let page = Math.min(Math.max(start, 0), count - 1);
  const reply = await message.reply({ embeds: [render(page, count > 1)] });
  if (count < 2) return reply;
  try {
    await reply.react(PREV);
    await reply.react(NEXT);
  } catch {
    // No Add Reactions here: say how to page instead.
    await reply.edit({ embeds: [render(page, false)] }).catch(() => {});
    return reply;
  }

  const client = message.client;
  const turn = (messageId: string, userId: string, emoji: string | null) => {
    if (messageId !== reply.id || userId !== message.author.id) return;
    const step = same(emoji, NEXT) ? 1 : same(emoji, PREV) ? -1 : 0;
    if (!step) return;
    page = (page + step + count) % count;
    reply.edit({ embeds: [render(page, true)] }).catch(() => {});
  };
  type One = { messageId: string; userId: string; emoji: { name: string | null } };
  const onOne = (p: One) => turn(p.messageId, p.userId, p.emoji.name);
  const onMany = (p: { messageId: string; reactions: { userId: string; emoji: { name: string | null } }[] }) =>
    p.reactions.forEach((r) => turn(p.messageId, r.userId, r.emoji.name));
  client.on(Events.MessageReactionAdd, onOne);
  client.on(Events.MessageReactionAddMany, onMany);
  client.on(Events.MessageReactionRemove, onOne);
  setTimeout(() => {
    client.off(Events.MessageReactionAdd, onOne);
    client.off(Events.MessageReactionAddMany, onMany);
    client.off(Events.MessageReactionRemove, onOne);
    reply.removeAllReactions().catch(() => {});
  }, timeoutMs).unref();
  return reply;
}
