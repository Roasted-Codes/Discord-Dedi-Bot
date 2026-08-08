# Dedi Bot Simple

A (AI-vibe-coded) Discord bot for managing Vultr VPS instances, designed for gaming communities to easily create, manage, and share game servers.

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
- **Administrative Locks**: Administrators can persistently protect individual instances from ServerBot deletion
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
| `ADMIN_USER_IDS` | Comma-separated Discord user IDs for snapshot and server-lock administration | No |
| `SERVER_LOCKS_FILE` | Override the durable lock registry path (default: `./data/server-locks.json`) | No |
| `SELF_DESTRUCT_INITIAL_MINUTES` | Server lifetime before auto-destroy (default: 180) | No |
| `SELF_DESTRUCT_COIN_MINUTES` | Time added per "Insert Coin" (default: 180) | No |

## Commands

| Command | Description | Options |
|---------|-------------|---------|
| `/panel` | Show persistent control panel with quick-create buttons | None |
| `/list` | List all active game servers | None |
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

## Server Lock Operations

- An ID in `ADMIN_USER_IDS` can open `/panel`, select **Server Locks**, and choose an instance to lock or unlock.
- Locks are keyed by immutable Vultr instance ID and stored at the application-root path `data/server-locks.json` with mode `0600`. `SERVER_LOCKS_FILE` may override this path. Writes are serialized within the single bot process and use an atomic temporary-file rename.
- A lock blocks manual destroy interactions, stale destroy selections, repeated deletion submissions, and automatic self-destruct. Locking also cancels that instance's current self-destruct timer; unlocking does not recreate an expired timer.
- Locked instances are marked with `🔒` in the panel and destroy selectors. Everyone, including administrators, must explicitly unlock an instance before ServerBot can destroy it.
- Startup reconciliation removes stale records only after a successful, complete paginated provider inventory omits an ID and an immediate per-instance request returns `404`. Empty, partial, malformed, failed, or non-`404` checks preserve records.
- A missing registry fails closed and disables guarded deletion. Initialize it once before the first lock-enabled startup:

  ```bash
  install -d -m 700 data
  test -e data/server-locks.json || printf '{"locks":[]}\n' > data/server-locks.json
  chmod 600 data/server-locks.json
  ```

- This is a ServerBot safety control only. It cannot prevent deletion through the Vultr dashboard or another API client.
- The mandatory firewall-attachment rollback for an unsafe newly created instance is the sole intentional lock bypass; ordinary deletion paths remain guarded.
- For rollback, restore the prior application version and restart the bot. The ignored lock registry may be retained for a later redeploy; the prior version will not read it.

## License

MIT
