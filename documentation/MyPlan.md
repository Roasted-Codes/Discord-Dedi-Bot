# Practical Code Audit: Dedi-Bot

**Date**: December 18, 2025
**Code Size**: 3,722 lines in index.js
**Dependencies**: discord.js v14.18.0, @vultr/vultr-node v2.8.0, dotenv v16.4.7

**Overall Assessment**: Your bot is solid and well-designed. There are 3 critical bugs that will break in production, plus some high-priority issues to fix. The single-file architecture is fine—don't let anyone tell you otherwise.

---

## CRITICAL BUGS (Fix This Week)

### 🔴 Bug #1: Memory Leak Will Crash Your Bot

**Problem**: Your timers never get cleaned up. After running for ~2 weeks with active servers, your bot will run out of memory and crash.

**Location**: [index.js:1794](index.js#L1794)

**The Issue**:
```javascript
// Line 1794 - This runs FOREVER with no way to stop it
setInterval(checkTimers, 30000);

// Lines 1450-1470 - These create new timers on every call
setTimeout(pollStatus, 45000);  // Creates new timer each recursion
```

If you have 100 servers, that's 100+ timers polling every 30 seconds = endless timer creation.

**How to Fix**:
```javascript
// Track all timers globally
const activeTimers = new Map();

function startPolling(instanceId) {
  const timerId = setInterval(...);
  activeTimers.set(instanceId, timerId);
}

function stopPolling(instanceId) {
  const timerId = activeTimers.get(instanceId);
  if (timerId) {
    clearInterval(timerId);
    activeTimers.delete(instanceId);
  }
}

// Clean up when server is destroyed
// Call stopPolling(instanceId) in your destroy handlers
```

**Time to fix**: 4 hours

---

### 🔴 Bug #2: Bot Could Destroy Its Own Server

**Problem**: If the metadata service times out AND you don't have `EXCLUDE_INSTANCE_ID` set, your self-protection check returns `null` and the bot could destroy the server it's running on.

**Location**: [index.js:578-595](index.js#L578-L595)

**The Issue**:
```javascript
async function isCurrentServer(instanceId) {
  if (!currentServerInstanceId) {
    currentServerInstanceId = await getCurrentServerInstanceId();
  }

  // BUG: If currentServerInstanceId is null, this always returns false
  if (currentServerInstanceId === instanceId) {  // null === "some-id" = false
    return true;
  }
}
```

**How to Fix**:
```javascript
async function isCurrentServer(instanceId) {
  if (!currentServerInstanceId) {
    currentServerInstanceId = await getCurrentServerInstanceId();

    // CRITICAL: If still null, block ALL destroy operations
    if (!currentServerInstanceId) {
      console.error('CRITICAL: Cannot determine current server ID!');
      throw new Error('Self-protection unavailable. Set EXCLUDE_INSTANCE_ID environment variable.');
    }
  }

  return currentServerInstanceId === instanceId;
}
```

**Time to fix**: 30 minutes

---

### 🔴 Bug #3: Security Vulnerabilities in Dependencies

**Problem**: You have 3 LOW severity vulnerabilities in the `undici` package (DoS via bad certificate).

**How to Fix**:
```bash
npm audit fix
npm update
```

**Time to fix**: 5 minutes

---

## HIGH PRIORITY (Fix This Month)

### 🟠 Issue #4: No Input Validation

**Problem**: Users can submit really long server names (2000+ characters) or bypass your city autocomplete with invalid region codes. This will cause confusing Vultr API errors.

**Location**: [index.js:2425-2429](index.js#L2425-L2429)

**How to Fix**:
```javascript
// Validate server name length
const rawName = interaction.options.getString('name') || `${interaction.user.username}'s Server`;
const serverName = rawName.trim().substring(0, 64); // Limit to 64 chars

// Validate city against known regions
const validRegions = ['dfw', 'ewr', 'ord', 'lax', 'sea', ...]; // Get from your quick-create list
const selectedCity = interaction.options.getString('city') || 'dfw';
if (!validRegions.includes(selectedCity)) {
  return interaction.editReply('❌ Invalid region. Please select from the dropdown.');
}
```

**Time to fix**: 2 hours

---

### 🟠 Issue #5: DM Failures Are Silent

**Problem**: When your bot tries to send a DM (server ready notification, self-destruct warning), if it fails, the user never knows. Your `sendDM()` function returns `false` on failure but nothing checks that.

**Location**: [index.js:341-355](index.js#L341-L355)

**Impact**: User's server is ready but they don't get notified. Or worse, server gets auto-destroyed and they never got the warning.

**How to Fix** (simple version):
```javascript
// Check return values
const dmSent = await sendServerReadyDM(...);
if (!dmSent) {
  // Fallback: send message in the channel
  await channel.send(`<@${userId}> Your server is ready! (Couldn't DM you)`);
}
```

**Time to fix**: 2 hours

---

### 🟠 Issue #6: No Rate Limiting

**Problem**: When updating the panel with 20 servers, you make 20 instant API calls to Vultr. This could hit rate limits (429 errors) and slow down your panel updates.

**Location**: [index.js:2041-2052](index.js#L2041-L2052)

**How to Fix** (simple caching):
```javascript
// Cache plan costs (they don't change often)
const planCostCache = new Map();
let planCacheExpiry = 0;

async function getCachedPlanCost(planId) {
  const now = Date.now();
  if (now > planCacheExpiry || !planCostCache.has(planId)) {
    const plans = await vultr.plans.listPlans();
    planCostCache.clear();
    plans.plans.forEach(p => planCostCache.set(p.id, p.monthly_cost));
    planCacheExpiry = now + 3600000; // 1 hour cache
  }
  return planCostCache.get(planId);
}
```

**Time to fix**: 3 hours

---

### 🟠 Issue #7: Panel Updates Can Overlap

**Problem**: Your panel auto-refreshes every 3 seconds, but if an update takes longer than 3 seconds (network delays, lots of servers), the next update starts before the first one finishes. This causes weird display glitches.

**Location**: [index.js:2920-2932](index.js#L2920-L2932)

**How to Fix**:
```javascript
let panelUpdateInProgress = false;
let pendingPanelUpdate = false;

async function updatePanel() {
  if (panelUpdateInProgress) {
    pendingPanelUpdate = true;
    return;
  }

  try {
    panelUpdateInProgress = true;
    pendingPanelUpdate = false;

    // ... actual update logic ...

  } finally {
    panelUpdateInProgress = false;

    // If update was requested during execution, run again
    if (pendingPanelUpdate) {
      setTimeout(() => updatePanel(), 100);
    }
  }
}
```

**Time to fix**: 2 hours

---

## NICE TO HAVE (But Not Critical)

### Better Error Messages

Right now, all Vultr API errors show generic "❌ Error destroying server" messages. Users can't tell if the server is in a transitional state vs a real error.

**How to improve** [index.js:3257-3276](index.js#L3257-L3276):
```javascript
} catch (error) {
  const status = error.response?.status;

  switch (status) {
    case 400:
      return interaction.editReply('❌ Server cannot be destroyed (in transitional state). Wait a minute and try again.');
    case 403:
      return interaction.editReply('❌ Permission denied. Check your Vultr API key permissions.');
    case 404:
      return interaction.editReply('❌ Server not found. It may have already been destroyed.');
    case 429:
      return interaction.editReply('❌ Rate limit exceeded. Please wait 60 seconds and try again.');
    default:
      console.error(`Destroy error [${status}]:`, error.message);
      return interaction.editReply(`❌ Error destroying server: ${error.message}`);
  }
}
```

**Time to fix**: 3 hours (apply to all catch blocks)

---

### Graceful Shutdown

Add cleanup on process exit so your timers don't keep running:

```javascript
// Add at end of index.js
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');

  // Clear all timers
  activeTimers.forEach(timer => clearInterval(timer));

  // Close Discord connection
  client.destroy();

  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  // Same cleanup
  process.exit(0);
});
```

**Time to fix**: 1 hour

---

### Clean Up Old Destroyed Instances

Your `instanceState.instances` array grows forever. Old destroyed instances never get removed.

**How to fix** [index.js:163](index.js#L163):
```javascript
// Periodically clean up old destroyed instances
setInterval(() => {
  const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
  instanceState.instances = instanceState.instances.filter(i =>
    i.status !== 'destroyed' || i.timestamp > twoWeeksAgo
  );
}, 86400000); // Daily cleanup
```

**Time to fix**: 30 minutes

---

## What You DON'T Need

**You DON'T need**:
- ❌ Airbnb style guide compliance
- ❌ ESLint setup (unless YOU want it)
- ❌ TypeScript migration
- ❌ Splitting index.js into multiple files (single-file is fine per your design)
- ❌ JSDoc comments on every function
- ❌ Unit tests right now (add them later if you want)
- ❌ Advanced monitoring (Sentry, Prometheus) unless you're running at scale
- ❌ Winston logger (console.log is fine)

**Your single-file architecture is perfectly acceptable.** It's easy to debug, easy to understand, and gets the job done.

---

## Summary

**What will break in production**:
1. Memory leak from timers (will crash after ~2 weeks)
2. Self-protection bypass (could destroy its own server)
3. Security vulnerabilities (low risk but easy to fix)

**What you should fix soon**:
4. Input validation (prevents API errors)
5. DM failure tracking (users miss notifications)
6. Rate limiting/caching (prevents 429 errors)
7. Panel update locking (prevents display glitches)

**What's nice to have**:
- Better error messages
- Graceful shutdown
- Old instance cleanup

**Total estimated time to production-ready**:
- Critical fixes: ~5 hours
- High priority fixes: ~9 hours
- Nice-to-have fixes: ~5 hours
- **Total: ~19 hours**

**Your code is good.** Just fix the critical bugs and you're solid.

---

## References

- [Node.js Best Practices](https://nodejs.org/en/learn/getting-started/security-best-practices)
- [Discord.js Guide](https://discordjs.guide/)
- [Vultr API Docs](https://www.vultr.com/api/)
