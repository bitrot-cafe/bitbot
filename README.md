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
| `!admin config …` | admin | Settings (see below) |
| `!admin status <text\|reset>` | admin | Set the bot status |
| `!admin audit [count]` | admin | Who changed what, newest first |
| `!root plugins …` | root | Install, enable, update and remove plugins (see below) |
| `!root restart` | root | Restart the bot |
| `!root debug [on\|off]` | root | Debug mode: debug logs, error details in replies, plugin guardrails off |
| `!root helppage` | root | Regenerate the web help page |

A plugin's commands that need `admin` or `root` appear under those groups too (e.g. `!admin access sync`).
`!ping` and `!invite` are built-in plugins: ping is enabled on a new bot, invite isn't
(`!root plugins enable invite`).
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
  token, `FLUXER_INSTANCE`, `DATABASE_URL`, `PLUGINS_DIR`, `PERMISSIONS_FILE`, `SAFE_MODE`,
  `AUTO_INSTALL_LOCAL_DEPS`. See `.env.example`.
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

Everything beyond the core is a plugin, and **plugins are opt-in**: only the ones on the allowlist (in the
database) load. They come from three places:

| Source | Where | Path (allowlist entry) |
|---|---|---|
| Built in | `builtin/` in the image, versioned with the core | `builtin/ping`, `builtin/invite` |
| Yours | `PLUGINS_DIR/local/<plugin>`; the bot only ever installs dependencies there (`node_modules`) | `local/<plugin>` |
| Plugin repos | `PLUGINS_DIR/repos/<repo>`: git clones the bot manages | `<repo>/<plugin>` (or `<repo>` for a one-plugin repo) |

As bot root:

| Command | What it does |
|---|---|
| `!root plugins list [loaded \| failed \| available] [page]` | Every plugin by state: 🟢 loaded, 🔴 failed (enabled but not loaded, and why), 🔵 available. Pages of 10, turned with ⬅️/➡️ |
| `!root plugins info <plugin>` | Details: version, API, settings, dependencies, commands |
| `!root plugins enable <plugin>` | Opt a plugin in after ✅ (approving its dependencies), and load it **without a restart** |
| `!root plugins disable <plugin>` | Opt it out after ✅ (its data is kept); restarts |
| `!root plugins approve <plugin>` | Approve an enabled plugin's dependencies when it's waiting for that, and load it |
| `!root plugins add <https-url> [branch\|tag]` | Clone a repo and list its plugins, after ✅. **Enables nothing** |
| `!root plugins update [repo]` | Fetch, show the new commits (and changed dependencies), apply after ✅; restarts |
| `!root plugins remove <repo>` | Delete a repo and disable its plugins (their data is kept), after ✅; restarts |
| `!root plugins repos` | Managed repos, their commits and plugins |

`<plugin>` is a path (`bitbot-plugins/whoami`), the plugin's id (`whoami`) or its folder name.

**Repos are disposable.** The database records each repo's URL and the commit root reviewed; on every
start the bot puts the clone back into that state: it re-clones a missing one, **discards local changes**,
and checks out the reviewed commit. Develop in `local/`, never in `repos/`. Folders in `repos/` the bot
doesn't manage are ignored, with a warning.

**Dependencies are never installed without root's approval.** A plugin with dependencies must ship a
`package-lock.json`. Root approves that exact lockfile, with the install scripts allowed to run (on
`enable`, `update`, or a prompt at startup), and is asked again whenever either changes. Installs run with
install scripts off (`npm ci --ignore-scripts`); only packages listed in the plugin's `allowScripts` get
theirs run. Every package must come from an https tarball with an integrity hash (the npm registry) or a
local tarball: git dependencies are refused, because npm runs their scripts regardless. An enabled plugin
waiting for approval at startup is asked about in the log channel (else by DM to the owner); any bot root
can answer, and ✅ loads it straight away. `AUTO_INSTALL_LOCAL_DEPS=true` skips the question for
`local/` plugins. Approving narrows what runs at install; the dependency's code still runs inside the bot.

**Guardrails:** two enabled plugins claiming the same command (or a core one), or sharing an id, are
**all disabled**, and the clash is reported to the log channel. `DEBUG=true` turns this off (first one
loaded wins).

**Safe mode:** `SAFE_MODE=true` starts the bot with no plugins at all, so one that breaks the bot can be
disabled from chat. Remove it and restart afterwards.

**Security:** bot root can make the bot run code from any HTTPS repo, and plugins run with the bot's token,
its secrets and its database. Give root only to people who already have access to the host. Every add,
update, enable, disable, dependency approval, remove and restart is posted to the log channel and recorded
in the audit log.

### Writing a plugin

A plugin is a folder with a `package.json` that has a `"bitbot"` object, and an `index.ts`. Start from
[`examples/plugins/whoami`](examples/plugins/whoami) (copy it to `plugins/local/whoami` and
`!root plugins enable local/whoami`).

**package.json** says what the plugin is, so the bot can list and check it without running it:

```json
{
  "name": "bitbot-plugin-cool",
  "version": "1.0.0",
  "type": "module",
  "description": "Does cool things.",
  "author": "JohnPluginman",
  "repository": "https://example.com/cool-plugin",
  "bitbot": {
    "api": "0.4",
    "id": "cool",
    "title": "Cool Plugin",
    "roles": ["cool-host"],
    "cooldown": 10,
    "config": { "channel": { "type": "id", "description": "Where to be cool.", "perGuild": true } },
    "allowScripts": []
  }
}
```

- `id` (required): lower case letters, digits, `-`. It names the plugin's settings and data, so keep it
  stable; a local dev copy and the published copy share it (only one can be enabled).
