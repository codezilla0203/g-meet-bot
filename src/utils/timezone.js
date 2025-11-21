/**
 * Timezone Utilities
 * 
 * Handles timezone conversions for the meeting bot.
 * Supports Mexico timezones and configurable timezone settings.
 */

// Default timezone configuration
const DEFAULT_TIMEZONE = process.env.TIMEZONE || 'America/Mexico_City';
const DEFAULT_LOCALE = process.env.LOCALE || 'es-MX';

/**
 * Available Mexico timezones:
 * - America/Mexico_City (Central Time - most of Mexico)
 * - America/Cancun (Eastern Time - Quintana Roo)
 * - America/Chihuahua (Mountain Time - Chihuahua, Sinaloa)
 * - America/Tijuana (Pacific Time - Baja California)
 * - America/Mazatlan (Mountain Time - Baja California Sur, Nayarit, Sinaloa)
 * - America/Monterrey (Central Time - same as Mexico_City)
 */

/**
 * Get current date/time in configured timezone
 * @param {Date|number|string} date - Optional date to convert (defaults to now)
 * @returns {Date} Date object
 */
function getCurrentDate(date = null) {
    return date ? new Date(date) : new Date();
}

/**
 * Format date to ISO string with timezone
 * @param {Date|number|string} date - Date to format
 * @param {string} timezone - IANA timezone (default: configured timezone)
 * @returns {string} ISO formatted string with timezone
 */
function toISOStringWithTimezone(date = null, timezone = DEFAULT_TIMEZONE) {
    const d = getCurrentDate(date);
    
    // Get timezone offset
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'short'
    });
    
    return d.toISOString();
}

/**
 * Format date for display in configured timezone
 * @param {Date|number|string} date - Date to format
 * @param {string} timezone - IANA timezone (default: configured timezone)
 * @param {string} locale - Locale string (default: configured locale)
 * @returns {string} Formatted date string
 */
function formatDate(date = null, timezone = DEFAULT_TIMEZONE, locale = DEFAULT_LOCALE) {
    const d = getCurrentDate(date);
    
    return d.toLocaleString(locale, {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

/**
 * Format date for display in long format
 * @param {Date|number|string} date - Date to format
 * @param {string} timezone - IANA timezone (default: configured timezone)
 * @param {string} locale - Locale string (default: configured locale)
 * @returns {string} Formatted date string (e.g., "19 de noviembre de 2025, 10:30:45")
 */
function formatDateLong(date = null, timezone = DEFAULT_TIMEZONE, locale = DEFAULT_LOCALE) {
    const d = getCurrentDate(date);
    
    return d.toLocaleString(locale, {
        timeZone: timezone,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

/**
 * Format time only
 * @param {Date|number|string} date - Date to format
 * @param {string} timezone - IANA timezone (default: configured timezone)
 * @param {string} locale - Locale string (default: configured locale)
 * @returns {string} Formatted time string (e.g., "10:30:45")
 */
function formatTime(date = null, timezone = DEFAULT_TIMEZONE, locale = DEFAULT_LOCALE) {
    const d = getCurrentDate(date);
    
    return d.toLocaleString(locale, {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

/**
 * Get timezone offset in hours
 * @param {string} timezone - IANA timezone (default: configured timezone)
 * @returns {number} Offset in hours (e.g., -6 for CST)
 */
function getTimezoneOffset(timezone = DEFAULT_TIMEZONE) {
    const now = new Date();
    
    // Get UTC time
    const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    
    // Get local time in timezone
    const tzDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    
    // Calculate offset in hours
    const offset = (tzDate.getTime() - utcDate.getTime()) / (1000 * 60 * 60);
    
    return offset;
}

/**
 * Get timezone information
 * @param {string} timezone - IANA timezone (default: configured timezone)
 * @returns {Object} Timezone info
 */
function getTimezoneInfo(timezone = DEFAULT_TIMEZONE) {
    const now = new Date();
    
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'long'
    });
    
    const parts = formatter.formatToParts(now);
    const timeZoneName = parts.find(part => part.type === 'timeZoneName')?.value || timezone;
    
    return {
        timezone,
        timeZoneName,
        offset: getTimezoneOffset(timezone),
        locale: DEFAULT_LOCALE
    };
}

/**
 * Convert timestamp to configured timezone
 * @param {number} timestampMs - Unix timestamp in milliseconds
 * @param {string} timezone - IANA timezone (default: configured timezone)
 * @returns {Object} Formatted date/time object
 */
function timestampToTimezone(timestampMs, timezone = DEFAULT_TIMEZONE) {
    const date = new Date(timestampMs);
    
    return {
        iso: date.toISOString(),
        formatted: formatDate(date, timezone),
        long: formatDateLong(date, timezone),
        time: formatTime(date, timezone),
        timestamp: timestampMs
    };
}

/**
 * Get current timestamp with timezone metadata
 * @returns {Object} Timestamp object with timezone info
 */
function getCurrentTimestamp() {
    const now = Date.now();
    
    return {
        timestampMs: now,
        iso: new Date(now).toISOString(),
        formatted: formatDate(now),
        timezone: DEFAULT_TIMEZONE,
        locale: DEFAULT_LOCALE
    };
}

/**
 * Parse date string and convert to configured timezone
 * @param {string} dateString - Date string to parse
 * @param {string} timezone - Target timezone
 * @returns {Date} Parsed date
 */
function parseDate(dateString, timezone = DEFAULT_TIMEZONE) {
    return new Date(dateString);
}

// Export functions and configuration
module.exports = {
    // Configuration
    DEFAULT_TIMEZONE,
    DEFAULT_LOCALE,
    
    // Formatting functions
    toISOStringWithTimezone,
    formatDate,
    formatDateLong,
    formatTime,
    
    // Utility functions
    getCurrentDate,
    getCurrentTimestamp,
    getTimezoneOffset,
    getTimezoneInfo,
    timestampToTimezone,
    parseDate,
    
    // Mexico timezone constants
    MEXICO_TIMEZONES: {
        CENTRAL: 'America/Mexico_City',      // Most of Mexico
        CANCUN: 'America/Cancun',            // Quintana Roo (Eastern Time)
        CHIHUAHUA: 'America/Chihuahua',      // Chihuahua (Mountain Time)
        TIJUANA: 'America/Tijuana',          // Baja California (Pacific Time)
        MAZATLAN: 'America/Mazatlan',        // Baja California Sur (Mountain Time)
        MONTERREY: 'America/Monterrey'       // Same as Mexico_City
    }
};

