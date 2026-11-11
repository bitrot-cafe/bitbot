# Deploying bitbot

Production runs the published image `ghcr.io/bitrot-cafe/bitbot:<version>` with plugins mounted from a
checkout of the plugin repo. The files here are templates for `/opt/bitbot` on the host.

## First install

```sh
sudo mkdir -p /opt/bitbot/plugins /opt/bitbot/public && cd /opt/bitbot
sudo cp <this repo>/deploy/compose.yaml .
sudo cp <this repo>/deploy/env.example .env && sudo chown root:docker .env && sudo chmod 660 .env
sudo $EDITOR .env                                    # token, instance, plugin settings
sudo chown -R 1000:1000 plugins public               # the bot runs as uid 1000 (node) and manages plugins/
docker compose up -d && docker compose logs -f
```

Then add plugin repos **from chat**, as a bot administrator:

```
!admin plugins add https://github.com/bitrot-cafe/bitbot-plugins
```

The bot clones the repo, lists its plugins, and after you react ✅ installs their dependencies (inside the
image, so native modules match), records the repo in `plugins/plugins.json`, and restarts. On a fresh host
you can instead drop a `plugins/plugins.json` in place before `up -d`. The bot clones every repo listed
there on startup:

```json
[{ "name": "bitbot-plugins", "url": "https://github.com/bitrot-cafe/bitbot-plugins" }]
```

## Updating

- **Core:** tag a release in this repo (`git tag -a v0.2.0 -m … && git push origin v0.2.0`). CI publishes
  `ghcr.io/bitrot-cafe/bitbot:0.2.0`. Bump the tag in `compose.yaml`, then `docker compose pull && docker compose up -d`.
- **Plugins:** `!admin plugins update` (all repos) or `!admin plugins update <repo>`. It shows the new
  commits, and ✅ applies them and restarts. `!admin plugins repos` shows what's installed;
  `!admin plugins remove <repo>` uninstalls.

## Security

Any bot administrator can make the bot download and run code from any HTTPS git repo, and plugins run with
the bot's token and the whole `.env`. Treat bot administrators (and instance staff, with
`TRUST_INSTANCE_STAFF=true`) as fully trusted, and only add repos you trust. Every add, update, remove and
restart is posted to the log channel.

## SELinux

If the host enforces SELinux **and** Docker runs with `selinux-enabled`, add `:z` to both mounts in
`compose.yaml` (e.g. `./plugins:/app/plugins:z`), or the container can't read them.

## Image access

GitHub Container Registry packages start **private**. Either make `bitbot` public (GitHub → bitrot-cafe →
Packages → bitbot → Package settings → Change visibility), or `docker login ghcr.io` on the host with a
token that has `read:packages`.
