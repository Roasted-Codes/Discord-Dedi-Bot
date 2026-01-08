/**
 * NOTE: Make sure your Vultr API key settings allow requests from this server's IP address, or commands will fail!
 * 
 * SELF-PROTECTION: The bot automatically detects and excludes the current server from all management
 * operations (list, status, start, stop, destroy) using Vultr's metadata service. No manual setup required!
 * 
 * EXCLUDE_SNAPSHOT_ID: (Optional) Set this environment variable to exclude additional servers by snapshot ID.
 * EXCLUDE_INSTANCE_ID: (Optional) Fallback if metadata service is unavailable - manually specify instance ID.
 * ADMIN_USER_IDS: (Required for snapshots) Comma-separated Discord user IDs who can create snapshots (e.g., "123456789,987654321")
 * VULTR_PUBLIC_SNAPSHOTS: (Legacy/Optional) Comma-separated snapshot IDs - now auto-detected via [PUBLIC] prefix
 *
 * Last Updated: September 7 2025 - Added dynamic snapshot management, consolidated handlers, self-protection
 * 
 * RECENT CODE IMPROVEMENTS (September 2025):
 * ========================================
 * 
 * 1. CONSOLIDATED INTERACTION HANDLERS:
 *    - Replaced 5 separate client.on('interactionCreate') handlers with 1 unified handler
 *    - Reduced code duplication from ~150 lines to ~80 lines
 *    - Improved maintainability while preserving ALL functionality
 *    - All Vultr OpenAPI calls remain exactly the same
 * 
 * 2. SIMPLIFIED STATUS LOGIC:
 *    - Replaced if/else chain with clean object map for status emojis
 *    - More maintainable and easier to extend
 * 
 * 3. MODERNIZED SYNTAX:
 *    - Replaced `!array || array.length === 0` with `!array?.length`
 *    - Cleaner null checks throughout the codebase
 * 
 * 4. REMOVED DEAD CODE:
 *    - Eliminated unused select_continent handler (~30 lines)
 *    - Cleaner codebase with no orphaned functionality
 * 
 * 5. ADDED SELF-PROTECTION:
 *    - Bot automatically detects current server using Vultr metadata service
 *    - Prevents accidental self-destruction via /destroy command
 *    - No manual .env configuration required - works out of the box
 *    - Fallback to EXCLUDE_INSTANCE_ID if metadata service unavailable
 * 
 * IMPORTANT: All Discord bot functionality and Vultr API integration remains identical.
 * These are purely code quality improvements with enhanced safety features.
 */

/**
 * Dedi Bot Simple - A streamlined Discord bot for managing Vultr VPS instances
 * 
 * This single-file implementation contains all functionality in one place for
 * maximum simplicity and ease of debugging.
 */

// ================ CONFIGURATION AND SETUP ================

// Environment variables
require('dotenv').config();

// Dependencies
const { 
  Client, 
  GatewayIntentBits, 
  Collection, 
  REST, 
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} = require('discord.js');
const VultrNode = require('@vultr/vultr-node');

// Ensure fetch is available (Node.js 18+ has it built-in)
const fetch = globalThis.fetch || require('node-fetch');

// Initialize Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Initialize Vultr client
const vultr = VultrNode.initialize({
  apiKey: process.env.VULTR_API_KEY
});

// ================ IN-MEMORY STATE MANAGEMENT ================

// Simple in-memory tracking of instances (replaces file-based instanceTracker)
const instanceState = {
  instances: [],
  
  // Add or update an instance
  trackInstance: function(instanceId, userId, username, status, metadata = {}) {
    const timestamp = new Date();
    const existingIndex = this.instances.findIndex(i => i.id === instanceId);
    
    const instanceData = {
      id: instanceId,
      creator: {
        id: userId,
        username
      },
      createdAt: timestamp.toISOString(),
      status: status || 'creating',
      ip: metadata.ip || null,
      name: metadata.name || `${username}'s Server`,
      lastUpdated: timestamp.toISOString()
    };
    
    if (existingIndex >= 0) {
      this.instances[existingIndex] = {
        ...this.instances[existingIndex],
        ...instanceData
      };
    } else {
      this.instances.push(instanceData);
    }
    
    return instanceData;
  },
  
  // Update instance status
  updateInstance: function(instanceId, status, metadata = {}) {
    const instanceIndex = this.instances.findIndex(i => i.id === instanceId);
    
    if (instanceIndex >= 0) {
      this.instances[instanceIndex] = {
        ...this.instances[instanceIndex],
        status,
        lastUpdated: new Date().toISOString(),
        ...metadata
      };
      
      return this.instances[instanceIndex];
    }
    
    return null;
  },
  
  // Get all active instances
  getActiveInstances: function() {
    return this.instances.filter(i => 
      i.status !== 'terminated' && i.status !== 'destroyed'
    );
  },
  
  // Get a specific instance
  getInstance: function(instanceId) {
    return this.instances.find(i => i.id === instanceId);
  },
  
  // Get instances for a specific user
  getUserInstances: function(userId) {
    return this.instances.filter(i => i.creator.id === userId);
  }
};

// Add server creation state management
const serverCreationState = new Map();

// ================ SELF-DESTRUCT TIMER CONFIGURATION ================

// Timer configuration (can be overridden via environment variables)
const SELF_DESTRUCT_INITIAL_MINUTES = parseInt(process.env.SELF_DESTRUCT_INITIAL_MINUTES) || 180; // 3 hours default
const SELF_DESTRUCT_COIN_MINUTES = parseInt(process.env.SELF_DESTRUCT_COIN_MINUTES) || 180; // 3 hours default

/**
 * Initialize self-destruct timer for an instance when it becomes running
 */
async function initializeSelfDestructTimer(instanceId) {
  const trackedInstance = instanceState.getInstance(instanceId);
  if (!trackedInstance) {
    console.log(`Cannot initialize timer for ${instanceId} - instance not tracked`);
    return;
  }
  
  // Check if timer already exists (prevent reset on panel refresh)
  if (trackedInstance.selfDestructTimer) {
    console.log(`Timer already exists for ${instanceId}, skipping initialization`);
    return;
  }
  
  const now = Date.now();
  const expiresAt = now + (SELF_DESTRUCT_INITIAL_MINUTES * 60 * 1000);
  
  instanceState.updateInstance(instanceId, trackedInstance.status, {
    selfDestructTimer: {
      expiresAt: expiresAt,
      initialDuration: SELF_DESTRUCT_INITIAL_MINUTES * 60 * 1000,
      extendedCount: 0,
      warningsSent: []
    }
  });
  
  console.log(`⏰💣 Self-destruct timer initialized for ${instanceId}: ${SELF_DESTRUCT_INITIAL_MINUTES} minutes`);
}

/**
 * Format remaining time as HH:MM:SS or MM:SS
 */
function formatRemainingTime(expiresAt) {
  const now = Date.now();
  const remainingMs = expiresAt - now;
  
  if (remainingMs <= 0) {
    return '0:00';
  }
  
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  } else {
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
}

// ================ PERSISTENT PANEL MANAGEMENT ================

// ================ FOLLOW-UP MESSAGE AND DM UTILITIES ================

/**
 * Send a follow-up message that auto-deletes after specified time
 * Used for panel responses to keep channel clean while maintaining visibility
 */
async function sendAutoCleanupFollowUp(interaction, content, deleteAfterMs = 30000) {
  try {
    // Handle different content types
    let messageOptions = {
      flags: MessageFlags.SuppressEmbeds // Prevent link previews to keep clean
    };
    
    if (typeof content === 'string') {
      messageOptions.content = content;
    } else if (content && typeof content === 'object') {
      // If it's an object, spread it into the message options
      messageOptions = { ...messageOptions, ...content };
    } else {
      // Fallback to string conversion
      messageOptions.content = String(content);
    }
    
    const followUpMessage = await interaction.followUp(messageOptions);
    
    // Auto-delete after specified time
    setTimeout(async () => {
      try {
        await followUpMessage.delete();
        console.log('Auto-deleted follow-up message');
      } catch (error) {
        console.log('Could not delete follow-up message (may already be deleted):', error.message);
      }
    }, deleteAfterMs);
    
    return followUpMessage;
  } catch (error) {
    console.error('Error sending auto-cleanup follow-up:', error);
    throw error;
  }
}

/**
 * Wrap interaction.editReply to send temporary follow-up messages that auto-delete
 * Returns a cleanup function to restore the original editReply method
 * 
 * @param {Object} interaction - Discord interaction object
 * @param {number} deleteAfterMs - Milliseconds before auto-deleting messages (default: 30000)
 * @returns {Function} Cleanup function to restore original editReply
 */
function wrapInteractionForAutoDelete(interaction, deleteAfterMs = 30000) {
  // Store original editReply method
  const originalEditReply = interaction.editReply;
  
  // Replace editReply with wrapper that uses sendAutoCleanupFollowUp
  interaction.editReply = async (content) => {
    return await sendAutoCleanupFollowUp(interaction, content, deleteAfterMs);
  };
  
  // Return cleanup function to restore original
  return () => {
    interaction.editReply = originalEditReply;
  };
}

/**
 * Send server creation details via DM to the creator
 * Includes IP address, connection links, and all relevant information
 */
async function sendServerCreationDM(user, serverDetails) {
  try {
    const { serverName, region, ip, elapsedMinutes } = serverDetails;
    
    const dmContent = 
      `🎉 **Your Server is Ready!**\n\n` +
      `✅ Server "${serverName}" is now READY in ${region.toUpperCase()}!\n\n` +
      `🖥️ **Connection Details:**\n` +
      `> Linux Remote Desktop: https://${ip}:8080\n` +
      `> Xlink Kai: http://${ip}:34522\n` +
      `> IP Address: \`${ip}\`\n\n` +
      `🎮 Your server is ready for gaming!\n` +
      `⏱️ Total setup time: ${elapsedMinutes} minutes\n` +
      `💡 Don't forget to use /destroy to delete your server when you're done!`;
    
    await user.send(dmContent);
    console.log(`✅ Server creation DM sent to ${user.username}`);
  } catch (error) {
    console.error(`Failed to send DM to ${user.username}:`, error.message);
    // Don't throw error - DM failure shouldn't break server creation
  }
}

/**
 * Execute list command for panel buttons with follow-up messages and auto-cleanup
 */
async function executeListFromPanel(interaction) {
  const cleanup = wrapInteractionForAutoDelete(interaction);
  try {
    await listCommand.execute(interaction);
  } finally {
    cleanup();
  }
}

/**
 * Execute status command for panel buttons with follow-up messages and auto-cleanup
 */
async function executeStatusFromPanel(interaction) {
  const cleanup = wrapInteractionForAutoDelete(interaction);
  try {
    await statusCommand.execute(interaction);
  } finally {
    cleanup();
  }
}

/**
 * Execute start command for panel buttons with follow-up messages and auto-cleanup
 */
async function executeStartFromPanel(interaction) {
  const cleanup = wrapInteractionForAutoDelete(interaction);
  try {
    await startCommand.execute(interaction);
  } finally {
    cleanup();
  }
}

/**
 * Execute stop command for panel buttons with follow-up messages and auto-cleanup
 */
async function executeStopFromPanel(interaction) {
  const cleanup = wrapInteractionForAutoDelete(interaction);
  try {
    await stopCommand.execute(interaction);
  } finally {
    cleanup();
  }
}

/**
 * Execute destroy command for panel buttons with follow-up messages and auto-cleanup
 */
async function executeDestroyFromPanel(interaction) {
  const cleanup = wrapInteractionForAutoDelete(interaction);
  try {
    await destroyCommand.execute(interaction);
  } finally {
    cleanup();
  }
}

/**
 * Execute restart command for panel buttons with follow-up messages and auto-cleanup
 */
async function executeRestartFromPanel(interaction) {
  const cleanup = wrapInteractionForAutoDelete(interaction);
  try {
    await restartCommand.execute(interaction);
  } finally {
    cleanup();
  }
}

/**
 * Execute server creation for panel buttons with follow-up messages and DM
 * This wraps the createCommand execution for panel usage
 */
async function executeCreateFromPanel(interaction, serverName, city, cityName) {
  try {
    // Send immediate follow-up message for visibility
    await sendAutoCleanupFollowUp(
      interaction, 
      `🚀 Creating server "${serverName}" in ${cityName}...\n💬 You'll receive connection details via DM when ready!`
    );
    
    // Get server name from command options or use provided
    const selectedCity = city || 'dfw';
    
    await sendAutoCleanupFollowUp(interaction, '🔄 Creating your server...', 60000);
    
    // Get available snapshots
    let snapshots;
    try {
      snapshots = await getSnapshots();
      console.log('Snapshots API response:', JSON.stringify(snapshots, null, 2));
      console.log(`Found ${snapshots?.length || 0} snapshots`);
    } catch (error) {
      console.error('Error fetching snapshots:', error);
      return await sendAutoCleanupFollowUp(interaction, '❌ Error fetching snapshots from Vultr API. Check console for details.', 60000);
    }
    
    // Check if we have a snapshot ID from environment variable as fallback
    let snapshotId;
    
    if (!snapshots?.length) {
      console.log('No snapshots from API, checking VULTR_SNAPSHOT_ID from env:', process.env.VULTR_SNAPSHOT_ID);
      
      if (process.env.VULTR_SNAPSHOT_ID) {
        console.log('Using VULTR_SNAPSHOT_ID from .env as fallback');
        snapshotId = process.env.VULTR_SNAPSHOT_ID;
      } else {
        return await sendAutoCleanupFollowUp(interaction, '❌ No snapshots available to create a server from. Please set VULTR_SNAPSHOT_ID in .env file.', 60000);
      }
    } else {
      // Use the snapshot ID from .env or the most recent snapshot
      snapshotId = process.env.VULTR_SNAPSHOT_ID || snapshots[0].id;
    }
    
    // Create the instance with the selected region
    const instance = await createInstanceFromSnapshot(snapshotId, serverName, selectedCity);
    
    if (!instance || !instance.id) {
      return await sendAutoCleanupFollowUp(interaction, '❌ Failed to create the server. Please try again later.', 60000);
    }
    
    // Track the new instance
    instanceState.trackInstance(
      instance.id,
      interaction.user.id,
      interaction.user.username,
      instance.status || 'creating',
      {
        ip: instance.main_ip,
        name: serverName,
        region: selectedCity
      }
    );
    
    // Send progress message
    const initialMessage = await sendAutoCleanupFollowUp(
      interaction,
      `✅ Server "${serverName}" creation started in ${selectedCity.toUpperCase()}!\n` +
      `⏳ Please be patient - server creation typically takes 15 minutes.\n` +
      `📊 Checking status automatically...\n` +
      `💡 Tip: The server will be ready when its status shows as "running"\n` +
      `Don't forget to use /destroy to delete your server when you're done!`,
      60000
    );

    // Start automatic status polling with DM enabled
    startInstanceStatusPolling(instance.id, serverName, selectedCity, interaction, initialMessage, true);

    // Refresh panel after creation starts
    setTimeout(() => updatePanel(), 5000);
    
  } catch (error) {
    console.error('Error executing panel create:', error);
    return await sendAutoCleanupFollowUp(interaction, '❌ There was an error creating the server.', 60000);
  }
}

// Store persistent panel info (survives bot restarts via file)
const fs = require('fs');
const path = require('path');
const PANEL_DATA_FILE = path.join(__dirname, 'panel_data.json');

// Panel data structure
let panelData = {
  messageId: null,
  channelId: null,
  lastUpdate: null
};

// Panel update synchronization - prevent concurrent updates
let panelUpdateInProgress = false;
let pendingPanelUpdate = false;

// #region agent log
const DEBUG_LOG = (location, message, data = {}) => {
  const logEntry = {
    location,
    message,
    data,
    timestamp: Date.now(),
    sessionId: 'debug-session',
    runId: 'run1'
  };
  // Also log to console for immediate visibility
  console.log(`[DEBUG] ${location}: ${message}`, data);
  // Send to logging server
  fetch('http://127.0.0.1:7242/ingest/67eea2e9-5833-41e9-8dae-a5bee6a132b2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(logEntry)
  }).catch(() => {}); // Silently ignore if logging server unavailable
};
// #endregion

// Load panel data on startup
function loadPanelData() {
  try {
    if (fs.existsSync(PANEL_DATA_FILE)) {
      const data = fs.readFileSync(PANEL_DATA_FILE, 'utf8');
      panelData = JSON.parse(data);
      console.log('Loaded persistent panel data:', panelData);
    }
  } catch (error) {
    console.error('Error loading panel data:', error);
  }
}

// Save panel data
function savePanelData() {
  try {
    fs.writeFileSync(PANEL_DATA_FILE, JSON.stringify(panelData, null, 2));
  } catch (error) {
    console.error('Error saving panel data:', error);
  }
}

