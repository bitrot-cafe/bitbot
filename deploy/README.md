# Deploying bitbot

Production runs the published image `ghcr.io/bitrot-cafe/bitbot:<version>` with plugins mounted from a
checkout of the plugin repo. The files here are templates for `/opt/bitbot` on the host.

## First install

```sh
sudo mkdir -p /opt/bitbot && cd /opt/bitbot
sudo cp <this repo>/deploy/compose.yaml .
sudo cp <this repo>/deploy/env.example .env && sudo chown root:docker .env && sudo chmod 660 .env
sudo $EDITOR .env                                  # token, instance, plugin settings
sudo git clone <plugin repo> plugins               # one folder per plugin
sudo mkdir -p public && sudo chown 1000:1000 public  # the bot runs as uid 1000 (node)
```

Install plugin dependencies **inside the image**, so native modules like sharp match its Alpine/musl.
The service mounts plugins read-only, so this one-off run mounts them writable, as root:

```sh
docker run --rm --user root -v "$PWD/plugins:/app/plugins" "$(docker compose config --images)" \
  sh -c 'for d in plugins/*/; do [ -f "$d/package.json" ] && (cd "$d" && npm install --omit=dev); done'
docker compose up -d
docker compose logs -f
```

## Updating

- **Core:** tag a release in this repo (`git tag v0.2.0 && git push --tags`). CI publishes
  `ghcr.io/bitrot-cafe/bitbot:0.2.0`. Bump the tag in `compose.yaml`, then `docker compose pull && docker compose up -d`.
- **Plugins:** `git -C plugins pull`, re-run the dependency install if a `package.json` changed, then
  `docker compose restart`.

## SELinux

If the host enforces SELinux **and** Docker runs with `selinux-enabled`, add `:z` to both mounts in
`compose.yaml` (e.g. `./plugins:/app/plugins:ro,z`), or the container can't read them.

## Image access

GitHub Container Registry packages start **private**. Either make `bitbot` public (GitHub → bitrot-cafe →
Packages → bitbot → Package settings → Change visibility), or `docker login ghcr.io` on the host with a
token that has `read:packages`.
