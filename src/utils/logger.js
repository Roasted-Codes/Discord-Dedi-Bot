/**
 * Logger Utility
 *
 * Simple logging utility with log levels for cleaner output.
 * Set LOG_LEVEL environment variable to: error, warn, info, debug
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

// Track messages that should only be logged once
const loggedOnce = new Set();

function shouldLog(level) {
  return LOG_LEVELS[level] <= currentLevel;
}

function formatMessage(level, message, ...args) {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = `[${timestamp}]`;

  if (args.length > 0) {
    return [prefix, message, ...args];
  }
  return [prefix, message];
}

export const logger = {
  error(message, ...args) {
    if (shouldLog('error')) {
      console.error(...formatMessage('error', message, ...args));
    }
  },

  warn(message, ...args) {
    if (shouldLog('warn')) {
      console.warn(...formatMessage('warn', message, ...args));
    }
  },

  info(message, ...args) {
    if (shouldLog('info')) {
      console.log(...formatMessage('info', message, ...args));
    }
  },

  debug(message, ...args) {
    if (shouldLog('debug')) {
      console.log(...formatMessage('debug', `[DEBUG] ${message}`, ...args));
    }
  },

  /**
   * Log a message only once (useful for repeated operations)
   */
  once(level, key, message, ...args) {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    this[level](message, ...args);
  },

  /**
   * Log startup banner
   */
  startup(botTag) {
    console.log('');
    console.log('='.repeat(50));
    console.log(`  Dedi-Bot started: ${botTag}`);
    console.log('='.repeat(50));
    console.log('');
  }
};

export default logger;
