const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { Bot } = require('./bot');
const path = require('path');
const fs = require('fs-extra');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { userOps, botOps, closeDatabase } = require('./database');
const { generateAndSaveSummary, getModelInfo } = require('./openai-service');

const app = express();
app.use(express.json());
// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';
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
        
        if (!token) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Email Verification - CXFlow</title>
                    <style>
                        body { font-family: 'Poppins', Arial, sans-serif; text-align: center; padding: 50px; background: #f3f4f6; }
                        .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                        .error { color: #dc2626; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1 class="error">❌ Invalid Verification Link</h1>
                        <p>The verification link is invalid or missing.</p>
                        <a href="/signup.html">Sign up again</a>
                    </div>
                </body>
                </html>
            `);
        }
        
        const user = userOps.verifyEmail(token);
        
        if (user) {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Email Verified - CXFlow</title>
                    <style>
                        body { font-family: 'Poppins', Arial, sans-serif; text-align: center; padding: 50px; background: #f3f4f6; }
                        .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                        .success { color: #059669; }
                        .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; margin-top: 20px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1 class="success">✅ Email Verified Successfully!</h1>
                        <p>Your email address has been verified. You can now sign in to your CXFlow account.</p>
                        <a href="/signin.html" class="button">Sign In Now</a>
                    </div>
                </body>
                </html>
            `);
        } else {
            res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Email Verification - CXFlow</title>
                    <style>
                        body { font-family: 'Poppins', Arial, sans-serif; text-align: center; padding: 50px; background: #f3f4f6; }
                        .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                        .error { color: #dc2626; }
                        .button { display: inline-block; background: #6b7280; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; margin-top: 20px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1 class="error">❌ Verification Failed</h1>
                        <p>The verification link is invalid or has expired. Please sign up again to receive a new verification email.</p>
                        <a href="/signup.html" class="button">Sign Up Again</a>
                    </div>
                </body>
                </html>
            `);
        }
    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Email Verification Error - CXFlow</title>
                <style>
                    body { font-family: 'Poppins', Arial, sans-serif; text-align: center; padding: 50px; background: #f3f4f6; }
                    .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    .error { color: #dc2626; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1 class="error">❌ Server Error</h1>
                    <p>An error occurred during email verification. Please try again later.</p>
                </div>
            </body>
            </html>
        `);
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
            // Don't reveal if email exists or not for security
            return res.json({ success: true, message: 'If an account with that email exists, we sent a reset link.' });
        }
        
        // Generate reset token (valid for 1 hour)
        const resetToken = require('crypto').randomBytes(32).toString('hex');
        const resetExpires = Date.now() + (60 * 60 * 1000); // 1 hour from now
        
        // Save reset token to database
        userOps.setResetToken(email, resetToken, resetExpires);
        
        // Send reset email
        const { sendPasswordResetEmail } = require('./utils/email-service');
        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        
        await sendPasswordResetEmail(email, resetToken, baseUrl);
        
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
        const { botId, shareUrl, isPublicShare } = req.body;
        
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
            
            // Get the bot owner's email
            user = userOps.findById(bot.user_id);
            if (!user || !user.email || !user.email_verified) {
                return res.status(400).json({ 
                    error: 'Cannot send email - bot owner email not available or not verified' 
                });
            }
            
            console.log(`📧 Public share: sending bot ${botId} summary to owner: ${user.email}...`);
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
            
            // Get user email
            user = userOps.findById(req.user.id);
            if (!user || !user.email || !user.email_verified) {
                return res.status(400).json({ error: 'User email not found or not verified' });
            }
            
            console.log(`📧 Authenticated share: sending bot ${botId} to: ${user.email}...`);
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
 * Get user's bots (authenticated)
 */
app.get('/api/bots', authMiddleware, async (req, res) => {
    try {
        const userBots = botOps.findByUserId(req.user.id);
        
        // Convert snake_case to camelCase for frontend compatibility
        const formattedBots = userBots.map(bot => ({
            id: bot.id,
            userId: bot.user_id,
            meetUrl: bot.meet_url,
            title: bot.title,
            status: bot.status,
            error: bot.error,
            createdAt: bot.created_at,
            startedAt: bot.started_at,
            endTime: bot.ended_at
        }));
        
        // Also check runtime directory for historical bots not in DB
        try {
            const runtimeDirs = await fs.readdir(RUNTIME_ROOT);
            const dbBotIds = new Set(formattedBots.map(b => b.id));
            
            for (const dirName of runtimeDirs) {
                // Skip if already in DB or not a valid bot directory
                if (dbBotIds.has(dirName) || dirName === 'bots') continue;
                
                const botDir = path.join(RUNTIME_ROOT, dirName);
                const stat = await fs.stat(botDir).catch(() => null);
                
                if (!stat || !stat.isDirectory()) continue;
                
                // Check if this directory has bot data (video, transcript, or summary)
                const videoPath = path.join(botDir, 'video', `${dirName}.webm`);
                const metricsPath = path.join(botDir, 'MeetingMetrics.json');
                const metadataPath = path.join(botDir, 'bot_metadata.json');
                const hasData = await fs.pathExists(videoPath) || await fs.pathExists(metricsPath);
                
                if (hasData) {
                    // Check user ownership from metadata file
                    let metadata = null;
                    let belongsToUser = false;
                    
                    if (await fs.pathExists(metadataPath)) {
                        try {
                            metadata = await fs.readJson(metadataPath);
                            belongsToUser = metadata.userId === req.user.id;
                        } catch (e) {
                            console.warn(`Could not parse metadata for ${dirName}`);
                        }
                    }
                    
                    // Only show historical bots that belong to this user
                    if (belongsToUser) {
                        // This is a historical bot - try to restore info from metrics
                        let metrics = null;
                        if (await fs.pathExists(metricsPath)) {
                            try {
                                metrics = JSON.parse(await fs.readFile(metricsPath, 'utf8'));
                            } catch (e) {
                                console.warn(`Could not parse metrics for ${dirName}`);
                            }
                        }
                        
                        // Add to bot list as historical/orphaned bot
                        formattedBots.push({
                            id: dirName,
                            userId: req.user.id,
                            meetUrl: metadata?.meetUrl || metrics?.meetUrl || 'N/A',
                            title: metadata?.title || `Historical Meeting ${dirName.slice(0, 8)}`,
                            status: 'completed',
                            error: null,
                            createdAt: metadata?.createdAt || metrics?.duration?.startTime || stat.mtime.toISOString(),
                            startedAt: metrics?.duration?.startTime || stat.mtime.toISOString(),
                            endTime: metrics?.duration?.endTime || stat.mtime.toISOString(),
                            isHistorical: true // Flag to indicate this bot was restored from files
                        });
                        
                        console.log(`📂 Found historical bot: ${dirName}`);
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
                // Check user ownership from metadata
                const metadataPath = path.join(botDir, 'bot_metadata.json');
                let metadata = null;
                let belongsToUser = false;
                
                if (await fs.pathExists(metadataPath)) {
                    try {
                        metadata = await fs.readJson(metadataPath);
                        belongsToUser = metadata.userId === req.user.id;
                    } catch (e) {
                        console.warn(`Could not parse metadata for ${req.params.id}`);
                    }
                }
                
                if (!belongsToUser) {
                    console.log(`❌ Bot ${req.params.id} does not belong to user ${req.user.id}`);
                    return res.status(403).json({ error: 'Access denied' });
                }
                
                // Try to load metrics
                const metricsPath = path.join(botDir, 'MeetingMetrics.json');
                let metrics = null;
                
                if (await fs.pathExists(metricsPath)) {
                    try {
                        metrics = JSON.parse(await fs.readFile(metricsPath, 'utf8'));
                    } catch (e) {
                        console.warn(`Could not parse metrics for ${req.params.id}`);
                    }
                }
                
                const stat = await fs.stat(botDir);
                
                // Create a historical bot entry
                formattedBot = {
                    id: req.params.id,
                    userId: req.user.id,
                    meetUrl: metadata?.meetUrl || metrics?.meetUrl || 'N/A',
                    title: metadata?.title || `Historical Meeting ${req.params.id.slice(0, 8)}`,
                    status: 'completed',
                    error: null,
                    createdAt: metadata?.createdAt || metrics?.duration?.startTime || stat.mtime.toISOString(),
                    startedAt: metrics?.duration?.startTime || stat.mtime.toISOString(),
                    endTime: metrics?.duration?.endTime || stat.mtime.toISOString(),
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
            
            // Generate signed S3 URL if video is in S3
            const metadataPath = path.join(runtimeDir, 'bot_metadata.json');
            if (fs.existsSync(metadataPath)) {
                try {
                    const metadata = fs.readJsonSync(metadataPath);
                    if (metadata.s3Key || metadata.s3VideoUrl) {
                        // Generate signed URL for secure access (expires in 4 hours)
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
            
            // Read transcript
            if (fs.existsSync(transcriptPath)) {
                formattedBot.transcript = fs.readJsonSync(transcriptPath);
                console.log(`✅ Transcript loaded: ${formattedBot.transcript.length} captions`);
            } else {
                formattedBot.transcript = [];
                console.log(`⚠️  No transcript found at: ${transcriptPath}`);
            }
            
            // Read summary
            if (fs.existsSync(summaryPath)) {
                formattedBot.summary = fs.readFileSync(summaryPath, 'utf8');
                console.log(`✅ Summary loaded: ${formattedBot.summary.length} characters`);
            } else {
                formattedBot.summary = '';
                console.log(`⚠️  No summary found at: ${summaryPath}`);
            }
            
            // Read OpenAI-generated keywords
            const keywordsPath = path.join(runtimeDir, 'keywords.json');
            if (fs.existsSync(keywordsPath)) {
                try {
                    formattedBot.keywords = fs.readJsonSync(keywordsPath);
                    console.log(`✅ Keywords loaded: ${formattedBot.keywords.length} keywords`);
                } catch (e) {
                    console.warn(`⚠️  Could not read keywords: ${e.message}`);
                    formattedBot.keywords = [];
                }
            } else {
                formattedBot.keywords = [];
                console.log(`⚠️  No keywords found at: ${keywordsPath}`);
            }
            
            // Read formatted transcript if available
            if (fs.existsSync(formattedTranscriptPath)) {
                formattedBot.formattedTranscript = fs.readFileSync(formattedTranscriptPath, 'utf8');
                console.log(`✅ Formatted transcript loaded`);
            }
            
            // Read metrics if available
            const metricsPath = path.join(runtimeDir, 'MeetingMetrics.json');
            if (fs.existsSync(metricsPath)) {
                try {
                    formattedBot.metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
                    console.log(`✅ Metrics loaded`);
                } catch (e) {
                    console.warn(`⚠️  Could not parse metrics:`, e.message);
                }
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
            bot_name = "CXFlow Meeting Bot",
            caption_language = "es",  // Default to Spanish
            email_recipients = null  // Optional: comma-separated email addresses
        } = req.body;

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
        
        // Save bot to database (user is authenticated at this point)
        botOps.create(botId, req.user.id, meeting_url, bot_name);
        
        // Save user_id to metadata file for historical recovery
        try {
            const botDir = path.join(RUNTIME_ROOT, botId);
            await fs.ensureDir(botDir);
            const metadataPath = path.join(botDir, 'bot_metadata.json');
            await fs.writeJson(metadataPath, {
                botId,
                userId: req.user.id, // User is authenticated, so this is always available
                meetUrl: meeting_url,
                title: bot_name,
                captionLanguage: caption_language || 'es', // Save language preference
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
                await generateAndSaveSummary(botId, RUNTIME_ROOT);
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

            // Send email summary to bot creator (after summary is generated)
            try {
                // Get bot from database to find the user who created it
                const bot = botOps.findById(botId);
                if (bot && bot.user_id) {
                    // Get user email
                    const user = userOps.findById(bot.user_id);
                    if (user && user.email && user.email_verified) {
                        const { sendMeetingSummaryEmail } = require('./utils/email-service');
                        console.log(`📧 Bot ${botId}: sending meeting summary email to bot creator: ${user.email}...`);
                        
                        const emailResult = await sendMeetingSummaryEmail({
                            botId: botId,
                            meetUrl: bot.meet_url,
                            recipients: user.email,
                            runtimeRoot: RUNTIME_ROOT
                        });
                        
                        if (emailResult.success) {
                            console.log(`✅ Bot ${botId}: summary email sent successfully to ${user.email} (${emailResult.attachments} attachments)`);
                        } else {
                            console.log(`⚠️ Bot ${botId}: email sending failed - ${emailResult.message || emailResult.error}`);
                        }
                    } else if (user && !user.email_verified) {
                        console.log(`⚠️ Bot ${botId}: user email not verified, skipping summary email`);
                    } else {
                        console.log(`⚠️ Bot ${botId}: user not found or no email, skipping summary email`);
                    }
                } else {
                    console.log(`⚠️ Bot ${botId}: bot not found in database, skipping summary email`);
                }
            } catch (e) {
                console.error(`❌ Error sending summary email for bot ${botId}:`, e && e.message ? e.message : e);
            }

             // Also send to additional recipients if configured (legacy functionality)
             if (botData && botData.emailRecipients) {
                try {
                    const { sendMeetingSummaryEmail } = require('./utils/email-service');
                    console.log(`📧 Bot ${botId}: sending meeting summary email to additional recipients: ${botData.emailRecipients}...`);
                    
                    const emailResult = await sendMeetingSummaryEmail({
                        botId: botId,
                        meetUrl: botData.meetingUrl,
                        recipients: botData.emailRecipients,
                        runtimeRoot: RUNTIME_ROOT
                    });
                    
                    if (emailResult.success) {
                        console.log(`✅ Bot ${botId}: additional email sent successfully (${emailResult.attachments} attachments)`);
                    } else {
                        console.log(`⚠️ Bot ${botId}: additional email sending failed - ${emailResult.message || emailResult.error}`);
                    }
                } catch (e) {
                    console.error(`❌ Error sending additional email for bot ${botId}:`, e && e.message ? e.message : e);
                }
            }

            // If a recording file exists, compress and extract audio
            try {
                const botInstance = botData?.bot;
                if (botInstance && typeof botInstance.getStats === 'function') {
                    const stats = botInstance.getStats();
                    const recordingFile = stats.recordingFile || stats.recordingPath;
                    if (recordingFile && fs.existsSync(recordingFile)) {
                        // Compress video to reduce file size (enabled by default for optimization)
                        // Can be disabled by setting ENABLE_VIDEO_COMPRESSION=false for maximum speed
                        const enableCompression = process.env.ENABLE_VIDEO_COMPRESSION !== 'false';
                        
                        // Fast mode: skip compression for files under 100MB for maximum speed
                        const fastMode = process.env.FAST_VIDEO_MODE === 'true';
                        const stats = fs.statSync(recordingFile);
                        const sizeMB = stats.size / 1024 / 1024;
                        if (enableCompression && !(fastMode && sizeMB < 50)) {
                            try {
                                console.log(`🗜️  Bot ${botId}: compressing video (${sizeMB.toFixed(1)} MB)...`);
                                const { compressVideoInPlace, getCompressionRecommendations } = require('./utils/video-compression');
                                
                                // Get compression recommendations
                                const recommendations = await getCompressionRecommendations(recordingFile);
                                
                                if (recommendations.shouldCompress) {
                                    console.log(`💡 Bot ${botId}: ${recommendations.reason}`);
                                    const result = await compressVideoInPlace(recordingFile, recommendations.settings);
                                    console.log(`✅ Bot ${botId}: video compressed - saved ${result.reductionPercent}% (${result.inputSizeMB - result.outputSizeMB} MB)`);
                                } else {
                                    console.log(`ℹ️  Bot ${botId}: compression skipped - ${recommendations.reason}`);
                                }
                            } catch (e) {
                                console.error(`❌ Error compressing video for bot ${botId}:`, e && e.message ? e.message : e);
                                // Continue even if compression fails
                            }
                        }
                        
                        // Upload video to S3 if configured (with automatic retry)
                        try {
                            const { uploadVideoToS3, isS3Configured } = require('./utils/s3-upload');
                            
                            if (isS3Configured()) {
                                console.log(`☁️  Bot ${botId}: Starting S3 upload...`);
                                const uploadResult = await uploadVideoToS3(recordingFile, botId, 3); // 3 retry attempts
                                
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
                                    }
                                    
                                    // Optionally delete local file after successful upload (if configured)
                                    if (process.env.AWS_S3_DELETE_LOCAL_AFTER_UPLOAD === 'true') {
                                        try {
                                            await fs.remove(recordingFile);
                                            console.log(`🗑️  Bot ${botId}: local video file deleted after S3 upload`);
                                        } catch (e) {
                                            console.warn(`⚠️  Bot ${botId}: failed to delete local file:`, e.message);
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
                    // Clear bot instance reference
                    if (botData && botData.bot) {
                        botData.bot = null;
                    }
                    activeBots.delete(botId);
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

        // Create bot
    const bot = new Bot(botId, bot_name, onLeaveCallback, caption_language, email_recipients);
        
        // Store bot data
        const botData = {
            botId,
            bot,
            userId: req.user.id, // Store userId since authentication is required
            meetingUrl: meeting_url,
            botName: bot_name,
            captionLanguage: caption_language,
            emailRecipients: email_recipients,
            status: 'starting',
            createdAt: new Date().toISOString(),
            outputFile: `${botId}.webm`,
            ttlTimer: null,
        };
        
        activeBots.set(botId, botData);

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
            bot_name,
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
                const webmFiles = files.filter(f => f.endsWith('.webm'));
                for (const file of webmFiles) {
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
        const contentType = 'video/webm';

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
                            return res.redirect(302, signedUrl);
                        }
                    }
                }
                
                // Try to generate signed URL even if metadata doesn't have it
                const signedUrl = await getS3VideoUrl(recordingId, null, 3600); // 1 hour
                if (signedUrl) {
                    // Check if file exists in S3 by trying to get metadata
                    const AWS = require('aws-sdk');
                    const s3 = new AWS.S3({
                        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                        region: process.env.AWS_REGION || 'us-east-1'
                    });
                    
                    try {
                        const s3Key = `videos/${recordingId}/${recordingId}.webm`;
                        await s3.headObject({
                            Bucket: process.env.AWS_S3_BUCKET,
                            Key: s3Key
                        }).promise();
                        
                        // File exists in S3, redirect to signed URL
                        console.log(`📤 Redirecting to signed S3 URL: ${recordingId}`);
                        return res.redirect(302, signedUrl);
                    } catch (e) {
                        // File doesn't exist in S3, fall through to local
                        console.log(`ℹ️  Video not found in S3, checking local storage...`);
                    }
                }
            } catch (e) {
                console.warn(`⚠️  Error checking S3:`, e.message);
                // Fall through to local storage
            }
        }

        // Fallback: look under runtime/<botId>/video/<botId>.webm
        const candidate = path.join(RUNTIME_ROOT, recordingId, 'video', `${recordingId}.webm`);
        if (await fs.pathExists(candidate)) {
            const stats = await fs.stat(candidate);
            const fileSize = stats.size;
            
            // Support HTTP Range requests for video streaming (essential for large files)
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Type', contentType);
            
            // Handle range requests for seeking in large video files
            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;
                const file = fs.createReadStream(candidate, { start, end });
                
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': contentType,
                });
                
                file.pipe(res);
                return;
            }
            
            // No range request - send full file (but this should rarely happen with large files)
            res.setHeader('Content-Length', fileSize);
            res.setHeader('Content-Disposition', `attachment; filename="${recordingId}.webm"`);
            const stream = fs.createReadStream(candidate);
            return stream.pipe(res);
        }

        // Fallback: check root (legacy)
        const legacy = `${recordingId}.webm`;
        if (await fs.pathExists(legacy)) {
            const stats = await fs.stat(legacy);
            const fileSize = stats.size;
            
            // Support HTTP Range requests for legacy files too
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Type', contentType);
            
            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;
                const file = fs.createReadStream(legacy, { start, end });
                
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': contentType,
                });
                
                file.pipe(res);
                return;
            }
            
            // No range request - send full file
            res.setHeader('Content-Length', fileSize);
            res.setHeader('Content-Disposition', `attachment; filename="${recordingId}.webm"`);
            const stream = fs.createReadStream(legacy);
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
        if (!fs.existsSync(botDir)) {
            return res.status(404).json({
                success: false,
                error: 'Meeting not found'
            });
        }
        
        // Load bot data
        const metadataPath = path.join(botDir, 'bot_metadata.json');
        const summaryPath = path.join(botDir, 'summary.txt');
        const captionsPath = path.join(botDir, 'transcripts', 'captions.json');
        const metricsPath = path.join(botDir, 'MeetingMetrics.json');
        
        // Generate signed S3 URL if video is in S3
        let s3VideoUrl = null;
        if (fs.existsSync(metadataPath)) {
            try {
                const metadata = fs.readJsonSync(metadataPath);
                if (metadata.s3Key || metadata.s3VideoUrl) {
                    // Generate signed URL for secure access (expires in 4 hours)
                    const { getS3VideoUrl } = require('./utils/s3-upload');
                    s3VideoUrl = await getS3VideoUrl(botId, null, 14400); // 4 hours
                    
                    if (s3VideoUrl) {
                        console.log(`🔐 Generated signed S3 URL for shared bot ${botId}`);
                    } else {
                        console.warn(`⚠️  Failed to generate signed URL for shared bot ${botId}`);
                    }
                }
            } catch (e) {
                console.warn('Could not parse bot_metadata.json');
            }
        }
        
        let summary = 'No summary available';
        let transcript = [];
        let metrics = null;
        
        // Load summary
        if (fs.existsSync(summaryPath)) {
            summary = await fs.readFile(summaryPath, 'utf8');
        }
        
        // Load metrics first to get meeting start time
        if (fs.existsSync(metricsPath)) {
            metrics = JSON.parse(await fs.readFile(metricsPath, 'utf8'));
        }
        
        // Load captions and build transcript (after loading metrics)
        if (fs.existsSync(captionsPath)) {
            const captions = JSON.parse(await fs.readFile(captionsPath, 'utf8'));
            
            // Build utterances from captions
            if (captions && captions.length > 0) {
                const { buildUtterances } = require('./openai-service');
                // Use meeting start time from metrics if available
                const meetingStartTime = metrics?.duration?.startTime || null;
                transcript = buildUtterances(captions, meetingStartTime);
            }
        }
        
        // Load OpenAI-generated keywords
        const keywordsPath = path.join(botDir, 'keywords.json');
        let keywords = [];
        if (fs.existsSync(keywordsPath)) {
            try {
                keywords = JSON.parse(await fs.readFile(keywordsPath, 'utf8'));
            } catch (e) {
                console.warn(`⚠️  Could not read keywords: ${e.message}`);
            }
        }
        
        // Build bot info
        const bot = {
            id: botId,
            title: `Meeting ${botId.slice(0, 8)}`,
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
        if (!fs.existsSync(botDir)) {
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
    res.sendFile(path.join(__dirname, '../public/reset-password.html'));
});

app.get('/signin', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/signin.html'));
});

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/signup.html'));
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
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
        res.redirect('/');
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

