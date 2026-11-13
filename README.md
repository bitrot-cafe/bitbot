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

The prefix is `!` by default (each guild can choose its own), and mentioning the bot always works:
`@Bitbot help`. Commands are grouped by who may use them.

| Command | Who | Description |
| ------- | --- | ----------- |
| `!help [plugin \| command]` | everyone | What you can use here, or details for a plugin or command |
| `!ping` | everyone | Replies with Pong! |
| `!invite` | everyone | Link to add the bot to a server |
| `!admin config …` | admin | Settings (see below) |
| `!admin status <text\|reset>` | admin | Set the bot status |
| `!admin audit [count]` | admin | Who changed what, newest first |
| `!root plugins …` | root | Install, enable, update and remove plugins (see below) |
| `!root restart` | root | Restart the bot |
| `!root debug [on\|off]` | root | Debug mode: debug logs, error details in replies, plugin guardrails off |
| `!root helppage` | root | Regenerate the web help page |

A plugin's commands that need `admin` or `root` appear under those groups too (e.g. `!admin access sync`).
Commands have a cooldown (default 5 seconds per user, setting `core.cooldown`); bot admins and root are exempt.

## Who administers the bot: `permissions.yaml`

Bot-wide roles live in `permissions.yaml` (in the app folder, or `PERMISSIONS_FILE`). It's yours: the bot
only reads it, at startup, and nothing in chat can change it. Copy `permissions.example.yaml`:

```yaml
roles:
  root:                    # plugins, restarts, debug mode: code running on the host
    users: ["1234567890123456789"]
  admin:                   # settings, status, audit log
    staff: true            # anyone with the instance Staff badge (never on fluxer.app)
    users: []
  access-sync-operator:    # a role a plugin defines (in its package.json) and checks
    users: []
```

- **The application owner is always root.** With no file at all, they're the only one.
- **root holds every role** and skips per-guild permission checks (but the bot's own missing permissions
  still stop a command). **admin** gets no powers inside guilds.
- **Immunity:** a lower rank can't act on a higher one (root > admin > everyone). Root-only settings
  (`core.debug`, `core.help_page_path`) can't be changed by admins.
- **Quote user IDs** (`"1562…"`): they're too big for YAML numbers. A malformed file stops the bot; a role
  nothing declares gets a warning (likely a typo).
- Per-guild permissions (which role may use what inside one server) are separate and come later, in the database.

## Settings, secrets and the database

- **Bootstrap settings** are read from the environment at startup and can't be changed from chat: the
  token, `FLUXER_INSTANCE`, `DATABASE_URL`, `PLUGINS_DIR`, `PERMISSIONS_FILE`. See `.env.example`.
  `PREFIX` is the default prefix; the prefix itself is a setting (`core.prefix`), so guilds can have their own.
- **Everything else is a setting in the database**, changed from chat by bot admins (root-only settings by root):

  | Command | What it does |
  |---|---|
  | `!admin config` | Every scope (`core`, and each plugin with settings); ⚠️ marks missing required ones |
  | `!admin config <scope>` | Each setting's value, where it comes from (env / set here / default) and what it does |
  | `!admin config set <scope> <key> <value>` | Store a setting (logged to the log channel) |
  | `!admin config unset <scope> <key>` | Back to its default |

  Core settings: `prefix`, `cooldown`, `status`, `log_channel`, `debug` (root), `help_page_path` (root),
  `help_url`. Plugins declare their own. A setting's environment variable (e.g. `LOG_CHANNEL_ID`) still
  works and **wins** over the database; `!admin config` shows it as "env". `!admin status` and
  `!root debug` are stored too, so they survive restarts.
- **Secrets** (tokens, passwords) never go in the database or chat. Set them in the environment, or better,
  as a file: any variable `X` can be given as `X_FILE=/path` (how Docker/compose secrets work).
