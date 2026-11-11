// !addemote <search> [source] — search an emote site, pick one via reactions, upload it as a guild emoji.
// Quick-and-dirty plugin; refactor later.
import { EmbedBuilder, Events, type Message } from '@fluxerjs/core';
import sharp from 'sharp';
import { EMOJI_DIMENSIONS, fetchLimits, getLimit } from '../../src/instance.js';
import { definePlugin, prefix, type Command } from '../../src/plugin.js';

type Emote = { id: string; name: string; animated: boolean; owner: string; width: number; height: number };

const PREV = '◀️';
const NEXT = '▶️';
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const ADD = '✅';
const SPLIT = '✂️';
const RENAME = '✏️';
const CANCEL = '❌';
const PAGE_SIZE = NUMBERS.length;
const IDLE_TIMEOUT_MS = 2 * 60 * 1000; // menu closes after this long without input

// Gateway emoji names may drop the variation selector (U+FE0F); compare without it.
const same = (a: string | null | undefined, b: string) => (a ?? '').replace(/\uFE0F/g, '') === b.replace(/\uFE0F/g, '');

// ---- 7TV ----------------------------------------------------------------------------------------

export async function search7tv(query: string): Promise<Emote[]> {
  const res = await fetch('https://7tv.io/v3/gql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query($q: String!) {
        emotes(query: $q, page: 1, limit: 50, sort: {value: "popularity", order: DESCENDING}) {
          items { id name animated owner { display_name } host { files { name width height } } }
        }
      }`,
      variables: { q: query },
    }),
  });
  if (!res.ok) throw new Error(`7TV search failed: HTTP ${res.status}`);
  const json: any = await res.json();
  return (json.data?.emotes?.items ?? []).map((e: any) => {
    const file = e.host.files.find((f: any) => f.name === '4x.webp') ?? e.host.files.at(-1);
    return {
      id: e.id,
      name: e.name,
      animated: e.animated,
      owner: e.owner?.display_name ?? 'unknown',
      width: file?.width ?? 128,
      height: file?.height ?? 128,
    };
  });
}

const emoteImageUrl = (e: Emote) => `https://cdn.7tv.app/emote/${e.id}/4x.webp`;
const emotePageUrl = (e: Emote) => `https://7tv.app/emotes/${e.id}`;

const SOURCES: Record<string, (query: string) => Promise<Emote[]>> = {
  '7tv': search7tv,
  // betterttv, frankerfacez: later
};

// ---- Image processing ---------------------------------------------------------------------------

/** How many square-ish pieces a wide emote splits into. */
const splitCount = (e: Emote) => Math.max(1, Math.round(e.width / e.height));

/** Re-encode (and shrink if needed) until the image fits the instance's emoji limits. */
export async function optimize(input: Buffer, maxBytes: number): Promise<Buffer> {
  const meta = await sharp(input, { animated: true }).metadata();
  const frameHeight = meta.pageHeight ?? meta.height!;
  const animated = (meta.pages ?? 1) > 1;
  let scale = Math.min(1, EMOJI_DIMENSIONS.max / Math.max(meta.width!, frameHeight));

  while (true) {
    const width = Math.max(EMOJI_DIMENSIONS.min, Math.round(meta.width! * scale));
    const height = Math.max(EMOJI_DIMENSIONS.min, Math.round(frameHeight * scale));
    for (const quality of [90, 75, 60, 45, 30]) {
      const out = await sharp(input, { animated: true })
        .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality, effort: 6, loop: 0, ...(animated ? {} : { lossless: quality === 90 }) })
        .toBuffer();
      if (out.length <= maxBytes) return out;
    }
    if (width === EMOJI_DIMENSIONS.min && height === EMOJI_DIMENSIONS.min) {
      throw new Error(`Couldn't compress below ${Math.round(maxBytes / 1024)} KiB.`);
    }
    scale *= 0.8;
  }
}

