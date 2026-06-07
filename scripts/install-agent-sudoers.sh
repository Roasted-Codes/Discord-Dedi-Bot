#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'This installer must run as root. Use: sudo bash scripts/install-agent-sudoers.sh\n' >&2
  exit 1
fi

install -d -m 0755 /usr/local/sbin

cat >/usr/local/sbin/dedi-bot-status <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
systemctl is-active dedi-bot.service
systemctl show -p MainPID --value dedi-bot.service
systemctl status dedi-bot.service --no-pager -n 30
EOF

cat >/usr/local/sbin/dedi-bot-restart <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
systemctl restart dedi-bot.service
sleep 3
systemctl is-active dedi-bot.service
systemctl show -p MainPID --value dedi-bot.service
EOF

cat >/usr/local/sbin/dedi-bot-logs <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
journalctl -u dedi-bot.service -n 120 --no-pager
EOF

chmod 0755 /usr/local/sbin/dedi-bot-status
chmod 0755 /usr/local/sbin/dedi-bot-restart
chmod 0755 /usr/local/sbin/dedi-bot-logs
chown root:root /usr/local/sbin/dedi-bot-status
chown root:root /usr/local/sbin/dedi-bot-restart
chown root:root /usr/local/sbin/dedi-bot-logs

cat >/etc/sudoers.d/dedi-bot-agent <<'EOF'
bot ALL=(root) NOPASSWD: /usr/local/sbin/dedi-bot-status
bot ALL=(root) NOPASSWD: /usr/local/sbin/dedi-bot-restart
bot ALL=(root) NOPASSWD: /usr/local/sbin/dedi-bot-logs
EOF

chmod 0440 /etc/sudoers.d/dedi-bot-agent
chown root:root /etc/sudoers.d/dedi-bot-agent
visudo -cf /etc/sudoers.d/dedi-bot-agent

printf 'Installed Dedi-Bot agent sudo wrappers.\n'
sudo -l -U bot