- `title`: display name (default: the id). `roles`: bot roles its commands use, so permissions.yaml can
  be checked for typos. `cooldown`: the default for its commands.
- `config`: its settings, `{ key: { type, description, default?, required?, secret?, env?, pattern?,
  perGuild?, restart?, rootOnly? } }` (types: string, number, boolean, id, url). They become
  `!admin config <id>`; each also reads an environment variable named from the id and key, upper case, with
  everything else turned into `_` (`access-sync` / `nextcloud_url` → `ACCESS_SYNC_NEXTCLOUD_URL`), or the
  name in `env`. Mark tokens and passwords
  `secret: true` (env / `*_FILE` only). A bad env value keeps the plugin from loading.
- `allowScripts`: dependencies whose install scripts may run. Leave it out unless one really needs it.

**index.ts** default-exports a **factory**; the bot calls it with `bot`, its helper API. A plugin imports
only **types** from the bot (`import type`, erased at runtime), so it works from any folder:

```ts
import type { PluginFactory } from 'bitbot';

const plugin: PluginFactory = (bot) => ({
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
        const where = bot.config.get('channel', message.guildId);
        return message.reply(`cool ${rest}${where ? ` (in <#${where}>)` : ''}`);
      },
    },
  ],
  setup: ({ client, log }) => log.info('connected'), // optional: runs once connected (or when loaded later)
  stop: () => {}, // optional: runs on shutdown
});

export default plugin;
```

- **`bot`** gives `fluxer` (the `@fluxerjs/core` library, the same instance the bot uses), `config`,
  `store`, `log`, `audit`, `prefixFor(guildId)`, `inviteUrl(client)`, `hasRole`, `rolesOf`, `canActOn`
  (immunity: check it before acting on a user), `hasStaffFlag`, `permissionLabel`, `permissionsIn` and
  `limits`. The full list is the `BotAPI` type in `src/plugin.ts`. Settings are readable in the factory too.
- **`ctx`** (the 4th argument to `run`): `ctx.prefix` (this guild's), `ctx.usage(note?)` (reply with the
  standard usage line for bad input) and `ctx.refund()` (nothing happened, for a reason you've told the
  user). A use is charged against the cooldown only when it finishes without either and without throwing.
- **Don't import runtime values from `@fluxerjs/core` or the bot.** Use `bot.fluxer.*` and `bot.*`.
  `import type` is fine. Don't read `process.env`: declare a setting.
- **Files:** never write into your plugin's folder (repo clones are reset on every start, and `builtin/` is
  read-only). Use `os.tmpdir()` for scratch files, `bot.store` for state, and attachments for anything
  you post.
- **Storage:** `bot.store` (`get`, `set`, `delete`, `list(prefix)`) is a private key/value store (JSON
  values), backed by the bot's database. `bot.store.guild(guildId)` and `.user(userId)` narrow it.
- **Dependencies:** list them in `package.json` and commit a `package-lock.json` (npm 7+). Installing
  replaces the folder's `node_modules`, including one you made yourself in `local/`.
- **Command names must be unique** across everything the bot loads (see the guardrails above).
- **Type-checking in a plugin repo:** map `bitbot` to this repo's `src/plugin.ts` and add `@fluxerjs/core`
  as a dev dependency. See bitbot-plugins' `tsconfig.json`.

### Plugin API versions

The plugin API (the `bot` object and the plugin format) is versioned with the bot itself: its version is
the bot's `major.minor`, currently **0.4** (`src/version.ts` reads it from `package.json`). From 1.0 on,
a minor release only adds to the API and a new major may break plugins. **While the bot is on 0.x,
anything can change in any minor release**: plugins are best effort and may need updating. 0.4 changed
the plugin format (metadata moved into package.json), so 0.3 plugins don't load until updated.

`"api": "0.4"` means "0.4 or later, within 0.x". The bot checks this **before running any of the plugin's
code**:

| Plugin declares | Result |
|---|---|
| A compatible version (same major, minor ≤ the bot's) | loads |
| Nothing | loads, with a warning in the log channel |
| An incompatible version | **not loaded**; shown with the reason in `!root plugins list`. `DEBUG=true` loads it anyway, with a warning. |

`!root plugins add`, `update` and `enable` show each plugin's compatibility (✅ API version, ⚠️ undeclared,
⛔ won't load) **before** you confirm; `info` shows it as ✅ / ⚠️ / ❌ next to the bot's version.

## Development vs production bots

Run development on its own Fluxer application, so testing never touches the real bot:

| | Production (Bitbot) | Development (Breakbot) |
|---|---|---|
| Runs from | a pinned release image (`deploy/`) | the **`:edge`** image (every push to `master`), or this checkout (`podman compose up`) for hot reload |
| Token | its own application | a separate application |
| Prefix | `!` | `??` (`PREFIX=??`), so it can share guilds without answering the same commands |
| Guilds | the real ones | a dev guild, plus real ones for realistic tests |
| Plugins | bot-managed repos (`bitbot-plugins`) | bot-managed repos, plus `plugins/local/` for work in progress |
| Log channel | the ops channel | a channel in the dev guild |

Separate tokens mean both can run at the same time. Plugins are developed in their own checkout,
next to this one (`../bitbot-plugins`); push, then `??root plugins update` on Breakbot to try a change.

## Production

The `prod` image (`ghcr.io/bitrot-cafe/bitbot:<version>`, published by CI on version tags) is a plain OCI
image that ships the core, tsx and git. Built-in plugins (`builtin/`) are baked in; everything else lives in the
writable `/app/plugins/local` and `/app/plugins/repos` mounts. See [deploy/README.md](deploy/README.md) for the compose setup.

## License

GPL-3.0. See [LICENSE](LICENSE).
