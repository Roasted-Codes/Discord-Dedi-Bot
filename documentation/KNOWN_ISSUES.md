# Known Issues & Technical Debt

**Last Updated:** January 27, 2026
**Status:** 1 of 7 main issues fixed. Critical bugs remain open.

---

## Fixed Issues

### ✅ Issue #7: Panel Update Locking (Fixed Jan 2026)
Panel updates now use `panelUpdateInProgress` flag with `pendingPanelUpdate` queue to prevent overlapping API calls. See [index.js:491](index.js#L491) and [index.js:2472](index.js#L2472).

---

## Open Issues

### 🔴 CRITICAL BUGS

#### Bug #1: Memory Leak Will Crash Your Bot
**Status:** Open | **Priority:** Critical

**Problem**: Timers never get cleaned up. After running for ~2 weeks with active servers, the bot will run out of memory and crash.

**Location**: [index.js:1808](index.js#L1808) and [index.js:1455](index.js#L1455)

**The Issue**:
```javascript
// Line 1808 - This runs FOREVER with no way to stop it
setInterval(checkTimers, 30000);

// Lines 1455, 1467, 1475 - These create new timers each recursion
setTimeout(pollStatus, 45000);
```

**Fix Required**: Track all timers in a `Map` and clean them up when instances are destroyed.

---

#### Bug #2: Bot Could Destroy Its Own Server
**Status:** Open | **Priority:** Critical

**Problem**: If the metadata service times out AND `EXCLUDE_INSTANCE_ID` isn't set, the self-protection check returns `null` and the bot could destroy the server it's running on.

**Location**: [index.js:579-596](index.js#L579-L596)

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

**Fix Required**: Throw an error or block all destroy operations when ID cannot be determined.

---

#### Bug #3: Security Vulnerabilities in Dependencies
**Status:** Unknown | **Priority:** Critical

**Action**: Run `npm audit` and `npm audit fix` to check for and fix vulnerabilities.

---

### 🟠 HIGH PRIORITY

#### Issue #4: No Input Validation
**Status:** Open | **Priority:** High

**Problem**: Users can submit very long server names (2000+ characters) or invalid region codes. This causes confusing Vultr API errors.

**Fix Required**: Validate server name length (max 64 chars) and validate city against known regions.

---

#### Issue #5: DM Failures Are Silent
**Status:** Open | **Priority:** High

**Problem**: When DMs fail (user has DMs disabled), the user never knows their server is ready or about to be destroyed. Errors are logged but no fallback notification is sent.

**Location**: [index.js:313](index.js#L313), [index.js:1701](index.js#L1701)

**Fix Required**: Send a channel fallback message when DM fails.

---

#### Issue #6: No Rate Limiting / Caching
**Status:** Open | **Priority:** High

**Problem**: Panel updates make multiple API calls for plan costs without caching. This could hit Vultr rate limits (429 errors).

**Fix Required**: Cache plan costs for 1 hour to reduce API calls.

---

### 🟡 NICE TO HAVE

#### Graceful Shutdown
**Status:** Open | **Priority:** Low

Add SIGTERM/SIGINT handlers to clean up timers and close Discord connection gracefully.

---

#### Clean Up Old Destroyed Instances
**Status:** Open | **Priority:** Low

`instanceState.instances` array grows forever. Old destroyed instances should be periodically pruned.

---

#### Better Error Messages
**Status:** Open | **Priority:** Low

Generic error messages could be improved to show specific failure reasons (rate limit, permission denied, server in transitional state, etc.)

---

## Changelog

| Date | Change |
|------|--------|
| Jan 27, 2026 | Audit review: confirmed Issue #7 fixed, all others remain open |
| Dec 18, 2025 | Initial code audit completed |

---

## References

- [Node.js Best Practices](https://nodejs.org/en/learn/getting-started/security-best-practices)
- [Discord.js Guide](https://discordjs.guide/)
- [Vultr API Docs](https://www.vultr.com/api/)