// Load on startup
loadPanelData();

// ================ VULTR API FUNCTIONS ================

/**
 * Auto-detect the current server instance to prevent self-destruction
 * Uses Vultr metadata service to identify this server automatically
 */
async function getCurrentServerInstanceId() {
  try {
    // Try to get the instance ID from Vultr's metadata service
    // This is available inside Vultr instances at this endpoint
    const response = await fetch('http://169.254.169.254/v1/instanceid', {
      timeout: 2000 // 2 second timeout
    });
    
    if (response.ok) {
      const instanceId = await response.text();
      console.log(`Auto-detected current server instance ID: ${instanceId}`);
      return instanceId.trim();
    }
  } catch (error) {
    console.log('Could not auto-detect current server (running outside Vultr or metadata service unavailable)');
  }
  
  // Fallback to environment variable if metadata service fails
  return process.env.EXCLUDE_INSTANCE_ID || null;
}

// Cache the current server ID to avoid repeated metadata calls
let currentServerInstanceId = null;

/**
 * Check if an instance ID is the current server running this bot
 */
async function isCurrentServer(instanceId) {
  if (!currentServerInstanceId) {
    currentServerInstanceId = await getCurrentServerInstanceId();
  }
  
  // Check if it's the current server
  if (currentServerInstanceId === instanceId) {
    return true;
  }
  
  // Also check if it's manually excluded
  const excludeInstanceId = process.env.EXCLUDE_INSTANCE_ID;
  if (excludeInstanceId === instanceId) {
    return true;
  }
  
  return false;
}

/**
 * Get information about a specific instance (returns null for excluded instances)
 */
async function getInstance(instanceId) {
  try {
    const response = await vultr.instances.getInstance({ 
      "instance-id": instanceId 
    });
    const instance = response.instance;
    
    // Check if this is the current server (self-protection)
    const isCurrent = await isCurrentServer(instanceId);
    if (isCurrent) {
      console.log(`Access denied to current server ${instanceId} (${instance.label || 'Unnamed'}) - self-protection enabled`);
      return null;
    }
    
    // Check if this instance should be excluded by snapshot ID
    const excludeSnapshotId = process.env.EXCLUDE_SNAPSHOT_ID;
    if (excludeSnapshotId && instance.snapshot_id === excludeSnapshotId) {
      console.log(`Access denied to excluded instance ${instanceId} (created from snapshot ${excludeSnapshotId})`);
      return null;
    }
    
    return instance;
  } catch (error) {
    console.error('Error getting instance:', error);
    throw error;
  }
}

/**
 * List all instances in the Vultr account (excluding the current server and EXCLUDE_SNAPSHOT_ID)
 */
async function listInstances() {
  try {
    const response = await vultr.instances.listInstances();
    let instances = response.instances || [];
    
    // Filter out the current server automatically
    const filteredInstances = [];
    for (const instance of instances) {
      const isCurrent = await isCurrentServer(instance.id);
      if (!isCurrent) {
        filteredInstances.push(instance);
      } else {
        console.log(`Auto-excluded current server ${instance.id} (${instance.label || 'Unnamed'}) from management`);
      }
    }
    instances = filteredInstances;
    
    // Also filter out excluded instances if EXCLUDE_SNAPSHOT_ID is set (backward compatibility)
    const excludeSnapshotId = process.env.EXCLUDE_SNAPSHOT_ID;
    if (excludeSnapshotId) {
      const filtered = instances.filter(instance => instance.snapshot_id !== excludeSnapshotId);
      const excludedCount = instances.length - filtered.length;
      if (excludedCount > 0) {
        console.log(`Filtered out ${excludedCount} instance(s) created from excluded snapshot ${excludeSnapshotId}`);
      }
      return filtered;
    }
    
    return instances;
  } catch (error) {
    console.error('Error listing instances:', error);
    throw error;
  }
}

/**
 * Start an instance
 */
async function startInstance(interaction, instanceId) {
  try {
    await interaction.editReply({
      content: '🔄 Starting the server. This may take a few minutes...',
      components: []
    });

    await vultr.instances.startInstance({ "instance-id": instanceId });

    const success = await waitForInstanceStatus(instanceId, 'running');
    if (success) {
      instanceState.updateInstance(instanceId, 'running');
      interaction.editReply('✅ Server started successfully!');
    } else {
      interaction.editReply('❌ Failed to confirm the server has started. Please check its status manually.');
    }
  } catch (error) {
    console.error('Error starting server:', error);
    interaction.editReply('❌ There was an error starting the server.');
  }
}

/**
 * Stop an instance
 */
async function stopInstance(interaction, instanceId) {
  try {
    await interaction.editReply({
      content: '🔄 Stopping the server. This may take a few minutes...',
      components: []
    });

    await vultr.instances.haltInstance({ "instance-id": instanceId });

    const success = await waitForInstanceStatus(instanceId, 'stopped');
    if (success) {
      instanceState.updateInstance(instanceId, 'stopped');
      interaction.editReply('✅ Server stopped successfully!');
    } else {
      interaction.editReply('❌ Failed to confirm the server has stopped. Please check its status manually.');
    }
  } catch (error) {
    console.error('Error stopping server:', error);
    interaction.editReply('❌ There was an error stopping the server.');
  }
}

/**
 * Restart an instance
 */
async function restartInstance(interaction, instanceId) {
  try {
    await interaction.editReply({
      content: '🔄 Restarting the server. This may take a few minutes...',
      components: []
    });

    await vultr.instances.rebootInstance({ "instance-id": instanceId });

    // Wait a bit and check if server is restarting/restarted
    // Note: reboot is usually quick, so we'll just show success after a brief delay
    setTimeout(async () => {
      try {
        const instance = await getInstance(instanceId);
        if (instance) {
          interaction.editReply('✅ Server restart initiated successfully! The server should be back online shortly.');
        } else {
          interaction.editReply('✅ Server restart initiated successfully!');
        }
      } catch (error) {
        // Even if we can't verify, the reboot command succeeded
        interaction.editReply('✅ Server restart initiated successfully!');
      }
    }, 2000);
  } catch (error) {
    console.error('Error restarting server:', error);
    interaction.editReply('❌ There was an error restarting the server.');
  }
}

