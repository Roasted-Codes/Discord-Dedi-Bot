/**
 * Configuration Loader
 *
 * Loads environment variables and exports configuration object.
 */

import 'dotenv/config';

// Export all constants
export * from './constants.js';

// Configuration object for easy access
export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    guildId: process.env.DISCORD_GUILD_ID
  },
  vultr: {
    apiKey: process.env.VULTR_API_KEY,
    snapshotId: process.env.VULTR_SNAPSHOT_ID,
    firewallGroupId: process.env.VULTR_FIREWALL_GROUP_ID,
    region: process.env.VULTR_REGION || 'dfw',
    plan: process.env.VULTR_PLAN || 'vc2-1c-1gb'
  },
  admin: {
    userIds: (process.env.ADMIN_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean)
  },
  exclude: {
    instanceId: process.env.EXCLUDE_INSTANCE_ID,
    snapshotId: process.env.EXCLUDE_SNAPSHOT_ID
  }
};
