// !invite: DM a link that adds the bot to a server. Built in, not enabled by default.
import type { PluginFactory } from 'bitbot';

const plugin: PluginFactory = (bot) => ({
  commands: [
    {
      name: 'invite',
      description: 'Link to add the bot to a server (includes the permissions its plugins need).',
      run: async (message) => {
        try {
          await message.author.send(`Add me to a server: ${bot.inviteUrl(message.client)}`);
        } catch {
          // DMs closed (privacy settings) or blocked: say so instead of failing silently.
          return message.reply("I couldn't DM you. Check your privacy settings, or ask an admin for the link.");
        }
        if (message.guildId) await message.react('📬').catch(() => {}); // "check your DMs"; skip if reactions are blocked
      },
    },
  ],
});

export default plugin;