/** Cut an image (animated or not) into `count` vertical strips, left to right. */
export async function split(input: Buffer, count: number): Promise<Buffer[]> {
  const meta = await sharp(input, { animated: true }).metadata();
  const frameHeight = meta.pageHeight ?? meta.height!;
  const pieceWidth = Math.floor(meta.width! / count);
  const pieces: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    pieces.push(
      await sharp(input, { animated: true })
        .extract({ left: i * pieceWidth, top: 0, width: pieceWidth, height: frameHeight })
        .webp({ lossless: true, loop: 0 })
        .toBuffer(),
    );
  }
  return pieces;
}

/** Fluxer emoji names: letters, digits, underscores, 2–32 chars. */
function emojiName(name: string, suffix = ''): string {
  let clean = name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32 - suffix.length);
  if (clean.length < 2) clean = clean.padEnd(2, '_');
  return clean + suffix;
}

// ---- Menu ---------------------------------------------------------------------------------------

/** Emote downloaded, split and compressed, ready to upload. */
type Prepared = { emote: Emote; parts: Buffer[]; baseName: string };

const partNames = (p: Prepared) =>
  p.parts.map((_, i) => emojiName(p.baseName, p.parts.length > 1 ? `_${i + 1}` : ''));

function listEmbeds(results: Emote[], page: number, query: string, source: string) {
  const pages = Math.ceil(results.length / PAGE_SIZE);
  const embeds = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((e, i) =>
    new EmbedBuilder()
      .setTitle(`${NUMBERS[i]} ${e.name}${e.animated ? ' (animated)' : ''}`)
      .setURL(emotePageUrl(e))
      .setDescription(`by ${e.owner} · ${e.width}×${e.height}${splitCount(e) > 1 ? ` · splittable ×${splitCount(e)}` : ''}`)
      .setThumbnail(emoteImageUrl(e)),
  );
  embeds.at(-1)?.setFooter({
    text: `${source} · "${query}" · page ${page + 1}/${pages} · pick ${NUMBERS[0]}–${NUMBERS[PAGE_SIZE - 1]}, ${PREV} ${NEXT} browse, ${CANCEL} cancel`,
  });
  return embeds;
}

function splitChoiceEmbed(e: Emote) {
  return new EmbedBuilder()
    .setTitle(e.name)
    .setURL(emotePageUrl(e))
    .setDescription(`${e.width}×${e.height} — wide emote.\n${ADD} keep as one   ${SPLIT} split into ${splitCount(e)}   ${CANCEL} cancel`)
    .setImage(emoteImageUrl(e));
}

function previewEmbed(p: Prepared, maxBytes: number) {
  const names = partNames(p);
  return new EmbedBuilder()
    .setTitle(`Preview: ${p.emote.name}`)
    .setURL(emotePageUrl(p.emote))
    .setImage(emoteImageUrl(p.emote))
    .addFields(
      {
        name: names.length > 1 ? `Will be added as ${names.length} emoji` : 'Will be added as',
        value: names.map((n, i) => `\`:${n}:\` — ${Math.round(p.parts[i].length / 1024)} KiB`).join('\n'),
      },
      { name: 'Size limit', value: `${Math.round(maxBytes / 1024)} KiB per emoji`, inline: true },
      { name: 'Animated', value: p.emote.animated ? 'yes' : 'no', inline: true },
    )
    .setFooter({ text: `${ADD} add   ${RENAME} rename   ${CANCEL} cancel` });
}

/** Download, optionally split, and compress to the instance's limit. */
async function prepare(message: Message, emote: Emote, doSplit: boolean): Promise<{ prepared: Prepared; maxBytes: number }> {
  const guild = await message.resolveGuild();
  if (!guild) throw new Error('Not in a guild.');
  const maxBytes = getLimit(await fetchLimits(message.client), 'emoji_max_size', guild.features);

  const res = await fetch(emoteImageUrl(emote));
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const original = Buffer.from(await res.arrayBuffer());

  const count = doSplit ? splitCount(emote) : 1;
  const pieces = count > 1 ? await split(original, count) : [original];
  const parts: Buffer[] = [];
  for (const piece of pieces) parts.push(await optimize(piece, maxBytes));
  return { prepared: { emote, parts, baseName: emojiName(emote.name) }, maxBytes };
}