- **Database:** SQLite by default (`data/bitbot.db`), which suits small communities; Postgres for large
  ones (`DATABASE_URL=postgres://…`). The schema is portable, so migrations run on both at startup and
  `db:copy` moves data between them (`pnpm db:copy --from <url> --to <url>` in a checkout; in the image,
  `node --import tsx src/db/copy.ts …`, see deploy/README.md). CI runs the tests on both.

## Web help page

Set the `help_page_path` setting (e.g. `public/help.html`) and the bot writes a static, self-contained
command list there on startup, built from the plugins it actually loaded. Serve it with any web server and
set `help_url` so `!help` links to it. In the dev container the project folder is `/app`, so
`public/help.html` lands in `./public/` (git-ignored). `!root helppage` rewrites it on demand.

## Plugins

Plugins come from **plugin repos**, installed and updated by the bot itself. The official one is
[bitbot-plugins](https://github.com/bitrot-cafe/bitbot-plugins). As bot root:

| Command | What it does |
|---|---|
| `!root plugins add <https-url> [branch\|tag]` | Clone a repo and list its plugins (after you react ✅). **Enables nothing** |
| `!root plugins enable <plugin>` / `disable <plugin>` | Opt a plugin in (installs its dependencies) or out, after ✅; restarts |
| `!root plugins update [repo]` | Fetch, show the new commits, and apply them after you react ✅ |
| `!root plugins remove <repo>` | Uninstall a repo after you react ✅ |
| `!root plugins repos` | Installed repos, their commits and plugins |
| `!root plugins list` / `info <n>` | Loaded plugins (and any that were disabled, with the reason) |
| `!root restart` | Restart the bot (plugins load at startup) |

**Plugins are opt-in:** adding a repo only makes its plugins available, and each one is enabled
explicitly. Everything lives in `PLUGINS_DIR` (default `./plugins`, git-ignored). `plugins.json` lists the
repos and which of their plugins are enabled; any repo missing from disk is re-cloned on startup. Each repo clone holds one or more plugin folders. A plugin
folder placed directly in `PLUGINS_DIR` also loads, which is handy for local experiments.

**Guardrail:** if two plugins claim the same command, a core command, or the same plugin name in two
repos, **all of them are disabled** and the clash is reported to the log channel. Fix the config rather
than relying on load order. `DEBUG=true` turns this off (first one loaded wins).

**Security:** bot root can make the bot run code from any HTTPS repo, and plugins run with the bot's token,
its secrets and its database. Give root only to people who already have access to the host. Every add,
update, remove and restart is posted to the log channel and recorded in the audit log.

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
      requiredRole: undefined, // optional: a bot role; 'admin'/'root' mount it as !admin cool / !root cool
      cooldown: 30, // optional: seconds per user, or { seconds, per: 'user' | 'guild' | 'bot' }, or a list
      run: async (message, args, rest, ctx) => {
        if (!rest) return ctx.usage(); // replies with the usage line; this use isn't charged to the cooldown
        return message.reply(`cool ${rest}`);
      },
    },
  ],
  setup: ({ client, log }) => log.info('connected'), // optional: runs once after the first connect
  stop: () => {}, // optional: runs on shutdown
});

