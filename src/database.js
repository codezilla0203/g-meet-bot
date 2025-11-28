const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs-extra');

// Database file path
const DB_PATH = path.join(__dirname, '../database.sqlite');

// Initialize database with configuration for better concurrency
const db = new Database(DB_PATH, {
    timeout: 10000, // Wait up to 10 seconds for database to be available
});

// Enable foreign keys
db.pragma('foreign_keys = ON');
// Enable WAL mode for better concurrency (allows multiple readers and one writer)
try {
    db.pragma('journal_mode = WAL');
    console.log('✅ Database WAL mode enabled for better concurrency');
} catch (e) {
    console.warn('⚠️  Could not enable WAL mode:', e.message);
}
// Set busy timeout to handle locked database situations (milliseconds)
db.pragma('busy_timeout = 10000');

/**
 * Initialize database schema
 */
function initializeDatabase() {
    // Create users table
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            hash TEXT NOT NULL,
            email_verified INTEGER DEFAULT 0,
            verification_token TEXT,
            verification_expires INTEGER,
            reset_token TEXT,
            reset_expires INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);

    // Create index on email for faster lookups
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
    `);

    // Create bots table
    db.exec(`
        CREATE TABLE IF NOT EXISTS bots (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            meet_url TEXT NOT NULL,
            title TEXT,
            status TEXT NOT NULL DEFAULT 'queued',
            error TEXT,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            ended_at INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // Create indexes on bots table
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_bots_user_id ON bots(user_id);
        CREATE INDEX IF NOT EXISTS idx_bots_created_at ON bots(created_at);
        CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status);
    `);

    // Create user_configurations table
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_configurations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL UNIQUE,
            bot_name TEXT,
            webhook_url TEXT,
            summary_template TEXT,
            bot_logo_url TEXT,
            max_recording_time INTEGER DEFAULT 60,
            total_recording_minutes INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // Create index on user_configurations table
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_configurations_user_id ON user_configurations(user_id);
    `);

    console.log('✅ Database initialized successfully');
}

/**
 * User operations
 */
const userOps = {
    /**
     * Create a new user
     */
    create: (id, email, hash) => {
        const stmt = db.prepare(`
            INSERT INTO users (id, email, hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        `);
        const now = Date.now();
        stmt.run(id, email, hash, now, now);
    },

    /**
     * Find user by email
     */
    findByEmail: (email) => {
        const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
        return stmt.get(email);
    },

    /**
     * Find user by id
     */
    findById: (id) => {
        const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
        return stmt.get(id);
    },

    /**
     * Get all users
     */
    getAll: () => {
        const stmt = db.prepare('SELECT * FROM users ORDER BY created_at DESC');
        return stmt.all();
    },

    /**
     * Update user
     */
    update: (id, updates) => {
        const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = Object.values(updates);
        values.push(Date.now()); // updated_at
        values.push(id);
        
        const stmt = db.prepare(`
            UPDATE users SET ${fields}, updated_at = ? WHERE id = ?
        `);
        stmt.run(...values);
    },

    /**
     * Delete user
     */
    delete: (id) => {
        const stmt = db.prepare('DELETE FROM users WHERE id = ?');
        stmt.run(id);
    },

    /**
     * Set email verification token
     */
    setVerificationToken: (email, token, expires) => {
        const stmt = db.prepare(`
            UPDATE users SET verification_token = ?, verification_expires = ?, updated_at = ?
            WHERE email = ?
        `);
        stmt.run(token, expires, Date.now(), email);
    },

    /**
     * Verify email with token
     */
    verifyEmail: (token) => {
        const stmt = db.prepare(`
            SELECT * FROM users WHERE verification_token = ? AND verification_expires > ?
        `);
        const user = stmt.get(token, Date.now());
        
        if (user) {
            const updateStmt = db.prepare(`
                UPDATE users SET email_verified = 1, verification_token = NULL, verification_expires = NULL, updated_at = ?
                WHERE id = ?
            `);
            updateStmt.run(Date.now(), user.id);
            return user;
        }
        return null;
    },

    /**
     * Check if email is verified
     */
    isEmailVerified: (email) => {
        const stmt = db.prepare('SELECT email_verified FROM users WHERE email = ?');
        const result = stmt.get(email);
        return result ? result.email_verified === 1 : false;
    },

    /**
     * Set password reset token for user
     */
    setResetToken: (email, token, expires) => {
        const stmt = db.prepare(`
            UPDATE users 
            SET reset_token = ?, reset_expires = ?, updated_at = ?
            WHERE email = ?
        `);
        return stmt.run(token, expires, Date.now(), email);
    },

    /**
     * Get user by reset token
     */
    getUserByResetToken: (token) => {
        const stmt = db.prepare(`
            SELECT * FROM users 
            WHERE reset_token = ? AND reset_expires > ?
        `);
        return stmt.get(token, Date.now());
    },

    /**
     * Update user password and clear reset token
     */
    updatePassword: (email, hash) => {
        const stmt = db.prepare(`
            UPDATE users 
            SET hash = ?, reset_token = NULL, reset_expires = NULL, updated_at = ?
            WHERE email = ?
        `);
        return stmt.run(hash, Date.now(), email);
    }
};

