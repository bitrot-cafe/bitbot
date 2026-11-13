// !whoami [@user] — what the bot knows about you (or someone else): identity, bot roles,
// and (in a guild) member info.
import type { PermissionString } from '@fluxerjs/core';
import type { Command, PluginFactory } from 'bitbot';

// Permissions worth calling out; the full list is long and mostly noise.
const NOTABLE: PermissionString[] = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'KickMembers',
  'BanMembers',
  'ModerateMembers',
  'ManageMessages',
  'ManageExpressions',
  'CreateExpressions',
  'ManageWebhooks',
  'MentionEveryone',
];

const when = (date: Date) => `<t:${Math.floor(date.getTime() / 1000)}:D>`;

const plugin: PluginFactory = (bot) => {
  const { hasStaffFlag, rolesOf, permissionLabel, permissionsIn } = bot;
  const { EmbedBuilder, parseUserMention } = bot.fluxer;

  const whoami: Command = {
    name: 'whoami',
    description: 'Show what the bot knows about you (or another user), including access level.',
    usage: '[@user]',
    botPermissions: ['EmbedLinks'],
    run: async (message, [target], _rest, ctx) => {
      // Accept a mention or a raw user ID; default to the caller.
      const targetId = target ? (parseUserMention(target) ?? (/^\d+$/.test(target) ? target : null)) : message.author.id;
      if (!targetId) return ctx.usage();
      let user;
      try {
        // Fetch so flags are always present (gateway users can be partial).
        user = await message.client.users.fetch(targetId);
      } catch {
        return message.reply(`Couldn't find user \`${target}\`.`);
      }
      const staff = await hasStaffFlag(user);

      const embed = new EmbedBuilder()
        .setTitle(user.globalName ?? user.username)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Username', value: `${user.username}${user.bot ? ' (bot)' : ''}`, inline: true },
          { name: 'ID', value: `\`${user.id}\``, inline: true },
          { name: 'Account created', value: when(user.createdAt), inline: true },
          { name: 'Bot roles', value: (await rolesOf(user)).join(', ') || 'none', inline: true },
          { name: 'Instance staff', value: staff ? 'yes' : 'no', inline: true },
        );

      const guild = await message.resolveGuild();
      const member = guild ? await guild.members.resolve(user.id).catch(() => null) : null;
      if (guild && !member) {
        embed.addFields({ name: 'This server', value: 'Not a member' });
      } else if (guild && member) {
        const perms = permissionsIn(member, guild, message.channelId);
        const roles = member.roles.roleIds.map((id) => guild.roles.get(id)?.name).filter((name) => name && name !== '@everyone');
        const held: PermissionString[] = perms.has('Administrator') ? ['Administrator'] : NOTABLE.filter((p) => perms.has(p));

        embed.addFields(
          { name: 'Nickname', value: member.nick ?? '—', inline: true },
          { name: 'Joined server', value: when(member.joinedAt), inline: true },
          { name: 'Server owner', value: guild.ownerId === user.id ? 'yes' : 'no', inline: true },
          { name: `Roles (${roles.length})`, value: roles.join(', ') || '—' },
          { name: 'Notable permissions here', value: held.map(permissionLabel).join(', ') || 'none' },
        );
      }

      return message.reply({ embeds: [embed] });
    },
  };

  return { commands: [whoami] };
};

export default plugin;
