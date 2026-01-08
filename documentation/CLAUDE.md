# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dedi Bot Simple is a streamlined Discord bot for managing Vultr VPS instances, designed for gaming communities to easily create, manage, and share game servers. The project consolidates all functionality into a single file (`index.js`) for simplicity and ease of debugging.

## Common Development Commands

### Running the Bot
- `npm start` - Start the Discord bot
- `node index.js` - Alternative way to start the bot directly
- `pkill -f "node index.js"` - Stop the bot

### Setup and Dependencies
- `npm install` - Install all dependencies
- `cp .env.example .env` - Copy environment template (edit with your credentials)

### No Tests Configured
The project currently has no test framework configured. The test script in package.json returns an error.

## Environment Configuration

The bot requires environment variables configured in `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Discord bot token from Discord Developer Portal |
| `DISCORD_GUILD_ID` | No | Discord server ID for immediate command testing (avoids 1-hour wait) |
| `VULTR_API_KEY` | Yes | Vultr API key for VPS management |
| `VULTR_FIREWALL_GROUP_ID` | **Yes** | Firewall group ID - MANDATORY for security, servers without firewall are auto-destroyed |
| `VULTR_SNAPSHOT_ID` | No | Specific snapshot ID (defaults to most recent) |
| `VULTR_REGION` | No | Default region for new instances (default: dfw) |
| `VULTR_PLAN` | No | Default instance plan (default: vc2-1c-1gb) |
| `EXCLUDE_SNAPSHOT_ID` | No | Snapshot ID to exclude from bot management |
| `EXCLUDE_INSTANCE_ID` | No | Fallback instance ID exclusion if metadata unavailable |
| `ADMIN_USER_IDS` | No | Comma-separated Discord user IDs for snapshot creation |
| `VULTR_PUBLIC_SNAPSHOTS` | No | Legacy comma-separated snapshot IDs (now auto-detected via [PUBLIC] prefix) |
| `SELF_DESTRUCT_INITIAL_MINUTES` | No | Initial timer for auto-destroy (default: 150 = 2.5 hours) |
| `SELF_DESTRUCT_COIN_MINUTES` | No | Time added per "Insert Coin" (default: 30 minutes) |

## Code Architecture

### Single-File Design
All functionality is consolidated in `index.js` with clear section headers:
- **CONFIGURATION AND SETUP** - Environment setup and client initialization
- **IN-MEMORY STATE MANAGEMENT** - Simple tracking without file persistence
- **SELF-DESTRUCT TIMER CONFIGURATION** - Automatic server cleanup timers
- **PERSISTENT PANEL MANAGEMENT** - Control panel that survives bot restarts
- **VULTR API FUNCTIONS** - All Vultr cloud API interactions
- **UTILITY FUNCTIONS** - Formatting and helper functions
- **COMMAND DEFINITIONS** - Discord slash commands
- **EVENT HANDLERS** - Consolidated interaction handler for all Discord events

### Key Components

#### State Management
- Uses in-memory `instanceState` object instead of file-based storage
- Tracks instances, users, creation timestamps, status, and self-destruct timers
- Provides methods for tracking, updating, and querying instances
- Panel data persisted to `panel_data.json` for bot restart recovery

#### Discord Commands
- `/list` - List all active game servers
- `/status` - Check server status via dropdown selection
- `/create` - Create new server with optional name and city selection (autocomplete)
- `/start` - Start stopped servers via dropdown selection
- `/stop` - Stop running servers via dropdown selection
- `/destroy` - Destroy servers and calculate costs
- `/restart` - Restart servers with confirmation
- `/snapshot` - Create snapshots from running instances (admin only)
- `/restore` - Create server from a public snapshot
- `/panel` - Show persistent control panel with quick-create buttons

#### Control Panel System
- Persistent panel with server list, timers, costs, and quick actions
- Quick-create buttons for 15 optimized gaming regions (CONUS, Canada, Europe)
- Auto-refreshes every 5 minutes and on server state changes
- Follow-up messages auto-delete after 30 seconds to keep channel clean
- DMs sent to creators when servers are ready with connection details

#### Self-Destruct Timer System
- Servers get automatic countdown timer when they become "running"
- Default: 2.5 hours initial time, +30 minutes per "Insert Coin"
- Warnings sent via DM at 10 minutes and 5 minutes remaining
- Server auto-destroyed when timer expires
- Timer displayed in panel as `⏰💣 HH:MM:SS`

#### Vultr Integration
- Uses `@vultr/vultr-node` SDK for API interactions
- **Bulletproof Firewall Verification**: Up to 10 retry attempts with verification after each
- Unprotected instances are automatically destroyed if firewall fails to attach
- DDOS protection enabled on all new instances
- Automatic status polling for new server creation (45-second intervals)
- Destruction polling with graceful handling of auto-deleted messages

### Important Implementation Details

#### Server Creation Flow
1. User clicks quick-create button or uses `/create` command
2. Instance created from snapshot via Vultr API
3. **Firewall attached with verification** (up to 10 retries, auto-destroy on failure)
4. DDOS protection enabled
5. Status polling begins (45-second intervals, 30-minute max)
6. DM sent to creator when server is ready with connection URLs
7. Self-destruct timer initialized
8. Panel auto-refreshes to show new server

#### Security Features
- **Automatic Self-Protection** - Bot detects current server via Vultr metadata service (`http://169.254.169.254/v1/instanceid`)
- **Mandatory Firewall** - `VULTR_FIREWALL_GROUP_ID` required; instances auto-destroyed if firewall fails
- **Firewall Verification Loop** - API call + 3-second wait + fetch instance to verify attachment
- `EXCLUDE_SNAPSHOT_ID` and `EXCLUDE_INSTANCE_ID` provide additional exclusion options
- All Vultr API calls check for excluded instances before operations
- Admin-only snapshot creation with `ADMIN_USER_IDS` configuration

