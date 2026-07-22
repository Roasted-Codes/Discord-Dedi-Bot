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
  return text
    .replace(/^(\s*XLINK_KAI_PASSWORD=).*$/m, '$1[REDACTED]')
    .replace(/^(\s*SELKIES_PASSWORD=).*$/m, '$1[REDACTED]')
    .replace(/^(\s*STATSBORG_MASTER_TOKEN=).*$/m, '$1[REDACTED]');
}

export function buildRealOnesCloudInit(identity, { extraEnv = {} } = {}) {
  const envFile = formatServerEnv(identity, extraEnv);
  const applyIdentityScript = `#!/usr/bin/env bash
set -euo pipefail

SERVER_ENV=/etc/realones/server.env
STACK_DIR=/home/realonesv2/cairo-station
STACK_ENV="$STACK_DIR/.env"
KAI_CONFIG="$STACK_DIR/services/xlinkkai/kaiengine.conf"
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
grep -Ev '^(REALONES|XLINK|SELKIES)_[A-Za-z0-9_]*=' "$STACK_ENV" > "$TMP_ENV" || true
grep -E '^(REALONES|XLINK|SELKIES)_[A-Za-z0-9_]*=' "$SERVER_ENV" >> "$TMP_ENV"
install -o realonesv2 -g realonesv2 -m 0600 "$TMP_ENV" "$STACK_ENV"

set_kai_config_value() {
  local key="$1"
  local value="$2"

  [ -f "$KAI_CONFIG" ] || return 0
  KAI_CONFIG_PATH="$KAI_CONFIG" KAI_CONFIG_KEY="$key" KAI_CONFIG_VALUE="$value" python3 - <<'PY'
import os

path = os.environ['KAI_CONFIG_PATH']
key = os.environ['KAI_CONFIG_KEY']
value = os.environ['KAI_CONFIG_VALUE']

try:
    with open(path, encoding='utf-8') as handle:
        lines = handle.read().splitlines()
except FileNotFoundError:
    raise SystemExit(0)

found = False
output = []
for line in lines:
    line_key = line.split('=', 1)[0].strip() if '=' in line else ''
    if line_key == key:
        output.append(f'{key}={value}')
        found = True
    else:
        output.append(line)

if not found:
    output.append(f'{key}={value}')

with open(path, 'w', encoding='utf-8') as handle:
    handle.write('\\n'.join(output) + '\\n')
PY
}

if [ -r "$SERVER_ENV" ]; then
  set -a
  . "$SERVER_ENV"
  set +a
fi
set_kai_config_value kaiUsername "\${XLINK_KAI_USERNAME:-}"
set_kai_config_value kaiPassword "\${XLINK_KAI_PASSWORD:-}"
set_kai_config_value kaiAutoLogin 1
set_kai_config_value kaiLanguage en
set_kai_config_value kaiSkin darkmode
`;

  const verifyIdentityScript = `#!/usr/bin/env python3
import json
import os
import shlex
import subprocess
import sys

SERVER_ENV = '/etc/realones/server.env'
STACK_ENV = '/home/realonesv2/cairo-station/.env'
CONTAINER = 'realonesv2-xlinkkai-1'
REQUIRED_KEYS = [
    'REALONES_SERVER_ID',
    'REALONES_DISPLAY_NAME',
    'REALONES_SERVER_SLUG',
    'XLINK_KAI_USERNAME',
    'XLINK_KAI_PASSWORD',
    'XLINK_PRIVATE_ARENA_DESCRIPTION',
]
CONTAINER_KEYS = [
    'XLINK_KAI_USERNAME',
    'XLINK_KAI_PASSWORD',
    'XLINK_PRIVATE_ARENA_DESCRIPTION',
]


def read_env(path):
    values = {}
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    with open(path, encoding='utf-8') as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            try:
                parsed = shlex.split(value, posix=True)
                values[key.strip()] = parsed[0] if parsed else ''
            except ValueError:
                values[key.strip()] = value.strip().strip("'").strip('"')
    return values


def container_env():
    result = subprocess.run(
        ['docker', 'inspect', CONTAINER, '--format', '{{json .Config.Env}}'],
        text=True,
        capture_output=True,
        check=True,
    )
    env_list = json.loads(result.stdout.strip() or '[]')
    values = {}
    for item in env_list:
        if '=' in item:
            key, value = item.split('=', 1)
            values[key] = value
    return values


def main():
    errors = []

    try:
        server = read_env(SERVER_ENV)
    except Exception as error:
        print(f'Missing or unreadable {SERVER_ENV}: {error}', file=sys.stderr)
        return 1

    try:
        stack = read_env(STACK_ENV)
    except Exception as error:
        print(f'Missing or unreadable {STACK_ENV}: {error}', file=sys.stderr)
        return 1

    for key in REQUIRED_KEYS:
        if not server.get(key):
            errors.append(f'{SERVER_ENV} missing {key}')
        if server.get(key) != stack.get(key):
            errors.append(f'{STACK_ENV} {key} does not match {SERVER_ENV}')

    try:
        container = container_env()
    except subprocess.CalledProcessError as error:
        print(f'Missing or unreadable XLink container {CONTAINER}: {error.stderr.strip() or error}', file=sys.stderr)
        return 1

    for key in CONTAINER_KEYS:
        if server.get(key) != container.get(key):
            errors.append(f'{CONTAINER} {key} does not match assigned identity')

    if errors:
        for error in errors:
            print(f'IDENTITY ERROR: {error}', file=sys.stderr)
        return 1

    print(f'Identity verified: {server.get("REALONES_SERVER_ID")} / {server.get("XLINK_KAI_USERNAME")}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
`;

  const prepSnapshotScript = `#!/usr/bin/env python3
import argparse
import json
import os
import pwd
import grp
import re
import shutil
import subprocess
import sys

SERVER_ENV = '/etc/realones/server.env'
STACK_DIR = '/home/realonesv2/cairo-station'
STACK_ENV = f'{STACK_DIR}/.env'
KAI_CONFIG = f'{STACK_DIR}/services/xlinkkai/kaiengine.conf'
CONTAINER = 'realonesv2-xlinkkai-1'
IDENTITY_FILES = [SERVER_ENV, STACK_ENV, KAI_CONFIG]
ENV_KEY_RE = re.compile(r'^(REALONES|XLINK|SELKIES)_[A-Za-z0-9_]*=')
XLINK_KEY_RE = re.compile(r'^XLINK_[A-Za-z0-9_]*=')
SELKIES_KEY_RE = re.compile(r'^SELKIES_[A-Za-z0-9_]*=')
STALE_RE = re.compile(r'gandhi|ghandi', re.IGNORECASE)
NEUTRAL_REALONES = {
    'REALONES_TEMPLATE_IMAGE': '1',
    'REALONES_SERVER_ID': 'template',
    'REALONES_DISPLAY_NAME': 'RealOnesV2 Template',
    'REALONES_SERVER_SLUG': 'template',
    'REALONES_SERVER_SEQUENCE': '000',
    'REALONES_REGION': '',
    'REALONES_HOSTNAME': '',
    'REALONES_FRIENDLY_HOSTNAME': '',
    'REALONES_CREATOR': 'snapshot-prep',
}


def quote_env(value):
    return "'" + str(value).replace("'", "'\\\\''") + "'"


def read_text(path):
    try:
        with open(path, encoding='utf-8') as handle:
            return handle.read()
    except FileNotFoundError:
        return ''


def run(command, *, cwd=None, check=True):
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=check)


def docker_container_exists():
    result = run(['docker', 'ps', '-a', '--format', '{{.Names}}'], check=False)
    return CONTAINER in result.stdout.splitlines()


def docker_container_running():
    result = run(['docker', 'ps', '--format', '{{.Names}}'], check=False)
    return CONTAINER in result.stdout.splitlines()


def check_state():
    issues = []

    for path in [SERVER_ENV, STACK_ENV]:
        text = read_text(path)
        if not text:
            issues.append(f'{path} is missing')
            continue

        for index, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith('#'):
                continue
            if XLINK_KEY_RE.match(stripped):
                issues.append(f'{path}:{index} still contains {stripped.split("=", 1)[0]}')
            if SELKIES_KEY_RE.match(stripped):
                issues.append(f'{path}:{index} still contains {stripped.split("=", 1)[0]}')
            if STALE_RE.search(stripped):
                issues.append(f'{path}:{index} still contains gandhi/ghandi text')

    kai_text = read_text(KAI_CONFIG)
    if kai_text:
        for index, line in enumerate(kai_text.splitlines(), start=1):
            stripped = line.strip()
            if re.match(r'^kai(User|Pass|Password|Username)=.+', stripped, re.IGNORECASE):
                issues.append(f'{KAI_CONFIG}:{index} still contains Kai credential config')
            if STALE_RE.search(stripped):
                issues.append(f'{KAI_CONFIG}:{index} still contains gandhi/ghandi text')

    if docker_container_running():
        issues.append(f'{CONTAINER} is still running')
    elif docker_container_exists():
        issues.append(f'{CONTAINER} container still exists')

    return issues


def write_neutral_env(path, *, owner=None, mode=0o600):
    lines = []
    text = read_text(path)
    for line in text.splitlines():
        if ENV_KEY_RE.match(line.strip()):
            continue
        lines.append(line)

    while lines and not lines[-1].strip():
        lines.pop()

    if lines:
        lines.append('')
    for key, value in NEUTRAL_REALONES.items():
        lines.append(f'{key}={quote_env(value)}')

    with open(path, 'w', encoding='utf-8') as handle:
        handle.write('\\n'.join(lines) + '\\n')
    os.chmod(path, mode)

    if owner:
        try:
            user = pwd.getpwnam(owner)
            group = grp.getgrnam(owner)
            os.chown(path, user.pw_uid, group.gr_gid)
        except KeyError:
            pass


def scrub_kai_config():
    if not os.path.exists(KAI_CONFIG):
        return False

    changed = False
    output = []
    for line in read_text(KAI_CONFIG).splitlines():
        key = line.split('=', 1)[0].strip() if '=' in line else ''
        if key in {'kaiUsername', 'kaiUser', 'kaiPassword', 'kaiPass'}:
            output.append(f'{key}=')
            changed = True
        elif key == 'kaiAutoLogin':
            output.append('kaiAutoLogin=0')
            changed = True
        else:
            output.append(line)

    with open(KAI_CONFIG, 'w', encoding='utf-8') as handle:
        handle.write('\\n'.join(output) + '\\n')
    return changed


def apply_cleanup():
    actions = []

    if os.path.isdir(STACK_DIR):
        result = run(['docker', 'compose', 'rm', '-sf', 'xlinkkai'], cwd=STACK_DIR, check=False)
        actions.append('stopped and removed xlinkkai with docker compose')
        if result.returncode != 0:
            fallback = run(['docker', 'rm', '-f', CONTAINER], check=False)
            if fallback.returncode == 0:
                actions.append('removed xlinkkai container with docker rm fallback')
    else:
        fallback = run(['docker', 'rm', '-f', CONTAINER], check=False)
        if fallback.returncode == 0:
            actions.append('removed xlinkkai container with docker rm')

    os.makedirs(os.path.dirname(SERVER_ENV), exist_ok=True)
    write_neutral_env(SERVER_ENV)
    actions.append(f'wrote neutral identity to {SERVER_ENV}')

    if os.path.isdir(STACK_DIR):
        write_neutral_env(STACK_ENV, owner='realonesv2')
        actions.append(f'wrote neutral identity to {STACK_ENV}')

    if scrub_kai_config():
        actions.append(f'scrubbed Kai credential fields from {KAI_CONFIG}')

    if shutil.which('cloud-init'):
        result = run(['cloud-init', 'clean', '--logs'], check=False)
        if result.returncode == 0:
            actions.append('ran cloud-init clean --logs')
        else:
            actions.append('cloud-init clean --logs returned non-zero')

    return actions


def emit(payload, as_json):
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(payload['summary'])
        for issue in payload.get('issues', []):
            print(f'- {issue}')


def main():
    parser = argparse.ArgumentParser(description='Prepare a RealOnesV2 server for snapshotting.')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--check', action='store_true')
    group.add_argument('--apply', action='store_true')
    parser.add_argument('--json', action='store_true', dest='json_output')
    args = parser.parse_args()

    actions = []
    if args.apply:
        actions = apply_cleanup()

    issues = check_state()
    safe = len(issues) == 0
    payload = {
        'mode': 'apply' if args.apply else 'check',
        'safe': safe,
        'status': 'safe' if safe else 'unsafe',
        'summary': 'SAFE TO SNAPSHOT' if safe else 'NOT SAFE TO SNAPSHOT',
        'issues': issues,
        'actions': actions,
    }
    emit(payload, args.json_output)
    return 0 if safe else 2


if __name__ == '__main__':
    sys.exit(main())
`;

const startStackScript = `#!/usr/bin/env bash
set -euo pipefail

STACK_DIR=/home/realonesv2/cairo-station

if [ ! -d "$STACK_DIR" ]; then
  echo "Missing $STACK_DIR; cannot start RealOnes stack" >&2
  exit 1
fi

cd "$STACK_DIR"
/usr/local/sbin/realones-apply-identity
/usr/bin/docker compose rm -sf xlinkkai || true
/usr/bin/docker compose up -d --remove-orphans
/usr/bin/docker compose up -d --force-recreate --no-deps xlinkkai
/usr/local/sbin/realones-verify-identity
`;

  const bootstrapStackScript = `#!/usr/bin/env bash
set -euo pipefail

if [ -x /usr/local/sbin/classic-v2-start-stack ] && [ -d /home/docker/docker-xemu-linuxserver ]; then
  /usr/local/sbin/classic-v2-start-stack
  /usr/local/sbin/classic-v2-verify-identity
  exit 0
fi

if [ -d /home/realonesv2/cairo-station ]; then
  /usr/local/sbin/realones-start-stack
  /usr/local/sbin/realones-verify-identity
  exit 0
fi

echo "No supported RealOnes stack path found" >&2
exit 1
`;

  const xlinkAutoArenaScript = `#!/usr/bin/env python3
import base64
import os
import shlex
import sys
import time
import urllib.parse
import urllib.request

BASE_URL = 'http://127.0.0.1:34522'
SERVER_ENV = '/etc/realones/server.env'
DEFAULT_ARENA = 'Arena/XBox/First Person Shooter/Halo 2/North America/MLG'


def log(message):
    print(f'[xlink-autoarena] {message}', flush=True)


def read_env(path):
    values = {}
    try:
        with open(path, encoding='utf-8') as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                try:
                    parsed = shlex.split(value, posix=True)
                    values[key.strip()] = parsed[0] if parsed else ''
                except ValueError:
                    values[key.strip()] = value.strip().strip("'").strip('"')
    except FileNotFoundError:
        pass
    return values


def post(path, data=None, timeout=8):
    encoded = None if data is None else urllib.parse.urlencode(data).encode()
    request = urllib.request.Request(BASE_URL + path, data=encoded, method='POST')
    if encoded is not None:
        request.add_header('Content-Type', 'application/x-www-form-urlencoded')
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode('utf-8', 'replace')


def attach():
    return post('/connector/attach', {}, timeout=5).strip()


def detach(session_id):
    try:
        post('/connector/detach', {}, timeout=5)
    except Exception:
        pass


def send(session_id, command):
    post('/connector/command', {'sessionid': session_id, 'command': command}, timeout=5)


def poll(session_id, seconds=8):
    rows = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            raw = post(f'/connector/poll?sessionid={session_id}', {}, timeout=3)
        except Exception:
            continue
        rows.extend(
            item.strip()
            for item in urllib.parse.unquote(raw).split('\\x01')
            if item.strip()
        )
        if rows:
            time.sleep(0.2)
    return rows


def is_logged_in(rows):
    return any(row.startswith('KAI_CLIENT_LOGGED_IN') or row.startswith('KAI_CLIENT_CONNECTED_') for row in rows)


def current_vector(rows):
    for row in rows:
        if row.startswith('KAI_CLIENT_VECTOR;'):
            bits = row.split(';')
            if len(bits) > 1:
                return bits[1]
    return ''


def private_exists(rows, private_vector):
    prefix = f'KAI_CLIENT_USER_SUB_VECTOR;{private_vector};'
    return any(row.startswith(prefix) for row in rows)


def main():
    env = read_env(SERVER_ENV)
    username = env.get('XLINK_KAI_USERNAME', '').strip()
    password = env.get('XLINK_KAI_PASSWORD', '')
    if not username:
        log('XLINK_KAI_USERNAME is missing; cannot create private arena')
        return 1

    target = env.get('XLINK_AUTO_ARENA_PATH') or DEFAULT_ARENA
    description = (
        env.get('XLINK_PRIVATE_ARENA_DESCRIPTION')
        or env.get('REALONES_DISPLAY_NAME')
        or env.get('REALONES_SERVER_ID')
        or username
    )
    max_players = ''.join(ch for ch in env.get('XLINK_PRIVATE_ARENA_MAX_PLAYERS', '99') if ch.isdigit()) or '99'
    arena_password = env.get('XLINK_PRIVATE_ARENA_PASSWORD', '')
    status = ''.join(ch for ch in env.get('XLINK_KAI_ARENA_STATUS', '3') if ch.isdigit()) or '3'
    private_vector = f'{target}/{username}'
    encoded_description = urllib.parse.quote(description, safe='')
    deadline = time.time() + int(env.get('XLINK_AUTO_ARENA_TIMEOUT_SECONDS', '240') or '240')
    last_error = None

    while time.time() < deadline:
        session_id = None
        try:
            session_id = attach()
            send(session_id, 'KAI_CLIENT_GETSTATE')
            rows = poll(session_id, 6)
            if not is_logged_in(rows) and password:
                password_b64 = base64.b64encode(password.encode()).decode()
                send(session_id, f'KAI_CLIENT_LOGIN\\t{username}\\t{password}\\t{password_b64}\\t')
                rows = poll(session_id, 10)
            if not is_logged_in(rows):
                raise RuntimeError('Kai is not logged in yet')

            send(session_id, f'KAI_CLIENT_VECTOR\\t{target}\\t')
            poll(session_id, 4)
            send(session_id, f'KAI_CLIENT_GET_VECTORS\\t{target}\\t')
            rows = poll(session_id, 6)

            send(session_id, f'KAI_CLIENT_CREATE_VECTOR\\t{max_players}\\t{encoded_description}\\t{arena_password}\\t')

            poll(session_id, 5)
            send(session_id, f'KAI_CLIENT_ARENA_STATUS\\t{status}\\t1\\t')
            send(session_id, 'KAI_CLIENT_GETSTATE')
            rows = poll(session_id, 8)
            vector = current_vector(rows)
            if vector == private_vector or private_exists(rows, private_vector):
                log(f'joined {private_vector}')
                return 0

            raise RuntimeError(f'private arena not confirmed; current vector is {vector or "unknown"}')
        except Exception as error:
            last_error = error
            log(f'waiting for Kai auto-arena: {error}')
            time.sleep(10)
        finally:
            if session_id:
                detach(session_id)

    log(f'failed to create private arena before timeout: {last_error}')
    return 1


if __name__ == '__main__':
    sys.exit(main())
`;

  const composeService = `[Unit]
Description=RealOnes disposable server Docker Compose stack
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=/
ExecStart=/usr/local/sbin/realones-bootstrap-stack
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
`;

  const xlinkAutoArenaService = `[Unit]
Description=RealOnes XLink Kai auto arena
Wants=network-online.target docker.service
After=network-online.target docker.service realonesv2-compose.service xemu-compose.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/realones-xlink-autoarena
TimeoutStartSec=300
Restart=on-failure
RestartSec=20
StartLimitIntervalSec=600
StartLimitBurst=20

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
  - path: /usr/local/sbin/realones-verify-identity
    owner: root:root
    permissions: '0755'
    content: |
${indent(verifyIdentityScript, 6)}
  - path: /usr/local/sbin/realones-prep-snapshot
    owner: root:root
    permissions: '0755'
    content: |
${indent(prepSnapshotScript, 6)}
  - path: /usr/local/sbin/realones-start-stack
    owner: root:root
    permissions: '0755'
    content: |
${indent(startStackScript, 6)}
  - path: /usr/local/sbin/realones-bootstrap-stack
    owner: root:root
    permissions: '0755'
    content: |
${indent(bootstrapStackScript, 6)}
  - path: /usr/local/sbin/realones-xlink-autoarena
    owner: root:root
    permissions: '0755'
    content: |
${indent(xlinkAutoArenaScript, 6)}
  - path: /etc/systemd/system/realonesv2-compose.service
    owner: root:root
    permissions: '0644'
    content: |
${indent(composeService, 6)}
  - path: /etc/systemd/system/realones-xlink-autoarena.service
    owner: root:root
    permissions: '0644'
    content: |
${indent(xlinkAutoArenaService, 6)}
runcmd:
  - [ systemctl, daemon-reload ]
  - [ systemctl, enable, realonesv2-compose.service ]
  - [ systemctl, enable, realones-xlink-autoarena.service ]
  - [ sh, -lc, '. /etc/realones/server.env; if [ "\${SELKIES_CENTRAL_PROXY_ENABLED:-}" = "1" ]; then ufw allow from "\${SELKIES_PROXY_SOURCE_IP:-45.76.27.186}" to any port 3000 proto tcp || true; ufw delete allow 80/tcp || true; ufw delete allow 443/tcp || true; systemctl disable --now realones-selkies-proxy.service caddy.service || true; fi' ]
  - [ systemctl, restart, realonesv2-compose.service ]
  - [ sh, -lc, '. /etc/realones/server.env; if [ "\${SELKIES_CENTRAL_PROXY_ENABLED:-}" != "1" ]; then systemctl restart realones-selkies-proxy.service || true; fi' ]
  - [ sh, -lc, 'systemctl restart realones-xlink-autoarena.service || true' ]
`;
}

export function buildVultrUserData(identity, options = {}) {
  return Buffer.from(buildRealOnesCloudInit(identity, options), 'utf8').toString('base64');
}
