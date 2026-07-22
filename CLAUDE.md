# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dedi Bot Simple is a Discord bot for managing Vultr VPS instances, designed for gaming communities. **Version 2.0** uses a modular ES module architecture in `src/`.

## Common Development Commands

### Running the Bot
- `npm start` - Start the modular bot (`src/index.js`)
- `npm run start:legacy` - Run legacy single-file version (`index.legacy.js`)
- `node src/index.js` - Direct node command for modular version
- `pkill -f "node src/index.js"` - Stop the bot

### Setup and Dependencies
- `npm install` - Install all dependencies
- `cp .env.example .env` - Copy environment template (edit with your credentials)

### No Tests Configured
The project currently has no test framework configured.

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

### Modular ES Module Design (v2.0)
```
src/
├── index.js                    # Entry point, wires all modules
├── config/
│   ├── index.js                # Config loader with dotenv
│   └── constants.js            # Timer defaults, regions, emojis
├── discord/
│   ├── client.js               # Discord client setup
│   ├── commands/               # 10 slash command files
│   │   ├── index.js            # Command registry
│   │   ├── list.js, status.js, start.js, stop.js
│   │   ├── create.js, destroy.js, restart.js
│   │   └── snapshot.js, restore.js, panel.js
│   └── handlers/               # Interaction handlers
│       ├── index.js            # Handler registry
│       ├── autocomplete.js     # City/server/snapshot autocomplete
│       ├── commands.js         # Slash command execution
│       ├── buttons.js          # Button interactions
│       ├── selectMenus.js      # Dropdown selections
│       └── modals.js           # Modal form submissions
├── vultr/
│   ├── client.js               # Vultr SDK initialization
│   └── index.js                # All Vultr API functions
├── state/
│   ├── instanceState.js        # In-memory instance tracking
│   └── panelState.js           # Panel persistence to panel_data.json
├── services/
│   └── notifications.js        # DMs and auto-cleanup follow-ups
└── utils/
    └── formatters.js           # Status emojis, time/cost formatting
```

### Legacy Single-File Version
`index.legacy.js` contains the original monolithic version for rollback.

### Key Components

#### State Management
- Uses in-memory `instanceState` object instead of file-based storage
- Tracks instances, users, creation timestamps, status, and self-destruct timers
- Provides methods for tracking, updating, and querying instances
- Panel data persisted to `panel_data.json` for bot restart recovery

#### Discord Commands
- `/list` - List all active game servers
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

## Documentation Practices

### KNOWN_ISSUES.md Maintenance
When updating `documentation/KNOWN_ISSUES.md`, always:
1. Update the **Last Updated** date at the top of the file
2. Update the **Status** line with a brief summary (e.g., "2 of 7 issues fixed. Critical bugs remain.")
3. Move fixed issues to the **Fixed Issues** section with the fix date
4. Add an entry to the **Changelog** table at the bottom

This ensures the document stays current and provides at-a-glance project health status.

---

## Development Notes

### File Structure
The project uses modular ES module architecture. When making changes:
- Add new commands in `src/discord/commands/` and register in `index.js`
- Add new handlers in `src/discord/handlers/`
- Vultr API functions go in `src/vultr/index.js`
- Shared state in `src/state/`
- Configuration constants in `src/config/constants.js`

### Version History
- **v2.0** (Jan 2026) - Modular ES module refactor in `src/`
- **v1.x** - Single-file versions in `stash/` (`index1.1.6b.js`, etc.)
- **Legacy** - `index.legacy.js` for rollback

### Recent Improvements (January 2026)
- **Modular Architecture** - ES modules with clean separation of concerns
- **Graceful Shutdown** - SIGINT/SIGTERM handlers clean up all timers (fixes memory leak)
- **Timer Cleanup** - All `setInterval` IDs tracked and cleared on shutdown

### Previous Improvements (December 2025)
- **Bulletproof Firewall System** - Retry loop with verification; auto-destroys unprotected instances
- **Self-Destruct Timers** - Automatic server cleanup with "Insert Coin" extension
- **DM Notifications** - Creators receive connection details when servers are ready
- **Safe Interaction Handling** - All defers wrapped to prevent crashes on expired interactions
- **Panel Quick-Create** - 15 optimized gaming regions with one-click server creation

### Previous Improvements (September 2025)
- **Consolidated Interaction Handlers** - Single unified handler
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


---

## AI Development Standards (MANDATORY)

The following rules apply to all AI-generated code in this repository. Claude must follow these constraints exactly when proposing or implementing changes.

### 1. Scope & Change Control
- Do NOT rewrite entire files unless explicitly requested
- Prefer surgical changes over refactors
- Any change affecting more than **120 total lines** must be split into multiple steps
- If a change exceeds this budget, Claude must:
  1. Propose a short plan (≤8 bullets)
  2. Implement only step 1

### 2. File Size & Modularity Rules
- No single file should exceed **300–500 lines**
- Any new feature over ~150 lines must be split into a new module
- Each file must have **one primary responsibility**:
  - Discord interaction logic
  - Vultr API access
  - State/timers
  - UI formatting (embeds, components)
  - Configuration
  - Utilities

**Anti-patterns (NOT allowed):**
- "God files"
- Business logic inside Discord handlers
- Direct Vultr SDK calls from command files
- Shared mutable state defined outside `src/state/`

### 3. Required Folder Ownership

