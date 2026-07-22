import { randomBytes } from 'crypto';

export const DEFAULT_SELKIES_USERNAME = 'realones';

export function generateSelkiesPassword() {
  return randomBytes(18).toString('base64url');
}

export function buildSelkiesAccess({
  username = process.env.SELKIES_USERNAME || DEFAULT_SELKIES_USERNAME,
  password = generateSelkiesPassword()
} = {}) {
  return {
    username: String(username || DEFAULT_SELKIES_USERNAME).trim() || DEFAULT_SELKIES_USERNAME,
    password: String(password || generateSelkiesPassword())
  };
}

export function buildSelkiesEnv(access) {
  if (!access?.username || !access?.password) {
    return {};
  }

  const env = {
    SELKIES_USERNAME: access.username,
    SELKIES_PASSWORD: access.password
  };

  if (process.env.SELKIES_CENTRAL_PROXY_ENABLED === '1') {
    env.SELKIES_CENTRAL_PROXY_ENABLED = '1';
    env.SELKIES_PROXY_SOURCE_IP = process.env.SELKIES_PROXY_SOURCE_IP || '45.76.27.186';
  }

  return env;
}