async function waitForInstanceStatus(instanceId, targetPowerStatus, timeout = 15 * 60 * 1000) {
  const startTime = Date.now();
  const checkInterval = 15000; // 15 seconds

  while (Date.now() - startTime < timeout) {
    try {
      const instance = await getInstance(instanceId);
      if (!instance) {
        console.log(`Instance ${instanceId} is excluded from management`);
        return false; // Can't wait for excluded instance
      }
      console.log(`Waiting for status: ${instance.power_status}, expecting: ${targetPowerStatus}`);
      if (instance.power_status === targetPowerStatus) {
        return true;
      }
    } catch (error) {
      console.error(`Error checking instance status for ${instanceId}:`, error);
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  return false;
}

/**
 * Get all snapshots
 */
async function getSnapshots() {
  try {
    console.log('Calling Vultr API: listSnapshots()');
    const response = await vultr.snapshots.listSnapshots();
    console.log('Raw Vultr snapshots response:', JSON.stringify(response, null, 2));
    
    // Check if response is empty object (likely IP restriction or permission issue)
    if (response && Object.keys(response).length === 0) {
      console.warn('⚠️ WARNING: Vultr API returned empty response for snapshots.');
      console.warn('This usually means:');
      console.warn('1. Your API key does not have "Snapshots" permission enabled');
      console.warn('2. This server\'s IP address is not in the API key\'s allowed IP list');
      console.warn('Please check: Vultr Dashboard → API → Your API Key → Settings');
      console.warn('- Ensure "Snapshots" permission is checked');
      console.warn('- Add this server\'s IP to the allowed IP addresses');
    }
    
    // Sort snapshots by date (newest first)
    const snapshots = response.snapshots || [];
    console.log(`Processing ${snapshots.length} snapshots from API`);
    
    snapshots.sort((a, b) => new Date(b.date_created) - new Date(a.date_created));
    return snapshots;
  } catch (error) {
    console.error('Error getting snapshots - Full error:', error);
    console.error('Error response data:', error.response?.data);
    console.error('Error status:', error.response?.status);
    
    // Check for common API permission errors
    if (error.response?.status === 401) {
      console.error('⚠️ API KEY ERROR: Authentication failed. Check if your VULTR_API_KEY is correct.');
    } else if (error.response?.status === 403) {
      console.error('⚠️ API PERMISSION ERROR: Access denied. This server\'s IP may not be in the allowed list.');
      console.error('Add this server\'s IP address to your API key settings in Vultr dashboard.');
    }
    
    throw error;
  }
}

/**
 * Get snapshots available to public users (dynamically detected via [PUBLIC] prefix)
 */
async function getPublicSnapshots() {
  try {
    const allSnapshots = await getSnapshots();
    
    // Filter snapshots marked as public via naming convention
    const publicSnapshots = allSnapshots.filter(snapshot => {
      const description = snapshot.description || '';
      // Look for [PUBLIC] prefix or #public tag
      return (description.startsWith('[PUBLIC]') || description.includes('#public')) 
        && snapshot.status === 'complete';
    });
    
    // If no public snapshots found via API, fall back to default snapshot
    if (publicSnapshots.length === 0 && process.env.VULTR_SNAPSHOT_ID) {
      const defaultSnapshot = allSnapshots.find(snap => snap.id === process.env.VULTR_SNAPSHOT_ID);
      if (defaultSnapshot && defaultSnapshot.status === 'complete') {
        console.log('No [PUBLIC] snapshots found, falling back to VULTR_SNAPSHOT_ID');
        return [defaultSnapshot];
      }
    }
    
    // Also include legacy snapshots from VULTR_PUBLIC_SNAPSHOTS for backward compatibility
    const legacySnapshotIds = process.env.VULTR_PUBLIC_SNAPSHOTS?.split(',').map(id => id.trim()) || [];
    if (legacySnapshotIds.length > 0) {
      const legacySnapshots = allSnapshots.filter(snap => 
        legacySnapshotIds.includes(snap.id) && snap.status === 'complete'
      );
      // Merge with public snapshots, avoiding duplicates
      legacySnapshots.forEach(legacySnap => {
        if (!publicSnapshots.find(pubSnap => pubSnap.id === legacySnap.id)) {
          publicSnapshots.push(legacySnap);
        }
      });
    }
    
    console.log(`Found ${publicSnapshots.length} public snapshots available for restore`);
    return publicSnapshots;
  } catch (error) {
    console.error('Error getting public snapshots:', error);
    return [];
  }
}

/**
 * Create a snapshot from a running instance
 */
async function createSnapshotFromInstance(instanceId, description) {
  try {
    console.log(`Creating snapshot from instance ${instanceId} with description: ${description}`);
    
    const response = await vultr.snapshots.createSnapshot({
      "instance_id": instanceId,
      "description": description
    });
    
    console.log('Snapshot creation response:', JSON.stringify(response, null, 2));
    return response.snapshot;
  } catch (error) {
    console.error('Error creating snapshot:', error);
    throw error;
  }
}

/**
 * Check if user has permission to create snapshots
 */
function hasSnapshotPermission(userId) {
  const adminUsers = process.env.ADMIN_USER_IDS?.split(',').map(id => id.trim()) || [];
  console.log(`Checking snapshot permission for user ${userId}. Admin users: ${adminUsers.join(', ')}`);
  return adminUsers.includes(String(userId));
}

/**
 * Clean snapshot name for display by removing [PUBLIC]/[PRIVATE] prefixes
 */
function getCleanSnapshotName(snapshot) {
  const description = snapshot.description || 'Unnamed Snapshot';
  // Remove [PUBLIC] or [PRIVATE] prefixes and clean up formatting
  return description
    .replace(/^\[(PUBLIC|PRIVATE)\]\s*/, '')  // Remove prefix
    .replace(/\s*\|\s*$/, '')                // Remove trailing separator
    .trim() || 'Unnamed Snapshot';           // Fallback if empty
}

/**
 * Format snapshot information for Discord display
 */
function formatSnapshotInfo(snapshot, includeId = false) {
  const sizeGB = snapshot.size ? `${snapshot.size} GB` : 'Unknown size';
  const created = new Date(snapshot.date_created).toLocaleString();
  const cleanName = getCleanSnapshotName(snapshot);
  
  let message = `📸 **${cleanName}**\n`;
  message += `> Size: ${sizeGB}\n`;
  message += `> Created: ${created}\n`;
  message += `> Status: ${snapshot.status}`;
  
  if (includeId) {
    message += `\n> ID: \`${snapshot.id}\``;
  }
  
  return message;
}

/**
 * Fetches all Vultr regions and organizes them by continent and country
 * Following OpenAPI spec exactly
 */
async function getGroupedRegions(vultrClient) {
  try {
    const response = await vultrClient.regions.listRegions();
    const regions = response.regions || [];
    
    const grouped = {};
    for (const region of regions) {
      // Only include regions that support the required options
      const hasRequiredOptions = region.options && region.options.includes('kubernetes');
      
      if (hasRequiredOptions) {
        const continent = region.continent || 'Other';
        const country = region.country || 'Other';
        
        if (!grouped[continent]) grouped[continent] = {};
        if (!grouped[continent][country]) grouped[continent][country] = [];
        
        grouped[continent][country].push({
          id: region.id,
          city: region.city,
          country: region.country,
          continent: region.continent,
          options: region.options
        });
      }
    }
    
    return grouped;
  } catch (error) {
    console.error('Error fetching regions:', error);
    throw error;
  }
}

/**
 * Create a new instance from a snapshot with specified region
 * @param {string} snapshotId - The ID of the snapshot to create the instance from
 * @param {string} label - The name/label for the new instance
 * @param {string} region - The region where the instance should be deployed
 * @returns {Promise<Object>} The created instance object
 */
async function createInstanceFromSnapshot(snapshotId, label, region) {
  try {
    // Validate required environment variables - firewall is mandatory
    const firewallGroupId = process.env.VULTR_FIREWALL_GROUP_ID;
    if (!firewallGroupId) {
      throw new Error('VULTR_FIREWALL_GROUP_ID is required but not set in environment variables. Firewall is mandatory.');
    }

    // Validate firewall_group_id format (should be UUID)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(firewallGroupId)) {
      throw new Error(`Invalid firewall_group_id format: "${firewallGroupId}". Expected UUID format (e.g., "1c4c6504-5094-4de1-a0bc-f7e885580921")`);
    }

    // Validate snapshot ID format
    if (!snapshotId || !uuidRegex.test(snapshotId)) {
      throw new Error(`Invalid snapshot_id format: "${snapshotId}". Expected UUID format.`);
    }

    // Verify snapshot exists before attempting creation
    console.log(`Verifying snapshot ${snapshotId} exists...`);
    const snapshots = await getSnapshots();
    const snapshotExists = snapshots.some(snap => snap.id === snapshotId);
    if (!snapshotExists) {
      const availableSnapshots = snapshots.map(s => `${s.id} (${s.description || 'Unnamed'})`).join(', ');
      throw new Error(`Snapshot ${snapshotId} not found. Available snapshots: ${availableSnapshots || 'none'}`);
    }
    console.log(`✅ Snapshot ${snapshotId} verified`);

    // Log creation parameters
    console.log(`Calling Vultr API: createInstance()`);
    console.log(`Creating instance with params:`, {
      snapshot_id: snapshotId,
      label,
      region: region || process.env.VULTR_REGION || "dfw",
      plan: process.env.VULTR_PLAN || "vc2-1c-1gb"
    });
    
    // Create instance WITHOUT firewall/DDOS first (matches working pattern from index1.1.6c.js)
    // The API may reject requests with firewall_group_id during creation, so we attach it after
    let response;
    try {
      response = await vultr.instances.createInstance({
        "snapshot_id": snapshotId,
        "label": label,
        "region": region || process.env.VULTR_REGION || "dfw",
        "plan": process.env.VULTR_PLAN || "vc2-1c-1gb"
      });
    } catch (apiError) {
      // Log detailed error information
      console.error('Vultr API Error Details:');
      console.error('- Error message:', apiError.message);
      console.error('- Error status:', apiError.response?.status);
      console.error('- Error status text:', apiError.response?.statusText);
      console.error('- Error data:', JSON.stringify(apiError.response?.data, null, 2));
      console.error('- Error headers:', JSON.stringify(apiError.response?.headers, null, 2));
      
      // Try to extract error message from response
      const errorMsg = apiError.response?.data?.error || apiError.response?.data?.message || apiError.message || 'Unknown error';
      
      // Provide helpful error messages based on status code
      if (apiError.response?.status === 400) {
        throw new Error(`Vultr API validation error (400): ${errorMsg}. Check: 1) Snapshot ID exists, 2) Plan is available in region, 3) Region is valid`);
      } else if (apiError.response?.status === 401) {
        throw new Error('Vultr API authentication failed (401). Check your VULTR_API_KEY is correct and has proper permissions.');
      } else if (apiError.response?.status === 403) {
        throw new Error('Vultr API access denied (403). Check: 1) API key has "Instances" permission, 2) Server IP is in allowed IP list');
      } else if (apiError.response?.status === 404) {
        throw new Error(`Vultr API resource not found (404): ${errorMsg}. Check: 1) Snapshot ID "${snapshotId}" exists, 2) Region "${region || process.env.VULTR_REGION || 'dfw'}" is valid`);
      } else {
        throw new Error(`Vultr API error (${apiError.response?.status || 'unknown'}): ${errorMsg}`);
      }
    }
    
    console.log("Raw Vultr createInstance response:", JSON.stringify(response, null, 2));

    // Validate response structure - check for empty response (SDK bug/API issue)
    if (!response || Object.keys(response).length === 0) {
      console.error('⚠️ WARNING: Vultr API returned empty response for instance creation.');
      console.error('This usually indicates:');
      console.error('1. API key does not have "Instances" permission enabled');
      console.error('2. This server\'s IP address is not in the API key\'s allowed IP list');
      console.error('3. Snapshot ID is invalid or doesn\'t exist');
      console.error('4. Plan/region combination is invalid');
      console.error('Please check: Vultr Dashboard → API → Your API Key → Settings');
      
      // Try direct HTTP call to get actual error
      try {
        console.log('Attempting direct HTTP call to diagnose issue...');
        const directResponse = await fetch('https://api.vultr.com/v2/instances', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.VULTR_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            snapshot_id: snapshotId,
            label: label,
            region: region || process.env.VULTR_REGION || "dfw",
            plan: process.env.VULTR_PLAN || "vc2-1c-1gb"
          })
        });
        
        const directData = await directResponse.text();
        console.log(`Direct HTTP call status: ${directResponse.status}`);
        console.log(`Direct HTTP call response: ${directData}`);
        
        if (!directResponse.ok) {
          throw new Error(`Direct API call failed (${directResponse.status}): ${directData}`);
        }
      } catch (directError) {
        console.error('Direct HTTP call error:', directError);
        throw new Error(`Vultr API returned empty response. Direct API call also failed: ${directError.message}`);
      }
      
      throw new Error('Vultr API returned empty response. Check API key permissions and snapshot/plan validity.');
    }

    // Validate response structure
    if (!response.instance) {
      console.error('Invalid response structure. Expected response.instance but got:', JSON.stringify(response, null, 2));
      throw new Error(`Invalid API response: expected response.instance but got: ${JSON.stringify(response)}`);
    }

    if (!response.instance.id) {
      console.error('Instance created but missing ID. Response:', JSON.stringify(response.instance, null, 2));
      throw new Error(`Instance created but missing ID in response: ${JSON.stringify(response.instance)}`);
    }

    console.log(`✅ Instance ${response.instance.id} created successfully. Now attaching firewall...`);

    // Attach firewall IMMEDIATELY - don't wait for running status
    // Vultr allows attaching firewall to instances in any state
    const instanceId = response.instance.id;
    let firewallAttached = false;
    let retryCount = 0;
    const maxRetries = 10;
    
    while (!firewallAttached && retryCount < maxRetries) {
      retryCount++;
      console.log(`🔥 Firewall attach attempt ${retryCount}/${maxRetries} for instance ${instanceId}...`);
      
      try {
        // Attach firewall group
        await vultr.instances.updateInstance({
          "instance-id": instanceId,
          "firewall_group_id": firewallGroupId
        });
        console.log(`✅ Firewall API call succeeded for instance ${instanceId}`);
        
        // CRITICAL: Verify firewall is actually attached - don't trust the API call alone
        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds for API to propagate
        
        const verifyInstance = await vultr.instances.getInstance({ "instance-id": instanceId });
        const actualFirewallId = verifyInstance?.instance?.firewall_group_id;
        
        console.log(`🔍 Firewall verification: Expected=${firewallGroupId}, Actual=${actualFirewallId || 'NONE'}`);
        
        if (actualFirewallId === firewallGroupId) {
          firewallAttached = true;
          console.log(`✅✅✅ FIREWALL VERIFIED ATTACHED: ${firewallGroupId} on instance ${instanceId}`);
        } else {
          console.error(`❌ FIREWALL VERIFICATION FAILED! Expected ${firewallGroupId} but got ${actualFirewallId || 'NONE'}`);
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
      } catch (attachError) {
        console.error(`❌ Firewall attach attempt ${retryCount} failed:`, attachError.message);
        if (retryCount < maxRetries) {
          console.log(`Waiting 10 seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }
    }
    
    // CRITICAL: If firewall didn't attach after all retries, DESTROY THE INSTANCE
    if (!firewallAttached) {
      console.error(`🚨🚨🚨 CRITICAL: FIREWALL FAILED TO ATTACH AFTER ${maxRetries} ATTEMPTS!`);
      console.error(`🗑️ DESTROYING UNPROTECTED INSTANCE ${instanceId} FOR SECURITY!`);
      
      try {
        await vultr.instances.deleteInstance({ "instance-id": instanceId });
        console.log(`✅ Unprotected instance ${instanceId} destroyed`);
      } catch (destroyError) {
        console.error(`❌ Failed to destroy unprotected instance:`, destroyError.message);
      }
      
      throw new Error(`SECURITY FAILURE: Firewall could not be attached after ${maxRetries} attempts. Instance was destroyed for security. Please try again.`);
    }
    
    // Now try to enable DDOS protection (optional, don't fail if this doesn't work)
    try {
      console.log(`Enabling DDOS protection for instance ${instanceId}...`);
      await vultr.instances.updateInstance({
        "instance-id": instanceId,
        "ddos_protection": true
      });
      
      // Verify DDOS
      await new Promise(resolve => setTimeout(resolve, 2000));
      const ddosCheck = await vultr.instances.getInstance({ "instance-id": instanceId });
      const hasDdos = ddosCheck?.instance?.features?.includes('ddos_protection');
      if (hasDdos) {
        console.log(`✅ DDOS protection enabled for instance ${instanceId}`);
      } else {
        console.warn(`⚠️ DDOS protection may not be enabled (features: ${JSON.stringify(ddosCheck?.instance?.features || [])})`);
      }
    } catch (ddosError) {
      console.warn(`⚠️ Could not enable DDOS protection (non-fatal): ${ddosError.message}`);
    }

    console.log(`✅✅✅ Instance ${instanceId} READY with VERIFIED firewall ${firewallGroupId}`);
    
    return response.instance;
  } catch (error) {
    console.error('Error creating instance from snapshot:', error);
    // Re-throw with context if it's our validation error
    if (error.message.includes('VULTR_FIREWALL_GROUP_ID') || 
        error.message.includes('Invalid') || 
        error.message.includes('Vultr API') ||
        error.message.includes('Failed to attach') ||
        error.message.includes('Snapshot')) {
      throw error;
    }
    // Wrap unexpected errors with context
    throw new Error(`Failed to create instance: ${error.message}`);
  }
}

/**
 * Get billing information for an instance
 */
async function getInstanceBilling(instanceId) {
  try {
    // Get billing history
    const response = await vultr.billing.listBillingHistory();
    
    // Filter charges for this instance and calculate total
    let totalCost = 0;
    if (response && response.billing_history) {
      const instanceCharges = response.billing_history.filter(charge => 
        charge.description.toLowerCase().includes(instanceId.toLowerCase())
      );
      totalCost = instanceCharges.reduce((sum, charge) => sum + parseFloat(charge.amount), 0);
    }
    
    return totalCost;
  } catch (error) {
    console.error('Error getting billing information:', error);
    return 0;
  }
}

/**
 * Calculate approximate cost for an instance based on uptime and plan pricing
 * @param {Object} instance - Instance object with plan, date_created, and optionally id
 * @returns {Promise<string>} Formatted cost string (e.g., "$12.34" or "unavailable")
 */
async function calculateInstanceCost(instance) {
  try {
    if (!instance || !instance.plan || !instance.date_created) {
      return 'unavailable';
    }
    
    const planId = instance.plan;
    const createdAt = new Date(instance.date_created);
    const currentTime = new Date();
    
    // Call the plans endpoint per Vultr OpenAPI specification
    const plansResponse = await vultr.plans.listPlans();
    
    if (plansResponse && plansResponse.plans) {
      const plan = plansResponse.plans.find(p => p.id === planId);
      
      if (plan && typeof plan.monthly_cost === 'number') {
        // Calculate uptime in hours (round up to next hour for billing)
        const uptimeMs = currentTime - createdAt;
        const uptimeHours = Math.ceil(uptimeMs / (1000 * 60 * 60));
        
        // Convert monthly cost to hourly rate
        // Using 730 hours per month (365 days * 24 hours / 12 months)
        const hourlyRate = plan.monthly_cost / 730;
        const cost = uptimeHours * hourlyRate;
        
        return `$${cost.toFixed(2)}`;
      }
    }
    
    return 'unavailable';
  } catch (error) {
    console.error('Error calculating instance cost:', error);
    return 'unavailable';
  }
}

/**
 * Delete an instance
 */
async function deleteInstance(instanceId) {
  try {
    await vultr.instances.deleteInstance({
      "instance-id": instanceId
    });
    return true;
  } catch (error) {
    console.error('Error deleting instance:', error);
    throw error;
  }
}

// ================ UTILITY FUNCTIONS ================

/**
 * Format instance status for display
 */
function formatStatus(instance) {
  const statusMap = {
    'running': '🟢',
    'stopped': '🔴',
    'pending': '🟡'
  };
  
  const status = instance.power_status || instance.status;
  const emoji = statusMap[status] || '⚪';
  
  return {
    emoji: emoji,
    label: status
  };
}

/**
 * Format a list of instances for display in Discord
 */
function formatInstanceList(instances) {
  if (!instances || instances.length === 0) {
    return '📃 **Server List**\nNo active servers found.';
  }
  
  let message = '📃 **Server List**\n';
  
  instances.forEach(instance => {
    const status = formatStatus(instance);
    const createdAt = new Date(instance.createdAt).toLocaleString();
    
    message += `\n${status.emoji} **${instance.name}**`;
    message += `\n> Status: ${status.label}`;
    
    if (instance.ip) {
      message += `\n> IP: \`${instance.ip}\``;
    }
    
    message += `\n> Created by: ${instance.creator.username}`;
    message += `\n> Created: ${createdAt}`;
    message += '\n';
  });
  
  return message;
}

/**
 * Format an instance for display in Discord
 */
function formatInstanceDetails(instance, vultrInstance = null) {
  const status = formatStatus(vultrInstance || instance);
  let message = `🖥️ **Server Details**\n`;
  
  // Use label instead of name, with fallback
  const serverName = (vultrInstance?.label || instance?.label || instance?.name || 'Unnamed Server');
  message += `\n${status.emoji} **${serverName}**`;
  message += `\n> Status: ${status.label}`;
  
  // Add Vultr-specific details if available
  if (vultrInstance) {
    message += `\n> Region: ${vultrInstance.region}`;
    
    if (vultrInstance.main_ip) {
      message += `\n> Linux Remote Desktop: https://${vultrInstance.main_ip}:8080`;
      message += `\n> Xlink Kai: http://${vultrInstance.main_ip}:34522`;
    }
  } else if (instance?.ip) {
    message += `\n> Region: ${instance.region || 'Unknown'}`;
    message += `\n> Linux Remote Desktop: https://${instance.ip}:8080`;
    message += `\n> Xlink Kai: http://${instance.ip}:34522`;
  }
  
  return message;
}

/**
 * Automatically poll instance status and update the Discord message when ready
 * OpenAPI-compliant implementation with proper error handling and unlimited polling
 */
async function startInstanceStatusPolling(instanceId, serverName, region, interaction, message, sendDM = true) {
  console.log(`Starting status polling for instance ${instanceId}`);
  
  let attempts = 0;
  const maxWaitTime = 30 * 60 * 1000; // 30 minutes absolute maximum
  const startTime = Date.now();
  
  const pollStatus = async () => {
    attempts++;
    const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
    
    // Hard stop at 30 minutes (reasonable for any cloud instance)
    if (Date.now() - startTime > maxWaitTime) {
      const timeoutMessage = 
        `⏰ Server "${serverName}" exceeded 30-minute startup limit.\n` +
        `📊 Use \`/status\` to check manually or contact support.\n` +
        `Don't forget to use /destroy to delete your server when you're done!`;
      
      await sendAutoCleanupFollowUp(interaction, timeoutMessage);
      console.log(`❌ Instance ${instanceId} polling timeout after 30 minutes`);
      return;
    }
    
    try {
      // Call GET /instances/{instance-id} per OpenAPI spec
      const instance = await getInstance(instanceId);
      if (!instance) {
        console.log(`Instance ${instanceId} is excluded from management - stopping status polling`);
        await sendAutoCleanupFollowUp(interaction, '❌ This server is not available for management.');
        return;
      }
      const status = formatStatus(instance);
      
      console.log(`Poll ${attempts} (${elapsedMinutes}min): status=${instance.status}, power=${instance.power_status}, ip=${instance.main_ip}`);
      
      // Update tracking
      instanceState.updateInstance(instanceId, instance.power_status, {
        ip: instance.main_ip
      });
      
      // Server is ready when: status=active, power_status=running, has real IP
      if (instance.status === 'active' && 
          instance.power_status === 'running' && 
          instance.main_ip && 
          instance.main_ip !== '0.0.0.0' &&
          instance.main_ip !== '') {
        
        // SUCCESS - Server is fully ready
        const finalMessage = 
          `✅ Server "${serverName}" is now READY in ${region.toUpperCase()}! 🎉\n\n` +
          `🖥️ **Connection Details:**\n` +
          `> Linux Remote Desktop: https://${instance.main_ip}:8080\n` +
          `> Xlink Kai: http://${instance.main_ip}:34522\n` +
          `> IP Address: \`${instance.main_ip}\`\n\n` +
          `🎮 Your server is ready for gaming!\n` +
          `⏱️ Total setup time: ${elapsedMinutes} minutes\n` +
          `Don't forget to use /destroy to delete your server when you're done!`;
        
        // Send DM FIRST - before sending follow-up message
        // This ensures DM is sent even if interaction token expired
        if (sendDM) {
          try {
            await sendServerCreationDM(interaction.user, {
              serverName,
              region,
              ip: instance.main_ip,
              elapsedMinutes
            });
          } catch (error) {
            console.error('Failed to send creation DM:', error);
          }
        }
        
        // Initialize self-destruct timer when server becomes running
        await initializeSelfDestructTimer(instanceId);
        
        await sendAutoCleanupFollowUp(interaction, finalMessage);
        console.log(`✅ Instance ${instanceId} ready after ${elapsedMinutes} minutes!`);
        return; // Stop polling
        
      } else if (instance.status === 'active' && instance.power_status === 'stopped') {
        // Instance is being restored from snapshot - this is normal, don't try to start it
        console.log(`Instance ${instanceId} is being restored from snapshot (${elapsedMinutes}min elapsed)`);
        
        // Continue polling - restoration will complete automatically
        const progressMessage = 
          `✅ Server "${serverName}" restoration in ${region.toUpperCase()}!\n` +
          `⏳ Status: ${status.emoji} Restoring from snapshot... (${elapsedMinutes}min elapsed)\n` +
          `📊 Auto-checking until ready...\n` +
          `💡 Server will show connection details when restoration completes\n` +
          `Don't forget to use /destroy when done!`;
        
        await sendAutoCleanupFollowUp(interaction, progressMessage);
        setTimeout(pollStatus, 45000); // Check again in 45 seconds
        
      } else {
        // Still creating/pending - show progress
        const progressMessage = 
          `✅ Server "${serverName}" creation in ${region.toUpperCase()}!\n` +
          `⏳ Status: ${status.emoji} ${status.label} (${elapsedMinutes}min elapsed)\n` +
          `📊 Auto-checking until ready...\n` +
          `💡 Server will show connection details when ready\n` +
          `Don't forget to use /destroy when done!`;
        
        await sendAutoCleanupFollowUp(interaction, progressMessage);
        setTimeout(pollStatus, 45000); // Check again in 45 seconds
      }
      
    } catch (error) {
      console.error(`Error polling instance ${instanceId}:`, error);
      
      // Continue trying unless we hit time limit
      if (Date.now() - startTime < maxWaitTime) {
        setTimeout(pollStatus, 45000);
      } else {
        const errorMessage = 
          `❌ Unable to monitor server "${serverName}" (API errors).\n` +
          `📊 Use \`/status\` to check manually.\n` +
          `Don't forget to use /destroy when done!`;
        
        await sendAutoCleanupFollowUp(interaction, errorMessage);
      }
    }
  };
  
  // Start first poll after 10 seconds
  setTimeout(pollStatus, 10000);
}

/**
 * Automatically poll snapshot status and update the Discord message when complete
 * Similar to instance polling but for snapshot creation progress
 */
async function startSnapshotStatusPolling(snapshotId, snapshotName, isPublic, interaction) {
  console.log(`Starting snapshot status polling for ${snapshotId}`);
  
  let attempts = 0;
  const maxWaitTime = 30 * 60 * 1000; // 30 minutes maximum
  const startTime = Date.now();
  
  const pollStatus = async () => {
    attempts++;
    const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
    
    // Hard stop at 30 minutes
    if (Date.now() - startTime > maxWaitTime) {
      const timeoutMessage = 
        `⏰ Snapshot "${snapshotName}" exceeded 30-minute creation limit.\n` +
        `📊 Check Vultr dashboard manually or contact support.\n` +
        `💡 Snapshots usually complete within 15 minutes.`;
      
      await sendAutoCleanupFollowUp(interaction, timeoutMessage);
      console.log(`❌ Snapshot ${snapshotId} polling timeout after 30 minutes`);
      return;
    }
    
    try {
      // Get snapshot status from Vultr API
      const snapshots = await getSnapshots();
      const snapshot = snapshots.find(s => s.id === snapshotId);
      
      if (!snapshot) {
        console.log(`Snapshot ${snapshotId} not found in API response`);
        setTimeout(pollStatus, 30000); // Try again in 30 seconds
        return;
      }
      
      console.log(`Snapshot poll ${attempts} (${elapsedMinutes}min): status=${snapshot.status}, size=${snapshot.size}GB`);
      
      // Check if snapshot is complete
      if (snapshot.status === 'complete') {
        // SUCCESS - Snapshot is ready
        const availabilityInfo = isPublic 
          ? '🌍 **Available to all users** - Now appears in `/restore` autocomplete!'
          : '🔒 **Private snapshot** - Available for admin use via `/restore`';
        
        const finalMessage = 
          `✅ Snapshot "${snapshotName}" is now COMPLETE! 🎉\n\n` +
          `📸 **Snapshot Details:**\n` +
          `> Name: ${snapshotName}\n` +
          `> Size: ${snapshot.size || 'Unknown'} GB\n` +
          `> ID: \`${snapshot.id}\`\n` +
          `> ${availabilityInfo}\n\n` +
          `⏱️ Total creation time: ${elapsedMinutes} minutes\n` +
          `💡 You can now use this snapshot with the \`/restore\` command!`;
        
        await sendAutoCleanupFollowUp(interaction, finalMessage);
        console.log(`✅ Snapshot ${snapshotId} completed after ${elapsedMinutes} minutes!`);
        return; // Stop polling
        
      } else if (snapshot.status === 'error' || snapshot.status === 'failed') {
        // FAILED - Snapshot creation failed
        const errorMessage = 
          `❌ Snapshot "${snapshotName}" creation FAILED!\n` +
          `📊 Status: ${snapshot.status}\n` +
          `💡 Please try creating the snapshot again or contact support.`;
        
        await sendAutoCleanupFollowUp(interaction, errorMessage);
        console.log(`❌ Snapshot ${snapshotId} failed with status: ${snapshot.status}`);
        return; // Stop polling
        
      } else {
        // Still creating - show progress
        const progressMessage = 
          `✅ Snapshot "${snapshotName}" creation in progress!\n` +
          `⏳ Status: ${snapshot.status} (${elapsedMinutes}min elapsed)\n` +
          `📊 Auto-checking until complete...\n` +
          `💡 Snapshots typically take 5-15 minutes depending on server size\n` +
          `${isPublic ? '🌍 Will be available to all users when complete' : '🔒 Private snapshot for admin use'}`;
        
        await sendAutoCleanupFollowUp(interaction, progressMessage);
        setTimeout(pollStatus, 30000); // Check again in 30 seconds
      }
      
    } catch (error) {
      console.error(`Error polling snapshot ${snapshotId}:`, error);
      
      // Continue trying unless we hit time limit
      if (Date.now() - startTime < maxWaitTime) {
        setTimeout(pollStatus, 30000);
      } else {
        const errorMessage = 
          `❌ Unable to monitor snapshot "${snapshotName}" (API errors).\n` +
          `📊 Check Vultr dashboard manually.\n` +
          `💡 Snapshot may still complete successfully.`;
        
        await sendAutoCleanupFollowUp(interaction, errorMessage);
      }
    }
  };
  
  // Start first poll after 15 seconds (snapshots need more time to appear)
  setTimeout(pollStatus, 15000);
}

/**
 * Automatically poll instance destruction and confirm when complete
 * Retries delete API call until successful (handles servers still booting)
 */
async function startInstanceDestructionPolling(instanceId, serverName, cost, interaction) {
  console.log(`Starting destruction polling for instance ${instanceId}`);
  
  let attempts = 0;
  const maxWaitTime = 15 * 60 * 1000; // 15 minutes max (may need to wait for boot)
  const startTime = Date.now();
  
  const pollStatus = async () => {
    attempts++;
    const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
    
    if (Date.now() - startTime > maxWaitTime) {
      await sendAutoCleanupFollowUp(interaction, `⏰ Destruction timeout after 15 minutes. Check Vultr dashboard.\n💰 Cost: ${cost}`);
      return;
    }
    
    try {
      // Check if instance still exists
      const instance = await getInstance(instanceId);
      
      if (!instance) {
        // SUCCESS - Gone
        instanceState.updateInstance(instanceId, 'destroyed', { selfDestructTimer: null });
        await sendAutoCleanupFollowUp(interaction, `✅ Server "${serverName}" DESTROYED! 🎉\n💰 Cost: ${cost}\nThanks for being a Real One! 🙏`);
        console.log(`✅ Instance ${instanceId} destroyed after ${elapsedMinutes} minutes`);
        return;
      }
      
      // Instance still exists - retry delete
      console.log(`Destroy retry ${attempts}: ${instance.status}/${instance.power_status}`);
      
      try {
        await vultr.instances.deleteInstance({ "instance-id": instanceId });
        console.log(`Delete request sent (attempt ${attempts})`);
      } catch (deleteErr) {
        // 400 = server busy/booting, just retry later
        if (deleteErr.response?.status !== 400) {
          console.log(`Delete error: ${deleteErr.message}`);
        }
      }
      
      // Update message and continue polling
      await sendAutoCleanupFollowUp(
        interaction,
        `🔄 Destroying "${serverName}"...\n` +
        `⏳ Attempt ${attempts} (${elapsedMinutes}min elapsed)\n` +
        `💡 Retrying until server is gone...`
      );
      
      setTimeout(pollStatus, 10000); // Retry every 10 seconds
      
    } catch (error) {
      if (error.response?.status === 404 || error.response?.status === 403) {
        // Gone
        instanceState.updateInstance(instanceId, 'destroyed', { selfDestructTimer: null });
        await sendAutoCleanupFollowUp(interaction, `✅ Server "${serverName}" DESTROYED! 🎉\n💰 Cost: ${cost}`);
        return;
      }
      console.error(`Destruction error:`, error.message);
      setTimeout(pollStatus, 10000);
    }
  };
  
  setTimeout(pollStatus, 2000); // Start quickly
}

/**
 * Send self-destruct warning DM to creator with insert coin button
 */
async function sendSelfDestructWarning(instanceId, serverName, minutesRemaining, creatorId) {
  try {
    const user = await client.users.fetch(creatorId);
    if (!user) {
      console.log(`Cannot send warning DM - user ${creatorId} not found`);
      return;
    }
    
    const trackedInstance = instanceState.getInstance(instanceId);
    if (!trackedInstance?.selfDestructTimer) {
      return; // Timer was cleared
    }
    
    const timeStr = formatRemainingTime(trackedInstance.selfDestructTimer.expiresAt);
    const emoji = minutesRemaining <= 5 ? '🔴💣' : '⚠️💣';
    
    const coinButton = new ButtonBuilder()
      .setCustomId(`coin_${instanceId}`)
      .setLabel(`💰 Insert Coin (+${SELF_DESTRUCT_COIN_MINUTES}min)`)
      .setStyle(ButtonStyle.Success);
    
    const row = new ActionRowBuilder().addComponents(coinButton);
    
    const message = `${emoji} **Self-Destruct Warning**\n\n` +
      `Server "${serverName}" will self-destruct in ${minutesRemaining} minutes!\n` +
      `⏰💣 Time remaining: ${timeStr}\n\n` +
      `Click the button below to extend the timer:`;
    
    await user.send({ content: message, components: [row] });
    console.log(`✅ Sent ${minutesRemaining}min warning DM to ${user.username} for server ${serverName}`);
  } catch (error) {
    console.error(`Failed to send warning DM to ${creatorId}:`, error.message);
    // Don't throw - DM failure shouldn't break the system
  }
}

/**
 * Background process that checks for expired timers and sends warnings
 */
async function startSelfDestructPolling() {
  console.log('⏰💣 Starting self-destruct timer polling...');
  
  const checkTimers = async () => {
    try {
      const activeInstances = instanceState.getActiveInstances();
      
      for (const trackedInstance of activeInstances) {
        const timer = trackedInstance.selfDestructTimer;
        if (!timer) continue;
        
        const expiresAt = timer.expiresAt;
        const now = Date.now();
        const remainingMs = expiresAt - now;
        const remainingMinutes = Math.floor(remainingMs / 60000);
        
        // Check if timer expired - destroy server
        if (remainingMs <= 0) {
          console.log(`⏰💣 Timer expired for instance ${trackedInstance.id} - initiating self-destruct`);
          
          try {
            // Verify instance still exists
            const vultrInstance = await getInstance(trackedInstance.id);
            if (!vultrInstance) {
              console.log(`Instance ${trackedInstance.id} already destroyed or excluded`);
              instanceState.updateInstance(trackedInstance.id, 'destroyed', {
                selfDestructTimer: null
              });
              continue;
            }
            
            // Destroy the instance
            await vultr.instances.deleteInstance({
              "instance-id": trackedInstance.id
            });
            
            console.log(`✅ Self-destruct initiated for instance ${trackedInstance.id}`);
            
            // Update state
            instanceState.updateInstance(trackedInstance.id, 'destroyed', {
              selfDestructTimer: null
            });
            
            // Try to send DM to creator
            try {
              const user = await client.users.fetch(trackedInstance.creator.id);
              if (user) {
                await user.send(`🔴💣 **Server Self-Destructed**\n\n` +
                  `Server "${trackedInstance.name}" has been automatically destroyed.\n` +
                  `⏰💣 The self-destruct timer expired.\n\n` +
                  `You can create a new server anytime using /create or the panel.`);
              }
            } catch (dmError) {
              console.error(`Failed to send self-destruct DM:`, dmError.message);
            }
            
            // Update panel
            setTimeout(() => updatePanel(), 2000);
            
          } catch (destroyError) {
            console.error(`Error destroying instance ${trackedInstance.id}:`, destroyError);
            // Continue checking other instances
          }
          continue;
        }
        
        // Check for warnings (10 minutes and 5 minutes)
        const warningsSent = timer.warningsSent || [];
        
        if (remainingMinutes <= 10 && remainingMinutes > 5 && !warningsSent.includes('10min')) {
          await sendSelfDestructWarning(
            trackedInstance.id,
            trackedInstance.name,
            10,
            trackedInstance.creator.id
          );
          timer.warningsSent.push('10min');
          instanceState.updateInstance(trackedInstance.id, trackedInstance.status, {
            selfDestructTimer: timer
          });
        } else if (remainingMinutes <= 5 && !warningsSent.includes('5min')) {
          await sendSelfDestructWarning(
            trackedInstance.id,
            trackedInstance.name,
            5,
            trackedInstance.creator.id
          );
          timer.warningsSent.push('5min');
          instanceState.updateInstance(trackedInstance.id, trackedInstance.status, {
            selfDestructTimer: timer
          });
        }
      }
    } catch (error) {
      console.error('Error in self-destruct polling:', error);
    }
  };
  
  // Check every 30 seconds
  setInterval(checkTimers, 30000);
  
  // Initial check after 5 seconds
  setTimeout(checkTimers, 5000);
}

// ================ PANEL HELPER FUNCTIONS ================

/**
 * Get server statistics for panel display
 */
async function getServerStats() {
  try {
    const instances = await listInstances();
    const running = instances.filter(i => i.power_status === 'running').length;
    const stopped = instances.filter(i => i.power_status === 'stopped').length;
    const total = instances.length;
    
    return { running, stopped, total };
  } catch (error) {
    console.error('Error getting server stats:', error);
    return { running: 0, stopped: 0, total: 0 };
  }
}

/**
 * Generate panel components with dynamic button states
 */
async function generatePanelComponents(showQuickActions = false) {
  const stats = await getServerStats();
  
  // Row 1: Basic operations
  const row1 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('btn_list')
        .setLabel(`📋 List (${stats.total})`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(stats.total === 0),
      new ButtonBuilder()
        .setCustomId('btn_destroy')
        .setLabel('🗑️ Destroy')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(stats.total === 0),
      new ButtonBuilder()
        .setCustomId('btn_restart')
        .setLabel('🔄 Restart')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(stats.total === 0),
      new ButtonBuilder()
        .setCustomId('btn_insert_coin')
        .setLabel(`💰 Insert Coin (+${SELF_DESTRUCT_COIN_MINUTES}min)`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(stats.total === 0)
    );
  
  const components = [row1];
  
  // Quick actions - Selected cities optimized for gaming traffic
  if (showQuickActions) {
    try {
      const groupedRegions = await getGroupedRegions(vultr);
      
      // Whitelist of optimal cities for gaming: 8 CONUS + 1 Canada + 6 Europe = 15 cities
      const selectedCityIds = [
        // CONUS (8)
        'atl', 'ord', 'dfw', 'lax', 'mia', 'ewr', 'sea', 'sjc',
        // Canada (1)
        'yto',
        // Europe (6)
        'ams', 'fra', 'lhr', 'mad', 'cdg', 'sto'
      ];
      
      // Build map of all available regions by ID for quick lookup
      const regionsById = {};
      for (const [continent, countries] of Object.entries(groupedRegions)) {
        for (const [country, cities] of Object.entries(countries)) {
          for (const city of cities) {
            regionsById[city.id] = city;
          }
        }
      }
      
      // Get selected cities in order
      const quickRegions = selectedCityIds
        .map(id => regionsById[id])
        .filter(city => city !== undefined); // Filter out any missing cities
      
      // Create buttons in rows of 5 (Discord limit per row)
      for (let i = 0; i < quickRegions.length; i += 5) {
        const rowCities = quickRegions.slice(i, i + 5);
        const row = new ActionRowBuilder();
        
        for (const region of rowCities) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`btn_quick_${region.id}`)
              .setLabel(`🚀 Quick: ${region.city}`)
              .setStyle(ButtonStyle.Primary)
          );
        }
        
        components.push(row);
      }
    } catch (error) {
      console.error('Error generating quick action buttons:', error);
      // Continue without quick buttons if there's an error
    }
  }
  
  return components;
}

