#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root on the halo2stats/Dedi-Bot host." >&2
  exit 1
fi

BOT_DIR="${DEDI_BOT_DIR:-/home/bot/Dedi-Bot}"
STATSBORG_DIR="${STATSBORG_DIR:-/home/statsborg/statsborg-master}"
AUTH_ENV="${STATSBORG_DIR}/dedi-auth.env"
CADDYFILE="${STATSBORG_DIR}/Caddyfile"
BASE_CADDYFILE="${STATSBORG_DIR}/Caddyfile.dedi-base"

if [ ! -d "$BOT_DIR" ] || [ ! -d "$STATSBORG_DIR" ]; then
  echo "Missing BOT_DIR or STATSBORG_DIR." >&2
  exit 1
fi

install -o root -g root -m 0755 "${BOT_DIR}/scripts/dedi-selkies-route-sync.js" /usr/local/sbin/dedi-selkies-route-sync

if [ -f "$CADDYFILE" ] && [ ! -f "$BASE_CADDYFILE" ]; then
  awk '/^# BEGIN DEDI SELKIES ROUTES - managed by dedi-selkies-route-sync$/ { exit } { print }' "$CADDYFILE" >"$BASE_CADDYFILE"
  chmod 0644 "$BASE_CADDYFILE"
  echo "Captured existing Caddyfile base at ${BASE_CADDYFILE}."
fi

cat >/etc/sudoers.d/dedi-selkies-route-sync <<'EOF'
bot ALL=(root) NOPASSWD: /usr/local/sbin/dedi-selkies-route-sync
EOF
chmod 0440 /etc/sudoers.d/dedi-selkies-route-sync
visudo -cf /etc/sudoers.d/dedi-selkies-route-sync

if [ ! -f "$AUTH_ENV" ]; then
  cookie_secret="$(openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_')"
  cat >"$AUTH_ENV" <<EOF
SELKIES_OAUTH_ENABLED=1
SELKIES_AUTH_PORT=4181
SELKIES_AUTH_BIND=0.0.0.0
SELKIES_AUTH_PUBLIC_URL=https://login.dedi.halo2stats.org
SELKIES_AUTH_COOKIE_DOMAIN=.dedi.halo2stats.org
SELKIES_AUTH_COOKIE_SECRET=${cookie_secret}
DISCORD_GUILD_ID=${DISCORD_GUILD_ID:-}
DISCORD_OAUTH_CLIENT_ID=${DISCORD_OAUTH_CLIENT_ID:-}
DISCORD_OAUTH_CLIENT_SECRET=${DISCORD_OAUTH_CLIENT_SECRET:-}
DISCORD_OAUTH_REDIRECT_URI=${DISCORD_OAUTH_REDIRECT_URI:-https://login.dedi.halo2stats.org/oauth/discord/callback}
EOF
  chmod 0600 "$AUTH_ENV"
  echo "Created ${AUTH_ENV}."
fi

set -a
# shellcheck disable=SC1090
. "$AUTH_ENV"
set +a

missing=()
[ -n "${DISCORD_GUILD_ID:-}" ] || missing+=("DISCORD_GUILD_ID")
[ -n "${DISCORD_OAUTH_CLIENT_ID:-}" ] || missing+=("DISCORD_OAUTH_CLIENT_ID")
[ -n "${DISCORD_OAUTH_CLIENT_SECRET:-}" ] || missing+=("DISCORD_OAUTH_CLIENT_SECRET")
[ -n "${SELKIES_AUTH_COOKIE_SECRET:-}" ] || missing+=("SELKIES_AUTH_COOKIE_SECRET")
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Fill these in ${AUTH_ENV}, then rerun this installer: ${missing[*]}" >&2
  exit 1
fi

cat >"${STATSBORG_DIR}/docker-compose.override.yml" <<EOF
services:
  dedi-auth:
    image: node:22-alpine
    working_dir: /app
    command: ["node", "src/selkies/authServer.js"]
    volumes:
      - ${BOT_DIR}:/app:ro
    env_file:
      - ${AUTH_ENV}
    restart: unless-stopped
EOF

cd "$STATSBORG_DIR"
docker compose config >/dev/null
/usr/local/sbin/dedi-selkies-route-sync