async function upload(message: Message, p: Prepared): Promise<string> {
  const guild = await message.resolveGuild();
  if (!guild) throw new Error('Not in a guild.');
  const names = partNames(p);
  const created: string[] = [];
  for (const [i, part] of p.parts.entries()) {
    const emoji = await guild.createEmoji({
      name: names[i],
      image: `data:image/webp;base64,${part.toString('base64')}`,
      reason: `!addemote by ${message.author.username} (7tv ${p.emote.id})`,
    });
    created.push(`<${p.emote.animated ? 'a' : ''}:${emoji.name}:${emoji.id}> \`:${emoji.name}:\``);
  }
  return created.join('\n');
}

async function setReactions(menu: Message, emojis: string[]) {
  await menu.removeAllReactions().catch(() => {});
  for (const emoji of emojis) await menu.react(emoji);
}

const addemote: Command = {
  name: 'addemote',
  description: 'Search 7TV for an emote and add it to this guild.',
  usage: '<search> [source]',
  botPermissions: ['EmbedLinks', 'AddReactions', 'ManageMessages', 'CreateExpressions'],
  userPermissions: ['CreateExpressions'],
  run: async (message, args) => {
    const [query, sourceName = '7tv'] = args;
    if (!message.guildId) return message.reply('This only works in a server.');
    if (!query) return message.reply(`Usage: \`${prefix}addemote <search> [source]\` (sources: 7tv)`);
    const source = SOURCES[sourceName.toLowerCase()];
    if (!source) return message.reply(`Unknown source "${sourceName}". Available: ${Object.keys(SOURCES).join(', ')}`);

    const results = await source(query);
    if (results.length === 0) return message.reply(`No emotes found for "${query}".`);

    const client = message.client;
    const pages = Math.ceil(results.length / PAGE_SIZE);
    let page = 0;
    // Menu steps: browse the list -> (wide emotes) keep/split -> preview (rename) -> upload
    let step: 'list' | 'split' | 'preview' | 'rename' = 'list';
    let picked: Emote | null = null;
    let prepared: Prepared | null = null;
    let maxBytes = 0;
    let busy = false;

    const menu = await message.reply({ embeds: listEmbeds(results, page, query, sourceName) });
    await setReactions(menu, [PREV, NEXT, ...NUMBERS, CANCEL]);

    // Raw events instead of ReactionCollector: the collector ignores the same user pressing the
    // same emoji twice, which breaks paging.
    let idle: NodeJS.Timeout;
    const stopListening = () => {
      client.off(Events.MessageReactionAdd, onReaction);
      client.off(Events.MessageReactionAddMany, onReactionMany);
      client.off(Events.MessageCreate, onMessage);
      clearTimeout(idle);
    };
    const close = async (content: string) => {
      stopListening();
      await menu.removeAllReactions().catch(() => {});
      await menu.edit({ content, embeds: [] }).catch(() => {});
    };
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => close('Timed out.'), IDLE_TIMEOUT_MS);
    };

    const showPreview = async (emote: Emote, doSplit: boolean) => {
      await menu.removeAllReactions().catch(() => {});
      await menu.edit({ content: `Preparing **${emote.name}**…`, embeds: [] });
      try {
        ({ prepared, maxBytes } = await prepare(message, emote, doSplit));
      } catch (error) {
        console.error('addemote prepare failed:', error);
        return close(`Couldn't prepare **${emote.name}**: ${(error as Error).message}`);
      }
      step = 'preview';
      await menu.edit({ content: '', embeds: [previewEmbed(prepared!, maxBytes)] });
      await setReactions(menu, [ADD, RENAME, CANCEL]);
    };

    const add = async (p: Prepared) => {
      stopListening();
      await menu.removeAllReactions().catch(() => {});
      await menu.edit({ content: `Adding **${p.baseName}**…`, embeds: [] });
      try {
        await menu.edit({ content: `Added:\n${await upload(message, p)}`, embeds: [] });
      } catch (error) {
        console.error('addemote upload failed:', error);
        await menu.edit({ content: `Failed to add **${p.baseName}**: ${(error as Error).message}`, embeds: [] });
      }
    };

    async function onReaction(payload: { messageId: string; userId: string; emoji: { name: string | null } }) {
      if (payload.messageId !== menu.id || payload.userId !== message.author.id) return;
      const emoji = payload.emoji.name;
      menu.removeReaction(emoji ?? '', payload.userId).catch(() => {}); // lets the same button be pressed again
      if (busy) return;
      busy = true;
      resetIdle();
      try {
        if (same(emoji, CANCEL)) return void (await close('Cancelled.'));

        if (step === 'list') {
          if (same(emoji, PREV) || same(emoji, NEXT)) {
            page = (page + (same(emoji, NEXT) ? 1 : -1) + pages) % pages;
            await menu.edit({ embeds: listEmbeds(results, page, query, sourceName) });
            return;
          }
          const slot = NUMBERS.findIndex((n) => same(emoji, n));
          const emote = slot >= 0 ? results[page * PAGE_SIZE + slot] : undefined;
          if (!emote) return;
          if (splitCount(emote) > 1) {
            picked = emote;
            step = 'split';
            await menu.edit({ embeds: [splitChoiceEmbed(emote)] });
            await setReactions(menu, [ADD, SPLIT, CANCEL]);
          } else {
            await showPreview(emote, false);
          }
        } else if (step === 'split' && picked) {
          if (same(emoji, ADD) || same(emoji, SPLIT)) await showPreview(picked, same(emoji, SPLIT));
        } else if (step === 'preview' && prepared) {
          if (same(emoji, ADD)) await add(prepared);
          else if (same(emoji, RENAME)) {
            step = 'rename';
            await menu.edit({ content: 'Type the new name in this channel (letters, numbers, underscores; 2–32 characters).' });
          }
        }
      } finally {
        busy = false;
      }
    }

    // Rename: the author's next message in this channel is the new name.
    async function onMessage(reply: Message) {
      if (step !== 'rename' || !prepared) return;
      if (reply.channelId !== message.channelId || reply.author.id !== message.author.id) return;
      resetIdle();
      const raw = reply.content.trim();
      if (raw.startsWith(prefix)) return; // a command, not a name
      reply.delete().catch(() => {}); // keep the channel tidy; needs Manage messages
      if (!/^[A-Za-z0-9_]{2,32}$/.test(raw)) {
        await menu.edit({ content: `"${raw}" isn't a valid name. Use letters, numbers and underscores, 2–32 characters. Try again:` });
        return;
      }
      prepared.baseName = raw;
      step = 'preview';
      await menu.edit({ content: '', embeds: [previewEmbed(prepared, maxBytes)] });
    }

    // The gateway may batch rapid reactions into one ADD_MANY event.
    const onReactionMany = (payload: { messageId: string; reactions: { userId: string; emoji: { name: string | null } }[] }) => {
      for (const r of payload.reactions) onReaction({ messageId: payload.messageId, userId: r.userId, emoji: r.emoji });
    };

    client.on(Events.MessageReactionAdd, onReaction);
    client.on(Events.MessageReactionAddMany, onReactionMany);
    client.on(Events.MessageCreate, onMessage);
    resetIdle();
  },
};

export default definePlugin({
  name: 'Add Emote',
  version: '0.2.0',
  author: 'UVClay',
  description: 'Search 7TV and add emotes to the guild, with compression, splitting for wide emotes, and a rename step.',
  commands: [addemote],
});
