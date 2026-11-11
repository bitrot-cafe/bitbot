# bitbot

A [Fluxer](https://fluxer.app) bot built on [`@fluxerjs/core`](https://fluxer.js.org).
Everything runs in containers (Podman). Nothing needs to be installed on the host.

## Setup

1. Create a bot in Fluxer (User Settings → Applications), copy its token, and invite it to a server.
2. `cp .env.example .env` and set `FLUXER_BOT_TOKEN`.
   For a self-hosted instance, also set `FLUXER_INSTANCE` (e.g. `https://chat.example.com`).

## Run

```sh
podman compose up --build        # dev: hot-reloads on changes in src/
```

Production image:

```sh
podman build --target prod -t bitbot .
podman run --rm --env-file .env bitbot
```

Run pnpm or other tooling inside the container:

```sh
podman compose run --rm bot pnpm typecheck
podman compose run --rm bot pnpm add <package>
```

## Commands

| Command | Description |
| ------- | ----------- |
| `!ping` | Replies with Pong! |
| `!invite` | Link to add the bot to a server |
| `!admin plugins list` | Numbered list of loaded plugins (bot administrators) |
| `!admin plugins info <n>` | Details for plugin `n` |
| `!admin status <text\|reset>` | Set the bot status |
| `!admin debug [on\|off]` | Toggle debug mode (bot administrators) |
| `!admin helppage` | Regenerate the web help page (bot administrators) |

## Web help page

Set `HELP_PAGE_PATH` (e.g. `public/help.html`) and the bot writes a static, self-contained command list there on
startup, built from the plugins it actually loaded. Serve it with any web server and set `HELP_URL` so `!help`
links to it. In the dev container the project folder is `/app`, so `public/help.html` lands in `./public/`
(git-ignored).

## Plugins

Each plugin is a folder in `plugins/` with an `index.ts` that default-exports its metadata and commands:

```ts
import { definePlugin } from '../../src/plugin.js';

export default definePlugin({
  name: 'Cool Plugin',
  version: '1.0.0',
  author: 'JohnPluginman',
  repo: 'https://example.com/cool-plugin', // optional
  description: 'Does cool things.', // optional
  commands: [
    {
      name: 'cool',
      description: 'Does a cool thing.',
      botPermissions: ['AddReactions'], // checked before running, and added to the invite link
      userPermissions: [], // the caller must have these
      run: (message, args) => message.reply('cool'),
    },
  ],
});
```

Plugins load alphabetically by folder at startup. If two commands share a name, the first one loaded wins
(core commands always win), and the clash is logged.

## License

GPL-3.0. See [LICENSE](LICENSE).
