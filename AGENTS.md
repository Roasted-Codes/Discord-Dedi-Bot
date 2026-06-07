# Dedi-Bot Agent Guide

## Source Of Truth

- Host: `bot@45.76.27.186`
- Repo: `/home/bot/Dedi-Bot`
- Service: `dedi-bot.service`
- Normal operator user: `bot`
- Current branch: `refactor/modular-architecture`

Treat the live VPS repo as authoritative until a clean remote baseline is pushed and confirmed. Do not assume a local checkout has the latest Discord, Vultr, snapshot, or XLink behavior.

## Hard Safety Rules

- Do not destroy, rebuild, or snapshot the bot instance itself.
- Do not print `.env` values, XLink passwords, Discord tokens, or Vultr API keys.
- Do not push commits without explicit confirmation.
- Use the bot-managed snapshot filters for normal restore flows.
- Keep raw snapshot-ID restore as an admin/manual fallback only.
- Use one-shot SSH commands and close sessions when finished.

The bot protects itself through Vultr metadata (`instance-v2-id`) and `EXCLUDE_INSTANCE_ID`. Verify that self-protection resolves before destructive Vultr maintenance.

## Safe Commands

Run these from `/home/bot/Dedi-Bot` as `bot`:

```bash
npm run agent:status
npm run snapshot:list
npm run restore:dry-run -- --snapshot=auto_dedi_rc --region=dfw --timer=210
npm run vultr:whoami
npm run deploy -- --check-only
```

Normal deploys require the one-time root setup below:

```bash
sudo bash scripts/install-agent-sudoers.sh
npm run deploy
```

If `npm run deploy` reports that the sudo wrapper is unavailable, install the wrapper as root. Do not use a kill/restart fallback unless the user explicitly authorizes it for that incident.

## Root Setup

`scripts/install-agent-sudoers.sh` installs these root-owned wrappers:

- `/usr/local/sbin/dedi-bot-status`
- `/usr/local/sbin/dedi-bot-restart`
- `/usr/local/sbin/dedi-bot-logs`

It also installs `/etc/sudoers.d/dedi-bot-agent`, allowing `bot` passwordless sudo only for those exact commands.

Verify scope with:

```bash
sudo -l
```

The expected allowed commands are only the three Dedi-Bot wrappers above.

## Restore And Snapshot Notes

- `/restore-snapshot` should show bot-managed RealOnesV2 snapshots first, newest first.
- Bot-managed snapshots come from the live Vultr snapshot list filtered by `getBotManagedSnapshots()`.
- Snapshot picker context should show name, created date, size/plan hint when available, and a short ID suffix.
- The normal restore modal asks for server name, region, and timer. It does not ask for a raw snapshot ID.
- Confirmation is required before Vultr create.
- `/snapshot` and raw Vultr list operations are admin maintenance paths and may use unfiltered Vultr APIs.

## Git Baseline

Review the dirty tree before committing:

```bash
git status --short
git diff --stat
```

Do not add `.env`, `.env.backups/`, `.env.bak-*`, XLink secrets, assignment data, logs, or generated backups. A remote exists only if `git remote -v` shows the intended repository. If the intended remote is unclear, document that and do not add one.