export default plugin;
```

- **`bot`** gives `fluxer` (the `@fluxerjs/core` library, the same instance the bot uses), `config`,
  `store`, `log`, `audit`, `prefixFor(guildId)`, `hasRole`, `rolesOf`, `canActOn` (immunity: check it
  before acting on a user), `hasStaffFlag`, `permissionLabel`, `permissionsIn` and `limits`. The full list
  is the `BotAPI` type in `src/plugin.ts`.
- **`ctx`** (the 4th argument to `run`): `ctx.prefix` (this guild's), `ctx.usage(note?)` (reply with the
  standard usage line for bad input) and `ctx.refund()` (nothing happened, for a reason you've told the
  user). A use is charged against the cooldown only when it finishes without either and without throwing.
- **package.json** declares, under `"bitbot"`: `api` (required, see below), `roles` (bot roles your
  commands use, so permissions.yaml can be checked for typos), and `cooldown` (a default for all your commands).
- **Don't import runtime values from `@fluxerjs/core` or the bot.** Use `bot.fluxer.*` and `bot.*`.
  `import type` is fine.
- **Dependencies:** give the plugin folder its own `package.json` (with `"type": "module"`), ideally with a
  `package-lock.json`. The bot installs them (`npm ci --omit=dev` with a lockfile, else `npm install`)
  when the plugin is enabled, or when an update changes them, without the bot's secrets in the environment.
- **Command names must be unique** across everything the bot loads (see the guardrail above).
- **Declare the bot API version** your plugin needs (see below).
- **Settings:** declare them in `config: { key: { type, description, default?, required?, secret?, env?, perGuild? } }`
  (types: string, number, boolean, id, url) and read them with `bot.config.get('key')` in commands or
  setup (also `ctx.config`). They become `!admin config <plugin>`. Mark tokens and passwords
  `secret: true`; those come from env / `*_FILE` only. Don't read `process.env`. A `perGuild` setting
  can differ per guild: `bot.config.get('key', guildId)` falls back to the bot-wide value. A bad env
  value disables the plugin at startup.
- **Storage:** `bot.store` (`get`, `set`, `delete`, `list(prefix)`) is a private key/value store (JSON
  values), backed by the bot's database. `bot.store.guild(guildId)` is the same for one guild: use it for
  per-guild data rather than `guild:<id>:` keys.
- **Logging:** `bot.log` is the plugin's logger (also `ctx.log`).
- **Type-checking in a plugin repo:** map `bitbot` to this repo's `src/plugin.ts` and add `@fluxerjs/core`
  as a dev dependency. See bitbot-plugins' `tsconfig.json`.

### Plugin API versions

The plugin API (the `bot` object and the plugin format) is versioned with the bot itself: its version is
the bot's `major.minor`, currently **0.3** (`src/version.ts` reads it from `package.json`). From 1.0 on,
a minor release only adds to the API and a new major may break plugins. **While the bot is on 0.x,
anything can change in any minor release**: plugins are best effort and may need updating. A plugin
declares what it needs in its folder's `package.json`:

```json
{ "name": "my-plugin", "type": "module", "bitbot": { "api": "0.3" } }
```

`"0.3"` means "0.3 or later, within 0.x". The bot checks this **before running any of the plugin's code**:

| Plugin declares | Result |
|---|---|
| A compatible version (same major, minor ≤ the bot's) | loads |
| Nothing | loads, with a warning in the log channel |
| An incompatible version | **not loaded**; listed under "Not loaded" in `!root plugins list`. `DEBUG=true` loads it anyway, with a warning. |

`!root plugins add` and `update` show each plugin's compatibility (✅ / ⚠️ / ⛔) **before** you confirm.

## Development vs production bots

Run development on its own Fluxer application, so testing never touches the real bot:

| | Production (Bitbot) | Development (Breakbot) |
|---|---|---|
| Runs from | a pinned release image (`deploy/`) | the **`:edge`** image (every push to `master`), or this checkout (`podman compose up`) for hot reload |
| Token | its own application | a separate application |
| Prefix | `!` | `??` (`PREFIX=??`), so it can share guilds without answering the same commands |
| Guilds | the real ones | a dev guild, plus real ones for realistic tests |
| Plugins | bot-managed, `bitbot-plugins` `main` | bot-managed, `bitbot-plugins` `main` (the dev checkout's `plugins/` too) |
| Log channel | the ops channel | a channel in the dev guild |

Separate tokens mean both can run at the same time. Plugins are developed in their own checkout,
next to this one (`../bitbot-plugins`); push, then `??root plugins update` on Breakbot to try a change.

## Production

The `prod` image (`ghcr.io/bitrot-cafe/bitbot:<version>`, published by CI on version tags) is a plain OCI
image that ships the core, tsx and git. **Plugins aren't baked in:** the bot manages them in a writable
`/app/plugins`. See [deploy/README.md](deploy/README.md) for the compose setup.

## License

GPL-3.0. See [LICENSE](LICENSE).
