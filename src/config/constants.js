/**
 * Application Constants
 *
 * Centralized configuration values and defaults.
 * Many can be overridden via environment variables.
 *
 * Environment Variables:
 *   LOG_LEVEL - Controls log verbosity (error, warn, info, debug)
 *               Default: info
 */

// Self-destruct timer configuration
export const SELF_DESTRUCT_INITIAL_MINUTES = parseInt(process.env.SELF_DESTRUCT_INITIAL_MINUTES) || 180; // 3 hours default
export const SELF_DESTRUCT_COIN_MINUTES = parseInt(process.env.SELF_DESTRUCT_COIN_MINUTES) || 180; // 3 hours default

// Panel refresh interval
export const PANEL_REFRESH_INTERVAL_MS = 10000; // 10 seconds

// Polling intervals
export const INSTANCE_POLL_INTERVAL_MS = 45000;
export const SNAPSHOT_POLL_INTERVAL_MS = 30000;
export const DESTRUCTION_POLL_INTERVAL_MS = 10000;
export const SELF_DESTRUCT_POLL_INTERVAL_MS = 30000;

// Timeouts
export const MAX_INSTANCE_WAIT_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_DESTRUCTION_WAIT_MS = 15 * 60 * 1000; // 15 minutes

// Auto-cleanup message timeout
export const AUTO_CLEANUP_DEFAULT_MS = 30000;
export const CREATE_REPLY_CLEANUP_MS = 10 * 60 * 1000;
export const POWER_ACTION_REPLY_CLEANUP_MS = 3 * 60 * 1000;

// Vultr defaults
export const DEFAULT_REGION = process.env.VULTR_REGION || 'dfw';
export const DEFAULT_PLAN = process.env.VULTR_PLAN || 'vc2-1c-1gb';

// Gaming-optimized region whitelist for quick action buttons
export const GAMING_REGIONS = [
  // CONUS (8)
  'atl', 'ord', 'dfw', 'lax', 'mia', 'ewr', 'sea', 'sjc',
  // Canada (1)
  'yto',
  // Europe (6)
  'ams', 'fra', 'lhr', 'mad', 'cdg', 'sto'
];

// Admin user IDs (from environment)
export const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// Status emoji mappings
export const STATUS_EMOJIS = {
  'running': '🟢',
  'stopped': '🔴',
  'pending': '🟡',
  'default': '⚪'
};
