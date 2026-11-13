// !ping: check that the bot is up. Built in and enabled by default (seeded once, so disabling it sticks).
import type { PluginFactory } from 'bitbot';

const plugin: PluginFactory = () => ({
  commands: [{ name: 'ping', description: 'Replies with Pong!', run: (message) => message.reply('Pong!') }],
});

export default plugin;