#### Error Handling
- **Safe Defer Wrappers** - All `deferReply`/`deferUpdate` wrapped to handle expired interactions (10062)
- **Safe Edit Reply** - Polling functions gracefully stop when messages are auto-deleted (10008)
- Comprehensive error handling for all Vultr API calls
- Clear error messages to users with actionable guidance

## Dependencies

### Core Dependencies
- `discord.js` v14.18.0 - Discord bot framework
- `@vultr/vultr-node` v2.8.0 - Vultr API SDK
- `dotenv` v16.4.7 - Environment variable management

### Key APIs Used
- Discord Bot API - For slash commands and interactive components
- Vultr API - For VPS instance management, snapshots, regions, and billing

## Development Notes

### File Structure
The project intentionally uses a single-file architecture for simplicity. When making changes:
- Follow the existing section organization
- Use the clear section headers for navigation
- Maintain the in-memory state approach
- Preserve the comprehensive error handling patterns

### Version History
Multiple versions exist (`index1.1.6b.js`, `index1.1.6c.js`, etc.) showing feature evolution. The current `index.js` is the production version.

### Recent Improvements (December 2025)
- **Bulletproof Firewall System** - Retry loop with verification; auto-destroys unprotected instances
- **Self-Destruct Timers** - Automatic server cleanup with "Insert Coin" extension
- **DM Notifications** - Creators receive connection details when servers are ready
- **Safe Interaction Handling** - All defers wrapped to prevent crashes on expired interactions
- **Panel Quick-Create** - 15 optimized gaming regions with one-click server creation
- **Destruction Polling** - Graceful handling of message deletion during polling

### Previous Improvements (September 2025)
- **Consolidated Interaction Handlers** - Reduced from 5 separate handlers to 1 unified handler
- **Simplified Status Logic** - Clean object map replacing if/else chains
- **Modernized Syntax** - Updated null checks and array handling
- **Enhanced Self-Protection** - Automatic current server detection via Vultr metadata
- **Dynamic Snapshot Management** - Auto-detection of public snapshots via [PUBLIC] prefix

### Discord Interaction Patterns
The bot uses modern Discord.js patterns:
- Slash commands with builders and autocomplete
- Interactive components (buttons, select menus, modals)
- **Safe deferred replies** - All `deferReply`/`deferUpdate` wrapped with try-catch for 10062 errors
- **Safe edit reply** - Polling functions use `safeEditReply` wrapper for 10008 errors
- Ephemeral responses for errors
- Auto-cleanup follow-up messages (30-second default)

### Vultr API Usage
- Follows OpenAPI specifications exactly
- Uses `@vultr/vultr-node` SDK methods matching API docs
- **Firewall verification**: `vultr.instances.updateInstance()` + fetch to verify
- Includes billing calculations based on plan costs and uptime (730 hours/month)

### Critical Code Patterns

#### Switch Statement Cases
All `case` blocks in the select menu handler MUST end with `break;` to prevent fallthrough crashes.

#### Polling Functions
Both `startInstanceStatusPolling` and `startInstanceDestructionPolling` must use `safeEditReply` wrapper:
```javascript
const safeEditReply = async (content) => {
  try {
    return await interaction.editReply(content);
  } catch (error) {
    if (error.code === 10008) return null; // Message deleted
    throw error;
  }
};
```

#### Defer Handling
All interaction handlers must wrap defer calls:
```javascript
try {
  await interaction.deferUpdate();
} catch (error) {
  if (error.code === 10062) return; // Interaction expired
  throw error;
}
```