| Folder | Ownership Rules |
|--------|-----------------|
| `src/discord/` | Interaction routing only. No Vultr logic. No timers. |
| `src/vultr/` | All Vultr SDK usage lives here. Exports clean, intention-based functions (e.g. `createInstance`, not raw SDK calls). |
| `src/state/` | Owns all timers and in-memory state. Timer operations must be idempotent. |
| `src/ui/` | Embed builders, buttons, dropdowns, formatting helpers. No API calls, no state mutation. |
| `src/config/` | Only place allowed to read `process.env`. |
| `src/utils/` | Small, reusable helpers only (logging, formatting, async wrappers). |

### 4. Function-Level Standards
- Max **~50 lines** per function
- Prefer early returns
- Avoid deep nesting
- No anonymous mega-callbacks
- Async functions must have clear error boundaries
- If a function name contains "and", it probably needs to be split

### 5. Error Handling Contract
- Vultr/service layers **throw** errors
- Discord layer decides how errors are **presented** to users
- No raw `console.log(error)` in production paths
- Use existing safe wrappers (`safeDefer`, `safeEditReply`, etc.)
- Interaction expiration (10062) and deleted messages (10008) must be handled gracefully

### 6. State & Timer Rules (CRITICAL)
All timers must be **created**, **tracked**, and **cleared** only in `src/state/`.

Timer functions must be safe to call multiple times:
- `scheduleDestroy(id)` → no duplicates
- `cancelDestroy(id)` → safe if none exists

**No `setTimeout` or `setInterval` allowed outside state modules.**

### 7. Configuration Rules
- `process.env` may ONLY be accessed in `src/config/`
- All config must be exported as a single config object
- Required env vars must be validated at startup
- No inline defaults scattered through the codebase

### 8. Vultr Security Invariants (NON-NEGOTIABLE)
Claude must **never** weaken or bypass the following:
- Firewall attachment is **mandatory**
- Firewall verification loop must remain intact
- Instances without confirmed firewall attachment must be **destroyed**
- Exclusion logic (`EXCLUDE_*`) must be checked before all destructive operations

**If a change touches server creation or destruction, Claude must explicitly state how these invariants are preserved.**

### 9. Refactor Protocol (When Requested)
When refactoring existing code, Claude must:
1. Preserve behavior exactly
2. Extract logic into a new module
3. Export named functions only
4. Provide:
   - The new file
   - A minimal patch (5–15 lines) showing how the original file changes
5. Avoid opportunistic cleanup unless explicitly asked

### 10. Output Format Requirements
**Before writing code**, Claude must list:
- Files that will be touched
- Purpose of each change

**After writing code**, Claude must include:
- A short manual test plan (3–5 steps)
- Any assumptions made

### 11. Dependency Policy
- No new dependencies without approval
- Prefer native Node.js or existing utilities
- Avoid "framework creep"

---

## AI Design Philosophy

This project favors:
- **Clarity** over cleverness
- **Explicitness** over magic
- **Small modules** over big abstractions
- **Predictable behavior** over DRY at all costs

Claude should act as a **careful maintainer**, not a rewrite engine.

---

## Claude Self-Check (Lint-Style) — MUST PASS BEFORE OUTPUT

### A. Scope & Output
- [ ] I am not rewriting whole files unless explicitly asked
- [ ] Total net-new code is ≤120 lines, or I proposed a multi-step plan and implemented only Step 1
- [ ] I listed exactly which files I will touch (and why) before coding
- [ ] I included a 3–5 step manual test plan after the code

### B. Architecture Boundaries
- [ ] Discord handlers (`src/discord/**`) contain routing/glue only (no Vultr SDK calls, no timer logic)
- [ ] Vultr SDK usage exists only in `src/vultr/**`
- [ ] Timers (`setTimeout`/`setInterval`) exist only in `src/state/**`
- [ ] UI building (embeds/components/formatting) lives in `src/ui/**` or `src/utils/**` with no side effects
- [ ] `process.env` is accessed only in `src/config/**`

### C. File & Function Size
- [ ] No new file exceeds 200 lines
- [ ] No modified file is pushed beyond ~500 lines without splitting
- [ ] No function exceeds ~50 lines (unless it's a pure embed/component builder)
- [ ] I avoided deep nesting and used early returns

### D. Safety & Invariants (Vultr)
- [ ] Firewall attachment remains mandatory
- [ ] Firewall verification loop remains intact
- [ ] Instances without confirmed firewall are auto-destroyed (no bypass)
- [ ] Exclusions (`EXCLUDE_*`) are checked before destructive operations
- [ ] I explicitly stated how I preserved these invariants if I touched create/destroy flows

### E. State & Timer Correctness
- [ ] Timer operations are idempotent (safe to call twice)
- [ ] All timers are tracked and cleared on shutdown (SIGINT/SIGTERM) via `src/state/**`
- [ ] No shared mutable state is introduced outside `src/state/**`

### F. Error Handling (Discord)
- [ ] Interaction expiration (10062) is handled (safe defer/update)
- [ ] Deleted message edits (10008) are handled (polling stops gracefully)
- [ ] Service layer throws; Discord layer formats user-facing errors
- [ ] No raw `console.log(error)` in main flows; uses logger/util where available

### G. Dependencies & Complexity
- [ ] I did not add dependencies without approval
- [ ] I avoided introducing new frameworks/patterns unless asked
- [ ] I kept the solution minimal and aligned with existing repo conventions

### H. Patch Style
- [ ] I used small, targeted patches (prefer new modules + minimal import/export edits)
- [ ] If refactoring: I preserved behavior exactly and provided a minimal integration patch

---

**Prompt Footer (append to prompts when working on this repo):**

```
Follow CLAUDE.md strictly.
Keep changes minimal.
Do not rewrite files.
Respect module boundaries.
Ask before expanding scope.
```