/**
 * Get all instances from Vultr API including destroyed ones (for cost calculation)
 * This is separate from listInstances() which filters for active management
 */
async function getAllInstancesForCost() {
  try {
    const response = await vultr.instances.listInstances();
    let instances = response.instances || [];
    
    // Filter out only the current server (self-protection)
    // But include destroyed instances for cost calculation
    const filteredInstances = [];
    for (const instance of instances) {
      const isCurrent = await isCurrentServer(instance.id);
      if (!isCurrent) {
        filteredInstances.push(instance);
      }
    }
    
    return filteredInstances;
  } catch (error) {
    console.error('Error getting all instances for cost calculation:', error);
    return [];
  }
}

/**
 * Calculate total estimated cost for all instances since first day of current month
 * Includes destroyed instances that existed during the month
 */
async function calculateMonthlyTotalCost() {
  try {
    // Get ALL instances including destroyed ones for accurate cost calculation
    const allInstances = await getAllInstancesForCost();
    
    if (!allInstances || allInstances.length === 0) {
      return { total: 0, count: 0 };
    }
    
    // Get first day of current month
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    let totalCost = 0;
    let instanceCount = 0;
    
    // Get plans data once for efficiency
    const plansResponse = await vultr.plans.listPlans();
    const plans = plansResponse?.plans || [];
    
    for (const instance of allInstances) {
      if (!instance.plan || !instance.date_created) continue;
      
      const createdAt = new Date(instance.date_created);
      
      // Skip instances created after the current month
      if (createdAt > now) continue;
      
      // Determine end date: use current time for active instances,
      // or check if instance was destroyed during the month
      let endDate = now;
      
      // If instance is destroyed/terminated, try to use a reasonable end date
      // Note: Vultr API may not provide exact destruction date, so we use current time
      // as a fallback (this will slightly overestimate but is safer)
      if (instance.status === 'destroyed' || instance.status === 'terminated' || 
          instance.power_status === 'destroyed' || instance.power_status === 'terminated') {
        // For destroyed instances, we can't get exact destruction time from API
        // So we'll calculate from creation to end of month or current time
        // This is an estimate - actual billing may differ
        endDate = now; // Use current time as safe estimate
      }
      
      // Only count costs from first day of month onwards
      const startDate = createdAt > firstDayOfMonth ? createdAt : firstDayOfMonth;
      
      // Only calculate if instance existed during this month
      if (endDate >= firstDayOfMonth) {
        const plan = plans.find(p => p.id === instance.plan);
        if (plan && typeof plan.monthly_cost === 'number') {
          // Calculate uptime in hours from start date to end date
          const uptimeMs = endDate - startDate;
          if (uptimeMs > 0) {
            const uptimeHours = Math.ceil(uptimeMs / (1000 * 60 * 60));
            const hourlyRate = plan.monthly_cost / 730;
            totalCost += uptimeHours * hourlyRate;
            instanceCount++;
          }
        }
      }
    }
    
    return { total: totalCost, count: instanceCount };
  } catch (error) {
    console.error('Error calculating monthly total cost:', error);
    return { total: 0, count: 0 };
  }
}

