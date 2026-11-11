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

Plugins load **at runtime** from `PLUGINS_DIR` (default `./plugins`), one folder each. They're TypeScript,
run by tsx in both dev and production, so there's no build step. Plugins live in their own repo(s); the bot
loads whatever is in the folder.

A plugin folder has an `index.ts` that default-exports a **factory**. The bot calls it with `bot`, its helper
API. A plugin imports only **types** from the bot (`import type`, erased at runtime), so it works wherever its
folder is mounted:

```ts
import type { PluginFactory } from 'bitbot';

const plugin: PluginFactory = (bot) => ({
  name: 'Cool Plugin',
  version: '1.0.0',
  author: 'JohnPluginman',
  repo: 'https://example.com/cool-plugin', // optional
  description: 'Does cool things.', // optional
  commands: [
    {
      name: 'cool',
      description: 'Does a cool thing.',
      usage: '[thing]', // optional, shown by !help
      botPermissions: ['AddReactions'], // checked before running, and added to the invite link
      userPermissions: [], // the caller must have these (implies server-only)
      run: (message, args, rest) => message.reply(`cool ${rest}`),
    },
  ],
  setup: ({ client, log }) => log.info('connected'), // optional: runs once after the first connect
  stop: () => {}, // optional: runs on shutdown
});

export default plugin;
```

- **`bot`** gives `fluxer` (the `@fluxerjs/core` library, the same instance the bot uses), `prefix`,
  `createLogger`, `isBotAdmin`, `hasStaffFlag`, `permissionLabel`, `permissionsIn` and `limits`. The full
  list is the `BotAPI` type in `src/plugin.ts`.
- **Don't import runtime values from `@fluxerjs/core` or the bot.** Use `bot.fluxer.*` and `bot.*`.
  `import type` is fine.
- **Dependencies:** give the folder its own `package.json` (with `"type": "module"`) and install them
  there, inside the container, so native modules like sharp match the image's OS:
  `podman compose run --rm bot sh -c 'cd plugins/<id> && npm install --omit=dev'`.
- **Type-checking in a plugin repo:** map `bitbot` to a checkout of this repo,
  `"paths": { "bitbot": ["../bitbot/src/plugin.ts"] }`, and add `@fluxerjs/core` as a dev dependency.

Plugins load alphabetically by folder. If two commands share a name, the first one loaded wins (core
commands always win), and the clash is logged. A plugin that fails to load is logged and skipped.

## Production

The `prod` image target is a plain OCI image (works with Docker or Podman). It ships the core and tsx;
**plugins are mounted**, not baked in:

```sh
podman build --target prod -t bitbot .
podman run --env-file .env -v ./plugins:/app/plugins bitbot
```

To keep the web help page, mount a writable folder at `/app/public` and set `HELP_PAGE_PATH=public/help.html`.

## License

GPL-3.0. See [LICENSE](LICENSE).
