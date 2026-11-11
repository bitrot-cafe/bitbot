import type { Message } from '@fluxerjs/core';

export type Command = {
  name: string;
  description: string;
  run: (message: Message, args: string[]) => Promise<unknown>;
};

const ping: Command = {
  name: 'ping',
  description: 'Replies with Pong!',
  run: (message) => message.reply('Pong!'),
};

export const commands = new Map<string, Command>([[ping.name, ping]]);