/**
 * Bot operations
 */
const botOps = {
    /**
     * Create a new bot
     */
    create: (id, userId, meetUrl, title = null) => {
        const stmt = db.prepare(`
            INSERT INTO bots (id, user_id, meet_url, title, status, created_at)
            VALUES (?, ?, ?, ?, 'queued', ?)
        `);
        stmt.run(id, userId, meetUrl, title, Date.now());
    },

    /**
     * Find bot by id
     */
    findById: (id) => {
        const stmt = db.prepare('SELECT * FROM bots WHERE id = ?');
        return stmt.get(id);
    },

    /**
     * Find bot by id and user id
     */
    findByIdAndUser: (id, userId) => {
        const stmt = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?');
        return stmt.get(id, userId);
    },

    /**
     * Get all bots for a user
     */
    findByUserId: (userId) => {
        const stmt = db.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC');
        return stmt.all(userId);
    },

    /**
     * Get all bots
     */
    getAll: () => {
        const stmt = db.prepare('SELECT * FROM bots ORDER BY created_at DESC');
        return stmt.all();
    },

    /**
     * Update bot status
     */
    updateStatus: (id, status, error = null) => {
        let stmt;
        const now = Date.now();
        
        if (status === 'recording' && !error) {
            stmt = db.prepare(`
                UPDATE bots SET status = ?, started_at = ? WHERE id = ?
            `);
            stmt.run(status, now, id);
        } else if (status === 'completed' || status === 'failed') {
            stmt = db.prepare(`
                UPDATE bots SET status = ?, ended_at = ?, error = ? WHERE id = ?
            `);
            stmt.run(status, now, error, id);
        } else {
            stmt = db.prepare(`
                UPDATE bots SET status = ?, error = ? WHERE id = ?
            `);
            stmt.run(status, error, id);
        }
    },

    /**
     * Update bot
     */
    update: (id, updates) => {
        const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = Object.values(updates);
        values.push(id);
        
        const stmt = db.prepare(`
            UPDATE bots SET ${fields} WHERE id = ?
        `);
        stmt.run(...values);
    },

    /**
     * Delete bot
     */
    delete: (id) => {
        const stmt = db.prepare('DELETE FROM bots WHERE id = ?');
        stmt.run(id);
    },

    /**
     * Get statistics
     */
    getStats: (userId = null) => {
        let query = `
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
                SUM(CASE WHEN status = 'starting' THEN 1 ELSE 0 END) as starting,
                SUM(CASE WHEN status = 'recording' THEN 1 ELSE 0 END) as recording,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
            FROM bots
        `;
        
        if (userId) {
            query += ' WHERE user_id = ?';
            const stmt = db.prepare(query);
            return stmt.get(userId);
        } else {
            const stmt = db.prepare(query);
            return stmt.get();
        }
    }
};

/**
 * Migration functions
 */
