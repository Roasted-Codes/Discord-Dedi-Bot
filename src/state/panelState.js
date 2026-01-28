/**
 * Panel State Management
 *
 * Persists the control panel message/channel IDs to survive bot restarts.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PANEL_DATA_FILE = path.join(__dirname, '../../panel_data.json');

// Panel data object
export const panelData = {
  messageId: null,
  channelId: null,
  lastUpdate: null
};

/**
 * Load panel data from file
 */
export function loadPanelData() {
  try {
    if (fs.existsSync(PANEL_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(PANEL_DATA_FILE, 'utf8'));
      panelData.messageId = data.messageId || null;
      panelData.channelId = data.channelId || null;
      panelData.lastUpdate = data.lastUpdate || null;
      logger.debug('Panel data loaded');
    }
  } catch (error) {
    logger.error('Error loading panel data:', error.message);
  }
}

/**
 * Save panel data to file
 */
export function savePanelData() {
  try {
    fs.writeFileSync(PANEL_DATA_FILE, JSON.stringify({
      messageId: panelData.messageId,
      channelId: panelData.channelId,
      lastUpdate: new Date().toISOString()
    }, null, 2));
  } catch (error) {
    logger.error('Error saving panel data:', error.message);
  }
}

// Load on module initialization
loadPanelData();
