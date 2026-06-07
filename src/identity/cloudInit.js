function quoteEnvValue(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function indent(text, spaces) {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map(line => line ? `${prefix}${line}` : line)
    .join('\n');
}

export function formatIdentityEnv(identity) {
  return `${Object.entries(identity.env)
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
    .join('\n')}\n`;
}

export function formatServerEnv(identity, extraEnv = {}) {
  return `${Object.entries({
    ...identity.env,
    ...extraEnv
  })
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
    .join('\n')}\n`;
}

export function redactServerEnvText(text) {
  return text.replace(/^(\s*XLINK_KAI_PASSWORD=).*$/m, '$1[REDACTED]');
}

export function buildRealOnesCloudInit(identity, { extraEnv = {} } = {}) {
  const envFile = formatServerEnv(identity, extraEnv);
  const applyIdentityScript = `#!/usr/bin/env bash
set -euo pipefail

SERVER_ENV=/etc/realones/server.env
STACK_DIR=/home/realonesv2/cairo-station
STACK_ENV="$STACK_DIR/.env"
TMP_ENV="$(mktemp)"

cleanup() {
  rm -f "$TMP_ENV"
}
trap cleanup EXIT

if [ ! -f "$SERVER_ENV" ]; then
  echo "Missing $SERVER_ENV; skipping RealOnes identity merge"
  exit 0
fi

if [ ! -d "$STACK_DIR" ]; then
  echo "Missing $STACK_DIR; cannot apply RealOnes identity"
  exit 1
fi

touch "$STACK_ENV"
grep -Ev '^(REALONES|XLINK)_[A-Za-z0-9_]*=' "$STACK_ENV" > "$TMP_ENV" || true
grep -E '^(REALONES|XLINK)_[A-Za-z0-9_]*=' "$SERVER_ENV" >> "$TMP_ENV"
install -o realonesv2 -g realonesv2 -m 0600 "$TMP_ENV" "$STACK_ENV"
`;

  const composeService = `[Unit]
Description=RealOnesV2 disposable server Docker Compose stack
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=true
User=realonesv2
Group=realonesv2
WorkingDirectory=/home/realonesv2/cairo-station
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
`;

  return `#cloud-config
bootcmd:
  - [ mkdir, -p, /etc/realones ]
write_files:
  - path: /etc/realones/server.env
    owner: root:root
    permissions: '0600'
    content: |
${indent(envFile, 6)}
  - path: /usr/local/sbin/realones-apply-identity
    owner: root:root
    permissions: '0755'
    content: |
${indent(applyIdentityScript, 6)}
  - path: /etc/systemd/system/realonesv2-compose.service
    owner: root:root
    permissions: '0644'
    content: |
${indent(composeService, 6)}
runcmd:
  - [ /usr/local/sbin/realones-apply-identity ]
  - [ systemctl, daemon-reload ]
  - [ systemctl, enable, --now, realonesv2-compose.service ]
`;
}

export function buildVultrUserData(identity, options = {}) {
  return Buffer.from(buildRealOnesCloudInit(identity, options), 'utf8').toString('base64');
}
