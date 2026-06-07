#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

section() {
  printf '\n== %s ==\n' "$1"
}

env_key_status() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    printf '%-28s set (process env)\n' "$key"
    return
  fi
  if [[ -f .env ]] && grep -Eq "^[[:space:]]*${key}=" .env; then
    printf '%-28s set (.env)\n' "$key"
    return
  fi
  printf '%-28s missing\n' "$key"
}

run_or_note() {
  local label="$1"
  shift
  if "$@"; then
    return
  fi
  printf '%s unavailable or failed\n' "$label"
}

section "Host"
printf 'user: %s\n' "$(id -un)"
printf 'host: %s\n' "$(hostname)"
printf 'repo: %s\n' "$repo_root"
printf 'date: %s\n' "$(date -Is)"

section "Git"
run_or_note "git branch" git branch --show-current
run_or_note "git remote" git remote -v
run_or_note "git status" git status --short

section "Runtime"
run_or_note "node" node --version
run_or_note "npm" npm --version

section "Environment Keys"
for key in DISCORD_TOKEN VULTR_API_KEY VULTR_FIREWALL_GROUP_ID ADMIN_USER_IDS; do
  env_key_status "$key"
done
for key in DISCORD_GUILD_ID VULTR_REGION VULTR_PLAN VULTR_SNAPSHOT_ID EXCLUDE_INSTANCE_ID EXCLUDE_SNAPSHOT_ID REALONES_DOMAIN XLINK_ACCOUNTS_FILE XLINK_ASSIGNMENTS_FILE; do
  env_key_status "$key"
done

section "Service"
if sudo -n /usr/local/sbin/dedi-bot-status >/tmp/dedi-bot-agent-status.out 2>/tmp/dedi-bot-agent-status.err; then
  cat /tmp/dedi-bot-agent-status.out
else
  systemctl is-active dedi-bot.service || true
  systemctl show -p MainPID --value dedi-bot.service || true
  systemctl status dedi-bot.service --no-pager -n 20 || true
fi

section "Vultr Identity"
npm run vultr:whoami || true

section "Bot-Managed Snapshots"
npm run snapshot:list -- --limit=5 || true

section "Recent Logs"
if sudo -n /usr/local/sbin/dedi-bot-logs >/tmp/dedi-bot-agent-logs.out 2>/tmp/dedi-bot-agent-logs.err; then
  cat /tmp/dedi-bot-agent-logs.out
else
  journalctl -u dedi-bot.service -n 40 --no-pager || true
fi