/**
 * Format server list for panel display with Xlink URLs, costs, and creators
 * @param {Guild|null} guild - Discord guild to fetch member nicknames from
 */
async function formatServersForPanel(guild = null) {
  try {
    // Get instances from Vultr API
    const vultrInstances = await listInstances();
    
    if (!vultrInstances || vultrInstances.length === 0) {
      return '📊 **No active servers**';
    }
    
    // Build formatted list for each server
    let panelContent = '';
    
    // Process each instance
    for (const vultrInstance of vultrInstances) {
      // Get tracked instance data for creator info
      const trackedInstance = instanceState.getInstance(vultrInstance.id);
      
      // Server name
      const serverName = vultrInstance.label || 'Unnamed Server';
      
      // Xlink URL
      const xlinkUrl = vultrInstance.main_ip ? `http://${vultrInstance.main_ip}:34522` : 'N/A';
      
      // Calculate cost
      const cost = await calculateInstanceCost(vultrInstance);
      
      // Creator name - use server nickname if available, otherwise username
      let creatorName = 'Unknown';
      if (trackedInstance?.creator?.id) {
        if (guild) {
          try {
            // Try to get member from cache first
            let member = guild.members.cache.get(trackedInstance.creator.id);
            
            // If not in cache, fetch it
            if (!member) {
              // Use fetch with cache option to avoid rate limits
              member = await guild.members.fetch({ user: trackedInstance.creator.id, cache: true }).catch(() => null);
            }
            
            if (member) {
              // displayName shows nickname if set, otherwise username
              creatorName = member.displayName;
            } else {
              // Fallback to username if member fetch fails
              creatorName = trackedInstance.creator.username || 'Unknown';
            }
          } catch (error) {
            console.error(`Error fetching member ${trackedInstance.creator.id}:`, error);
            // Fallback to username on error
            creatorName = trackedInstance.creator.username || 'Unknown';
          }
        } else {
          // No guild context, use username
          creatorName = trackedInstance.creator.username || 'Unknown';
        }
      }
      
      // Timer display
      let timerDisplay = '';
      if (trackedInstance?.selfDestructTimer?.expiresAt) {
        const expiresAt = trackedInstance.selfDestructTimer.expiresAt;
        const remainingMs = expiresAt - Date.now();
        
        if (remainingMs > 0) {
          const remainingMinutes = Math.floor(remainingMs / 60000);
          const timeStr = formatRemainingTime(expiresAt);
          
          if (remainingMinutes < 5) {
            timerDisplay = `🔴💣 ${timeStr}`;
          } else if (remainingMinutes < 10) {
            timerDisplay = `⚠️💣 ${timeStr}`;
          } else {
            timerDisplay = `⏰💣 ${timeStr}`;
          }
        } else {
          timerDisplay = `🔴💣 EXPIRED`;
        }
      }
      
      // Format: **Server Name** | Xlink: http://ip:34522 | ⏰💣 1:23:45 | 💰 Insert Coin | Cost: $X.XX | By: creator
      const timerPart = timerDisplay ? ` | ${timerDisplay}` : '';
      panelContent += `**${serverName}** | Xlink: ${xlinkUrl}${timerPart} | 💰 Insert Coin | Cost: ${cost} | By: ${creatorName}\n`;
    }
    
    return panelContent.trimEnd();
  } catch (error) {
    console.error('Error formatting servers for panel:', error);
    return '📊 **Error loading server list**';
  }
}

/**
 * Generate panel message content with server list
 * @param {Guild|null} guild - Discord guild to fetch member nicknames from
 */
async function generatePanelContent(guild = null) {
  const serverList = await formatServersForPanel(guild);
  
  return '🎮 **Server Control Panel**\n\n' +
         serverList.trimEnd();
}

/**
 * Update existing panel or create new one
 */
async function updatePanel(interaction = null, channel = null) {
  // #region agent log
  DEBUG_LOG('index.js:2103', 'updatePanel entry', {
    hypothesisId: 'B,C',
    hasInteraction: !!interaction,
    hasChannel: !!channel,
    panelUpdateInProgress,
    pendingPanelUpdate,
    storedMessageId: panelData.messageId,
    storedChannelId: panelData.channelId
  });
  // #endregion
  
  // Prevent concurrent updates
  if (panelUpdateInProgress) {
    // #region agent log
    DEBUG_LOG('index.js:2115', 'Panel update blocked by lock', {
      hypothesisId: 'B',
      hasInteraction: !!interaction
    });
    // #endregion
    if (!interaction) {
      // Queue the update for later if it's a periodic refresh
      pendingPanelUpdate = true;
      return null;
    }
    // For interactions, wait a bit and retry once
    await new Promise(resolve => setTimeout(resolve, 100));
    if (panelUpdateInProgress) {
      // #region agent log
      DEBUG_LOG('index.js:2127', 'Panel update still blocked after wait', { hypothesisId: 'B' });
      // #endregion
      console.log('Panel update already in progress, skipping');
      return null;
    }
  }
  
  panelUpdateInProgress = true;
  pendingPanelUpdate = false;
  // #region agent log
  DEBUG_LOG('index.js:2135', 'Panel update lock acquired', { hypothesisId: 'B' });
  // #endregion
  
  try {
    // Extract guild from interaction or channel for nickname lookup
    let guild = null;
    if (interaction?.guild) {
      guild = interaction.guild;
    } else if (interaction?.guildId) {
      guild = client.guilds.cache.get(interaction.guildId);
    } else if (channel?.guild) {
      guild = channel.guild;
    } else if (panelData.channelId) {
      const panelChannel = client.channels.cache.get(panelData.channelId);
      if (panelChannel?.guild) {
        guild = panelChannel.guild;
      }
    }
    
    const content = await generatePanelContent(guild);
    const components = await generatePanelComponents(true);
    
    // If we have an interaction, ALWAYS respond to it first
    // This ensures the command responds even if we also update an existing panel
    if (interaction) {
      // #region agent log
      DEBUG_LOG('index.js:2143', 'Calling interaction.editReply', {
        hypothesisId: 'A',
        deferred: interaction.deferred,
        replied: interaction.replied
      });
      // #endregion
      try {
        const message = await interaction.editReply({ content, components });
        // #region agent log
        DEBUG_LOG('index.js:2151', 'interaction.editReply succeeded', {
          hypothesisId: 'A',
          messageId: message.id,
          channelId: message.channelId
        });
        // #endregion
        // Update stored panel data with the new message
        panelData.messageId = message.id;
        panelData.channelId = message.channelId;
        panelData.lastUpdate = new Date().toISOString();
        savePanelData();
        return message;
      } catch (editError) {
        // #region agent log
        DEBUG_LOG('index.js:2163', 'interaction.editReply failed', {
          hypothesisId: 'A',
          error: editError.message,
          code: editError.code,
          deferred: interaction.deferred,
          replied: interaction.replied
        });
        // #endregion
        throw editError;
      }
    }
    
    // If we have a stored panel, try to update it (for periodic refreshes)
    if (panelData.messageId && panelData.channelId) {
      // #region agent log
      DEBUG_LOG('index.js:2175', 'Attempting to update stored panel', {
        hypothesisId: 'C,D',
        messageId: panelData.messageId,
        channelId: panelData.channelId
      });
      // #endregion
      try {
        const panelChannel = client.channels.cache.get(panelData.channelId);
        if (panelChannel) {
          // #region agent log
          DEBUG_LOG('index.js:2182', 'Fetching panel message', {
            hypothesisId: 'C',
            messageId: panelData.messageId
          });
          // #endregion
          const message = await panelChannel.messages.fetch(panelData.messageId);
          // #region agent log
          DEBUG_LOG('index.js:2187', 'Editing panel message', { hypothesisId: 'C' });
          // #endregion
          await message.edit({ content, components });
          panelData.lastUpdate = new Date().toISOString();
          savePanelData();
          // #region agent log
          DEBUG_LOG('index.js:2192', 'Panel message updated successfully', { hypothesisId: 'C' });
          // #endregion
          return message;
        } else {
          // #region agent log
          DEBUG_LOG('index.js:2196', 'Panel channel not found in cache', {
            hypothesisId: 'C',
            channelId: panelData.channelId
          });
          // #endregion
        }
      } catch (error) {
        // #region agent log
        DEBUG_LOG('index.js:2203', 'Error updating stored panel', {
          hypothesisId: 'C,D',
          error: error.message,
          code: error.code,
          errorType: error.constructor.name
        });
        // #endregion
        // Check if message was deleted (Discord error code 10008)
        const isMessageDeleted = error.code === 10008 || 
                                 error.message?.includes('Unknown Message') ||
                                 error.message?.includes('message not found');
        
        // #region agent log
        DEBUG_LOG('index.js:2212', 'Checking if message was deleted', {
          hypothesisId: 'D',
          isMessageDeleted,
          errorCode: error.code
        });
        // #endregion
        
        if (isMessageDeleted) {
          console.log('Panel message was deleted, attempting to recreate');
          // Save channel ID before clearing (for recreation attempt)
          const savedChannelId = panelData.channelId;
          // Clear stored message data
          panelData.messageId = null;
          savePanelData();
          
          // Try to recreate in the same channel if we have it
          if (savedChannelId) {
            // #region agent log
            DEBUG_LOG('index.js:2296', 'Looking up channel for recreation', {
              hypothesisId: 'D',
              savedChannelId,
              cacheSize: client.channels.cache.size
            });
            // #endregion
            let panelChannel = client.channels.cache.get(savedChannelId);
            // #region agent log
            DEBUG_LOG('index.js:2303', 'Channel lookup result (cache)', {
              hypothesisId: 'D',
              channelFound: !!panelChannel,
              channelType: panelChannel?.type
            });
            // #endregion
            // If not in cache, try to fetch it
            if (!panelChannel) {
              try {
                // #region agent log
                DEBUG_LOG('index.js:2310', 'Channel not in cache, fetching', {
                  hypothesisId: 'D',
                  savedChannelId
                });
                // #endregion
                panelChannel = await client.channels.fetch(savedChannelId);
                // #region agent log
                DEBUG_LOG('index.js:2316', 'Channel fetched successfully', {
                  hypothesisId: 'D',
                  channelType: panelChannel?.type
                });
                // #endregion
              } catch (fetchError) {
                // #region agent log
                DEBUG_LOG('index.js:2322', 'Channel fetch failed', {
                  hypothesisId: 'D',
                  error: fetchError.message,
                  code: fetchError.code
                });
                // #endregion
                console.error('Failed to fetch channel for panel recreation:', fetchError);
                panelChannel = null;
              }
            }
            // #region agent log
            DEBUG_LOG('index.js:2331', 'Final channel check before recreation', {
              hypothesisId: 'D',
              channelFound: !!panelChannel,
              channelType: panelChannel?.type
            });
            // #endregion
            if (panelChannel) {
              // #region agent log
              DEBUG_LOG('index.js:2309', 'Attempting to recreate panel', {
                hypothesisId: 'D',
                channelId: savedChannelId
              });
              // #endregion
              try {
                // #region agent log
                DEBUG_LOG('index.js:2315', 'Calling panelChannel.send', {
                  hypothesisId: 'D',
                  contentLength: content?.length,
                  componentsCount: components?.length
                });
                // #endregion
                const newMessage = await panelChannel.send({ content, components });
                panelData.messageId = newMessage.id;
                panelData.channelId = newMessage.channelId;
                panelData.lastUpdate = new Date().toISOString();
                savePanelData();
                // #region agent log
                DEBUG_LOG('index.js:2238', 'Panel recreated successfully', {
                  hypothesisId: 'D',
                  newMessageId: newMessage.id
                });
                // #endregion
                console.log('✅ Panel recreated automatically');
                return newMessage;
              } catch (recreateError) {
                // #region agent log
                DEBUG_LOG('index.js:2246', 'Panel recreation failed', {
                  hypothesisId: 'D',
                  error: recreateError.message,
                  code: recreateError.code
                });
                // #endregion
                console.error('Failed to recreate panel:', recreateError);
                // Clear channel if recreation failed
                panelData.channelId = null;
                savePanelData();
              }
            } else {
              // #region agent log
              DEBUG_LOG('index.js:2256', 'Panel channel not found for recreation', {
                hypothesisId: 'D',
                savedChannelId
              });
              // #endregion
              // Channel not found, clear it
              panelData.channelId = null;
              savePanelData();
            }
          }
        } else {
          // Other error - log and clear data
          console.log('Could not update existing panel:', error.message);
          panelData.messageId = null;
          panelData.channelId = null;
          savePanelData();
        }
      }
    }
    
    // Create new panel if needed (for channel-based creation or auto-recreation)
    if (channel) {
      const message = await channel.send({ content, components });
      panelData.messageId = message.id;
      panelData.channelId = channel.id;
      panelData.lastUpdate = new Date().toISOString();
      savePanelData();
      return message;
    }
    
    // If we have stored channel but no message, try to recreate
    if (panelData.channelId && !panelData.messageId) {
      try {
        const panelChannel = client.channels.cache.get(panelData.channelId);
        if (panelChannel) {
          const message = await panelChannel.send({ content, components });
          panelData.messageId = message.id;
          panelData.channelId = message.channelId;
          panelData.lastUpdate = new Date().toISOString();
          savePanelData();
          console.log('✅ Panel recreated in stored channel');
          return message;
        }
      } catch (error) {
        console.error('Failed to recreate panel in stored channel:', error);
        // Clear invalid channel data
        panelData.messageId = null;
        panelData.channelId = null;
        savePanelData();
      }
    }
  } catch (error) {
    console.error('Error updating panel:', error);
    // If we have an interaction and error occurred, still try to respond
    if (interaction) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('❌ Error displaying the control panel.');
        } else {
          await interaction.reply('❌ Error displaying the control panel.');
        }
      } catch (replyError) {
        console.error('Failed to send error reply:', replyError);
      }
    }
  } finally {
    // #region agent log
    DEBUG_LOG('index.js:2271', 'updatePanel finally block', {
      hypothesisId: 'B',
      pendingPanelUpdate
    });
    // #endregion
    // Release lock
    panelUpdateInProgress = false;
    
    // If another update was requested while we were working, execute it
    if (pendingPanelUpdate) {
      // #region agent log
      DEBUG_LOG('index.js:2280', 'Executing queued panel update', { hypothesisId: 'B' });
      // #endregion
      console.log('Executing queued panel update');
      setTimeout(() => {
        updatePanel();
      }, 100); // Small delay to avoid tight loop
    }
  }
}

// ================ COMMAND DEFINITIONS ================

// Collection to store command handlers
client.commands = new Collection();

