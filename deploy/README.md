# Deploying bitbot

Production runs the published image `ghcr.io/bitrot-cafe/bitbot:<version>` with plugins mounted from a
checkout of the plugin repo. The files here are templates for `/opt/bitbot` on the host.

## First install (Postgres)

```sh
sudo mkdir -p /opt/bitbot/{plugins,public,pgdata,secrets} && cd /opt/bitbot
sudo cp <this repo>/deploy/compose.yaml .
sudo cp <this repo>/deploy/env.example .env && sudo chown root:docker .env && sudo chmod 660 .env

# Secrets: one file each, never in .env or the database.
pw=$(openssl rand -hex 24)
printf '%s' "$pw"                                        | sudo tee secrets/postgres_password >/dev/null
printf 'postgres://bitbot:%s@db:5432/bitbot' "$pw"       | sudo tee secrets/database_url     >/dev/null
printf '%s' '<the bot token>'                            | sudo tee secrets/fluxer_bot_token >/dev/null
sudo chown root:docker secrets/* && sudo chmod 640 secrets/*  # readable by the containers, not by everyone

sudo chown -R 1000:1000 plugins public                   # the bot runs as uid 1000 (node)
sudo cp permissions.example.yaml permissions.yaml        # who administers the bot; edit it (see below)
docker compose up -d && docker compose logs -f bot       # look for "Database: postgres", "applied 0001_init"
```

`permissions.yaml` (mounted read-only) lists who holds the bot roles: **root** (plugins, restarts, debug
mode) and **admin** (settings, status, audit log). The application owner is always root. Quote user IDs.
The bot reads it at startup, so restart after editing it. Then, as bot root in chat:

```
!root plugins add https://github.com/bitrot-cafe/bitbot-plugins   # makes its plugins available
!root plugins enable whoami                                       # opt in, one plugin at a time
!admin config                                   # every settings scope; ⚠️ marks missing required ones
!admin config set core log_channel <channel id>
```

Adding a repo clones it and lists its plugins; it **enables nothing**. `enable` installs that plugin's
dependencies, records it in `plugins/plugins.json` and restarts. On a fresh host you can instead put a
`plugins/plugins.json` in place before `up -d`; the bot clones every repo listed there on startup:

```json
[{ "name": "bitbot-plugins", "url": "https://github.com/bitrot-cafe/bitbot-plugins", "enabled": ["whoami", "addemote"] }]
```

### Plugin secrets

A plugin's secrets (e.g. access-sync's Nextcloud app password) also come from files. Add one to
`compose.yaml`'s `secrets:` (top level and under `bot:`), and point the plugin's variable at it:

```yaml
    environment:
      ACCESS_SYNC_NEXTCLOUD_APP_PASSWORD_FILE: /run/secrets/nextcloud_app_password
```

`!admin config access-sync` shows secrets only as "(set)" / missing, never the value.

## Small install (SQLite)

For a small community, skip Postgres. In `compose.yaml`:
- delete the `db` service, `depends_on`, and the `database_url` / `postgres_password` secrets;
- mount `./data:/app/data` (`sudo mkdir data && sudo chown 1000:1000 data`).

The bot then keeps everything in `data/bitbot.db` (the default `DATABASE_URL`). Back it up by copying
that file while the bot is stopped.

## Moving between SQLite and Postgres

The schema is the same on both, and `db:copy` moves the data. Stop the bot first; the target must be empty
(it's migrated automatically):

```sh
docker compose stop bot
docker compose run --rm --no-deps -v ./data:/app/data bot \
  node --import tsx src/db/copy.ts --from sqlite:data/bitbot.db --to "$(sudo cat secrets/database_url)"
# then switch compose.yaml to the Postgres setup above and `docker compose up -d`
```

It works the other way round too (`--from postgres://… --to sqlite:…`). It refuses a non-empty target,
copies in one transaction, and checks row counts.

## Updating

- **Core:** tag a release in this repo (`git tag -a v0.3.0 -m … && git push origin v0.3.0`). CI publishes
  `ghcr.io/bitrot-cafe/bitbot:0.3.0`. Bump the tag in `compose.yaml`, then `docker compose pull && docker compose up -d`.
  Database migrations run automatically at startup (on SQLite and Postgres alike).
  With Podman's `podman-compose` and a floating tag (`:0`), recreate explicitly: `pull && down && up -d`.
- **Settings:** `!admin config` (persisted in the database; no restart, except where marked).
- **Plugins:** `!root plugins update` (all repos) or `!root plugins update <repo>`. It shows the new
  commits, and ✅ applies them and restarts. `!root plugins repos` shows what's installed;
  `!root plugins remove <repo>` uninstalls.
- **Who administers the bot:** edit `permissions.yaml`, then `docker compose restart bot`.

## Security

Bot root can make the bot download and run code from any HTTPS git repo, and plugins run with the bot's
token, its secrets and its database. Give root only to people who already have access to the host, and only
add repos you trust. Every add, update, remove and restart is posted to the log channel and recorded in the
audit log (`!admin audit`). Admins can't install code or change root-only settings. `permissions.yaml` is
mounted read-only, so nothing in chat can change who holds a role.

## SELinux

If the host enforces SELinux **and** the container runtime labels mounts (Podman; Docker with
`selinux-enabled`):
- add `:z` to the plugin, public, data and permissions mounts in `compose.yaml` (e.g. `./plugins:/app/plugins:z`,
  `./permissions.yaml:/app/permissions.yaml:ro,z`), and
  `:Z` to `./pgdata:/var/lib/postgresql/data:Z`;
- relabel the secrets folder once, since compose file secrets aren't relabelled automatically:
  `sudo chcon -R -t container_file_t secrets`.

Without these, the containers get "Permission denied" reading their mounts and secrets.

## Image access

GitHub Container Registry packages start **private**. Either make `bitbot` public (GitHub → bitrot-cafe →
Packages → bitbot → Package settings → Change visibility), or `docker login ghcr.io` on the host with a
token that has `read:packages`.
