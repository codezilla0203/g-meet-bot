const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Bot } = require('./bot');
const path = require('path');
const fs = require('fs-extra');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { remuxWebmToMp4 } = require('./utils/remux');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { userOps, botOps, configOps, closeDatabase } = require('./database');
const { generateAndSaveSummary, getModelInfo, getDefaultSummaryTemplate } = require('./openai-service');
const { getCachedFile, invalidateCache } = require('./utils/file-cache');

const app = express();

// CORS configuration for frontend
// Allow origins from environment variable or use default allowed origins
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://biometrictesting.fiscoclic.mx',
      'https://www.biometrictesting.fiscoclic.mx'
    ];

// CORS middleware with origin callback
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, Postman, curl, server-to-server)
    if (!origin) {
      return callback(null, true);
    }
    
    // Log CORS requests for debugging (only in development)
    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_CORS === 'true') {
      console.log(`[CORS] Request from origin: ${origin}`);
    }
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // Log rejected origins
    console.warn(`[CORS] Rejected origin: ${origin}`);
    return callback(new Error(`Not allowed by CORS. Origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'X-Requested-With', 'Accept'],
    // Expose range-related headers so the frontend can inspect them via fetch/HEAD
exposedHeaders: ['Content-Length', 'Content-Type', 'Accept-Ranges', 'Content-Range'],
  maxAge: 86400, // 24 hours
}));

// Optional: handle OPTIONS explicitly for all routes
app.options('*', cors());

app.use(express.json());
// Static frontend serving is disabled by default because this project
// uses a Next.js frontend served separately. To enable serving the
// legacy `public/` folder from this backend, set
// `SERVE_STATIC_FRONTEND=true` in your environment.
if (process.env.SERVE_STATIC_FRONTEND === 'true') {
    app.use(express.static(path.join(__dirname, '../public')));
} else {
    console.log('ℹ️  Static public serving is disabled (use NEXT frontend). To enable, set SERVE_STATIC_FRONTEND=true');
}

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';
// URL of the Next.js frontend (used for redirects instead of serving HTML)
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.BASE_URL || 'http://localhost:3000';
const RUNTIME_DIR = path.join(__dirname, '../runtime/bots');
const RUNTIME_ROOT = path.join(__dirname, '../runtime');
fs.ensureDirSync(RUNTIME_ROOT);
// Don't create bots folder unless needed (only created when PID files are written)

// Maximum lifetime for a single bot (minutes). After this TTL the bot is
// force-stopped even if still in a meeting or recording.
const BOT_MAX_LIFETIME_MINUTES = Number(process.env.BOT_MAX_LIFETIME_MINUTES || 90);
const BOT_MAX_LIFETIME_MS = BOT_MAX_LIFETIME_MINUTES * 60 * 1000;
// In-memory storage for active bots
const activeBots = new Map();

// Cache recording storage location to avoid repeated S3 checks for every range request
// Values: 'local' | 's3' ; stored with timestamp for optional TTL
const recordingStorageCache = new Map();

// TTL for recordingStorageCache entries (ms). Default 10 minutes, override with env var
const RECORDING_STORAGE_CACHE_TTL_MS = Number(process.env.RECORDING_STORAGE_CACHE_TTL_MS || 10 * 60 * 1000);

/**
 * Get cache entry for a recording, evicting it if TTL expired.
 * @param {string} recordingId
 * @returns {{where:string,ts:number}|null}
 */
function getRecordingStorageCacheEntry(recordingId) {
    try {
        const entry = recordingStorageCache.get(recordingId);
        if (!entry) return null;
        if (Date.now() - (entry.ts || 0) > RECORDING_STORAGE_CACHE_TTL_MS) {
            recordingStorageCache.delete(recordingId);
            return null;
        }
        return entry;
    } catch (e) {
        return null;
    }
}

/**
 * Find video file for a bot (checks both .webm and .mp4 extensions)
 * @param {string} botId - Bot ID
 * @param {string} videoDir - Video directory path
 * @returns {Promise<string|null>} Path to video file or null if not found
 */
async function findVideoFile(botId, videoDir) {
    // Check for .mp4 first (compressed files), then .webm (original)
    const mp4Path = path.join(videoDir, `${botId}.mp4`);
    const webmPath = path.join(videoDir, `${botId}.webm`);
    
    if (await fs.pathExists(mp4Path)) {
        return mp4Path;
    }
    if (await fs.pathExists(webmPath)) {
        return webmPath;
    }
    return null;
}

// Authentication middleware
function authMiddleware(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.split(' ')[1];
    try {
        const user = jwt.verify(token, JWT_SECRET);
        req.user = user;
        next();
    } catch {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// // Optional auth middleware (allows both authenticated and unauthenticated requests)
// function optionalAuthMiddleware(req, res, next) {
//     const header = req.headers['authorization'] || '';
//     const token = header.split(' ')[1];
//     if (token) {
//         try {
//             const user = jwt.verify(token, JWT_SECRET);
//             req.user = user;
//         } catch {}
//     }
//     next();
// }

/**
 * Force cleanup all processes related to a specific bot (Chrome, Node, etc.)
 * This is called before creating a new bot to ensure clean state
 */
async function forceCleanupBotProcesses(botId) {
    console.log(`🧹 Force cleaning up all processes for bot ${botId}...`);
    const isWindows = process.platform === 'win32';
    const { execSync } = require('child_process');
    
    try {
        // 1. Check if bot has PID file and kill that process tree
        const botPidFile = path.join(RUNTIME_DIR, `${botId}.pid`);
        if (await fs.pathExists(botPidFile)) {
            try {
                const pidStr = await fs.readFile(botPidFile, 'utf8');
                const pid = parseInt(pidStr.trim(), 10);
                
                if (!isNaN(pid) && Number.isInteger(pid)) {
                    if (isWindows) {
                        try {
                            execSync(`taskkill /F /T /PID ${pid}`, { 
                                stdio: 'ignore',
                                timeout: 5000 
                            });
                            console.log(`  ✅ Killed process tree (Windows) PID: ${pid}`);
                        } catch {}
                    } else {
                        try {
                            // Kill process tree
                            execSync(`pkill -P ${pid}`, { stdio: 'ignore', timeout: 3000 });
                            process.kill(pid, 'SIGTERM');
                            await new Promise(r => setTimeout(r, 500));
                            process.kill(pid, 'SIGKILL');
                            console.log(`  ✅ Killed process tree (Unix) PID: ${pid}`);
                        } catch {}
                    }
                }
            } catch (e) {
                console.warn(`  ⚠️ Error reading/killing PID from ${botPidFile}:`, e.message);
            }
            
            // Remove PID file
            try {
                await fs.remove(botPidFile);
            } catch {}
        }
        
        // 2. Kill any Chrome processes that might be orphaned for this bot
        // (Search by botId pattern in process command line or window title)
        const botIdPattern = botId.slice(0, 8);
        
        if (isWindows) {
            try {
                // Kill Chrome processes that might be related to this bot
                execSync(`taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq *${botIdPattern}*"`, {
                    stdio: 'ignore',
                    timeout: 3000
                });
            } catch {}
        } else {
            // Unix: kill chrome processes that might be orphaned
            try {
                execSync(`pkill -f "chrome.*${botIdPattern}"`, {
                    stdio: 'ignore',
                    timeout: 3000
                });
            } catch {}
        }
        
        console.log(`✅ Force cleanup completed for bot ${botId}`);
    } catch (e) {
        console.warn(`⚠️ Error during force cleanup for bot ${botId}:`, e.message);
    }
}

// Kill leftover Chrome processes from previous crash/restart
async function cleanupLeftoverBrowsers() {
    console.log('🧹 Cleaning up leftover browser processes...');
    let cleaned = 0;
    
    try {
        // Only check if the directory exists (don't create it if not needed)
        if (!(await fs.pathExists(RUNTIME_DIR))) {
            console.log('📋 No bots directory found - nothing to clean up');
            return;
        }
        
        const files = await fs.readdir(RUNTIME_DIR);
        const pidFiles = files.filter(f => f.endsWith('.pid'));
        
        console.log(`📋 Found ${pidFiles.length} PID files to clean up`);
        
        for (const f of pidFiles) {
            const full = path.join(RUNTIME_DIR, f);
            try {
                const pidStr = await fs.readFile(full, 'utf8');
                const pid = parseInt(pidStr.trim(), 10);
                
                if (!isNaN(pid) && Number.isInteger(pid)) {
                    const isWindows = process.platform === 'win32';
                    
                    if (isWindows) {
                        // Windows: use taskkill to kill process tree
                        try {
                            const { execSync } = require('child_process');
                            execSync(`taskkill /F /T /PID ${pid}`, { 
                                stdio: 'ignore',
                                timeout: 5000 
                            });
                            console.log(`  ✅ Killed Chrome process tree (Windows) PID: ${pid}`);
                            cleaned++;
                        } catch {
                            // Process might already be dead
                        }
                    } else {
                        // Unix: use SIGTERM then SIGKILL
                        try { 
                            process.kill(pid, 'SIGTERM'); 
                            await new Promise(r => setTimeout(r, 500));
                        } catch {}
                        try { 
                            process.kill(pid, 'SIGKILL'); 
                            console.log(`  ✅ Killed Chrome process (Unix) PID: ${pid}`);
                            cleaned++;
                        } catch {}
                    }
                }
            } catch (e) {
                console.warn(`  ⚠️ Error killing process from ${f}:`, e.message);
            }
            
            // Remove PID file
            try { 
                await fs.remove(full); 
                console.log(`  🗑️  Removed PID file: ${f}`);
            } catch {}
        }
        
        console.log(`✅ Cleanup complete: ${cleaned} processes killed, ${pidFiles.length} PID files removed`);
    } catch (e) {
        console.warn('⚠️ Error during browser cleanup:', e.message);
    }
}

// Note: Crash recovery is handled in bot.js via browser.on('disconnected')
// The forceCleanupBotProcesses function is exported for use in bot.js if needed

/**
 * SIMPLE LOCAL TESTING API
 * 
 * Endpoints:
 * GET    /health           - Health check
 * POST   /v1/bots          - Create recording bot  
 * GET    /v1/bots          - List all bots
 * GET    /v1/bots/:id      - Get bot status
 * DELETE /v1/bots/:id      - Stop bot
 * GET    /v1/recordings    - List recordings
 * GET    /v1/recordings/:id - Download recording
 */

/**
 * Health check
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeBots: activeBots.size
    });
});

/**
 * AUTHENTICATION ENDPOINTS
 */

/**
 * User signup
 */
app.post('/api/signup', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Validate input
        if (!email || !password) {
            return res.status(400).json({ error: 'Please provide both email and password' });
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Please enter a valid email address' });
        }
        
        // Validate password length
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }
        
        // Check if user already exists
        const existingUser = userOps.findByEmail(email);
        if (existingUser) {
            return res.status(409).json({ error: 'An account with this email already exists' });
        }
        
        // Hash password and create user
        const hash = await bcrypt.hash(password, 8);
        const userId = uuidv4();
        userOps.create(userId, email, hash);
        
        // Create default configuration for new user
        try {
            const DEFAULT_BOT_LOGO_URL = "https://www.cxflow.io/app/images/logo.png";
            const defaultSummaryTemplate = getDefaultSummaryTemplate();
            configOps.upsert(userId, {
                botName: "CXFlow Meeting Bot",
                // Set the default webhook_url requested for new users
                webhookUrl: null,
                summaryTemplate: defaultSummaryTemplate,
                botLogoUrl: DEFAULT_BOT_LOGO_URL,
                maxRecordingTime: 60,
                totalRecordingMinutes: 0
            });
            console.log(`✅ Default configuration created for user ${userId}`);
        } catch (configError) {
            console.warn(`⚠️  Could not create default configuration for user ${userId}:`, configError.message);
            // Don't fail signup if config creation fails
        }
        
        // Generate verification token and send email
        const verificationToken = uuidv4();
        const expires = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
        userOps.setVerificationToken(email, verificationToken, expires);
        
        // Send verification email if email is configured
        if (process.env.EMAIL_USER) {
            try {
                const { sendVerificationEmail } = require('./utils/email-service');
                const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
                
                const emailResult = await sendVerificationEmail({
                    email: email,
                    verificationToken: verificationToken,
                    baseUrl: baseUrl
                });
                
                if (emailResult.success) {
                    console.log(`✅ Verification email sent to: ${email}`);
                } else {
                    console.log(`⚠️ Failed to send verification email: ${emailResult.error}`);
                }
            } catch (error) {
                console.error('Error sending verification email:', error);
            }
        }
        
        res.json({ 
            success: true, 
            message: 'Account created successfully! Please check your email to verify your account.',
            emailSent: !!process.env.EMAIL_USER
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Server error. Please try again later' });
    }
});