// Create the /list command
const listCommand = {
  data: new SlashCommandBuilder()
    .setName('list')
    .setDescription('List all active game servers'),
  
  async execute(interaction) {
    try {
      // Try to get instances from Vultr API to ensure our tracking is up to date
      try {
        const vultrInstances = await listInstances();
        
        // Update our tracked instances based on Vultr's data
        const activeInstances = instanceState.getActiveInstances();
        
        vultrInstances.forEach(vultrInstance => {
          const trackedInstance = activeInstances.find(i => i.id === vultrInstance.id);
          
          if (trackedInstance) {
            // Update existing instance
            instanceState.updateInstance(vultrInstance.id, vultrInstance.power_status, {
              ip: vultrInstance.main_ip
            });
          } else {
            // Add new instance we're not tracking yet (any status)
            instanceState.trackInstance(
              vultrInstance.id,
              'unknown',
              'Unknown',
              vultrInstance.power_status,
              {
                ip: vultrInstance.main_ip,
                name: vultrInstance.label || 'Unknown Server'
              }
            );
          }
        });
        
        // Mark tracked instances that don't exist in Vultr as terminated
        activeInstances.forEach(trackedInstance => {
          const vultrInstance = vultrInstances.find(i => i.id === trackedInstance.id);
          if (!vultrInstance) {
            instanceState.updateInstance(trackedInstance.id, 'terminated');
          }
        });
      } catch (error) {
        console.error('Error syncing with Vultr API:', error);
        // Continue with local data if Vultr API fails
      }
      
      // Get the refreshed list of active instances
      const activeInstances = instanceState.getActiveInstances();
      
      // Format and send the response
      const formattedList = formatInstanceList(activeInstances);
      return interaction.editReply(formattedList);
    } catch (error) {
      console.error('Error executing list command:', error);
      return interaction.editReply('❌ There was an error trying to list the servers.');
    }
  }
};

// Create the /status command
const statusCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check the status of a game server'),
  
  async execute(interaction) {
    try {
      // Get all instances first
      const vultrInstances = await listInstances();
      
      if (!vultrInstances?.length) {
        return interaction.editReply('No servers found.');
      }

      // Create select menu options from instances
      const options = vultrInstances.map(instance => ({
        label: instance.label || 'Unnamed Server',
        description: `Status: ${instance.power_status} | IP: ${instance.main_ip} | Region: ${instance.region}`,
        value: instance.id
      }));

      // Create the select menu
      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_server')
            .setPlaceholder('Select a server to check')
            .addOptions(options)
        );

      // Send message with select menu
      return interaction.editReply({
        content: 'Choose a server to check its status:',
        components: [row]
      });
    } catch (error) {
      console.error('Error executing status command:', error);
      return interaction.editReply('❌ There was an error checking server status.');
    }
  }
};

// Create the /start command
const startCommand = {
  data: new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start a game server'),
  
  async execute(interaction) {
    try {
      // Get all instances that are stopped
      const vultrInstances = await listInstances();
      const stoppedInstances = vultrInstances.filter(instance => 
        instance.power_status === 'stopped'
      );
      
      if (!stoppedInstances?.length) {
        return interaction.editReply('No stopped servers found. All servers may already be running.');
      }

      // Create select menu options from stopped instances
      const options = stoppedInstances.map(instance => ({
        label: instance.label || 'Unnamed Server',
        description: `Status: ${instance.power_status} | IP: ${instance.main_ip} | Region: ${instance.region}`,
        value: instance.id
      }));

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('start_server')
            .setPlaceholder('Select a server to start')
            .addOptions(options)
        );

      return interaction.editReply({
        content: 'Choose a server to start:',
        components: [row]
      });
    } catch (error) {
      console.error('Error executing start command:', error);
      return interaction.editReply('❌ There was an error listing servers.');
    }
  }
};

// Create the /stop command
const stopCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop a game server'),
  
  async execute(interaction) {
    try {
      // Get all instances that are running
      const vultrInstances = await listInstances();
      const runningInstances = vultrInstances.filter(instance => 
        instance.power_status === 'running'
      );
      
      if (!runningInstances?.length) {
        return interaction.editReply('No running servers found. All servers may already be stopped.');
      }

      // Create select menu options from running instances
      const options = runningInstances.map(instance => ({
        label: instance.label || 'Unnamed Server',
        description: `Status: ${instance.power_status} | IP: ${instance.main_ip} | Region: ${instance.region}`,
        value: instance.id
      }));

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('stop_server')
            .setPlaceholder('Select a server to stop')
            .addOptions(options)
        );

      return interaction.editReply({
        content: 'Choose a server to stop:',
        components: [row]
      });
    } catch (error) {
      console.error('Error executing stop command:', error);
      return interaction.editReply('❌ There was an error listing servers.');
    }
  }
};

// Create the /create command
const createCommand = {
  data: new SlashCommandBuilder()
    .setName('create')
    .setDescription('Create a new game server')
    .addStringOption(option => 
      option
        .setName('name')
        .setDescription('A name for your server')
        .setRequired(false))
    .addStringOption(option =>
      option
        .setName('city')
        .setDescription('City to create server in (optional - defaults to Dallas)')
        .setRequired(false)
        .setAutocomplete(true)),
  
  async execute(interaction) {
    try {
      // Get server name from command options or use default
      const serverName = interaction.options.getString('name') || 
                        `${interaction.user.username}'s Server`;
      
      // Get city from command options or use default (DFW)
      const selectedCity = interaction.options.getString('city') || 'dfw';
      
      await interaction.editReply('🔄 Creating your server...');
      
      // Get available snapshots
      let snapshots;
      try {
        snapshots = await getSnapshots();
        console.log('Snapshots API response:', JSON.stringify(snapshots, null, 2));
        console.log(`Found ${snapshots?.length || 0} snapshots`);
      } catch (error) {
        console.error('Error fetching snapshots:', error);
        return interaction.editReply('❌ Error fetching snapshots from Vultr API. Check console for details.');
      }
      
      // Check if we have a snapshot ID from environment variable as fallback
      let snapshotId;
      
      if (!snapshots?.length) {
        console.log('No snapshots from API, checking VULTR_SNAPSHOT_ID from env:', process.env.VULTR_SNAPSHOT_ID);
        
        if (process.env.VULTR_SNAPSHOT_ID) {
          console.log('Using VULTR_SNAPSHOT_ID from .env as fallback');
          snapshotId = process.env.VULTR_SNAPSHOT_ID;
        } else {
          return interaction.editReply('❌ No snapshots available to create a server from. Please set VULTR_SNAPSHOT_ID in .env file.');
        }
      } else {
        // Use the snapshot ID from .env or the most recent snapshot
        snapshotId = process.env.VULTR_SNAPSHOT_ID || snapshots[0].id;
      }
      
      // Create the instance with the selected region
      const instance = await createInstanceFromSnapshot(snapshotId, serverName, selectedCity);
      
      if (!instance || !instance.id) {
        return interaction.editReply('❌ Failed to create the server. Please try again later.');
      }
      
      // Track the new instance
      instanceState.trackInstance(
        instance.id,
        interaction.user.id,
        interaction.user.username,
        instance.status || 'creating',
        {
          ip: instance.main_ip,
          name: serverName,
          region: selectedCity
        }
      );
      
      // Initial response
      const initialMessage = await interaction.editReply(
        `✅ Server "${serverName}" creation started in ${selectedCity.toUpperCase()}!\n` +
        `⏳ Please be patient - server creation typically takes 15 minutes.\n` +
        `📊 Checking status automatically...\n` +
        `💡 Tip: The server will be ready when its status shows as "running"\n` +
        `Don't forget to use /destroy to delete your server when you're done!`
      );

      // Start automatic status polling
      startInstanceStatusPolling(instance.id, serverName, selectedCity, interaction, initialMessage);

      return; // Don't return the editReply, let the polling handle updates
      
    } catch (error) {
      console.error('Error executing create command:', error);
      return interaction.editReply('❌ There was an error creating the server.');
    }
  }
};

// Create the /snapshot command
const snapshotCommand = {
  data: new SlashCommandBuilder()
    .setName('snapshot')
    .setDescription('Create a snapshot of a running server (Admin only)')
    .addStringOption(option =>
      option
        .setName('server')
        .setDescription('Server to snapshot')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('Custom name for the snapshot (e.g., "Gaming Setup v2")')
        .setRequired(true)
        .setMaxLength(50))
    .addStringOption(option =>
      option
        .setName('description')
        .setDescription('Optional description')
        .setRequired(false)
        .setMaxLength(150))
    .addBooleanOption(option =>
      option
        .setName('public')
        .setDescription('Make snapshot available to all users via /restore command')
        .setRequired(false)),
  
  async execute(interaction) {
    try {
      // Check admin permissions
      if (!hasSnapshotPermission(interaction.user.id)) {
        return interaction.editReply('❌ You do not have permission to create snapshots. Contact an administrator.');
      }
      
      const serverId = interaction.options.getString('server');
      const snapshotName = interaction.options.getString('name');
      const userDescription = interaction.options.getString('description') || '';
      const isPublic = interaction.options.getBoolean('public') || false;
      
      // Build the snapshot description using naming conventions
      const prefix = isPublic ? '[PUBLIC]' : '[PRIVATE]';
      const description = userDescription 
        ? `${prefix} ${snapshotName} | ${userDescription}`
        : `${prefix} ${snapshotName}`;
      
      // Verify the server exists and is running
      const instance = await getInstance(serverId);
      if (!instance) {
        return interaction.editReply('❌ Server not found or not available for management.');
      }
      
      if (instance.power_status !== 'running') {
        return interaction.editReply(`❌ Server must be running to create a snapshot. Current status: ${instance.power_status}`);
      }
      
      // Show cost warning and confirmation
      await interaction.editReply(
        `⚠️ **Snapshot Creation Cost Warning**\n\n` +
        `📸 **Server:** ${instance.label || 'Unnamed Server'}\n` +
        `📝 **Snapshot Name:** ${snapshotName}\n` +
        `${isPublic ? '🌍 **Visibility:** Public (available to all users)' : '🔒 **Visibility:** Private (admin only)'}\n` +
        `💰 **Cost:** ~$0.05/GB/month on Vultr\n` +
        `⏱️ **Time:** 5-15 minutes depending on server size\n\n` +
        `🔄 Creating snapshot...`
      );
      
      // Create the snapshot
      const snapshot = await createSnapshotFromInstance(serverId, description);
      
      if (!snapshot?.id) {
        return interaction.editReply('❌ Failed to create snapshot. Please try again later.');
      }
      
      // Initial response showing creation started
      const initialMessage = await interaction.editReply(
        `✅ Snapshot "${snapshotName}" creation started successfully!\n` +
        `📸 **From Server:** ${instance.label || 'Unnamed Server'}\n` +
        `⏳ Please be patient - snapshot creation typically takes 5-15 minutes.\n` +
        `📊 Checking status automatically...\n` +
        `💡 You'll be notified when the snapshot is ready!\n` +
        `${isPublic ? '🌍 Will be available to all users when complete' : '🔒 Private snapshot for admin use'}`
      );

      // Start automatic status polling
      startSnapshotStatusPolling(snapshot.id, snapshotName, isPublic, interaction);

      return; // Let the polling handle updates
      
    } catch (error) {
      console.error('Error executing snapshot command:', error);
      return interaction.editReply('❌ There was an error creating the snapshot.');
    }
  }
};

// Create the /restore command
const restoreCommand = {
  data: new SlashCommandBuilder()
    .setName('restore')
    .setDescription('Create a new server from a snapshot')
    .addStringOption(option =>
      option
        .setName('snapshot')
        .setDescription('Snapshot to restore from')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('Name for the new server')
        .setRequired(false))
    .addStringOption(option =>
      option
        .setName('city')
        .setDescription('City to create server in (optional - defaults to Dallas)')
        .setRequired(false)
        .setAutocomplete(true)),
  
  async execute(interaction) {
    try {
      const snapshotId = interaction.options.getString('snapshot');
      const serverName = interaction.options.getString('name') || 
                        `${interaction.user.username}'s Restored Server`;
      const selectedCity = interaction.options.getString('city') || 'dfw';
      
      await interaction.editReply('🔄 Restoring server from snapshot...');
      
      // Verify snapshot exists and is available
      const publicSnapshots = await getPublicSnapshots();
      const selectedSnapshot = publicSnapshots.find(snap => snap.id === snapshotId);
      
      if (!selectedSnapshot) {
        return interaction.editReply('❌ Snapshot not found or not available for use.');
      }
      
      if (selectedSnapshot.status !== 'complete') {
        return interaction.editReply(`❌ Snapshot is not ready yet. Status: ${selectedSnapshot.status}. Please wait and try again.`);
      }
      
      // Create the instance from the snapshot (reuse existing function)
      const instance = await createInstanceFromSnapshot(snapshotId, serverName, selectedCity);
      
      if (!instance?.id) {
        return interaction.editReply('❌ Failed to restore server from snapshot. Please try again later.');
      }
      
      // Track the new instance
      instanceState.trackInstance(
        instance.id,
        interaction.user.id,
        interaction.user.username,
        instance.status || 'creating',
        {
          ip: instance.main_ip,
          name: serverName,
          region: selectedCity
        }
      );
      
      // Initial response
      const cleanSnapshotName = getCleanSnapshotName(selectedSnapshot);
      const initialMessage = await interaction.editReply(
        `✅ Server "${serverName}" restoration started in ${selectedCity.toUpperCase()}!\n` +
        `📸 **From Snapshot:** ${cleanSnapshotName}\n` +
        `⏳ Please be patient - server creation typically takes 15 minutes.\n` +
        `📊 Checking status automatically...\n` +
        `Don't forget to use /destroy to delete your server when you're done!`
      );

      // Start automatic status polling (reuse existing function)
      startInstanceStatusPolling(instance.id, serverName, selectedCity, interaction, initialMessage);

      return; // Let the polling handle updates
      
    } catch (error) {
      console.error('Error executing restore command:', error);
      return interaction.editReply('❌ There was an error restoring the server.');
    }
  }
};

// Create the /restart command
const restartCommand = {
  data: new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart a server'),
  
  async execute(interaction) {
    try {
      // Get all instances
      const vultrInstances = await listInstances();
      const activeInstances = vultrInstances.filter(instance => 
        instance.status !== 'destroyed' && instance.power_status !== 'destroyed'
      );
      
      if (!activeInstances?.length) {
        return interaction.editReply('No active servers found to restart.');
      }

      // Create select menu options from instances
      const options = activeInstances.map(instance => ({
        label: instance.label || 'Unnamed Server',
        description: `Status: ${instance.power_status} | IP: ${instance.main_ip} | Region: ${instance.region}`,
        value: instance.id
      }));

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('restart_server')
            .setPlaceholder('Select a server to restart')
            .addOptions(options)
        );

      return interaction.editReply({
        content: '🔄 **Restart Server**\nSelect a server to restart:',
        components: [row]
      });
    } catch (error) {
      console.error('Error executing restart command:', error);
      return interaction.editReply('❌ There was an error listing servers.');
    }
  }
};

// Create the /destroy command
const destroyCommand = {
  data: new SlashCommandBuilder()
    .setName('destroy')
    .setDescription('Destroy a server and see its total cost'),
  
  async execute(interaction) {
    try {
      // Get all instances
      const vultrInstances = await listInstances();
      const activeInstances = vultrInstances.filter(instance => 
        instance.status !== 'destroyed' && instance.power_status !== 'destroyed'
      );
      
      if (!activeInstances?.length) {
        return interaction.editReply('No active servers found to destroy.');
      }

      // Create select menu options from instances
      const options = activeInstances.map(instance => ({
        label: instance.label || 'Unnamed Server',
        description: `Status: ${instance.power_status} | IP: ${instance.main_ip} | Region: ${instance.region}`,
        value: instance.id
      }));

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('destroy_server')
            .setPlaceholder('Select a server to destroy')
            .addOptions(options)
        );

      return interaction.editReply({
        content: '⚠️ **WARNING**: This will permanently destroy the server and all its data!\nSelect a server to destroy:',
        components: [row]
      });
    } catch (error) {
      console.error('Error executing destroy command:', error);
      return interaction.editReply('❌ There was an error listing servers.');
    }
  }
};

// Create the /panel command - Shows button control panel
const panelCommand = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Show the server control panel with buttons'),
  
  async execute(interaction) {
    // #region agent log
    DEBUG_LOG('index.js:2844', 'Panel command execute entry', {
      hypothesisId: 'A',
      userId: interaction.user?.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId
    });
    // #endregion
    
    // Defer reply first - required for editReply to work
    try {
      await interaction.deferReply();
      // #region agent log
      DEBUG_LOG('index.js:2850', 'deferReply completed', { hypothesisId: 'A' });
      // #endregion
    } catch (deferError) {
      // #region agent log
      DEBUG_LOG('index.js:2853', 'deferReply failed', {
        hypothesisId: 'A',
        error: deferError.message,
        code: deferError.code
      });
      // #endregion
      throw deferError;
    }
    
    try {
      // #region agent log
      DEBUG_LOG('index.js:2861', 'Calling updatePanel', { hypothesisId: 'A' });
      // #endregion
      await updatePanel(interaction);
      // #region agent log
      DEBUG_LOG('index.js:2864', 'updatePanel completed successfully', { hypothesisId: 'A' });
      // #endregion
    } catch (error) {
      // #region agent log
      DEBUG_LOG('index.js:2867', 'Panel command error', {
        hypothesisId: 'A',
        error: error.message,
        code: error.code,
        stack: error.stack?.substring(0, 200)
      });
      // #endregion
      console.error('Error executing panel command:', error);
      
      // Try to respond with error message
      try {
        await interaction.editReply('❌ There was an error displaying the control panel.');
      } catch (replyError) {
        // #region agent log
        DEBUG_LOG('index.js:2878', 'Failed to send error reply', {
          hypothesisId: 'A',
          error: replyError.message
        });
        // #endregion
        console.error('Failed to send error reply:', replyError);
      }
    }
  }
};