const migrations = {
    /**
     * Migrate from JSON files to SQLite
     */
    migrateFromJSON: () => {
        const usersJsonPath = path.join(__dirname, '../users.json');
        const botsJsonPath = path.join(__dirname, '../bots.json');
        
        try {
            // Migrate users
            if (fs.existsSync(usersJsonPath)) {
                const users = fs.readJsonSync(usersJsonPath);
                console.log(`📦 Migrating ${users.length} users from JSON to SQLite...`);
                
                for (const user of users) {
                    try {
                        userOps.create(user.id, user.email, user.hash);
                    } catch (e) {
                        if (e.message.includes('UNIQUE constraint failed')) {
                            console.log(`⚠️  User ${user.email} already exists, skipping...`);
                        } else {
                            console.error(`❌ Error migrating user ${user.email}:`, e.message);
                        }
                    }
                }
                
                console.log('✅ Users migrated successfully');
            }
            
            // Migrate bots
            if (fs.existsSync(botsJsonPath)) {
                const bots = fs.readJsonSync(botsJsonPath);
                console.log(`📦 Migrating ${bots.length} bots from JSON to SQLite...`);
                
                for (const bot of bots) {
                    try {
                        const stmt = db.prepare(`
                            INSERT INTO bots (id, user_id, meet_url, title, status, error, created_at, started_at, ended_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `);
                        stmt.run(
                            bot.id,
                            bot.userId,
                            bot.meetUrl,
                            bot.title || null,
                            bot.status || 'queued',
                            bot.error || null,
                            bot.createdAt || Date.now(),
                            bot.startedAt || null,
                            bot.endTime || bot.ended_at || null
                        );
                    } catch (e) {
                        if (e.message.includes('UNIQUE constraint failed')) {
                            console.log(`⚠️  Bot ${bot.id} already exists, skipping...`);
                        } else {
                            console.error(`❌ Error migrating bot ${bot.id}:`, e.message);
                        }
                    }
                }
                
                console.log('✅ Bots migrated successfully');
            }
            
            // Backup JSON files
            if (fs.existsSync(usersJsonPath)) {
                fs.moveSync(usersJsonPath, path.join(__dirname, '../users.json.backup'), { overwrite: true });
                console.log('📁 Backed up users.json to users.json.backup');
            }
            if (fs.existsSync(botsJsonPath)) {
                fs.moveSync(botsJsonPath, path.join(__dirname, '../bots.json.backup'), { overwrite: true });
                console.log('📁 Backed up bots.json to bots.json.backup');
            }
            
        } catch (error) {
            console.error('❌ Migration error:', error);
            throw error;
        }
    }
};

/**
 * Close database connection
 */
function closeDatabase() {
    db.close();
    console.log('🔒 Database connection closed');
}

// Initialize database on module load
initializeDatabase();

// Check if we need to migrate from JSON files
const usersJsonPath = path.join(__dirname, '../users.json');
const botsJsonPath = path.join(__dirname, '../bots.json');
if (fs.existsSync(usersJsonPath) || fs.existsSync(botsJsonPath)) {
    console.log('📦 JSON files detected, starting migration...');
    migrations.migrateFromJSON();
}

/**
 * User Configuration operations
 */
const configOps = {
    /**
     * Get user configuration
     */
    getByUserId: (userId) => {
        const stmt = db.prepare('SELECT * FROM user_configurations WHERE user_id = ?');
        return stmt.get(userId);
    },

    /**
     * Create or update user configuration
     */
    upsert: (userId, config) => {
        const now = Date.now();
        
        // Check if configuration exists
        const existing = configOps.getByUserId(userId);
        
        if (existing) {
            // Update existing configuration - update each value explicitly
            const stmt = db.prepare(`
                UPDATE user_configurations SET 
                    bot_name = ?, 
                    webhook_url = ?, 
                    summary_template = ?, 
                    bot_logo_url = ?, 
                    max_recording_time = ?, 
                    total_recording_minutes = ?, 
                    updated_at = ?
                WHERE user_id = ?
            `);
            stmt.run(
                config.botName || null,
                config.webhookUrl || null,
                config.summaryTemplate || null,
                config.botLogoUrl || null,
                config.maxRecordingTime || 60,
                config.totalRecordingMinutes || 0,
                now,
                userId
            );
        } else {
            // Create new configuration
            const stmt = db.prepare(`
                INSERT INTO user_configurations (
                    user_id, bot_name, webhook_url, summary_template, 
                    bot_logo_url, max_recording_time, total_recording_minutes, 
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                userId,
                config.botName || null,
                config.webhookUrl || null,
                config.summaryTemplate || null,
                config.botLogoUrl || null,
                config.maxRecordingTime || 60,
                config.totalRecordingMinutes || 0,
                now,
                now
            );
        }
        
        // Return the updated/created configuration
        return configOps.getByUserId(userId);
    },

    /**
     * Delete user configuration
     */
    delete: (userId) => {
        const stmt = db.prepare('DELETE FROM user_configurations WHERE user_id = ?');
        stmt.run(userId);
    }
};

module.exports = {
    db,
    userOps,
    botOps,
    configOps,
    migrations,
    closeDatabase
};

