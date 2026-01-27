# Known Issues & Technical Debt

**Last Updated:** January 27, 2026
**Status:** 4 of 7 main issues fixed in v2.0 modular refactor. 3 remain open.

---

## Fixed Issues

### ✅ Bug #1: Memory Leak (Fixed Jan 2026)
**Fix:** Graceful shutdown handlers (SIGINT/SIGTERM) now track all `setInterval` IDs in `cleanupFunctions` array and clear them on exit. See [src/index.js](../src/index.js).

### ✅ Issue #7: Panel Update Locking (Fixed Jan 2026)
Panel updates use `panelUpdateInProgress` flag with `pendingPanelUpdate` queue.

### ✅ Graceful Shutdown (Fixed Jan 2026)
**Fix:** Added SIGINT/SIGTERM handlers in `src/index.js` that clean up timers and close Discord connection.

### ✅ Clean Up Old Destroyed Instances (Partially Fixed Jan 2026)
**Fix:** Graceful shutdown prevents indefinite accumulation. Full periodic pruning still recommended for long-running instances.

---

## Open Issues

### 🔴 CRITICAL BUGS

#### Bug #2: Bot Could Destroy Its Own Server
**Status:** Open | **Priority:** Critical

**Problem**: If the metadata service times out AND `EXCLUDE_INSTANCE_ID` isn't set, the self-protection check returns `null` and the bot could destroy the server it's running on.

**Location**: [src/vultr/index.js](../src/vultr/index.js) - `isCurrentServer()` function

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

**Location**: [src/services/notifications.js](../src/services/notifications.js)

**Fix Required**: Send a channel fallback message when DM fails.

---

#### Issue #6: No Rate Limiting / Caching
**Status:** Open | **Priority:** High

**Problem**: Panel updates make multiple API calls for plan costs without caching. This could hit Vultr rate limits (429 errors).

**Location**: [src/vultr/index.js](../src/vultr/index.js) - `calculateInstanceCost()`

**Fix Required**: Cache plan costs for 1 hour to reduce API calls.

---

### 🟡 NICE TO HAVE

#### Better Error Messages
**Status:** Open | **Priority:** Low

Generic error messages could be improved to show specific failure reasons (rate limit, permission denied, server in transitional state, etc.)

---

#### Periodic Instance Pruning
**Status:** Open | **Priority:** Low

`instanceState.instances` array could benefit from periodic pruning of old destroyed instances for very long-running bot sessions.

---

## Changelog

| Date | Change |
|------|--------|
| Jan 27, 2026 | **v2.0 Modular Refactor**: Fixed Bug #1 (memory leak), graceful shutdown, instance cleanup. 4 of 7 issues now fixed. |
| Jan 27, 2026 | Audit review: confirmed Issue #7 fixed, all others remain open |
| Dec 18, 2025 | Initial code audit completed |

---

## References

- [Node.js Best Practices](https://nodejs.org/en/learn/getting-started/security-best-practices)
- [Discord.js Guide](https://discordjs.guide/)
- [Vultr API Docs](https://www.vultr.com/api/)