// Add all commands to the collection
client.commands.set(listCommand.data.name, listCommand);
client.commands.set(statusCommand.data.name, statusCommand);
client.commands.set(startCommand.data.name, startCommand);
client.commands.set(stopCommand.data.name, stopCommand);
client.commands.set(createCommand.data.name, createCommand);
client.commands.set(snapshotCommand.data.name, snapshotCommand);
client.commands.set(restoreCommand.data.name, restoreCommand);
client.commands.set(restartCommand.data.name, restartCommand);
client.commands.set(destroyCommand.data.name, destroyCommand);
client.commands.set(panelCommand.data.name, panelCommand);

// ================ EVENT HANDLERS ================

// When the client is ready, register all slash commands
client.once('ready', async () => {
  console.log(`Bot is ready! Logged in as ${client.user.tag}`);
  
  // Test Vultr API connectivity and permissions
  console.log('Testing Vultr API connectivity...');
  try {
    // Test basic API access
    const testResponse = await vultr.instances.listInstances();
    console.log('✅ Vultr API connection successful');
    
    // Test snapshot permissions
    const snapshotTest = await vultr.snapshots.listSnapshots();
    if (snapshotTest && Object.keys(snapshotTest).length === 0) {
      console.warn('⚠️ WARNING: Snapshots API returned empty - check IP whitelist and permissions');
      console.warn('Go to: Vultr Dashboard → API → Your API Key → Settings');
      console.warn('1. Add this server\'s IP to allowed IPs');
      console.warn('2. Ensure "Snapshots" permission is enabled');
    } else if (snapshotTest.snapshots) {
      console.log(`✅ Snapshots API working - found ${snapshotTest.snapshots.length} snapshots`);
    }
    
    // Test instances permissions
    const instanceTest = await vultr.instances.listInstances();
    if (instanceTest && Object.keys(instanceTest).length === 0) {
      console.warn('⚠️ WARNING: Instances API returned empty - check permissions');
    } else if (instanceTest.instances) {
      console.log(`✅ Instances API working - found ${instanceTest.instances.length} instances`);
      
      // Recover existing instances into in-memory state
      console.log('Recovering existing instances into state tracking...');
      instanceTest.instances.forEach(vultrInstance => {
        // Skip excluded instances
        if (vultrInstance.id === process.env.EXCLUDE_INSTANCE_ID) {
          console.log(`Skipping excluded instance: ${vultrInstance.id} (${vultrInstance.label})`);
          return;
        }
        
        instanceState.trackInstance(
          vultrInstance.id,
          'unknown', // We don't know the Discord user who created it
          'System Recovery',
          vultrInstance.power_status,
          {
            ip: vultrInstance.main_ip,
            name: vultrInstance.label || 'Recovered Server',
            region: vultrInstance.region
          }
        );
      });
      console.log(`✅ Recovered ${instanceTest.instances.length} instances into state tracking`);
    }
    
  } catch (error) {
    console.error('❌ Vultr API test failed:', error.message);
    if (error.response?.status === 401) {
      console.error('Invalid API key. Check VULTR_API_KEY in .env file');
    } else if (error.response?.status === 403) {
      console.error('API access denied. This server\'s IP may not be whitelisted');
      console.error('Add this server\'s IP to your Vultr API key settings');
    }
  }
  
  try {
    // Get all commands for registration
    const commands = [...client.commands.values()].map(command => command.data.toJSON());
    
    // Create REST API client
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    console.log(`Registering ${commands.length} application commands...`);
    console.log('Command names:', commands.map(cmd => cmd.name));
    
    // Register globally (can take up to 1 hour to propagate)
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    
    // Also register to guild for immediate testing (if DISCORD_GUILD_ID is set)
    if (process.env.DISCORD_GUILD_ID) {
      console.log(`Also registering commands to guild ${process.env.DISCORD_GUILD_ID} for immediate testing...`);
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, process.env.DISCORD_GUILD_ID),
        { body: commands }
      );
      console.log(`Successfully registered ${commands.length} guild commands!`);
    }
    
    console.log(`Successfully registered ${commands.length} application commands!`);
  } catch (error) {
    console.error('Error registering commands:', error);
  }
  
  // Restore persistent panel if it exists
  // #region agent log
  DEBUG_LOG('index.js:2971', 'Checking panel restoration on startup', {
    hypothesisId: 'F',
    hasMessageId: !!panelData.messageId,
    hasChannelId: !!panelData.channelId,
    messageId: panelData.messageId,
    channelId: panelData.channelId
  });
  // #endregion
  if (panelData.messageId && panelData.channelId) {
    console.log('Attempting to restore persistent panel...');
    try {
      let channel = client.channels.cache.get(panelData.channelId);
      // If not in cache, try to fetch it
      if (!channel) {
        try {
          channel = await client.channels.fetch(panelData.channelId);
        } catch (fetchError) {
          console.error('Failed to fetch channel for panel restoration:', fetchError);
          channel = null;
        }
      }
      if (channel) {
        // #region agent log
        DEBUG_LOG('index.js:2990', 'Calling updatePanel for restoration', {
          hypothesisId: 'F',
          channelId: panelData.channelId
        });
        // #endregion
        await updatePanel(null, channel);
        // #region agent log
        DEBUG_LOG('index.js:2996', 'Panel restoration completed', { hypothesisId: 'F' });
        // #endregion
        console.log('✅ Persistent panel restored');
      } else {
        // #region agent log
        DEBUG_LOG('index.js:3000', 'Panel channel not found on startup', {
          hypothesisId: 'F',
          channelId: panelData.channelId
        });
        // #endregion
        console.log('Could not find panel channel, will create new panel on next /panel command');
      }
    } catch (error) {
      // #region agent log
      DEBUG_LOG('index.js:3008', 'Panel restoration error', {
        hypothesisId: 'F',
        error: error.message,
        code: error.code
      });
      // #endregion
      console.error('Error restoring panel:', error);
    }
  } else {
    // #region agent log
    DEBUG_LOG('index.js:3007', 'No panel data to restore', {
      hypothesisId: 'F',
      hasMessageId: !!panelData.messageId,
      hasChannelId: !!panelData.channelId
    });
    // #endregion
  }
  
  // Set up periodic panel refresh (every 3 seconds)
  setInterval(async () => {
    // #region agent log
    DEBUG_LOG('index.js:3015', 'Periodic refresh tick', {
      hypothesisId: 'E',
      hasChannelId: !!panelData.channelId,
      channelId: panelData.channelId,
      hasMessageId: !!panelData.messageId
    });
    // #endregion
    // Refresh if we have a message, or try to recreate if we have a channel but no message
    if (panelData.channelId) {
      try {
        await updatePanel();
        // #region agent log
        DEBUG_LOG('index.js:3024', 'Periodic refresh completed', { hypothesisId: 'E' });
        // #endregion
      } catch (error) {
        // #region agent log
        DEBUG_LOG('index.js:3027', 'Periodic refresh error', {
          hypothesisId: 'E',
          error: error.message,
          code: error.code
        });
        // #endregion
        // Log error but don't spam - updatePanel handles most errors internally
        const isMessageDeleted = error.code === 10008 || 
                                 error.message?.includes('Unknown Message');
        if (!isMessageDeleted) {
          console.error('Error in periodic panel refresh:', error.message);
        }
      }
    } else {
      // #region agent log
      DEBUG_LOG('index.js:3039', 'Periodic refresh skipped - no channelId', {
        hypothesisId: 'E'
      });
      // #endregion
    }
  }, 3000); // 3 seconds
  
  // Start self-destruct timer polling
  startSelfDestructPolling();
});

/**
 * CONSOLIDATED INTERACTION HANDLER
 * 
 * This single handler replaces 5 separate client.on('interactionCreate') handlers
 * that were previously scattered throughout the code. Consolidation improves
 * maintainability and reduces code duplication while preserving all functionality.
 * 
 * Handler responsibilities:
 * 1. Autocomplete interactions (city selection for /create command)
 * 2. Slash command execution (all bot commands)
 * 3. String select menu interactions (server selection dropdowns)
 * 
 * IMPORTANT: This handler maintains exact same functionality as before.
 * All Vultr OpenAPI interactions remain unchanged.
 */
