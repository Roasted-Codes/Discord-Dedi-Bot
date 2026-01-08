# Dedi Bot Simple

A streamlined Discord bot for managing Vultr VPS instances, designed for gaming communities to easily create, manage, and share game servers.

## Overview

This is a simplified version of the original Dedi Bot, redesigned to be:
- **Easy to understand**: All code in a single file with clear section headers
- **Simple to maintain**: No complex file structure or abstractions
- **Straightforward to debug**: Clear error messages and simplified logic

## Features

- **Create Game Servers**: Quickly spin up new servers from snapshots
- **Manage Instances**: Start, stop, restart, and destroy servers using friendly dropdown menus
- **Control Panel**: Persistent panel with quick-create buttons for 15 optimized gaming regions
- **Self-Destruct Timers**: Servers auto-destroy after configurable time; extend with "Insert Coin"
- **DM Notifications**: Creators receive connection details when servers are ready
- **Bulletproof Security**: Mandatory firewall with verification; unprotected instances auto-destroyed
- **User Tracking**: Automatically associates servers with their Discord creators
- **Self-Protection**: Bot auto-detects and excludes itself from management operations

## Installation

1. **Clone the repository**

```bash
git clone <repository-url>
cd dedi-bot-simple
```

2. **Install dependencies**

```bash
npm install
```

3. **Set up environment variables**

Copy the example environment file and edit it with your credentials:

```bash
cp .env.example .env
# Then edit .env with your Discord token and Vultr API key
```

4. **Start the bot**

```bash
npm start
```

## Environment Variables

Edit the `.env` file with your credentials:

| Variable | Description | Required |
|----------|-------------|----------|
| `DISCORD_TOKEN` | Your Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications) | Yes |
| `VULTR_API_KEY` | Your Vultr API key from [Vultr Account](https://my.vultr.com/settings/#settingsapi) | Yes |
| `VULTR_FIREWALL_GROUP_ID` | Firewall group UUID - servers without firewall are auto-destroyed | **Yes** |
| `VULTR_SNAPSHOT_ID` | ID of the snapshot to use (defaults to most recent) | No |
| `VULTR_REGION` | Region code for new instances (default: dfw) | No |
| `VULTR_PLAN` | Instance plan for new instances (default: vc2-1c-1gb) | No |
| `DISCORD_GUILD_ID` | Your server ID for immediate command registration | No |
| `ADMIN_USER_IDS` | Comma-separated Discord user IDs for snapshot creation | No |
| `SELF_DESTRUCT_INITIAL_MINUTES` | Server lifetime before auto-destroy (default: 180) | No |
| `SELF_DESTRUCT_COIN_MINUTES` | Time added per "Insert Coin" (default: 180) | No |

## Commands

| Command | Description | Options |
|---------|-------------|---------|
| `/panel` | Show persistent control panel with quick-create buttons | None |
| `/list` | List all active game servers | None |
| `/status` | Check status of a server | Shows dropdown of available servers |
| `/create` | Create a new server from snapshot | `name`, `city` (optional) |
| `/start` | Start a stopped server | Shows dropdown of stopped servers |
| `/stop` | Stop a running server | Shows dropdown of running servers |
| `/restart` | Restart a server | Shows dropdown with confirmation |
| `/destroy` | Destroy a server and show cost | Shows dropdown with confirmation |
| `/snapshot` | Create snapshot from running instance (admin only) | `server`, `name`, `public` |
| `/restore` | Create server from a public snapshot | `snapshot`, `name`, `city` |

## Differences from Original Version

This simplified version:

1. **Consolidates all code into a single file** for easier understanding and debugging
2. **Uses in-memory state** instead of file-based storage for simplicity
3. **Reduces the command set** to focus on core functionality
4. **Simplifies error handling** while maintaining robust operation
5. **Removes complex abstractions** like the separate wrapper for the Vultr API

## Understanding The Code

The code is organized into clearly labeled sections:

```
// ================ CONFIGURATION AND SETUP ================
// ================ IN-MEMORY STATE MANAGEMENT ================
// ================ VULTR API FUNCTIONS ================
// ================ UTILITY FUNCTIONS ================
// ================ COMMAND DEFINITIONS ================
// ================ EVENT HANDLERS ================
// ================ START THE BOT ================
```

This makes it easy to locate specific functionality when debugging or making changes.

## How to Use

1. **Invite the bot** to your Discord server using the OAuth2 URL from the Discord Developer Portal.
2. **Set up the control panel** using `/panel` - this creates a persistent panel with quick-create buttons.
3. **Create a server** by clicking a region button on the panel, or use `/create` command.
4. **Wait for DM** - you'll receive connection details (IP, remote desktop URL) when the server is ready.
5. **Monitor the timer** - servers auto-destroy after 3 hours; click "Insert Coin" to add 3 more hours.
6. **Destroy when done** - use `/destroy` or the panel button to delete your server and see the cost.

## License

MIT
