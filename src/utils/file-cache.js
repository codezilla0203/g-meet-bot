/**
 * File Cache Utility
 * Caches file reads to reduce I/O operations and improve performance
 */

const fs = require('fs-extra');
const path = require('path');

// In-memory cache with TTL
const fileCache = new Map();
const CACHE_TTL_MS = 30000; // 30 seconds default TTL

/**
 * Get cached file content or read from disk
 * @param {string} filePath - Path to file
 * @param {Function} reader - Async function to read file (e.g., fs.readJson, fs.readFile)
 * @param {number} ttl - Time to live in milliseconds (optional)
 * @returns {Promise<any>} File content
 */
async function getCachedFile(filePath, reader = fs.readJson, ttl = CACHE_TTL_MS) {
    const normalizedPath = path.resolve(filePath);
    const now = Date.now();
    
    // Check cache
    const cached = fileCache.get(normalizedPath);
    if (cached && (now - cached.timestamp) < ttl) {
        return cached.data;
    }
    
    // Read from disk
    try {
        if (!(await fs.pathExists(normalizedPath))) {
            return null;
        }
        
        const data = await reader(normalizedPath);
        
        // Cache the result
        fileCache.set(normalizedPath, {
            data,
            timestamp: now
        });
        
        return data;
    } catch (error) {
        // Remove from cache if read fails
        fileCache.delete(normalizedPath);
        throw error;
    }
}

/**
 * Invalidate cache for a specific file
 * @param {string} filePath - Path to file
 */
function invalidateCache(filePath) {
    const normalizedPath = path.resolve(filePath);
    fileCache.delete(normalizedPath);
}

/**
 * Clear all cache entries
 */
function clearCache() {
    fileCache.clear();
}

/**
 * Clean up expired cache entries
 */
function cleanupExpiredCache() {
    const now = Date.now();
    for (const [key, value] of fileCache.entries()) {
        if (now - value.timestamp > CACHE_TTL_MS) {
            fileCache.delete(key);
        }
    }
}

// Clean up expired entries every minute
setInterval(cleanupExpiredCache, 60000);

module.exports = {
    getCachedFile,
    invalidateCache,
    clearCache,
    cleanupExpiredCache
};