client.on('interactionCreate', async interaction => {
  
  // =============================================================================
  // AUTOCOMPLETE HANDLER - Handles autocomplete for various commands
  // =============================================================================
  if (interaction.isAutocomplete()) {
    const focusedOption = interaction.options.getFocused(true);
    
    try {
      // Handle city autocomplete for /create and /restore commands
      if ((interaction.commandName === 'create' || interaction.commandName === 'restore') && 
          focusedOption.name === 'city') {
        const focusedValue = focusedOption.value;
        const groupedRegions = await getGroupedRegions(vultr);
        
        // Flatten all cities and filter based on user input
        const cities = Object.values(groupedRegions)
          .flatMap(countries => Object.values(countries))
          .flat()
          .filter(city => 
            city.city.toLowerCase().includes(focusedValue.toLowerCase()) ||
            city.id.toLowerCase().includes(focusedValue.toLowerCase())
          )
          .map(city => ({
            name: `${city.city} (${city.id.toUpperCase()})`,
            value: city.id
          }))
          .slice(0, 25); // Discord API limit is 25 autocomplete choices

        return await interaction.respond(cities);
      }
      
      // Handle server autocomplete for /snapshot command
      if (interaction.commandName === 'snapshot' && focusedOption.name === 'server') {
        const focusedValue = focusedOption.value;
        const runningInstances = await listInstances();
        const runningServers = runningInstances.filter(instance => 
          instance.power_status === 'running'
        );
        
        const servers = runningServers
          .filter(instance => {
            const label = instance.label || 'Unnamed Server';
            return label.toLowerCase().includes(focusedValue.toLowerCase()) ||
                   instance.id.toLowerCase().includes(focusedValue.toLowerCase());
          })
          .map(instance => ({
            name: `${instance.label || 'Unnamed Server'} (${instance.region})`,
            value: instance.id
          }))
          .slice(0, 25);

        return await interaction.respond(servers);
      }
      
      // Handle snapshot autocomplete for /restore command
      if (interaction.commandName === 'restore' && focusedOption.name === 'snapshot') {
        const focusedValue = focusedOption.value;
        const publicSnapshots = await getPublicSnapshots();
        
        const snapshots = publicSnapshots
          .filter(snapshot => {
            const cleanName = getCleanSnapshotName(snapshot);
            return cleanName.toLowerCase().includes(focusedValue.toLowerCase()) ||
                   snapshot.id.toLowerCase().includes(focusedValue.toLowerCase());
          })
          .map(snapshot => ({
            name: `${getCleanSnapshotName(snapshot)} (${snapshot.status})`,
            value: snapshot.id
          }))
          .slice(0, 25);

        return await interaction.respond(snapshots);
      }
      
    } catch (error) {
      console.error('Error handling autocomplete:', error);
      await interaction.respond([]); // Return empty array on error
    }
    
    return; // Exit early for autocomplete interactions
  }
  
  // =============================================================================
  // SLASH COMMAND HANDLER - Executes all bot commands (/list, /status, /create, etc.)
  // =============================================================================
  if (interaction.isCommand()) {
    const command = client.commands.get(interaction.commandName);
    
    // Check if the command exists in our registered commands
    if (!command) {
      console.error(`Command ${interaction.commandName} not found`);
      return interaction.reply({
        content: 'Sorry, this command is not available.',
        flags: MessageFlags.Ephemeral
      });
    }
    
    // Defer reply immediately to get 15-minute response window
    // This MUST happen within 3 seconds of receiving the interaction
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
      }
    } catch (error) {
      if (error.code === 10062) { // Unknown interaction (expired)
        console.log(`Slash command ${interaction.commandName} expired before deferReply; skipping.`);
        return;
      }
      throw error;
    }
    
    // Store original editReply for deferred reply cleanup
    const originalEditReply = interaction.editReply;
    
    // Wrap interaction to make all editReply calls use temporary auto-deleting follow-ups
    const cleanup = wrapInteractionForAutoDelete(interaction);
    
    try {
      // Execute the command - this calls the execute() function in each command object
      await command.execute(interaction);
      
      // Edit deferred reply to minimal placeholder after command completes
      // This prevents the placeholder from cluttering the channel
      // Use original editReply since we want to edit the deferred message, not send a follow-up
      try {
        await originalEditReply.call(interaction, { content: 'Processing...', flags: MessageFlags.SuppressEmbeds });
      } catch (error) {
        // Ignore errors editing the placeholder - it's not critical
        if (error.code !== 10008) {
          console.log('Could not edit deferred reply placeholder:', error.message);
        }
      }
    } catch (error) {
      console.error(`Error executing command ${interaction.commandName}:`, error);
      
      // Handle error response using auto-delete follow-up
      try {
        await sendAutoCleanupFollowUp(interaction, 'There was an error while executing this command.');
      } catch (followUpError) {
        // Fallback to ephemeral reply if follow-up fails
        const replyMethod = interaction.replied || interaction.deferred
          ? interaction.followUp
          : interaction.reply;
        
        replyMethod.call(interaction, {
          content: 'There was an error while executing this command.',
          flags: MessageFlags.Ephemeral
        }).catch(console.error);
      }
    } finally {
      // Always restore original editReply
      cleanup();
    }
    return; // Exit early for command interactions
  }
  
  // =============================================================================
  // STRING SELECT MENU HANDLER - Handles dropdown selections for server management
  // =============================================================================
  if (interaction.isStringSelectMenu()) {
    // Handle different select menu types using switch statement for clarity
    switch (interaction.customId) {
      
      // Server status checking - triggered by /status command
      case 'select_server':
        try {
          await interaction.deferUpdate();
        } catch (error) {
          if (error.code === 10062) { console.log('select_server interaction expired'); return; }
          throw error;
        }
        const selectedId = interaction.values[0]; // Get the selected server ID

        try {
          // Get server details from Vultr API (respects EXCLUDE_SNAPSHOT_ID)
          const instance = await getInstance(selectedId);
          if (!instance) {
            return interaction.editReply({
              content: '❌ This server is not available for management.',
              components: [] // Remove the select menu
            });
          }
          
          // Get our internal tracking data for the server
          const trackedInstance = instanceState.getInstance(selectedId);
          
          // Format server details for Discord display
          const formattedStatus = formatInstanceDetails(trackedInstance, instance);
          return interaction.editReply({
            content: formattedStatus,
            components: [] // Remove the select menu after selection
          });
        } catch (error) {
          console.error('Error handling server selection:', error);
          return interaction.editReply({
            content: '❌ There was an error getting the server status.',
            components: [] // Remove the select menu on error
          });
        }

      // Server starting - triggered by /start command
      case 'start_server':
        try {
          await interaction.deferUpdate();
        } catch (error) {
          if (error.code === 10062) { console.log('start_server interaction expired'); return; }
          throw error;
        }
        const startServerId = interaction.values[0];
        // Call the existing startInstance function (unchanged Vultr OpenAPI calls)
        await startInstance(interaction, startServerId);
        break;

      // Server stopping - triggered by /stop command  
      case 'stop_server':
        try {
          await interaction.deferUpdate();
        } catch (error) {
          if (error.code === 10062) { console.log('stop_server interaction expired'); return; }
          throw error;
        }
        const stopServerId = interaction.values[0];
        // Call the existing stopInstance function (unchanged Vultr OpenAPI calls)
        await stopInstance(interaction, stopServerId);
        break;

      // Server restart - triggered by /restart command or panel button
      case 'restart_server':
        try {
          await interaction.deferUpdate();
        } catch (error) {
          if (error.code === 10062) { console.log('restart_server interaction expired'); return; }
          throw error;
        }
        const restartServerId = interaction.values[0];
        
        try {
          // Get instance details
          const instance = await getInstance(restartServerId);
          if (!instance) {
            return interaction.editReply({
              content: '❌ This server is not available for management.',
              components: []
            });
          }
          
          const serverName = instance.label || 'Unnamed Server';
          
          // Show confirmation with button
          const confirmRow = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`confirm_restart_${restartServerId}`)
                .setLabel('✅ Confirm Restart')
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId('cancel_restart')
                .setLabel('❌ Cancel')
                .setStyle(ButtonStyle.Secondary)
            );
          
          return interaction.editReply({
            content: `⚠️ **Confirm Restart**\n\nAre you sure you want to restart "${serverName}"?`,
            components: [confirmRow]
          });
        } catch (error) {
          console.error('Error handling restart selection:', error);
          return interaction.editReply({
            content: '❌ There was an error processing the restart request.',
            components: []
          });
        }

      // Server destruction - triggered by /destroy command
      // This is the most complex handler as it includes cost calculation
      case 'destroy_server':
        // Safely defer; if the interaction has already expired (Unknown Interaction 10062),
        // just bail out quietly instead of crashing the bot.
        try {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate();
          }
        } catch (error) {
          if (error.code === 10062) {
            console.log('Destroy select expired before deferUpdate; skipping handler.');
            return;
          }
          throw error;
        }
        const destroyId = interaction.values[0];

        try {
          // SELF-PROTECTION: Block destruction of current server for EVERYONE (including admins)
          const isCurrent = await isCurrentServer(destroyId);
          if (isCurrent) {
            return interaction.editReply({
              content: '❌ Cannot destroy bot server - self-protection enabled.\nThis server is running the Discord bot and cannot be destroyed.',
              components: [] // Remove the select menu
            });
          }
          
          // Get instance details before destroying (needed for cost calculation)
          const instance = await getInstance(destroyId);
          if (!instance) {
            return interaction.editReply({
              content: '❌ This server is not available for management.',
              components: [] // Remove the select menu
            });
          }
          
          // Extract server information for cost calculation and display
          const serverName = instance.label || 'Unnamed Server';
          
          // Calculate cost using helper function
          const formattedCost = await calculateInstanceCost(instance);
          
          // Show initial destruction message
          await interaction.editReply({
            content: `🔄 Attempting to destroy server "${serverName}"...\n` +
                    `📊 Checking if Vultr allows deletion...\n` +
                    `💡 Some processes (like snapshots) may prevent immediate deletion`,
            components: [] // Remove the select menu
          });

          try {
            // Attempt to destroy the instance using exact OpenAPI spec method
            await vultr.instances.deleteInstance({
              "instance-id": destroyId
            });
            
            console.log(`Destruction request sent for instance ${destroyId}`);
            
            // Clear timer before destruction
            const trackedInstance = instanceState.getInstance(destroyId);
            if (trackedInstance?.selfDestructTimer) {
              instanceState.updateInstance(destroyId, trackedInstance.status, {
                selfDestructTimer: null
              });
            }
            
            // Start polling to confirm destruction
            startInstanceDestructionPolling(destroyId, serverName, formattedCost, interaction);
            
          } catch (deleteError) {
            console.error('Error sending destruction request:', deleteError);
            
            // Handle specific errors
            if (deleteError.response && deleteError.response.status === 400) {
              return interaction.editReply(
                `❌ Cannot destroy server "${serverName}" right now.\n` +
                `📊 Vultr is preventing deletion (likely due to active processes)\n` +
                `💡 Common causes: Active snapshots, backups, or billing issues\n` +
                `🕒 Try again in a few minutes\n` +
                `💰 Estimated cost so far: ${formattedCost}`
              );
            } else {
              return interaction.editReply(
                `❌ Error destroying server "${serverName}".\n` +
                `📊 API Error: ${deleteError.message || 'Unknown error'}\n` +
                `💰 Estimated cost so far: ${formattedCost}`
              );
            }
          }
        } catch (error) {
          console.error('Error destroying server:', error);
          return interaction.editReply({
            content: '❌ There was an error destroying the server.',
            components: [] // Remove the select menu on error
          });
        }
        break;
        
      // Insert coin - triggered by btn_insert_coin button
      case 'insert_coin_server':
        try {
          await interaction.deferUpdate();
        } catch (error) {
          if (error.code === 10062) { console.log('insert_coin_server interaction expired'); return; }
          throw error;
        }
        const coinInstanceId = interaction.values[0];
        
        try {
          const trackedInstance = instanceState.getInstance(coinInstanceId);
          if (!trackedInstance || !trackedInstance.selfDestructTimer) {
            return interaction.editReply({
              content: '❌ This server does not have an active timer.',
              components: []
            });
          }
          
          const timer = trackedInstance.selfDestructTimer;
          const newExpiresAt = timer.expiresAt + (SELF_DESTRUCT_COIN_MINUTES * 60 * 1000);
          
          // Update timer
          timer.expiresAt = newExpiresAt;
          timer.extendedCount = (timer.extendedCount || 0) + 1;
          
          instanceState.updateInstance(coinInstanceId, trackedInstance.status, {
            selfDestructTimer: timer
          });
          
          const timeStr = formatRemainingTime(newExpiresAt);
          const serverName = trackedInstance.name || 'Unnamed Server';
          
          await interaction.editReply({
            content: `💰 **Coin Inserted!**\n\n` +
              `Server "${serverName}" timer extended by ${SELF_DESTRUCT_COIN_MINUTES} minutes.\n` +
              `⏰💣 New time remaining: ${timeStr}`,
            components: []
          });
          
          // Update panel
          setTimeout(() => updatePanel(), 1000);
          
        } catch (error) {
          console.error('Error handling insert coin:', error);
          return interaction.editReply({
            content: '❌ There was an error inserting the coin.',
            components: []
          });
        }
        break;
        
      // If we receive an unknown select menu ID, log it for debugging
      default:
        console.error(`Unknown select menu interaction: ${interaction.customId}`);
        break;
    }
    return; // Exit early for select menu interactions
  }
  
  // =============================================================================
  // BUTTON HANDLER - Handles button clicks from the control panel
  // =============================================================================
  if (interaction.isButton()) {
    // Handle modal-triggering buttons differently
    if (interaction.customId === 'btn_create_modal' || interaction.customId === 'btn_restore_modal') {
      // Don't defer for modal buttons - wrap entire block in try-catch
      try {
        if (interaction.customId === 'btn_create_modal') {
          // Create modal for server creation
          const modal = new ModalBuilder()
            .setCustomId('create_server_modal')
            .setTitle('Create New Server');
          
          const nameInput = new TextInputBuilder()
            .setCustomId('server_name')
            .setLabel('Server Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(`${interaction.user.username}'s Server`)
            .setRequired(false)
            .setMaxLength(50);
          
          const cityInput = new TextInputBuilder()
            .setCustomId('server_city')
            .setLabel('City/Region (e.g., dfw, mia, sea)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('dfw')
            .setValue('dfw')
            .setRequired(false)
            .setMaxLength(10);
          
          const row1 = new ActionRowBuilder().addComponents(nameInput);
          const row2 = new ActionRowBuilder().addComponents(cityInput);
          
          modal.addComponents(row1, row2);
          await interaction.showModal(modal);
          return;
        }
        
        if (interaction.customId === 'btn_restore_modal') {
          // Get available snapshots first
          const publicSnapshots = await getPublicSnapshots();
          
          if (!publicSnapshots.length) {
            await interaction.reply({
              content: '❌ No snapshots available for restore.',
              flags: MessageFlags.Ephemeral
            });
            return;
          }
          
          // Create modal for restore
          const modal = new ModalBuilder()
            .setCustomId('restore_server_modal')
            .setTitle('Restore Server from Snapshot');
          
          const snapshotInput = new TextInputBuilder()
            .setCustomId('snapshot_id')
            .setLabel('Snapshot ID (or leave empty for latest)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(publicSnapshots[0].id)
            .setRequired(false);
          
          const nameInput = new TextInputBuilder()
            .setCustomId('server_name')
            .setLabel('Server Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(`${interaction.user.username}'s Restored Server`)
            .setRequired(false)
            .setMaxLength(50);
          
          const cityInput = new TextInputBuilder()
            .setCustomId('server_city')
            .setLabel('City/Region (e.g., dfw, mia, sea)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('dfw')
            .setValue('dfw')
            .setRequired(false)
            .setMaxLength(10);
          
          const row1 = new ActionRowBuilder().addComponents(snapshotInput);
          const row2 = new ActionRowBuilder().addComponents(nameInput);
          const row3 = new ActionRowBuilder().addComponents(cityInput);
          
          modal.addComponents(row1, row2, row3);
          await interaction.showModal(modal);
          return;
        }
      } catch (error) {
        if (error.code === 10062) {
          console.log('Modal button interaction expired');
          return;
        }
        console.error('Error showing modal:', error);
        return;
      }
    }
    
    // Defer for non-modal buttons
    try {
      await interaction.deferReply();
    } catch (error) {
      // Interaction may have expired or already been responded to
      if (error.code === 10062) {
        console.log(`Interaction ${interaction.id} expired or already handled`);
        return;
      }
      throw error; // Re-throw other errors
    }
    
    // Handle restart confirmation buttons (check before switch)
    if (interaction.customId.startsWith('confirm_restart_')) {
      const confirmRestartId = interaction.customId.replace('confirm_restart_', '');
      await restartInstance(interaction, confirmRestartId);
      return;
    }
    
    if (interaction.customId === 'cancel_restart') {
      await interaction.editReply({
        content: '❌ Restart cancelled.',
        components: []
      });
      return;
    }
    
    // Handle coin buttons (from DMs or panel)
    if (interaction.customId.startsWith('coin_')) {
      const coinInstanceId = interaction.customId.replace('coin_', '');
      
      try {
        const trackedInstance = instanceState.getInstance(coinInstanceId);
        if (!trackedInstance || !trackedInstance.selfDestructTimer) {
          return interaction.editReply({
            content: '❌ This server does not have an active timer.'
          });
        }
        
        const timer = trackedInstance.selfDestructTimer;
        const newExpiresAt = timer.expiresAt + (SELF_DESTRUCT_COIN_MINUTES * 60 * 1000);
        
        // Update timer
        timer.expiresAt = newExpiresAt;
        timer.extendedCount = (timer.extendedCount || 0) + 1;
        
        instanceState.updateInstance(coinInstanceId, trackedInstance.status, {
          selfDestructTimer: timer
        });
        
        const timeStr = formatRemainingTime(newExpiresAt);
        const serverName = trackedInstance.name || 'Unnamed Server';
        
        await interaction.editReply({
          content: `💰 **Coin Inserted!**\n\n` +
            `Server "${serverName}" timer extended by ${SELF_DESTRUCT_COIN_MINUTES} minutes.\n` +
            `⏰💣 New time remaining: ${timeStr}`
        });
        
        // Update panel if it exists
        setTimeout(() => updatePanel(), 1000);
        
      } catch (error) {
        console.error('Error handling coin button:', error);
        return interaction.editReply({
          content: '❌ There was an error inserting the coin.'
        }).catch(() => {}); // Ignore errors if interaction already expired
      }
      return;
    }
    
    // Handle regular button clicks
    switch (interaction.customId) {
      case 'btn_list':
        await executeListFromPanel(interaction);
        break;
        
      case 'btn_start':
        await executeStartFromPanel(interaction);
        break;
        
      case 'btn_destroy':
        await executeDestroyFromPanel(interaction);
        break;
        
      case 'btn_restart':
        await executeRestartFromPanel(interaction);
        break;
        
      case 'btn_insert_coin':
        // Show select menu for server to insert coin
        try {
          const vultrInstances = await listInstances();
          const activeInstances = vultrInstances.filter(instance => 
            instance.status !== 'destroyed' && instance.power_status !== 'destroyed'
          );
          
          if (!activeInstances?.length) {
            return interaction.editReply('No active servers found.');
          }
          
          // Filter to only servers with timers
          const instancesWithTimers = activeInstances.filter(instance => {
            const tracked = instanceState.getInstance(instance.id);
            return tracked?.selfDestructTimer;
          });
          
          if (!instancesWithTimers.length) {
            return interaction.editReply('No servers with active timers found.');
          }
          
          const options = instancesWithTimers.map(instance => {
            const tracked = instanceState.getInstance(instance.id);
            const timer = tracked.selfDestructTimer;
            const timeStr = formatRemainingTime(timer.expiresAt);
            return {
              label: instance.label || 'Unnamed Server',
              description: `Time remaining: ${timeStr}`,
              value: instance.id
            };
          });
          
          const row = new ActionRowBuilder()
            .addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('insert_coin_server')
                .setPlaceholder('Select a server to insert coin')
                .addOptions(options)
            );
          
          return interaction.editReply({
            content: `💰 **Insert Coin**\n\nSelect a server to extend its timer by ${SELF_DESTRUCT_COIN_MINUTES} minutes:`,
            components: [row]
          });
        } catch (error) {
          console.error('Error handling insert coin:', error);
          return interaction.editReply('❌ There was an error processing the insert coin request.');
        }
        
      default:
        // Handle dynamic quick action buttons
        if (interaction.customId.startsWith('btn_quick_')) {
          // Extract region ID from button custom ID
          const regionId = interaction.customId.replace('btn_quick_', '');
          
          // Get city name from Vultr API
          try {
            const groupedRegions = await getGroupedRegions(vultr);
            let cityName = regionId.toUpperCase(); // Fallback to region ID
            
            // Find the city name
            for (const [continent, countries] of Object.entries(groupedRegions)) {
              for (const [country, cities] of Object.entries(countries)) {
                const city = cities.find(c => c.id === regionId);
                if (city) {
                  cityName = city.city;
                  break;
                }
              }
              if (cityName !== regionId.toUpperCase()) break;
            }
            
            const serverName = `${interaction.user.username}'s ${cityName} Server`;
            
            // Use new panel creation system with follow-up messages and DM
            await executeCreateFromPanel(interaction, serverName, regionId, cityName);
          } catch (error) {
            console.error('Error handling quick action button:', error);
            await interaction.editReply('❌ Error processing quick action. Please try again.');
          }
          break;
        }
        
        // If we reach here, it's an unknown button
        console.error(`Unknown button interaction: ${interaction.customId}`);
        return interaction.editReply('❌ Unknown button action.');
    }
    return;
  }
  
  // =============================================================================
  // MODAL SUBMISSION HANDLER - Handles form submissions from modals
  // =============================================================================
  if (interaction.isModalSubmit()) {
    try {
      await interaction.deferReply();
    } catch (error) {
      // Interaction may have expired or already been responded to
      if (error.code === 10062) {
        console.log(`Modal interaction ${interaction.id} expired or already handled`);
        return;
      }
      throw error; // Re-throw other errors
    }
    
    if (interaction.customId === 'create_server_modal') {
      try {
        // Handle create server modal submission
        const serverName = interaction.fields.getTextInputValue('server_name') || 
                          `${interaction.user.username}'s Server`;
        const city = interaction.fields.getTextInputValue('server_city') || 'dfw';
        
        // Set up interaction options for create command
        interaction.options = {
          getString: (name) => {
            if (name === 'name') return serverName;
            if (name === 'city') return city;
            return null;
          }
        };
        
        await createCommand.execute(interaction);
        
        // Refresh panel after creation starts
        setTimeout(() => updatePanel(), 5000);
      } catch (error) {
        console.error('Error executing create from modal:', error);
        try {
          await interaction.editReply('❌ Error creating server. Please try again.');
        } catch (e) { /* ignore */ }
      }
    }
    
    if (interaction.customId === 'restore_server_modal') {
      try {
        // Handle restore server modal submission
        const snapshotId = interaction.fields.getTextInputValue('snapshot_id');
        const serverName = interaction.fields.getTextInputValue('server_name') || 
                          `${interaction.user.username}'s Restored Server`;
        const city = interaction.fields.getTextInputValue('server_city') || 'dfw';
        
        // Get available snapshots to validate
        const publicSnapshots = await getPublicSnapshots();
        
        // Use provided snapshot ID or default to latest
        let selectedSnapshotId = snapshotId || (publicSnapshots[0]?.id);
        
        if (!selectedSnapshotId) {
          return interaction.editReply('❌ No snapshots available for restore.');
        }
        
        // Validate snapshot exists
        const snapshot = publicSnapshots.find(s => s.id === selectedSnapshotId);
        if (!snapshot && snapshotId) {
          return interaction.editReply('❌ Invalid snapshot ID. Please check and try again.');
        }
        
        // Set up interaction options for restore command
        interaction.options = {
          getString: (name) => {
            if (name === 'snapshot') return selectedSnapshotId;
            if (name === 'name') return serverName;
            if (name === 'city') return city;
            return null;
          }
        };
        
        await restoreCommand.execute(interaction);
        
        // Refresh panel after restore starts
        setTimeout(() => updatePanel(), 5000);
      } catch (error) {
        console.error('Error executing restore from modal:', error);
        try {
          await interaction.editReply('❌ Error restoring server. Please try again.');
        } catch (e) { /* ignore */ }
      }
    }
    
    return;
  }
  
  // If we reach here, it's an interaction type we don't handle
  console.log(`Unhandled interaction type: ${interaction.type}`);
});

// Log in to Discord with bot token
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('Bot is connecting to Discord...'))
  .catch(error => console.error('Failed to login:', error));