/**
 * Resend verification email
 */
app.post('/api/resend-verification', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        // Check if user exists
        const user = userOps.findByEmail(email);
        if (!user) {
            return res.status(404).json({ error: 'No account found with this email address' });
        }
        
        // Check if already verified
        if (user.email_verified) {
            return res.status(400).json({ error: 'Email is already verified' });
        }
        
        // Generate new verification token
        const verificationToken = uuidv4();
        const expires = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
        userOps.setVerificationToken(email, verificationToken, expires);
        
        // Send verification email if email is configured
        if (process.env.EMAIL_USER) {
            try {
                const { sendVerificationEmail } = require('./utils/email-service');
                const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
                
                const emailResult = await sendVerificationEmail({
                    email: email,
                    verificationToken: verificationToken,
                    baseUrl: baseUrl
                });
                
                if (emailResult.success) {
                    console.log(`✅ Verification email resent to: ${email}`);
                    res.json({ 
                        success: true, 
                        message: 'Verification email sent! Please check your email and spam folder.',
                        emailSent: true
                    });
                } else {
                    console.log(`⚠️ Failed to resend verification email: ${emailResult.error}`);
                    res.status(500).json({ error: 'Failed to send verification email. Please try again later.' });
                }
            } catch (error) {
                console.error('Error resending verification email:', error);
                res.status(500).json({ error: 'Failed to send verification email. Please try again later.' });
            }
        } else {
            res.status(500).json({ error: 'Email service is not configured' });
        }
    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({ error: 'Server error. Please try again later' });
    }
});

/**
 * Manual email verification (for development/testing)
 */
app.post('/api/verify-email-manual', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        // Find user by email
        const user = userOps.findByEmail(email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.email_verified) {
            return res.json({ success: true, message: 'Email is already verified' });
        }
        
        // Manually verify the email
        const stmt = db.prepare(`
            UPDATE users SET email_verified = 1, verification_token = NULL, verification_expires = NULL, updated_at = ?
            WHERE email = ?
        `);
        stmt.run(Date.now(), email);
        
        res.json({ success: true, message: 'Email verified manually' });
    } catch (error) {
        console.error('Manual verification error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Email verification
 */
app.get('/api/verify-email', async (req, res) => {
    try {
        const { token } = req.query;
        // If no token provided, redirect to frontend verification page
        if (!token) {
            return res.redirect(`${FRONTEND_URL}/verify-email?status=invalid`);
        }

        // Verify the token and redirect to frontend pages instead of serving HTML
        const user = userOps.verifyEmail(token);

        if (user) {
            // Successful verification -> redirect to frontend sign-in or confirmation page
            return res.redirect(`${FRONTEND_URL}/signin?verified=1`);
        } else {
            // Verification failed or expired
            return res.redirect(`${FRONTEND_URL}/verify-email?status=failed`);
        }
    } catch (error) {
        console.error('Email verification error:', error);
        return res.redirect(`${FRONTEND_URL}/verify-email?status=error`);
    }
});

/**
 * User login
 */
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Validate input
        if (!email || !password) {
            return res.status(400).json({ error: 'Please provide both email and password' });
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Please enter a valid email address' });
        }
        
        // Find user by email
        const user = userOps.findByEmail(email);
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        // Verify password
        const isValid = await bcrypt.compare(password, user.hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        // Check if email is verified
        if (!user.email_verified) {
            return res.status(403).json({ 
                error: 'Please verify your email address before signing in. Check your email for the verification link.',
                emailNotVerified: true
            });
        }
        
        // Generate JWT token
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error. Please try again later' });
    }
});

/**
 * Forgot Password - Send reset email
 */
app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        // Check if user exists
        const user = userOps.findByEmail(email);
        if (!user) {
            // Explicit error when email not found (caller requested this behavior)
            return res.status(404).json({ error: 'No account found with this email address' });
        }
        
        // Generate reset token (valid for 1 hour)
        const resetToken = require('crypto').randomBytes(32).toString('hex');
        const resetExpires = Date.now() + (60 * 60 * 1000); // 1 hour from now
        
        // Save reset token to database
        userOps.setResetToken(email, resetToken, resetExpires);

        // Send reset email and honor helper result
        const { sendPasswordResetEmail } = require('./utils/email-service');
        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

        const emailResult = await sendPasswordResetEmail(email, resetToken, baseUrl);
        if (!emailResult || emailResult.success === false) {
            console.error(`❌ Failed to send password reset email to ${email}:`, emailResult && emailResult.error ? emailResult.error : 'unknown');
            return res.status(500).json({ error: 'Failed to send reset email. Please try again later.' });
        }

        console.log(`✅ Password reset email sent to: ${email}`);
        res.json({ success: true, message: 'Password reset email sent successfully.' });
        
    } catch (error) {
        console.error('❌ Forgot password error:', error);
        res.status(500).json({ error: 'Failed to send reset email' });
    }
});

/**
 * Reset Password - Verify token and update password
 */
