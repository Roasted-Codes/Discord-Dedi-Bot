/**
 * Vultr API Client
 *
 * Initializes and exports the Vultr SDK client.
 */

import VultrNode from '@vultr/vultr-node';
import { config } from '../config/index.js';

// Initialize Vultr client
export const vultr = VultrNode.initialize({
  apiKey: config.vultr.apiKey
});

// Ensure fetch is available (Node.js 18+ has it built-in)
export const fetch = globalThis.fetch;
