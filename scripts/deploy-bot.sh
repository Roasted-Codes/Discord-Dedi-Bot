#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

check_only=0
for arg in "$@"; do
  case "$arg" in
    --check-only)
      check_only=1
      ;;
    *)
      printf 'Unknown deploy argument: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

section() {
  printf '\n== %s ==\n' "$1"
}

section "Git"
git branch --show-current
git status --short

section "Syntax"
mapfile -t changed_js < <(
  {
    git diff --name-only -- '*.js'
    git diff --cached --name-only -- '*.js'
    git ls-files --others --exclude-standard -- '*.js'
  } | sort -u
)

if [[ "${#changed_js[@]}" -eq 0 ]]; then
  printf 'No changed JavaScript files to syntax-check.\n'
else
  for file in "${changed_js[@]}"; do
    if [[ -f "$file" ]]; then
      printf 'node --check %s\n' "$file"
      node --check "$file"
    fi
  done
fi

section "Dry Runs"
npm run snapshot:list -- --limit=3
npm run vultr:whoami
npm run restore:dry-run -- --snapshot=auto_dedi_rc --region="${VULTR_REGION:-dfw}" --timer=210

if [[ "$check_only" -eq 1 ]]; then
  section "Check Only"
  printf 'Dry-run deploy checks passed. Service was not restarted.\n'
  exit 0
fi

section "Restart"
if ! sudo -n /usr/local/sbin/dedi-bot-restart; then
  printf '\nCannot restart through /usr/local/sbin/dedi-bot-restart.\n' >&2
  printf 'Install the root-owned wrappers once with: sudo bash scripts/install-agent-sudoers.sh\n' >&2
  exit 1
fi

section "Post-Restart Status"
sudo -n /usr/local/sbin/dedi-bot-status

section "Startup Logs"
sudo -n /usr/local/sbin/dedi-bot-logs