app.post('/api/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        
        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token and new password are required' });
        }
        
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }
        
        // Find user by reset token
        const user = userOps.getUserByResetToken(token);
        if (!user) {
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }
        
        // Hash new password
        const bcrypt = require('bcryptjs');
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
        
        // Update password and clear reset token
        userOps.updatePassword(user.email, hashedPassword);
        
        console.log(`✅ Password reset successful for: ${user.email}`);
        res.json({ success: true, message: 'Password reset successfully.' });
        
    } catch (error) {
        console.error('❌ Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

/**
 * Share meeting summary via email
 */
app.post('/api/share-via-email', async (req, res) => {
    try {
        const { botId, shareUrl, isPublicShare, email } = req.body;
        
        if (!botId) {
            return res.status(400).json({ error: 'Bot ID is required' });
        }
        
        // For authenticated requests, verify the token manually
        if (!isPublicShare) {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            const token = authHeader.split(' ')[1];
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                req.user = { id: decoded.userId };
            } catch (error) {
                return res.status(401).json({ error: 'Invalid or expired token' });
            }
        }
        
        let bot, user;
        
        if (isPublicShare) {
            // For public share pages, we don't require authentication
            // but we need to find the bot owner to send them the email
            
            // Check if bot directory exists (for public shares)
            const botDir = path.join(RUNTIME_ROOT, botId);
            if (!fs.existsSync(botDir)) {
                return res.status(404).json({ error: 'Meeting not found' });
            }
            
            // Get bot from database (without user verification for public shares)
            bot = botOps.findById(botId);
            if (!bot) {
                return res.status(404).json({ error: 'Meeting not found in database' });
            }
            
            // If a specific recipient email was provided in the public share request, honor it
            if (email && typeof email === 'string' && email.trim()) {
                // Use the provided email address directly (no verification of owner required)
                const providedEmail = email.trim();
                user = { email: providedEmail };
                console.log(`📧 Public share: sending bot ${botId} summary to provided email: ${providedEmail}...`);
            } else {
                // Get the bot owner's email
                user = userOps.findById(bot.user_id);
                if (!user || !user.email || !user.email_verified) {
                    return res.status(400).json({ 
                        error: 'Cannot send email - bot owner email not available or not verified' 
                    });
                }
                console.log(`📧 Public share: sending bot ${botId} summary to owner: ${user.email}...`);
            }
        } else {
            // For authenticated users (original functionality)
            if (!req.user || !req.user.id) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            // Get bot from database to verify ownership
            bot = botOps.findByIdAndUser(botId, req.user.id);
            if (!bot) {
                return res.status(403).json({ error: 'Bot not found or access denied' });
            }
            
            // Get user email (default recipient when no explicit email provided)
            user = userOps.findById(req.user.id);
            if (!user || !user.email || !user.email_verified) {
                return res.status(400).json({ error: 'User email not found or not verified' });
            }

            // If an explicit email was provided in the authenticated request, prefer that
            if (email && typeof email === 'string' && email.trim()) {
                const providedEmail = email.trim();
                // Use provided email as recipient (do not change account ownership)
                user = { email: providedEmail };
                console.log(`📧 Authenticated share: sending bot ${botId} to provided email: ${providedEmail}...`);
            } else {
                console.log(`📧 Authenticated share: sending bot ${botId} to: ${user.email}...`);
            }
        }
        
        // Send email with meeting summary
        const { sendMeetingSummaryEmail } = require('./utils/email-service');
        
        const emailResult = await sendMeetingSummaryEmail({
            botId: botId,
            meetUrl: bot.meet_url,
            recipients: user.email,
            runtimeRoot: RUNTIME_ROOT,
            shareUrl: shareUrl,
            isShareRequest: true
        });
        
        if (emailResult.success) {
            console.log(`✅ Share email sent successfully to ${user.email}`);
            res.json({ 
                success: true, 
                message: 'Meeting summary shared via email successfully',
                recipient: user.email
            });
        } else {
            console.log(`⚠️ Share email failed: ${emailResult.message || emailResult.error}`);
            res.status(500).json({ 
                error: 'Failed to send email', 
                details: emailResult.message || emailResult.error 
            });
        }
        
    } catch (error) {
        console.error('❌ Error sharing via email:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get user configuration (authenticated)
 */
app.get('/api/config', authMiddleware, async (req, res) => {
    try {
        let config = configOps.getByUserId(req.user.id);
        
        // If no configuration exists, create default configuration
        if (!config) {
            const DEFAULT_BOT_LOGO_URL = "https://www.cxflow.io/app/images/logo.png";
            const defaultSummaryTemplate = getDefaultSummaryTemplate();
            try {
                configOps.upsert(req.user.id, {
                    botName: "CXFlow Meeting Bot",
                    webhookUrl: null,
                    summaryTemplate: defaultSummaryTemplate,
                    botLogoUrl: DEFAULT_BOT_LOGO_URL,
                    maxRecordingTime: 60,
                    totalRecordingMinutes: 0
                });
                config = configOps.getByUserId(req.user.id);
                console.log(`✅ Default configuration created for existing user ${req.user.id}`);
            } catch (configError) {
                console.warn(`⚠️  Could not create default configuration for user ${req.user.id}:`, configError.message);
                // Fallback to defaults if creation fails
                return res.json({
                    botName: '',
                    webhookUrl: '',
                    summaryTemplate: defaultSummaryTemplate,
                    botLogoUrl: DEFAULT_BOT_LOGO_URL,
                    maxRecordingTime: 60,
                    totalRecordingMinutes: 0
                });
            }
        }
        
        // Convert snake_case to camelCase for frontend
        // Use default logo if no custom logo is configured
        const DEFAULT_BOT_LOGO_URL = "https://www.cxflow.io/app/images/logo.png";
        
        // Debug: Log the summary_template value
        console.log(`📋 Config for user ${req.user.id}: summary_template =`, config.summary_template ? `[${config.summary_template.length} chars]` : 'null/empty');
        
        res.json({
            botName: config.bot_name || '',
            webhookUrl: config.webhook_url || '',
            summaryTemplate: config.summary_template ?? '', // Use nullish coalescing to preserve empty strings
            botLogoUrl: (config.bot_logo_url && config.bot_logo_url.trim()) || DEFAULT_BOT_LOGO_URL,
            maxRecordingTime: config.max_recording_time || 60,
            totalRecordingMinutes: config.total_recording_minutes || 0
        });
    } catch (error) {
        console.error('Error fetching user configuration:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Save user configuration (authenticated)
 */
app.post('/api/configSave', authMiddleware, async (req, res) => {
    try {
        const {
            botName,
            webhookUrl,
            summaryTemplate,
            botLogoUrl,
            maxRecordingTime,
            totalRecordingMinutes
        } = req.body;
        
        // Validate input
        if (maxRecordingTime && (maxRecordingTime < 1 || maxRecordingTime > 480)) {
            return res.status(400).json({ 
                error: 'Maximum recording time must be between 1 and 480 minutes' 
            });
        }
        
        // Use default logo if empty string is provided
        const DEFAULT_BOT_LOGO_URL = "https://www.cxflow.io/app/images/logo.png";
        const finalBotLogoUrl = (botLogoUrl && botLogoUrl.trim()) || DEFAULT_BOT_LOGO_URL;
        
        // Save configuration
        const savedConfig = configOps.upsert(req.user.id, {
            botName,
            webhookUrl,
            summaryTemplate,
            botLogoUrl: finalBotLogoUrl,
            maxRecordingTime: maxRecordingTime || 60,
            totalRecordingMinutes: totalRecordingMinutes || 0
        });
        
        console.log(`✅ Configuration saved for user ${req.user.id}`);
        
        // Return saved configuration in camelCase
        res.json({
            success: true,
            message: 'Configuration saved successfully',
            config: {
                botName: savedConfig.bot_name || '',
                webhookUrl: savedConfig.webhook_url || '',
                summaryTemplate: savedConfig.summary_template || '',
                botLogoUrl: savedConfig.bot_logo_url || '',
                maxRecordingTime: savedConfig.max_recording_time || 60,
                totalRecordingMinutes: savedConfig.total_recording_minutes || 0
            }
        });
    } catch (error) {
        console.error('Error saving user configuration:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get user's bots (authenticated)
 */
app.get('/api/bots', authMiddleware, async (req, res) => {
    try {
        const userBots = botOps.findByUserId(req.user.id);
        
        // Convert snake_case to camelCase for frontend compatibility
        // Read all metadata files in parallel for better performance
        const metadataPromises = userBots.map(bot => {
            const metadataPath = path.join(RUNTIME_ROOT, String(bot.id), 'bot_metadata.json');
            return getCachedFile(metadataPath, fs.readJson, 60000)
                .then(metadata => ({ bot, metadata }))
                .catch(() => ({ bot, metadata: null }));
        });
        
        const metadataResults = await Promise.allSettled(metadataPromises);
        const formattedBots = metadataResults.map((result, index) => {
            if (result.status === 'rejected') {
                const bot = userBots[index];
                return {
                    id: bot.id,
                    userId: bot.user_id,
                    meetUrl: bot.meet_url,
                    title: bot.title,
                    status: bot.status,
                    error: bot.error,
                    createdAt: bot.created_at,
                    startedAt: bot.started_at,
                    endTime: bot.ended_at
                };
            }
            
            const { bot, metadata } = result.value;
            // Prefer runtime metadata title when available (e.g. AI-generated or extension-provided title)
            let resolvedTitle = bot.title;
            if (metadata && metadata.title && typeof metadata.title === 'string' && metadata.title.trim().length > 0) {
                resolvedTitle = metadata.title;
            }
            
            return {
                id: bot.id,
                userId: bot.user_id,
                meetUrl: bot.meet_url,
                title: resolvedTitle,
                status: bot.status,
                error: bot.error,
                createdAt: bot.created_at,
                startedAt: bot.started_at,
                endTime: bot.ended_at
            };
        });
        
        // Also check runtime directory for historical bots not in DB
        // Optimize: Only scan if we have less than 100 bots (to avoid performance issues)
        // and limit to checking metadata files first (faster than full directory scan)
        try {
            if (formattedBots.length < 100) {
                const runtimeDirs = await fs.readdir(RUNTIME_ROOT);
                const dbBotIds = new Set(formattedBots.map(b => b.id));
                
                // Batch process directories in parallel (limit to 10 at a time to avoid memory issues)
                const batchSize = 10;
                for (let i = 0; i < runtimeDirs.length; i += batchSize) {
                    const batch = runtimeDirs.slice(i, i + batchSize);
                    const batchPromises = batch.map(async (dirName) => {
                        // Skip if already in DB or not a valid bot directory
                        if (dbBotIds.has(dirName) || dirName === 'bots') return null;
                        
                        const botDir = path.join(RUNTIME_ROOT, dirName);
                        const stat = await fs.stat(botDir).catch(() => null);
                        
                        if (!stat || !stat.isDirectory()) return null;
                        
                        // Check metadata first (faster than checking video files)
                        const metadataPath = path.join(botDir, 'bot_metadata.json');
                        const metadata = await getCachedFile(metadataPath, fs.readJson, 60000).catch(() => null);
                        
                        // Early exit if metadata doesn't exist or doesn't belong to user
                        if (!metadata || metadata.userId !== req.user.id) return null;
                        
                        // Only check for data if metadata exists and belongs to user
                        const metricsPath = path.join(botDir, 'MeetingMetrics.json');
                        const videoDir = path.join(botDir, 'video');
                        const [videoPath, metrics] = await Promise.allSettled([
                            findVideoFile(dirName, videoDir),
                            getCachedFile(metricsPath, (p) => fs.readFile(p, 'utf8').then(d => JSON.parse(d)), 60000).catch(() => null)
                        ]);
                        
                        const hasData = (videoPath.status === 'fulfilled' && videoPath.value !== null) || 
                                       (metrics.status === 'fulfilled' && metrics.value !== null);
                        
                        if (hasData) {
                            const metricsData = metrics.status === 'fulfilled' ? metrics.value : null;
                            
                            return {
                                id: dirName,
                                userId: req.user.id,
                                meetUrl: metadata.meetUrl || metricsData?.meetUrl || 'N/A',
                                title: metadata.title || `Historical Meeting ${dirName.slice(0, 8)}`,
                                status: 'completed',
                                error: null,
                                createdAt: metadata.createdAt || metricsData?.duration?.startTime || stat.mtime.toISOString(),
                                startedAt: metricsData?.duration?.startTime || stat.mtime.toISOString(),
                                endTime: metricsData?.duration?.endTime || stat.mtime.toISOString(),
                                isHistorical: true
                            };
                        }
                        return null;
                    });
                    
                    const batchResults = await Promise.allSettled(batchPromises);
                    for (const result of batchResults) {
                        if (result.status === 'fulfilled' && result.value) {
                            formattedBots.push(result.value);
                            console.log(`📂 Found historical bot: ${result.value.id}`);
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Error scanning runtime directory for historical bots:', error.message);
            // Don't fail the whole request, just return DB bots
        }
        
        // Sort by creation date (newest first)
        formattedBots.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        // Calculate hash of bot list for change detection (after all bots are collected)
        const botIds = formattedBots.map(b => b.id).sort().join(',');
        const botStatuses = formattedBots.map(b => `${b.id}:${b.status}`).sort().join(',');
        const dataHash = require('crypto').createHash('md5').update(botIds + botStatuses).digest('hex');
        
        res.json({
            bots: formattedBots,
            hash: dataHash,
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Error fetching bots:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get specific bot details (authenticated)
 */
app.get('/api/bots/:id', authMiddleware, async (req, res) => {
    try {
        console.log(`📊 Fetching bot details for: ${req.params.id}`);
        
        const bot = botOps.findByIdAndUser(req.params.id, req.user.id);
        let formattedBot;
        
        if (!bot) {
            console.log(`⚠️  Bot ${req.params.id} not in database, checking runtime directory...`);
            
            // Check if this is a historical bot in runtime directory
            const botDir = path.join(RUNTIME_ROOT, req.params.id);
            if (await fs.pathExists(botDir)) {
                // Check user ownership from metadata - use cached read
                const metadataPath = path.join(botDir, 'bot_metadata.json');
                const metricsPath = path.join(botDir, 'MeetingMetrics.json');
                
                const [metadata, metrics, stat] = await Promise.allSettled([
                    getCachedFile(metadataPath, fs.readJson, 60000).catch(() => null),
                    getCachedFile(metricsPath, (p) => fs.readFile(p, 'utf8').then(d => JSON.parse(d)), 60000).catch(() => null),
                    fs.stat(botDir)
                ]);
                
                const metadataData = metadata.status === 'fulfilled' ? metadata.value : null;
                const metricsData = metrics.status === 'fulfilled' ? metrics.value : null;
                const statData = stat.status === 'fulfilled' ? stat.value : null;
                const belongsToUser = metadataData && metadataData.userId === req.user.id;
                
                if (!belongsToUser) {
                    console.log(`❌ Bot ${req.params.id} does not belong to user ${req.user.id}`);
                    return res.status(403).json({ error: 'Access denied' });
                }
                
                // Create a historical bot entry
                formattedBot = {
                    id: req.params.id,
                    userId: req.user.id,
                    meetUrl: metadataData?.meetUrl || metricsData?.meetUrl || 'N/A',
                    title: metadataData?.title || `Historical Meeting ${req.params.id.slice(0, 8)}`,
                    status: 'completed',
                    error: null,
                    createdAt: metadataData?.createdAt || metricsData?.duration?.startTime || (statData ? statData.mtime.toISOString() : new Date().toISOString()),
                    startedAt: metricsData?.duration?.startTime || (statData ? statData.mtime.toISOString() : new Date().toISOString()),
                    endTime: metricsData?.duration?.endTime || (statData ? statData.mtime.toISOString() : new Date().toISOString()),
                    isHistorical: true
                };
                
                console.log(`✅ Historical bot found in runtime directory`);
            } else {
                console.log(`❌ Bot ${req.params.id} not found in DB or runtime directory`);
                return res.status(404).json({ error: 'Not found' });
            }
        } else {
            console.log(`✅ Bot found in database:`, {
                id: bot.id,
                status: bot.status,
                createdAt: new Date(bot.created_at).toISOString()
            });
            
            // Convert snake_case to camelCase
            formattedBot = {
                id: bot.id,
                userId: bot.user_id,
                meetUrl: bot.meet_url,
                title: bot.title,
                status: bot.status,
                error: bot.error,
                createdAt: bot.created_at,
                startedAt: bot.started_at,
                endTime: bot.ended_at
            };
        }
        
        // Try to read transcript and summary from RUNTIME_ROOT
        try {
            const runtimeDir = path.join(RUNTIME_ROOT, req.params.id);
            const transcriptPath = path.join(runtimeDir, 'transcripts', 'captions.json');
            const summaryPath = path.join(runtimeDir, 'summary.txt');
            const formattedTranscriptPath = path.join(runtimeDir, 'transcripts', 'formatted.txt');
            
            console.log(`📂 Checking RUNTIME_ROOT: ${runtimeDir}`);
            
            // Generate signed S3 URL if video is in S3 - use cached file read
            const metadataPath = path.join(runtimeDir, 'bot_metadata.json');
            const metadata = await getCachedFile(metadataPath, fs.readJson, 60000).catch(() => null);
            if (metadata) {
                try {
                    // Prefer metadata.title from runtime if available (e.g. AI-generated or extension-provided title)
                    if (metadata.title && typeof metadata.title === 'string' && metadata.title.trim().length > 0) {
                        formattedBot.title = metadata.title;
                    }
                    if (metadata.s3Key || metadata.s3VideoUrl) {
                        // Generate signed URL for secure access (expires in 4 hours)
                        // URL is cached to avoid regenerating on every request
                        const { getS3VideoUrl } = require('./utils/s3-upload');
                        const signedUrl = await getS3VideoUrl(req.params.id, null, 14400); // 4 hours
                        
                        if (signedUrl) {
                            formattedBot.videoUrl = signedUrl;
                            formattedBot.s3VideoUrl = signedUrl;
                            formattedBot.isS3Video = true;
                            console.log(`🔐 Generated signed S3 URL for bot ${req.params.id}`);
                        } else {
                            console.warn(`⚠️  Failed to generate signed URL for bot ${req.params.id}`);
                        }
                    }
                } catch (e) {
                    console.warn('Could not parse bot_metadata.json');
                }
            }
            
            // Read all files in parallel for better performance
            const [transcript, summary, keywords, formattedTranscript, metrics] = await Promise.allSettled([
                getCachedFile(transcriptPath, fs.readJson, 30000).catch(() => null),
                getCachedFile(summaryPath, (p) => fs.readFile(p, 'utf8'), 30000).catch(() => null),
                getCachedFile(path.join(runtimeDir, 'keywords.json'), fs.readJson, 30000).catch(() => null),
                getCachedFile(formattedTranscriptPath, (p) => fs.readFile(p, 'utf8'), 30000).catch(() => null),
                getCachedFile(path.join(runtimeDir, 'MeetingMetrics.json'), (p) => fs.readFile(p, 'utf8').then(d => JSON.parse(d)), 30000).catch(() => null)
            ]);
            
            // Read transcript
            if (transcript.status === 'fulfilled' && transcript.value) {
                formattedBot.transcript = transcript.value;
                console.log(`✅ Transcript loaded: ${formattedBot.transcript.length} captions`);
            } else {
                formattedBot.transcript = [];
                console.log(`⚠️  No transcript found at: ${transcriptPath}`);
            }
            
            // Read summary
            if (summary.status === 'fulfilled' && summary.value) {
                formattedBot.summary = summary.value;
                console.log(`✅ Summary loaded: ${formattedBot.summary.length} characters`);
            } else {
                formattedBot.summary = '';
                console.log(`⚠️  No summary found at: ${summaryPath}`);
            }
            
            // Read OpenAI-generated keywords
            if (keywords.status === 'fulfilled' && keywords.value) {
                formattedBot.keywords = keywords.value;
                console.log(`✅ Keywords loaded: ${formattedBot.keywords.length} keywords`);
            } else {
                formattedBot.keywords = [];
                console.log(`⚠️  No keywords found`);
            }
            
            // Read formatted transcript if available
            if (formattedTranscript.status === 'fulfilled' && formattedTranscript.value) {
                formattedBot.formattedTranscript = formattedTranscript.value;
                console.log(`✅ Formatted transcript loaded`);
            }
            
            // Read metrics if available
            if (metrics.status === 'fulfilled' && metrics.value) {
                formattedBot.metrics = metrics.value;
                console.log(`✅ Metrics loaded`);
            }
            
        } catch (e) {
            console.error('❌ Error reading bot files from RUNTIME_ROOT:', e);
            formattedBot.transcript = [];
            formattedBot.summary = '';
        }
        
        console.log(`📤 Sending bot data with ${formattedBot.transcript.length} captions and ${formattedBot.summary.length} char summary`);
        res.json(formattedBot);
    } catch (error) {
        console.error('❌ Error fetching bot:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Create and start recording bot
 * Requires authentication - unauthenticated users cannot create bots
 */
app.post('/v1/bots', authMiddleware, async (req, res) => {
    try {
        // Authentication is required - authMiddleware ensures req.user exists
        if (!req.user || !req.user.id) {
            return res.status(401).json({ 
                error: 'Authentication required',
                message: 'You must be logged in to create a bot and start recording'
            });
        }

        const {
            meeting_url,
            caption_language = "es",  // Default to Spanish
            notification_emails = null,  // Optional: comma-separated email addresses (snake_case)
            recording_type = "audio-video",
            meeting_type = "other",
            // Allow callers to set a per-bot webhook URL when creating the bot
            webhook_url = null,
            webhookUrl = null
        } = req.body;

        // Get user configuration if fields are not provided
        let userConfig = null;
        try {
            userConfig = configOps.getByUserId(req.user.id);
        } catch (e) {
            console.warn(`⚠️  Could not load user config for ${req.user.id}:`, e.message);
        }

        // Use provided values or fall back to user config or defaults
        const finalBotName = (userConfig?.bot_name) || "CXFlow Meeting Bot";
        const finalSummaryTemplate = (userConfig?.summary_template) || null;
        const finalMaxRecordingTime = (userConfig?.max_recording_time) || 60;
        // Accept both snake_case and camelCase keys from different clients
        let finalEmailRecipients = notification_emails;
        // Normalize empty strings to 
        // Use default logo if no custom logo is configured
        const DEFAULT_BOT_LOGO_URL = "https://www.cxflow.io/app/images/logo.png";
        const finalBotLogoUrl = (userConfig?.bot_logo_url && userConfig.bot_logo_url.trim()) || DEFAULT_BOT_LOGO_URL;

        // Validate required fields
        if (!meeting_url) {
            return res.status(400).json({ 
                error: 'meeting_url is required',
                example: {
                    meeting_url: "https://meet.google.com/abc-defg-hij",
                    bot_name: "CXFlow Meeting Bot",
                    caption_language: "es",
                    transcription: { enabled: true }
                }
            });
        }

        // Validate meeting URL format
        if (!meeting_url.includes('meet.google.com')) {
            return res.status(400).json({ 
                error: 'Invalid Google Meet URL format',
                expected: 'https://meet.google.com/xxx-xxxx-xxx'
            });
        }

        const botId = uuidv4();
        console.log(`🤖 Creating bot ${botId} for user ${req.user.id}: ${meeting_url}`);
        
        // STEP 1: Force cleanup any existing processes for this botId (if somehow it exists)
        // This ensures clean state before creating new bot
        await forceCleanupBotProcesses(botId);
        
        // STEP 2: Check if bot already exists in activeBots (shouldn't happen, but safety check)
        if (activeBots.has(botId)) {
            console.warn(`⚠️  Bot ${botId} already exists in activeBots, cleaning up...`);
            const existingBotData = activeBots.get(botId);
            try {
                if (existingBotData.bot && typeof existingBotData.bot.leaveMeet === 'function') {
                    await existingBotData.bot.leaveMeet().catch(() => {});
                }
                activeBots.delete(botId);
            } catch (e) {
                console.error(`❌ Error cleaning up existing bot ${botId}:`, e);
            }
        }
        
        // Save bot to database (user is authenticated at this point)
        botOps.create(botId, req.user.id, meeting_url, finalBotName);
        
        // Save user_id to metadata file for historical recovery
        try {
            const botDir = path.join(RUNTIME_ROOT, botId);
            await fs.ensureDir(botDir);
            const metadataPath = path.join(botDir, 'bot_metadata.json');

            await fs.writeJson(metadataPath, {
                botId,
                userId: req.user.id, // User is authenticated, so this is always available
                meetUrl: meeting_url,
                title: finalBotName,
                captionLanguage: caption_language || 'es', // Save language preference
                recordingType: recording_type,
                meetingType: meeting_type,
                summaryTemplate: finalSummaryTemplate,
                maxRecordingTime: finalMaxRecordingTime,
                // Include per-bot webhook URL from request, or fall back to user config / env
                webhookUrl: userConfig?.webhook_url || process.env.WEBHOOK_URL || null,
                emailRecipients: finalEmailRecipients,
                createdAt: new Date().toISOString()
            });
        } catch (e) {
            console.warn(`⚠️  Could not save bot metadata for ${botId}:`, e.message);
        }

        // Create bot cleanup callback
        const onLeaveCallback = async () => {
            console.log(`🧹 Bot ${botId} cleanup started...`);
            const botData = activeBots.get(botId);
            if (botData) {
                botData.status = 'completed';
                botData.endTime = new Date().toISOString();
                
                // Clear TTL timer
                if (botData.ttlTimer) {
                    clearTimeout(botData.ttlTimer);
                    botData.ttlTimer = null;
                }
                
                // Clear max recording time timer
                if (botData.maxRecordingTimer) {
                    clearTimeout(botData.maxRecordingTimer);
                    botData.maxRecordingTimer = null;
                }
                
                // Update database status (user is authenticated, so bot is in DB)
                try {
                    botOps.updateStatus(botId, 'completed');
                } catch (e) {
                    console.error('Error updating bot status in DB:', e);
                }
            }

             // Generate summary from transcript
             try {
                console.log(`📝 Bot ${botId}: generating meeting summary...`);
                // Get summary template and meeting type from metadata if available
                let summaryTemplateToUse = null;
                let meetingTypeToUse = null;
                try {
                    const botDir = path.join(RUNTIME_ROOT, botId);
                    const metadataPath = path.join(botDir, 'bot_metadata.json');
                    const metadata = await getCachedFile(metadataPath, fs.readJson, 60000).catch(() => null);
                    if (metadata) {
                        summaryTemplateToUse = metadata.summaryTemplate || null;
                        meetingTypeToUse = metadata.meetingType || null;
                    }
                } catch (e) {
                    console.warn(`⚠️  Could not read metadata for summary template: ${e.message}`);
                }
                await generateAndSaveSummary(botId, RUNTIME_ROOT, summaryTemplateToUse, meetingTypeToUse);
                console.log(`✅ Bot ${botId}: summary generated successfully`);
            } catch (e) {
                console.error(`❌ Error generating summary for bot ${botId}:`, e && e.message ? e.message : e);
            }

            // Update metadata and database with meeting title from extension (if available)

            try {
                const botInstance = botData?.bot;
                if (botInstance && botInstance.meetingTitle && botInstance.meetingTitle.trim()) {
                    const meetingTitle = botInstance.meetingTitle.trim();
                    
                    // Update metadata file
                    const botDir = path.join(RUNTIME_ROOT, botId);
                    const metadataPath = path.join(botDir, 'bot_metadata.json');
                    
                    if (await fs.pathExists(metadataPath)) {
                        const metadata = await fs.readJson(metadataPath);
                        metadata.title = meetingTitle;
                        await fs.writeJson(metadataPath, metadata);
                        // Invalidate cache after update
                        invalidateCache(metadataPath);
                        console.log(`📝 Bot ${botId}: updated metadata with meeting title: ${meetingTitle}`);
                    }
                    
                    // Update database title
                    try {
                        botOps.update(botId, { title: meetingTitle });
                        console.log(`📝 Bot ${botId}: updated database title to: ${meetingTitle}`);
                    } catch (dbError) {
                        console.warn(`⚠️  Could not update database title for ${botId}:`, dbError.message);
                    }
                }
            } catch (e) {
                console.warn(`⚠️  Could not update meeting title for ${botId}:`, e.message);
            }

            // Send email summary to all recipients (bot creator + provided emails)
            try {
                const { sendMeetingSummaryEmail } = require('./utils/email-service');
                const allRecipients = new Set();
                console.log(`🧾 Bot ${botId}: configured botData.emailRecipients =`, botData?.emailRecipients);
                try {
                    const metadataPath = path.join(RUNTIME_ROOT, botId, 'bot_metadata.json');
                    const metadata = await getCachedFile(metadataPath, fs.readJson, 60000).catch(() => null);
                    if (metadata) {
                        console.log(`🧾 Bot ${botId}: metadata.emailRecipients =`, metadata.emailRecipients);
                    }
                } catch (metaErr) {
                    console.warn(`⚠️ Bot ${botId}: could not read metadata for email debug:`, metaErr && metaErr.message ? metaErr.message : metaErr);
                }
                
                // Get bot from database to find the user who created it
                const bot = botOps.findById(botId);
                if (bot && bot.user_id) {
                    // Get user email
                    const user = userOps.findById(bot.user_id);
                    if (user && user.email && user.email_verified) {
                        allRecipients.add(user.email);
                    }
                }
                
                // Add email recipients from request/configuration
                if (botData && botData.emailRecipients) {
                    try {
                        let emails = [];
                        // Accept array or comma-separated string
                        if (Array.isArray(botData.emailRecipients)) {
                            emails = botData.emailRecipients.map(e => String(e).trim()).filter(e => e);
                        } else if (typeof botData.emailRecipients === 'string') {
                            emails = botData.emailRecipients.split(',').map(e => e.trim()).filter(e => e);
                        } else if (botData.emailRecipients && typeof botData.emailRecipients === 'object') {
                            // Might be stored as JSON/object with a field 'emails' or similar
                            if (Array.isArray(botData.emailRecipients.emails)) {
                                emails = botData.emailRecipients.emails.map(e => String(e).trim()).filter(e => e);
                            }
                        }

                        emails.forEach(email => allRecipients.add(email));
                    } catch (e) {
                        console.warn(`⚠️ Bot ${botId}: could not parse configured email recipients:`, e && e.message ? e.message : e);
                    }
                }
                
                // Send email to all recipients
                if (allRecipients.size > 0) {
                    // Convert Set to array for cleaner passing to email service
                    const recipientsArray = Array.from(allRecipients);
                    
                    const emailResult = await sendMeetingSummaryEmail({
                        botId: botId,
                        meetUrl: botData?.meetingUrl || (bot ? bot.meet_url : meeting_url),
                        recipients: recipientsArray, // Pass as array - email-service.js handles both array and string
                        runtimeRoot: RUNTIME_ROOT
                    });
                    
                    if (emailResult.success) {
                        console.log(`✅ Bot ${botId}: summary email sent successfully to ${allRecipients.size} recipient(s) (${emailResult.attachments} attachments)`);
                    } else {
                        console.log(`⚠️ Bot ${botId}: email sending failed - ${emailResult.message || emailResult.error}`);
                    }
                } else {
                    console.log(`⚠️ Bot ${botId}: no valid email recipients found, skipping summary email`);
                }
            } catch (e) {
                console.error(`❌ Error sending summary email for bot ${botId}:`, e && e.message ? e.message : e);
            }

             // Update user's total recording minutes
             try {
                const bot = botOps.findById(botId);
                if (bot && bot.user_id) {
                    // Try to get recording duration from metrics - use cached read
                    let recordingDurationMinutes = 0;
                    const botDir = path.join(RUNTIME_ROOT, botId);
                    const metricsPath = path.join(botDir, 'MeetingMetrics.json');
                    
                    try {
                        const metrics = await getCachedFile(metricsPath, (p) => fs.readFile(p, 'utf8').then(d => JSON.parse(d)), 60000).catch(() => null);
                        if (metrics && metrics.duration && metrics.duration.totalMinutes) {
                            recordingDurationMinutes = Math.ceil(metrics.duration.totalMinutes); // Round up to nearest minute
                            console.log(`📊 Bot ${botId}: recording duration from metrics: ${recordingDurationMinutes} minutes`);
                        }
                    } catch (e) {
                        console.warn(`⚠️  Could not read metrics for duration: ${e.message}`);
                    }
                    
                    // Fallback: calculate from bot stats if metrics not available
                    if (recordingDurationMinutes === 0 && botData?.bot) {
                        try {
                            const stats = botData.bot.getStats();
                            if (stats.recordingDuration && stats.recordingDuration > 0) {
                                recordingDurationMinutes = Math.ceil(stats.recordingDuration / 60000); // Convert ms to minutes, round up
                                console.log(`📊 Bot ${botId}: recording duration from stats: ${recordingDurationMinutes} minutes`);
                            }
                        } catch (e) {
                            console.warn(`⚠️  Could not get duration from stats: ${e.message}`);
                        }
                    }
                    
                    // Only update if we have a valid duration
                    if (recordingDurationMinutes > 0) {
                        // Get current user configuration
                        const currentConfig = configOps.getByUserId(bot.user_id);
                        const currentTotalMinutes = currentConfig?.total_recording_minutes || 0;
                        const newTotalMinutes = currentTotalMinutes + recordingDurationMinutes;
                        
                        // Update user configuration with new total
                        configOps.upsert(bot.user_id, {
                            botName: currentConfig?.bot_name || null,
                            webhookUrl: currentConfig?.webhook_url || null,
                            summaryTemplate: currentConfig?.summary_template || null,
                            botLogoUrl: currentConfig?.bot_logo_url || null,
                            maxRecordingTime: currentConfig?.max_recording_time || 60,
                            totalRecordingMinutes: newTotalMinutes
                        });
                        
                        console.log(`✅ Bot ${botId}: updated user total recording minutes: ${currentTotalMinutes} + ${recordingDurationMinutes} = ${newTotalMinutes} minutes`);
                    } else {
                        console.warn(`⚠️  Bot ${botId}: could not determine recording duration, skipping total minutes update`);
                    }
                }
            } catch (e) {
                console.error(`❌ Error updating total recording minutes for bot ${botId}:`, e && e.message ? e.message : e);
                // Don't fail the cleanup if this update fails
            }

            // If a recording file exists, compress and extract audio
            try {
                const botInstance = botData?.bot;
                if (botInstance && typeof botInstance.getStats === 'function') {
                    const stats = botInstance.getStats();
                    let recordingFile = stats.recordingFile || stats.recordingPath;
                    if (recordingFile && await fs.pathExists(recordingFile)) {
                        // Compress video to reduce file size (enabled by default for optimization)
                        // Can be disabled by setting ENABLE_VIDEO_COMPRESSION=false for maximum speed
                        const enableCompression = process.env.ENABLE_VIDEO_COMPRESSION !== 'false';
                        
                        // Fast mode: skip compression for files under 100MB for maximum speed
                        const fastMode = process.env.FAST_VIDEO_MODE === 'true';
                        const stats = await fs.stat(recordingFile);
                        const sizeMB = stats.size / 1024 / 1024;
                        // if (enableCompression && fastMode) {
                        //     try {
                        //         console.log(`🗜️  Bot ${botId}: compressing video (${sizeMB.toFixed(1)} MB)...`);
                        //         const { compressVideoInPlace, getCompressionRecommendations } = require('./utils/video-compression');
                                
                        //         // Get compression recommendations
                        //         const recommendations = await getCompressionRecommendations(recordingFile);
                                
                        //         if (recommendations.shouldCompress) {
                        //             console.log(`💡 Bot ${botId}: ${recommendations.reason}`);
                        //             const result = await compressVideoInPlace(recordingFile, recommendations.settings);
                        //             console.log(`✅ Bot ${botId}: video compressed - saved ${result.reductionPercent}% (${result.inputSizeMB - result.outputSizeMB} MB)`);
                                    
                        //             // Update recordingFile to point to compressed file (may have different extension)
                        //             if (result.outputPath) {
                        //                 recordingFile = result.outputPath;
                        //                 console.log(`📝 Bot ${botId}: updated recording file path to: ${recordingFile}`);
                                        
                        //                 // Update outputFile metadata to reflect actual file extension
                        //                 if (botData) {
                        //                     const fileExt = path.extname(result.outputPath);
                        //                     const filename = path.basename(result.outputPath);
                        //                     botData.outputFile = filename;
                        //                 }
                        //             }
                        //         } else {
                        //             console.log(`ℹ️  Bot ${botId}: compression skipped - ${recommendations.reason}`);
                        //         }
                        //     } catch (e) {
                        //         console.error(`❌ Error compressing video for bot ${botId}:`, e && e.message ? e.message : e);
                        //         // Continue even if compression fails
                        //     }
                        // }
                        
                        // Upload video to S3 if configured (with automatic retry)
                        // Note: recordingFile may now point to .mp4 if compression occurred
                        try {
                            const { uploadVideoToS3, isS3Configured } = require('./utils/s3-upload');

                            if (isS3Configured()) {
                                console.log(`☁️  Bot ${botId}: Starting S3 upload...`);

                                // Attempt remux for .webm files to .mp4 (container copy, faststart)
                                let fileToUpload = recordingFile;
                                try {
                                    const ext = path.extname(recordingFile || '').toLowerCase();
                                    if (ext === '.webm') {
                                        const remuxedPath = recordingFile.replace(/\.webm$/i, '.mp4');
                                            if (!(await fs.pathExists(remuxedPath))) {
                                            console.log(`🔁 Bot ${botId}: remuxing ${recordingFile} -> ${remuxedPath}`);
                                            await remuxWebmToMp4(recordingFile, remuxedPath, botData?.webhookUrl || null);
                                            console.log(`✅ Bot ${botId}: remuxed to mp4: ${remuxedPath}`);
                                        } else {
                                            console.log(`ℹ️ Bot ${botId}: remuxed file already exists: ${remuxedPath}`);
                                        }
                                        fileToUpload = remuxedPath;
                                        if (botData) botData.outputFile = path.basename(remuxedPath);
                                    }
                                } catch (remuxErr) {
                                    console.warn(`⚠️ Bot ${botId}: remux failed, will upload original file instead: ${remuxErr && remuxErr.message ? remuxErr.message : remuxErr}`);
                                    fileToUpload = recordingFile;
                                }

                                const uploadResult = await uploadVideoToS3(fileToUpload, botId, 3); // 3 retry attempts

                                if (uploadResult.success) {
                                    console.log(`✅ Bot ${botId}: video uploaded to S3: ${uploadResult.s3Url} (${uploadResult.attempts} attempts)`);

                                    // Store S3 URL in metadata
                                    const botDir = path.join(RUNTIME_ROOT, botId);
                                    const metadataPath = path.join(botDir, 'bot_metadata.json');

                                    if (await fs.pathExists(metadataPath)) {
                                        const metadata = await fs.readJson(metadataPath);
                                        metadata.s3VideoUrl = uploadResult.s3Url;
                                        metadata.s3Key = uploadResult.s3Key;
                                        metadata.s3UploadedAt = new Date().toISOString();
                                        metadata.s3FileSize = uploadResult.size;
                                        await fs.writeJson(metadataPath, metadata, { spaces: 2 });
                                        // Invalidate cache after update
                                        invalidateCache(metadataPath);
                                    }
                                    // Mark cache as S3 so future range requests short-circuit
                                    try { recordingStorageCache.set(recordingId, { where: 's3', ts: Date.now() }); } catch (e) {}

                                    // Optionally delete local file after successful upload (if configured)
                                    if (process.env.AWS_S3_DELETE_LOCAL_AFTER_UPLOAD === 'true') {
                                        try {
                                            await fs.remove(fileToUpload);
                                            console.log(`🗑️  Bot ${botId}: uploaded file deleted after S3 upload: ${fileToUpload}`);
                                            // Also consider deleting original .webm if a remuxed .mp4 was created
                                            if (fileToUpload !== recordingFile && await fs.pathExists(recordingFile)) {
                                                try { await fs.remove(recordingFile); console.log(`🗑️  Bot ${botId}: original file deleted: ${recordingFile}`); } catch (e) {}
                                            }
                                        } catch (e) {
                                            console.warn(`⚠️  Bot ${botId}: failed to delete uploaded local file:`, e.message);
                                        }
                                    }
                                } else {
                                    console.warn(`⚠️  Bot ${botId}: S3 upload failed after retries: ${uploadResult.error}`);
                                    // Store failure info in metadata for debugging
                                    const botDir = path.join(RUNTIME_ROOT, botId);
                                    const metadataPath = path.join(botDir, 'bot_metadata.json');

                                    if (await fs.pathExists(metadataPath)) {
                                        const metadata = await fs.readJson(metadataPath);
                                        metadata.s3UploadError = uploadResult.error;
                                        metadata.s3UploadAttemptedAt = new Date().toISOString();
                                        await fs.writeJson(metadataPath, metadata, { spaces: 2 });
                                        // Invalidate cache after update
                                        invalidateCache(metadataPath);
                                    }
                                }
                            } else {
                                console.log(`ℹ️  Bot ${botId}: S3 not configured, keeping video locally`);
                            }
                        } catch (e) {
                            console.error(`❌ Error uploading video to S3 for bot ${botId}:`, e && e.message ? e.message : e);
                            // Continue even if S3 upload fails
                        }
                    }
                }
            } catch (e) {
                console.error(`❌ Error processing recording for bot ${botId}:`, e && e.message ? e.message : e);
            }

            // Remove bot instance to free memory and cleanup references
            if (activeBots.has(botId)) {
                try {
                    // Clear bot instance reference and all associated data
                    if (botData) {
                        if (botData.bot) {
                            // Ensure browser is closed before clearing reference
                            try {
                                if (botData.bot.browser && botData.bot.browser.isConnected()) {
                                    await botData.bot.browser.close().catch(() => {});
                                }
                            } catch (e) {
                                // Browser might already be closed
                            }
                            // Clear bot instance
                            botData.bot = null;
                        }
                        // Clear timers
                        if (botData.ttlTimer) {
                            clearTimeout(botData.ttlTimer);
                            botData.ttlTimer = null;
                        }
                        if (botData.maxRecordingTimer) {
                            clearTimeout(botData.maxRecordingTimer);
                            botData.maxRecordingTimer = null;
                        }
                        // Clear all references
                        botData.meetingUrl = null;
                        botData.emailRecipients = null;
                        botData.botName = null;
                        botData.webhookUrl = null;
                    }
                    activeBots.delete(botId);
                    
                    // Force garbage collection hint (if available)
                    if (global.gc) {
                        global.gc();
                    }
                    
                    // Additional cleanup: wait a bit for processes to fully terminate
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    console.log(`🗑️  Bot ${botId} removed from active list`);
                } catch (e) {
                    console.error(`❌ Error removing bot ${botId} from active list:`, e);
                }
            }

            // If no active bots remain, just log; keep HTTP server running for future requests
            if (activeBots.size === 0) {
                console.log('📴 No active bots remaining – HTTP server remains running');
            }
            
            console.log(`✅ Bot ${botId} cleanup completed`);
        };

        const finalWebhook = userConfig?.webhook_url || process.env.WEBHOOK_URL || null;


        // Create bot with error handling wrapper
        let bot;
        try {
            bot = new Bot(botId, finalBotName, onLeaveCallback, caption_language, finalEmailRecipients, recording_type, finalMaxRecordingTime, finalBotLogoUrl, finalWebhook);
        } catch (e) {
            console.error(`❌ Failed to create bot instance ${botId}:`, e);
            botOps.updateStatus(botId, 'failed', `Bot creation failed: ${e.message}`);
            return res.status(500).json({ 
                error: 'Failed to create bot instance',
                bot_id: botId,
                details: e.message
            });
        }
        
        // Determine the webhook URL for this bot (priority: request body -> user config -> env)
        try {
            bot.webhookUrl = finalWebhook;
            if (finalWebhook) console.log(`ℹ️ Bot ${botId}: using webhook URL: ${finalWebhook}`);
        } catch (e) {
            console.warn(`⚠️ Bot ${botId}: could not set webhook URL: ${e.message}`);
        }

        // Note: Crash recovery is handled in bot.js via browser.on('disconnected')
        // The forceCleanupBotProcesses will be called automatically on crashes

        // Store bot data
        const botData = {
            botId,
            bot,
            userId: req.user.id, // Store userId since authentication is required
            meetingUrl: meeting_url,
            botName: finalBotName,
            webhookUrl: bot.webhookUrl || null,
            captionLanguage: caption_language,
            recordingType: recording_type,
            meetingType: meeting_type,
            emailRecipients: finalEmailRecipients,
            summaryTemplate: finalSummaryTemplate,
            maxRecordingTime: finalMaxRecordingTime,
            status: 'starting',
            createdAt: new Date().toISOString(),
            outputFile: `${botId}.webm`,
            ttlTimer: null,
            maxRecordingTimer: null, // Timer for max recording time
        };
        
        activeBots.set(botId, botData);

        // Set max recording time timer (in addition to TTL)
        if (finalMaxRecordingTime && finalMaxRecordingTime > 0) {
            const maxRecordingTimeMs = finalMaxRecordingTime * 60 * 1000; // Convert minutes to milliseconds
            botData.maxRecordingTimer = setTimeout(async () => {
                try {
                    const current = activeBots.get(botId);
                    if (!current || current.status === 'completed' || current.status === 'failed') return;
                    console.log(`⏱️ Bot ${botId} reached max recording time of ${finalMaxRecordingTime} minutes, stopping recording...`);
                    if (current.bot && typeof current.bot.leaveMeet === 'function') {
                        await current.bot.leaveMeet().catch(() => {});
                    }
                } catch (e) {
                    console.error(`❌ Error during max recording time shutdown for bot ${botId}:`, e);
                }
            }, maxRecordingTimeMs);
        }

        // Per-bot hard TTL: force stop after BOT_MAX_LIFETIME_MS even if
        // recording is still in progress. This prevents orphaned bots.
        botData.ttlTimer = setTimeout(async () => {
            try {
                const current = activeBots.get(botId);
                if (!current) return;
                console.log(`⏱️ Bot ${botId} reached TTL of ${BOT_MAX_LIFETIME_MINUTES} minutes, forcing shutdown...`);
                if (current.bot && typeof current.bot.leaveMeet === 'function') {
                    await current.bot.leaveMeet().catch(() => {});
                }
                activeBots.delete(botId);
            } catch (e) {
                console.error(`❌ Error during TTL shutdown for bot ${botId}:`, e);
            }
        }, BOT_MAX_LIFETIME_MS);

        // Start bot (async, don't wait)
        bot.joinMeet(meeting_url)
            .then(() => {
                console.log(`✅ Bot ${botId} started successfully`);
                botData.status = 'recording';
                
                // Update database status if user is authenticated
                if (req.user) {
                    try {
                        botOps.updateStatus(botId, 'recording');
                    } catch (e) {
                        console.error('Error updating bot status in DB:', e);
                    }
                }
            })
            .catch(async (error) => {
                console.error(`❌ Bot ${botId} failed:`, error.message);
                botData.status = 'failed';
                botData.error = error.message;
                
                // Update database status if user is authenticated
                if (req.user) {
                    try {
                        botOps.updateStatus(botId, 'failed', error.message);
                    } catch (e) {
                        console.error('Error updating bot status in DB:', e);
                    }
                }

                // Ensure we don't leave any Chrome/Playwright processes running
                try {
                    if (bot && typeof bot.leaveMeet === 'function') {
                        await bot.leaveMeet().catch(() => {});
                    }
                } catch {}
            });

        // Return immediate response
        res.json({
            success: true,
            bot_id: botId,
            meeting_url,
            bot_name: finalBotName,
            status: 'starting',
            output_file: `${botId}.webm`,
            created_at: botData.createdAt
        });

    } catch (error) {
        console.error('❌ Failed to create bot:', error);
        res.status(500).json({ 
            error: error.message,
            details: 'Check server logs for more information'
        });
    }
});

/**
 * List all bots
 */
app.get('/v1/bots', (req, res) => {
    const bots = Array.from(activeBots.values()).map(botData => ({
        bot_id: botData.botId,
        meeting_url: botData.meetingUrl,
        bot_name: botData.botName,
        status: botData.status,
        created_at: botData.createdAt,
        end_time: botData.endTime,
        output_file: botData.outputFile,
        error: botData.error,
        stats: botData.bot?.getStats()
    }));

    res.json({
        bots,
        total: bots.length,
        active: bots.filter(b => b.status === 'recording').length,
        completed: bots.filter(b => b.status === 'completed').length,
        failed: bots.filter(b => b.status === 'failed').length
    });
});

/**
 * Get specific bot status
 */
app.get('/v1/bots/:botId', (req, res) => {
    const { botId } = req.params;
    const botData = activeBots.get(botId);

    if (!botData) {
        return res.status(404).json({ 
            error: 'Bot not found',
            bot_id: botId
        });
    }

    const stats = botData.bot?.getStats() || {};
    
    res.json({
        bot_id: botId,
        meeting_url: botData.meetingUrl,
        bot_name: botData.botName,
        status: botData.status,
        created_at: botData.createdAt,
        end_time: botData.endTime,
        output_file: botData.outputFile,
        error: botData.error,
        stats
    });
});

/**
 * Participants diagnostics for a bot
 */
app.get('/v1/bots/:botId/participants', async (req, res) => {
    const { botId } = req.params;
    const botData = activeBots.get(botId);
    if (!botData) {
        return res.status(404).json({ error: 'Bot not found', bot_id: botId });
    }
    try {
        const diag = await botData.bot.getParticipantsDiagnostics();
        res.json({ bot_id: botId, ...diag });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Stop and remove bot
 */
app.delete('/v1/bots/:botId', async (req, res) => {
    const { botId } = req.params;
    const botData = activeBots.get(botId);

    if (!botData) {
        return res.status(404).json({ 
            error: 'Bot not found',
            bot_id: botId
        });
    }

    try {
        console.log(`🛑 Stopping bot ${botId}...`);

        // Clear TTL timer
        if (botData.ttlTimer) {
            clearTimeout(botData.ttlTimer);
            botData.ttlTimer = null;
        }

        // Call leaveMeet which handles all cleanup
        if (botData.bot && typeof botData.bot.leaveMeet === 'function') {
            await botData.bot.leaveMeet();
        }

        // Force cleanup in case leaveMeet didn't remove it
        if (activeBots.has(botId)) {
            // Clear bot instance reference
            if (botData.bot) {
                botData.bot = null;
            }
            activeBots.delete(botId);
            console.log(`🗑️  Bot ${botId} force removed from active list`);
        }

        res.json({
            success: true,
            message: `Bot ${botId} stopped and removed`,
            bot_id: botId,
            status: 'stopped'
        });

    } catch (error) {
        console.error(`❌ Error stopping bot ${botId}:`, error);
        
        // Ensure cleanup even on error
        if (activeBots.has(botId)) {
            try {
                if (botData.bot) {
                    botData.bot = null;
                }
                activeBots.delete(botId);
            } catch {}
        }
        
        res.status(500).json({ 
            error: error.message,
            bot_id: botId
        });
    }
});

/**
 * List all recordings
 */
app.get('/v1/recordings', async (req, res) => {
    try {
        const recordings = [];
        // Look for recordings saved under runtime/<botId>/video/*.webm
        try {
            const botDirs = await fs.readdir(RUNTIME_ROOT);
            for (const d of botDirs) {
                const botDir = path.join(RUNTIME_ROOT, d);
                // Only consider directories that look like bot folders (skip 'bots' dir)
                const stat = await fs.stat(botDir).catch(() => null);
                if (!stat || !stat.isDirectory()) continue;
                if (d === 'bots') continue;

                const videoDir = path.join(botDir, 'video');
                if (!(await fs.pathExists(videoDir))) continue;

                const files = await fs.readdir(videoDir).catch(() => []);
                // Include both .webm and .mp4 files (compression may convert to .mp4)
                const videoFiles = files.filter(f => f.endsWith('.webm') || f.endsWith('.mp4'));
                for (const file of videoFiles) {
                    try {
                        const fullPath = path.join(videoDir, file);
                        const stats = await fs.stat(fullPath);
                        const botId = d;
                        const botData = activeBots.get(botId);

                        recordings.push({
                            recording_id: botId,
                            filename: path.join('runtime', botId, 'video', file),
                            size: stats.size,
                            size_mb: (stats.size / 1024 / 1024).toFixed(2),
                            created_at: stats.birthtime.toISOString(),
                            modified_at: stats.mtime.toISOString(),
                            bot_name: botData?.botName || 'Unknown',
                            meeting_url: botData?.meetingUrl || 'Unknown'
                        });
                    } catch (e) {
                        console.warn(`Warning: Could not get stats for ${file} in ${videoDir}`);
                    }
                }
            }
        } catch (e) {
            console.warn('Warning: could not scan runtime recordings:', e && e.message ? e.message : e);
        }
        
        // Sort by creation time (newest first)
        recordings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        
        res.json({
            recordings,
            total: recordings.length,
            total_size_mb: recordings.reduce((sum, r) => sum + parseFloat(r.size_mb), 0).toFixed(2)
        });
        
    } catch (error) {
        console.error('❌ Error listing recordings:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Download recording
 */
app.get('/v1/recordings/:recordingId', async (req, res) => {
    const { recordingId } = req.params;
    try {
        // Determine content type based on recording type (audio-only vs audio-video)
        let contentType = 'video/webm'; // Default to video/webm
        try {
            const botDir = path.join(RUNTIME_ROOT, recordingId);
            const metadataPath = path.join(botDir, 'bot_metadata.json');
            if (await fs.pathExists(metadataPath)) {
                const metadata = await fs.readJson(metadataPath);
                if (metadata.recordingType === 'audio-only') {
                    contentType = 'audio/webm';
                    console.log(`🎵 Serving audio-only recording: ${recordingId}`);
                } else {
                    console.log(`🎥 Serving video recording: ${recordingId}`);
                }
            }
        } catch (e) {
            console.warn(`⚠️  Could not read metadata for content type, defaulting to video/webm: ${e.message}`);
        }

        // Quick local check first: if file exists locally, serve it directly and skip S3 checks.
    const localVideoCandidateDir = path.join(RUNTIME_ROOT, recordingId, 'video');
    const localCandidateEarly = await findVideoFile(recordingId, localVideoCandidateDir);
        if (localCandidateEarly && await fs.pathExists(localCandidateEarly)) {
            // Serve local file immediately (range handling follows the existing local path logic)
            const stats = await fs.stat(localCandidateEarly);
            const fileSize = stats.size;
            const fileExt = path.extname(localCandidateEarly).toLowerCase();
            let actualContentType = contentType;
            if (fileExt === '.mp4') actualContentType = contentType.replace('webm', 'mp4');

            // mark cache
            try { recordingStorageCache.set(recordingId, { where: 'local', ts: Date.now() }); } catch (e) {}

            // Support HTTP Range requests for video streaming (essential for large files)
            const lastModified = stats.mtime.toUTCString();
            const etag = `${stats.size}-${stats.mtimeMs}`;

            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Type', actualContentType);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Last-Modified', lastModified);
            res.setHeader('ETag', etag);

            if (req.method === 'HEAD') { res.setHeader('Content-Length', fileSize); return res.end(); }

            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                let start = parts[0] ? parseInt(parts[0], 10) : NaN;
                let end = parts[1] ? parseInt(parts[1], 10) : NaN;
                if (isNaN(start) && !isNaN(end)) { const suffixLen = end; start = Math.max(0, fileSize - suffixLen); end = fileSize - 1; } else { if (isNaN(end)) end = fileSize - 1; }
                if (isNaN(start) || start < 0 || start >= fileSize || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` }); return res.end(); }
                const chunksize = (end - start) + 1;
                const file = fs.createReadStream(localCandidateEarly, { start, end, highWaterMark: 1024 * 1024 });
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': actualContentType,
                    'Cache-Control': 'public, max-age=3600',
                    'Last-Modified': lastModified,
                    'ETag': etag
                });
                file.pipe(res);
                return;
            }
            res.setHeader('Content-Length', fileSize);
            const stream = fs.createReadStream(localCandidateEarly, { highWaterMark: 1024 * 1024 });
            return stream.pipe(res);
        }

        // Quick cache check: if we recently discovered this recording is in S3, short-circuit
        try {
            const cached = getRecordingStorageCacheEntry(recordingId);
            if (cached && cached.where === 's3') {
                const { getS3VideoUrl, isS3Configured } = require('./utils/s3-upload');
                if (isS3Configured()) {
                    try {
                        const signedUrl = await getS3VideoUrl(recordingId, null, 3600);
                        if (signedUrl) {
                            console.log(`📤 Cached: redirecting to signed S3 URL for ${recordingId}`);
                            return res.redirect(302, signedUrl);
                        }
                    } catch (e) {
                        console.log(`ℹ️  Cached S3 redirect failed, will fall back to normal checks: ${e.message}`);
                    }
                }
            }
        } catch (e) {
            // Continue with normal flow on any cache helper error
        }

        // First, check if video is in S3
        const { getS3VideoUrl, isS3Configured } = require('./utils/s3-upload');
        if (isS3Configured()) {
            try {
                const botDir = path.join(RUNTIME_ROOT, recordingId);
                const metadataPath = path.join(botDir, 'bot_metadata.json');
                
                if (await fs.pathExists(metadataPath)) {
                    const metadata = await fs.readJson(metadataPath);
                    if (metadata.s3Key || metadata.s3VideoUrl) {
                        // Generate signed URL and redirect
                        const signedUrl = await getS3VideoUrl(recordingId, null, 3600); // 1 hour
                        if (signedUrl) {
                            console.log(`📤 Redirecting to signed S3 URL for ${recordingId}`);
                            try { recordingStorageCache.set(recordingId, { where: 's3', ts: Date.now() }); } catch (e) {}
                            return res.redirect(302, signedUrl);
                        }
                    }
                }
                
                // Try to generate signed URL even if metadata doesn't have it
                const signedUrl = await getS3VideoUrl(recordingId, null, 3600); // 1 hour
                if (signedUrl) {
                    // Check if file exists in S3 by trying to get metadata
                    const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
                    const s3 = new S3Client({
                        credentials: {
                            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                        },
                        region: process.env.AWS_REGION || 'us-east-1'
                    });
                    
                    try {
                        // Try .mp4 first (compressed files), then .webm
                        let s3Key = `videos/${recordingId}/${recordingId}.mp4`;
                        let fileExists = false;
                        
                        try {
                            await s3.send(new HeadObjectCommand({
                                Bucket: process.env.AWS_S3_BUCKET,
                                Key: s3Key
                            }));
                            fileExists = true;
                        } catch (e) {
                            // Try .webm if .mp4 doesn't exist
                            s3Key = `videos/${recordingId}/${recordingId}.webm`;
                            try {
                                await s3.send(new HeadObjectCommand({
                                    Bucket: process.env.AWS_S3_BUCKET,
                                    Key: s3Key
                                }));
                                fileExists = true;
                            } catch (e2) {
                                // Neither file exists
                                fileExists = false;
                            }
                        }
                        
                        if (fileExists) {
                            // File exists in S3, redirect to signed URL
                            console.log(`📤 Redirecting to signed S3 URL: ${recordingId}`);
                            try { recordingStorageCache.set(recordingId, { where: 's3', ts: Date.now() }); } catch (e) {}
                            return res.redirect(302, signedUrl);
                        } else {
                            // File doesn't exist in S3, fall through to local
                            console.log(`ℹ️  Video not found in S3, checking local storage...`);
                        }
                    } catch (e) {
                        // Error checking S3, fall through to local
                        console.log(`ℹ️  Error checking S3, checking local storage:`, e.message);
                    }
                }
            } catch (e) {
                console.warn(`⚠️  Error checking S3:`, e.message);
                // Fall through to local storage
            }
        }

        // Fallback: look under runtime/<botId>/video/<botId>.mp4 or .webm
        const videoDir = path.join(RUNTIME_ROOT, recordingId, 'video');
        const candidate = await findVideoFile(recordingId, videoDir);
        if (candidate && await fs.pathExists(candidate)) {
            const stats = await fs.stat(candidate);
            try { recordingStorageCache.set(recordingId, { where: 'local', ts: Date.now() }); } catch (e) {}
            const fileSize = stats.size;
            
            // Determine content type based on actual file extension
            const fileExt = path.extname(candidate).toLowerCase();
            let actualContentType = contentType;
            if (fileExt === '.mp4') {
                actualContentType = contentType.replace('webm', 'mp4');
            }
            
            // Support HTTP Range requests for video streaming (essential for large files)
            const lastModified = stats.mtime.toUTCString();
            const etag = `${stats.size}-${stats.mtimeMs}`;

            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Type', actualContentType);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Last-Modified', lastModified);
            res.setHeader('ETag', etag);

            // Handle HEAD requests quickly (return headers only)
            if (req.method === 'HEAD') {
              // Indicate full length for HEAD so client can inspect size
              res.setHeader('Content-Length', fileSize);
              return res.end();
            }

            // Handle range requests for seeking in large video files
            const range = req.headers.range;
            if (range) {
                // Support suffix ranges like bytes=-500 and normal ranges
                const parts = range.replace(/bytes=/, "").split("-");
                let start = parts[0] ? parseInt(parts[0], 10) : NaN;
                let end = parts[1] ? parseInt(parts[1], 10) : NaN;

                if (isNaN(start) && !isNaN(end)) {
                    // suffix length: last `end` bytes
                    const suffixLen = end;
                    start = Math.max(0, fileSize - suffixLen);
                    end = fileSize - 1;
                } else {
                    if (isNaN(end)) end = fileSize - 1;
                }

                // Validate range
                if (isNaN(start) || start < 0 || start >= fileSize || start > end) {
                    // 416 Range Not Satisfiable
                    res.writeHead(416, {
                        'Content-Range': `bytes */${fileSize}`
                    });
                    return res.end();
                }

                const chunksize = (end - start) + 1;
                const file = fs.createReadStream(candidate, { start, end, highWaterMark: 1024 * 1024 }); // 1MB buffer for faster piping

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': actualContentType,
                    'Cache-Control': 'public, max-age=3600',
                    'Last-Modified': lastModified,
                    'ETag': etag
                });

                file.pipe(res);
                return;
            }

            // No range request - stream full file for playback (do NOT force attachment)
            res.setHeader('Content-Length', fileSize);
            const stream = fs.createReadStream(candidate, { highWaterMark: 1024 * 1024 });
            return stream.pipe(res);
        }

        // Fallback: check root (legacy) - try both .mp4 and .webm
        const legacyMp4 = `${recordingId}.mp4`;
        const legacyWebm = `${recordingId}.webm`;
        let legacy = null;
        if (await fs.pathExists(legacyMp4)) {
            legacy = legacyMp4;
        } else if (await fs.pathExists(legacyWebm)) {
            legacy = legacyWebm;
        }
        
        if (legacy) {
            const stats = await fs.stat(legacy);
            try { recordingStorageCache.set(recordingId, { where: 'local', ts: Date.now() }); } catch (e) {}
            const fileSize = stats.size;
            
            // Determine content type based on actual file extension
            const legacyExt = path.extname(legacy).toLowerCase();
            let legacyContentType = contentType;
            if (legacyExt === '.mp4') {
                legacyContentType = contentType.replace('webm', 'mp4');
            }
            
            // Support HTTP Range requests for legacy files too
            const lastModifiedLegacy = stats.mtime.toUTCString();
            const etagLegacy = `${stats.size}-${stats.mtimeMs}`;

            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Type', legacyContentType);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Last-Modified', lastModifiedLegacy);
            res.setHeader('ETag', etagLegacy);

            if (req.method === 'HEAD') {
              res.setHeader('Content-Length', fileSize);
              return res.end();
            }

            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                let start = parts[0] ? parseInt(parts[0], 10) : NaN;
                let end = parts[1] ? parseInt(parts[1], 10) : NaN;

                if (isNaN(start) && !isNaN(end)) {
                    const suffixLen = end;
                    start = Math.max(0, fileSize - suffixLen);
                    end = fileSize - 1;
                } else {
                    if (isNaN(end)) end = fileSize - 1;
                }

                if (isNaN(start) || start < 0 || start >= fileSize || start > end) {
                    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
                    return res.end();
                }

                const chunksize = (end - start) + 1;
                const file = fs.createReadStream(legacy, { start, end, highWaterMark: 1024 * 1024 });
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': legacyContentType,
                    'Cache-Control': 'public, max-age=3600',
                    'Last-Modified': lastModifiedLegacy,
                    'ETag': etagLegacy
                });

                file.pipe(res);
                return;
            }

            // No range request - stream full file
            res.setHeader('Content-Length', fileSize);
            const stream = fs.createReadStream(legacy, { highWaterMark: 1024 * 1024 });
            return stream.pipe(res);
        }

        return res.status(404).json({ 
            error: 'Recording not found',
            recording_id: recordingId,
            attempted_paths: [candidate, legacy]
        });
    } catch (error) {
        console.error(`❌ Error downloading ${req.params.recordingId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get live captions for a bot
 */
app.get('/v1/transcripts/:botId', async (req, res) => {
    const { botId } = req.params;
    try {
        const botRootDir = path.join(RUNTIME_ROOT, botId);
        const captionsPath = path.join(botRootDir, 'transcripts', 'captions.json');

        let captions = null;

        if (await fs.pathExists(captionsPath)) {
            try {
                const raw = await fs.readFile(captionsPath, 'utf8');
                captions = JSON.parse(raw);
            } catch {}
        }

        res.json({
            bot_id: botId,
            captions,
            updated_at: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get environment info
 */
app.get('/v1/info', (req, res) => {
    const openaiInfo = getModelInfo();
    res.json({
        server: 'Google Meet Recording Bot API',
        version: '2.0.0',
        features: {
            webrtc_recording: true,
            ai_summaries: openaiInfo.configured,
            webhooks: false,
            ws_audio_streaming: false,
            server_side_asr: false,
            sse_monitoring: false,
            authentication: true,
            database: 'SQLite3'
        },
        openai: {
            configured: openaiInfo.configured,
            model: openaiInfo.model,
            status: openaiInfo.configured ? 'ready' : 'not configured'
        },
        environment: {
            node_version: process.version,
            port: PORT
        },
        endpoints: {
            'POST /api/signup': 'User registration',
            'POST /api/login': 'User authentication',
            'GET /api/config': 'Get user configuration (auth)',
            'POST /api/config': 'Save user configuration (auth)',
            'GET /api/bots': 'Get user bots (auth)',
            'GET /api/bots/:id': 'Get bot details (auth)',
            'POST /v1/bots': 'Create recording bot',
            'GET /v1/bots': 'List all bots',
            'GET /v1/bots/:id': 'Get bot status',
            'DELETE /v1/bots/:id': 'Stop bot',
            'GET /v1/recordings': 'List recordings',
            'GET /v1/recordings/:id': 'Download recording',
            'GET /v1/transcripts/:id': 'Get live captions for a bot',
            'GET /v1/bots/:id/participants': 'Diagnostics for participant counting',
        }
    });
});

/**
 * Public share endpoint - no authentication required
 * Returns meeting data for shareable link
 */
app.get('/api/share/:shareToken', async (req, res) => {
    try {
        const { shareToken } = req.params;
        
        // Share token is just the botId for now (could be enhanced with expiration)
        const botId = shareToken;
        
        const botDir = path.join(RUNTIME_ROOT, botId);
        
        // Check if bot directory exists
        if (!(await fs.pathExists(botDir))) {
            return res.status(404).json({
                success: false,
                error: 'Meeting not found'
            });
        }
        
        // Load bot data - use cached reads and parallel loading
        const metadataPath = path.join(botDir, 'bot_metadata.json');
        const summaryPath = path.join(botDir, 'summary.txt');
        const captionsPath = path.join(botDir, 'transcripts', 'captions.json');
        const metricsPath = path.join(botDir, 'MeetingMetrics.json');
        
        // Generate signed S3 URL if video is in S3 - use cached read
        let s3VideoUrl = null;
        const metadata = await getCachedFile(metadataPath, fs.readJson, 60000).catch(() => null);
        if (metadata && (metadata.s3Key || metadata.s3VideoUrl)) {
            try {
                // Generate signed URL for secure access (expires in 4 hours)
                // URL is cached to avoid regenerating on every request
                const { getS3VideoUrl } = require('./utils/s3-upload');
                s3VideoUrl = await getS3VideoUrl(botId, null, 14400); // 4 hours
                
                if (s3VideoUrl) {
                    console.log(`🔐 Generated signed S3 URL for shared bot ${botId}`);
                } else {
                    console.warn(`⚠️  Failed to generate signed URL for shared bot ${botId}`);
                }
            } catch (e) {
                console.warn('Could not generate S3 URL');
            }
        }
        
        // Load all files in parallel for better performance
        const [summaryResult, metricsResult] = await Promise.allSettled([
            getCachedFile(summaryPath, (p) => fs.readFile(p, 'utf8'), 30000).catch(() => null),
            getCachedFile(metricsPath, (p) => fs.readFile(p, 'utf8').then(d => JSON.parse(d)), 30000).catch(() => null)
        ]);
        
        let summary = 'No summary available';
        let metrics = null;
        
        // Load summary
        if (summaryResult.status === 'fulfilled' && summaryResult.value) {
            summary = summaryResult.value;
        }
        
        // Load metrics first to get meeting start time
        if (metricsResult.status === 'fulfilled' && metricsResult.value) {
            metrics = metricsResult.value;
        }
        
        // Load captions and build transcript (after loading metrics) - use cached read
        let rawCaptions = [];
        let transcript = [];
        console.log(`📄 Looking for captions at: ${captionsPath}`);
        
        const captionsData = await getCachedFile(captionsPath, (p) => fs.readFile(p, 'utf8').then(d => JSON.parse(d)), 30000).catch(() => null);
        if (captionsData) {
            try {
                rawCaptions = captionsData;
                console.log(`✅ Loaded ${rawCaptions?.length || 0} raw captions from file`);
                
                // Build utterances from captions
                if (rawCaptions && rawCaptions.length > 0) {
                    const { buildUtterances } = require('./openai-service');
                    // Use meeting start time from metrics if available
                    const meetingStartTime = metrics?.duration?.startTime || null;
                    transcript = buildUtterances(rawCaptions, meetingStartTime);
                    console.log(`✅ Built ${transcript?.length || 0} utterances from captions`);
                } else {
                    console.warn(`⚠️  Captions file exists but is empty or invalid`);
                }
            } catch (error) {
                console.error(`❌ Error parsing captions:`, error.message);
            }
        } else {
            console.warn(`⚠️  Captions file not found at: ${captionsPath}`);
            
            // Try alternative paths
            const altPaths = [
                path.join(botDir, 'captions.json'),
                path.join(botDir, 'transcript.json'),
                path.join(botDir, 'transcripts.json')
            ];
            
            for (const altPath of altPaths) {
                const altCaptions = await getCachedFile(altPath, (p) => fs.readFile(p, 'utf8').then(d => JSON.parse(d)), 30000).catch(() => null);
                if (altCaptions) {
                    console.log(`📄 Trying alternative path: ${altPath}`);
                    try {
                        rawCaptions = altCaptions;
                        console.log(`✅ Loaded ${rawCaptions?.length || 0} raw captions from alternative path`);
                        
                        if (rawCaptions && rawCaptions.length > 0) {
                            const { buildUtterances } = require('./openai-service');
                            const meetingStartTime = metrics?.duration?.startTime || null;
                            transcript = buildUtterances(rawCaptions, meetingStartTime);
                            console.log(`✅ Built ${transcript?.length || 0} utterances from alternative captions`);
                        }
                        break;
                    } catch (error) {
                        console.error(`❌ Error reading alternative captions file:`, error.message);
                    }
                }
            }
        }
        
        // Load OpenAI-generated keywords and title in parallel
        const keywordsPath = path.join(botDir, 'keywords.json');
        const [keywordsResult] = await Promise.allSettled([
            getCachedFile(keywordsPath, (p) => fs.readFile(p, 'utf8').then(d => JSON.parse(d)), 30000).catch(() => null)
        ]);
        
        let keywords = [];
        if (keywordsResult.status === 'fulfilled' && keywordsResult.value) {
            keywords = keywordsResult.value;
        }
        
        // Load metadata to get title (already loaded above)
        const title = metadata?.title || null;
        
        // Build bot info
        const bot = {
            id: botId,
            title: title || botId, // Use title from metadata, fallback to botId (matching botdetail behavior)
            createdAt: metrics?.duration?.startTime || null,
            duration: metrics?.duration ? 
                `${metrics.duration.totalMinutes} min` : null,
            videoUrl: s3VideoUrl || `/v1/recordings/${botId}`, // S3 URL if available, otherwise local
            s3VideoUrl: s3VideoUrl, // Explicit S3 URL field
            metrics: metrics, // Include full metrics for video player duration
            keywords: keywords // Include OpenAI-generated keywords
        };
        
        res.json({
            success: true,
            bot,
            transcript,
            apiTranscript: rawCaptions, // Return raw captions for frontend processing
            summary
        });
        
    } catch (error) {
        console.error('Error serving shared meeting:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to load meeting'
        });
    }
});

/**
 * Generate and download PDF export of transcript and summary
 */
app.get('/v1/bots/:botId/export/pdf', async (req, res) => {
    try {
        const { botId } = req.params;
        
        const botDir = path.join(RUNTIME_ROOT, botId);
        if (!(await fs.pathExists(botDir))) {
            return res.status(404).json({ error: 'Bot not found' });
        }
        
        console.log(`📄 Generating PDF for bot ${botId}...`);
        
        const { generateBotPDF } = require('./utils/pdf-export');
        const { pdfPath, meetingTitle } = await generateBotPDF(botId, RUNTIME_ROOT);
        
        // Sanitize title for filename (remove invalid characters)
        const sanitizeFilename = (text) => {
            return text.replace(/[^\w\-_.() ]/g, '_').replace(/\s+/g, '_').substring(0, 80);
        };
        const sanitizedTitle = sanitizeFilename(meetingTitle || `Meeting-${botId.slice(0, 8)}`);
        
        // Send PDF file with meeting title in filename (include botId for uniqueness)
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="meeting-transcript-${sanitizedTitle}-${botId.slice(0, 8)}.pdf"`);
        
        const pdfStream = fs.createReadStream(pdfPath);
        pdfStream.pipe(res);
        
        pdfStream.on('error', (error) => {
            console.error('Error streaming PDF:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to generate PDF' });
            }
        });
        
    } catch (error) {
        console.error(`❌ Error generating PDF for bot ${req.params.botId}:`, error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to generate PDF', message: error.message });
        }
    }
});


// Error handling middleware
app.use((error, req, res, next) => {
    console.error('❌ Unhandled error:', error);
    res.status(500).json({
        error: 'Internal server error',
        message: error.message
    });
});

// Serve HTML pages explicitly
app.get('/reset-password', (req, res) => {
    // Redirect to Next.js frontend reset-password route (preserve query string)
    return res.redirect(FRONTEND_URL + req.originalUrl);
});

app.get('/signin', (req, res) => {
    return res.redirect(FRONTEND_URL + req.originalUrl);
});

app.get('/signup', (req, res) => {
    return res.redirect(FRONTEND_URL + req.originalUrl);
});

// Serve main page
app.get('/', (req, res) => {
    return res.redirect(FRONTEND_URL);
});

// 404 handler for API routes only
app.use('/api/*', (req, res) => {
    res.status(404).json({
        error: 'API endpoint not found',
        available_endpoints: [
            'POST /api/signup',
            'POST /api/login',
            'POST /api/forgot-password',
            'POST /api/reset-password',
            'GET /api/verify-email',
            'POST /api/resend-verification',
            'GET /api/config',
            'POST /api/config',
            'GET /api/bots',
            'POST /api/bots',
            'GET /api/bots/:id',
            'DELETE /api/bots/:id'
        ]
    });
});

// 404 handler for v1 API routes
app.use('/v1/*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        available_endpoints: [
            'GET /health',
            'GET /v1/info', 
            'POST /v1/bots',
            'GET /v1/bots',
            'GET /v1/bots/:id',
            'DELETE /v1/bots/:id',
            'GET /v1/recordings',
            'GET /v1/recordings/:id'
        ]
    });
});

// General 404 handler for other routes
app.use((req, res) => {
    // For HTML requests, redirect to main page
    if (req.accepts('html')) {
        // Redirect HTML requests to frontend app
        res.redirect(FRONTEND_URL);
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

// Start server (only when run directly). This allows tests to require the app
// without starting a listener and prevents EADDRINUSE during automated tests.
let server = null;
if (require.main === module) {
    server = app.listen(PORT, () => {
        console.log(`🚀 Google Meet Recording Bot API`);
        console.log(`📡 Server running on http://localhost:${PORT}`);
        
        console.log(``);
        console.log(`📖 API Endpoints:`);
        console.log(`   Health Check: http://localhost:${PORT}/health`);
        console.log(`   API Info:     http://localhost:${PORT}/v1/info`);
        console.log(``);
        console.log(`🤖 Test Bot Creation (PowerShell):`);
        console.log(`   See examples/test.py or use test-api.json file`);

        // On startup, attempt to clean up any leftover Chrome processes
        cleanupLeftoverBrowsers()
            .then(() => console.log('🧹 Startup cleanup of leftover Chrome processes completed'))
            .catch(() => console.warn('⚠️ Startup cleanup encountered issues'));
    });
}

// Graceful shutdown to avoid orphaned browsers/bots on restarts
let serverClosePromise = null;
async function gracefulShutdown(reason = 'shutdown') {
    try {
        console.log(`\n⚙️  Initiating graceful shutdown due to: ${reason}`);
        console.log(`📊 Active bots: ${activeBots.size}`);
        
        // Ask all active bots to leave meetings
        const shutdownPromises = [];
        for (const [botId, botData] of activeBots.entries()) {
            try {
                console.log(`🛑 Requesting bot ${botId} to leave...`);
                
                // Clear TTL timer
                if (botData.ttlTimer) {
                    clearTimeout(botData.ttlTimer);
                    botData.ttlTimer = null;
                }
                
                // Call leaveMeet to handle all cleanup
                if (botData?.bot?.leaveMeet) {
                    shutdownPromises.push(
                        botData.bot.leaveMeet().catch((e) => {
                            console.error(`Error during bot ${botId} shutdown:`, e);
                        })
                    );
                }
            } catch (e) {
                console.error(`Error initiating shutdown for bot ${botId}:`, e);
            }
        }
        
        // Wait for all bots to finish leaving (with timeout)
        console.log(`⏳ Waiting for ${shutdownPromises.length} bots to complete...`);
        await Promise.race([
            Promise.allSettled(shutdownPromises),
            new Promise(resolve => setTimeout(resolve, 10000)) // 10 second timeout
        ]);
        console.log(`✅ All bots shutdown complete`);
        
        // Force clear all active bots
        activeBots.clear();
        console.log(`🗑️  Cleared all active bot sessions`);
        
    } catch (e) {
        console.error('❌ Error during bot shutdown:', e);
    }
    
    // Close HTTP server once (if it exists)
    try {
        if (server) {
            if (!serverClosePromise) {
                serverClosePromise = new Promise(resolve => server.close(resolve));
            }
            await serverClosePromise;
            console.log('✅ HTTP server closed');
        }
    } catch (e) {
        console.warn('⚠️ Error closing HTTP server:', e && e.message ? e.message : e);
    }
    
    // Close database connection
    try {
        closeDatabase();
        console.log('✅ Database connection closed');
    } catch (e) {
        console.warn('⚠️ Error closing database:', e && e.message ? e.message : e);
    }
}

process.once('SIGINT', () => {
    gracefulShutdown('SIGINT (Ctrl+C)').finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
    gracefulShutdown('SIGTERM').finally(() => process.exit(0));
});
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught exception:', err);
    gracefulShutdown('uncaughtException').finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled rejection:', reason);
    gracefulShutdown('unhandledRejection').finally(() => process.exit(1));
});

module.exports = app;

