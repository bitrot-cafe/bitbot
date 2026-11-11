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

Plugins come from **plugin repos**, installed and updated by the bot itself. The official one is
[bitbot-plugins](https://github.com/bitrot-cafe/bitbot-plugins). As a bot administrator:

| Command | What it does |
|---|---|
| `!admin plugins add <https-url> [branch\|tag]` | Clone a repo, list its plugins, and load them after you react ✅ |
| `!admin plugins update [repo]` | Fetch, show the new commits, and apply them after you react ✅ |
| `!admin plugins remove <repo>` | Uninstall a repo after you react ✅ |
| `!admin plugins repos` | Installed repos, their commits and plugins |
| `!admin plugins list` / `info <n>` | Loaded plugins (and any that were disabled, with the reason) |
| `!admin restart` | Restart the bot (plugins load at startup) |

Everything lives in `PLUGINS_DIR` (default `./plugins`, git-ignored). `plugins.json` lists the repos, and
any missing from disk are re-cloned on startup. Each repo clone holds one or more plugin folders. A plugin
folder placed directly in `PLUGINS_DIR` also loads, which is handy for local experiments.

**Guardrail:** if two plugins claim the same command, a core command, or the same plugin name in two
repos, **all of them are disabled** and the clash is reported to the log channel. Fix the config rather
than relying on load order. `DEBUG=true` turns this off (first one loaded wins).

**Security:** any bot administrator can make the bot run code from any HTTPS repo, and plugins run with the
bot's token and the whole `.env`. Treat bot administrators (and instance staff, with
`TRUST_INSTANCE_STAFF=true`) as fully trusted. Every add, update, remove and restart is posted to the log channel.

### Writing a plugin

A plugin folder has an `index.ts` that default-exports a **factory**. The bot calls it with `bot`, its helper
API. Start from [`examples/plugins/whoami`](examples/plugins/whoami), which isn't loaded by default and isn't
in the image. A plugin imports only **types** from the bot (`import type`, erased at runtime), so it works
from any repo:

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
- **Dependencies:** give the plugin folder its own `package.json` (with `"type": "module"`). The bot runs
  `npm install --omit=dev` there when the repo is added, or when an update changes it.
- **Command names must be unique** across everything the bot loads (see the guardrail above).
- **Type-checking in a plugin repo:** map `bitbot` to this repo's `src/plugin.ts` and add `@fluxerjs/core`
  as a dev dependency. See bitbot-plugins' `tsconfig.json`.

## Production

The `prod` image (`ghcr.io/bitrot-cafe/bitbot:<version>`, published by CI on version tags) is a plain OCI
image that ships the core, tsx and git. **Plugins aren't baked in:** the bot manages them in a writable
`/app/plugins`. See [deploy/README.md](deploy/README.md) for the compose setup.

## License

GPL-3.0. See [LICENSE](LICENSE).
