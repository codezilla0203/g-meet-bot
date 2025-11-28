const { S3Client, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const fs = require('fs-extra');
const path = require('path');
const { sendWebhook } = require('./webhook');

/**
 * S3 Upload Utility
 * Handles uploading video files to AWS S3 bucket
 */

let s3Client = null;
let s3Config = null;

// Cache for signed URLs to avoid regenerating on every request
// Format: { botId: { url: string, expiresAt: number } }
const signedUrlCache = new Map();

/**
 * Initialize S3 client if credentials are provided
 */
function initS3() {
    if (s3Client) return s3Client;
    
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION || 'us-east-1';
    const bucket = process.env.AWS_S3_BUCKET;
    
    // Only initialize if credentials are provided
    if (!accessKeyId || !secretAccessKey || !bucket) {
        console.log('ℹ️  S3 not configured - videos will be stored locally');
        console.log('ℹ️  Missing env vars:', {
            AWS_ACCESS_KEY_ID: accessKeyId ? '✅' : '❌',
            AWS_SECRET_ACCESS_KEY: secretAccessKey ? '✅' : '❌',
            AWS_S3_BUCKET: bucket ? '✅' : '❌',
            AWS_REGION: region
        });
        return null;
    }
    
    s3Config = {
        accessKeyId,
        secretAccessKey,
        region,
        bucket
    };
    
    s3Client = new S3Client({
        credentials: {
            accessKeyId,
            secretAccessKey
        },
        region
    });
    
    console.log(`✅ S3 initialized - bucket: ${bucket}, region: ${region}`);
    return s3Client;
}

/**
 * Test S3 connection and bucket access
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function testS3Connection() {
    try {
        const client = initS3();
        if (!client) {
            try { sendWebhook('error.occurred', { code: 's3_config_error', message: 'S3 not configured', details: {} }); } catch (e) {}
            return { success: false, error: 'S3 not configured' };
        }
        
        // Test bucket access by listing objects (with limit 1)
        await client.send(new ListObjectsV2Command({
            Bucket: s3Config.bucket,
            MaxKeys: 1
        }));
        
        console.log(`✅ S3 connection test successful - bucket: ${s3Config.bucket}`);
        return { success: true };
    } catch (error) {
        console.error(`❌ S3 connection test failed:`, error.message);
        return { 
            success: false, 
            error: `S3 connection failed: ${error.message}` 
        };
    }
}

/**
 * Upload video file to S3 with automatic retry and progress tracking
 * @param {string} localFilePath - Path to local video file
 * @param {string} botId - Bot ID (used as S3 key prefix)
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 * @returns {Promise<{success: boolean, s3Url?: string, error?: string}>}
 */
async function uploadVideoToS3(localFilePath, botId, maxRetries = 3) {
    try {
        const client = initS3();
        if (!client) {
            return { success: false, error: 'S3 not configured' };
        }
        
        if (!await fs.pathExists(localFilePath)) {
            try { sendWebhook('error.occurred', { code: 's3_upload_error', message: 'Local file not found', details: { localFilePath, botId } }); } catch (e) {}
            return { success: false, error: 'Local file not found' };
        }
        
        const fileName = path.basename(localFilePath);
        const s3Key = `videos/${botId}/${fileName}`;
        
        // Determine content type based on file extension
        const fileExt = path.extname(localFilePath).toLowerCase();
        let contentType = 'video/webm'; // Default
        if (fileExt === '.mp4') {
            contentType = 'video/mp4';
        } else if (fileExt === '.webm') {
            contentType = 'video/webm';
        } else if (fileExt === '.ogg' || fileExt === '.ogv') {
            contentType = 'video/ogg';
        }
        
        // Test connection first
        const connectionTest = await testS3Connection();
        if (!connectionTest.success) {
            try { sendWebhook('error.occurred', { code: 's3_connection_error', message: 'S3 connection test failed', details: { error: connectionTest.error } }); } catch (e) {}
            return { success: false, error: connectionTest.error };
        }
        
        console.log(`📤 Uploading video to S3: ${s3Key} (${contentType})...`);
        
        const fileStats = await fs.stat(localFilePath);
        const fileSizeMB = (fileStats.size / 1024 / 1024).toFixed(2);
        
        console.log(`📊 File size: ${fileSizeMB} MB`);
        
        // Retry logic with exponential backoff
        let lastError = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`🔄 Upload attempt ${attempt}/${maxRetries}`);
                
                // Use stream for large files to avoid memory issues
                const fileStream = fs.createReadStream(localFilePath);
                
                const uploadParams = {
                    client: client,
                    params: {
                        Bucket: s3Config.bucket,
                        Key: s3Key,
                        Body: fileStream,
                        ContentType: contentType,
                        Metadata: {
                            'bot-id': botId,
                            'uploaded-at': new Date().toISOString(),
                            'file-size': fileStats.size.toString(),
                            'attempt': attempt.toString()
                        }
                    }
                };
                
                // Add progress tracking for large files
                const upload = new Upload(uploadParams);
                
                // Track upload progress
                upload.on('httpUploadProgress', (progress) => {
                    if (progress.total) {
                        const percent = Math.round((progress.loaded / progress.total) * 100);
                        if (percent % 25 === 0 || percent === 100) { // Log every 25%
                            console.log(`📈 Upload progress: ${percent}% (${(progress.loaded / 1024 / 1024).toFixed(1)} MB / ${fileSizeMB} MB)`);
                        }
                    }
                });
                
                const result = await upload.done();
                
                // Success - break retry loop
                const s3Url = result.Location || `https://${s3Config.bucket}.s3.${s3Config.region}.amazonaws.com/${s3Key}`;
                
                console.log(`✅ Video uploaded to S3: ${s3Url} (${fileSizeMB} MB) - attempt ${attempt}`);
                
                return {
                    success: true,
                    s3Url,
                    s3Key,
                    size: fileStats.size,
                    attempts: attempt
                };
                
            } catch (error) {
                lastError = error;
                console.warn(`⚠️  Upload attempt ${attempt} failed:`, error.message);
                
                // Don't retry on certain errors
                const errorName = error.name || error.code;
                if (errorName === 'NoSuchBucket' || 
                    errorName === 'NotFound' ||
                    errorName === 'InvalidAccessKeyId' || 
                    errorName === 'InvalidClientTokenId' ||
                    errorName === 'SignatureDoesNotMatch' ||
                    errorName === 'InvalidSignature') {
                    break; // These won't be fixed by retrying
                }
                
                // Wait before retry (exponential backoff)
                if (attempt < maxRetries) {
                    const waitTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s...
                    console.log(`⏳ Waiting ${waitTime/1000}s before retry...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            }
        }
        
    // All retries failed
    const finalErr = lastError || new Error('Upload failed after all retries');
    try { sendWebhook('error.occurred', { code: 's3_upload_error', message: 'Upload failed after retries', details: { localFilePath, botId, error: finalErr && finalErr.message ? finalErr.message : String(finalErr) } }); } catch (e) {}
    throw finalErr;
        
    } catch (error) {
        console.error(`❌ S3 upload failed:`, {
            message: error.message,
            code: error.code,
            statusCode: error.statusCode,
            region: s3Config?.region,
            bucket: s3Config?.bucket,
            key: s3Key
        });
        
        // Emit error webhook
        try { sendWebhook('error.occurred', { code: 's3_upload_error', message: 'S3 upload failed', details: { localFilePath, botId, error: error && error.message ? error.message : String(error) } }); } catch (e) {}
        
        // Provide more specific error messages
        let errorMessage = error.message || 'Unknown error';
        const errorName = error.name || error.code;
        const statusCode = error.$metadata?.httpStatusCode || error.statusCode;
        
        if (errorName === 'NoSuchBucket' || errorName === 'NotFound') {
            errorMessage = `S3 bucket '${s3Config.bucket}' does not exist`;
        } else if (errorName === 'AccessDenied' || errorName === 'Forbidden') {
            errorMessage = 'Access denied - check AWS credentials and bucket permissions';
        } else if (errorName === 'InvalidAccessKeyId' || errorName === 'InvalidClientTokenId') {
            errorMessage = 'Invalid AWS Access Key ID';
        } else if (errorName === 'SignatureDoesNotMatch' || errorName === 'InvalidSignature') {
            errorMessage = 'Invalid AWS Secret Access Key';
        }
        
        return {
            success: false,
            error: errorMessage,
            awsError: {
                code: errorName,
                statusCode: statusCode
            }
        };
    }
}

/**
 * Get signed S3 URL for a video (secure, time-limited access)
 * @param {string} botId - Bot ID
 * @param {string} fileName - Video file name (default: tries {botId}.mp4 then {botId}.webm)
 * @param {number} expiresIn - URL expiration time in seconds (default: 1 hour)
 * @returns {Promise<string|null>} Signed S3 URL or null if not configured
 */
async function getS3VideoUrl(botId, fileName = null, expiresIn = 3600) {
    const client = initS3();
    if (!client) return null;
    
    // Check cache first (only if no fileName specified, as cache is per botId)
    if (!fileName) {
        const cacheKey = botId;
        const cached = signedUrlCache.get(cacheKey);
        if (cached) {
            const now = Date.now();
            // Use cached URL if it has at least 5 minutes left (to account for clock skew)
            const bufferTime = 5 * 60 * 1000; // 5 minutes in ms
            if (cached.expiresAt > (now + bufferTime)) {
                console.log(`♻️  Using cached signed URL for ${botId} (expires in ${Math.round((cached.expiresAt - now) / 1000)}s)`);
                return cached.url;
            } else {
                // Cache expired, remove it
                signedUrlCache.delete(cacheKey);
            }
        }
    }
    
    try {
        let file = fileName;
        let contentType = 'video/webm';
        
        // If no filename provided, check S3 directly for both .mp4 and .webm files
        if (!file) {
            // Try .mp4 first (compressed files), then .webm
            const mp4Key = `videos/${botId}/${botId}.mp4`;
            const webmKey = `videos/${botId}/${botId}.webm`;
            
            // Check if .mp4 exists in S3
            try {
                await client.send(new HeadObjectCommand({
                    Bucket: s3Config.bucket,
                    Key: mp4Key
                }));
                file = `${botId}.mp4`;
                contentType = 'video/mp4';
            } catch (e) {
                // .mp4 doesn't exist, try .webm
                try {
                    await client.send(new HeadObjectCommand({
                        Bucket: s3Config.bucket,
                        Key: webmKey
                    }));
                    file = `${botId}.webm`;
                    contentType = 'video/webm';
                } catch (e2) {
                    // Neither exists in S3, check local files as fallback
                    const RUNTIME_ROOT = path.join(__dirname, '../runtime');
                    const videoDir = path.join(RUNTIME_ROOT, botId, 'video');
                    const mp4Path = path.join(videoDir, `${botId}.mp4`);
                    const webmPath = path.join(videoDir, `${botId}.webm`);
                    
                    if (await fs.pathExists(mp4Path)) {
                        file = `${botId}.mp4`;
                        contentType = 'video/mp4';
                    } else if (await fs.pathExists(webmPath)) {
                        file = `${botId}.webm`;
                        contentType = 'video/webm';
                    } else {
                        // Default to .mp4 (compressed files are more common now)
                        file = `${botId}.mp4`;
                        contentType = 'video/mp4';
                    }
                }
            }
        } else {
            // Determine content type from provided filename
            const fileExt = path.extname(file).toLowerCase();
            if (fileExt === '.mp4') {
                contentType = 'video/mp4';
            } else if (fileExt === '.webm') {
                contentType = 'video/webm';
            }
        }
        
        const s3Key = `videos/${botId}/${file}`;
        
        // Generate signed URL for secure access
        const command = new GetObjectCommand({
            Bucket: s3Config.bucket,
            Key: s3Key,
            ResponseContentType: contentType
        });
        const signedUrl = await getSignedUrl(client, command, { expiresIn });
        
        // Cache the signed URL (only if no fileName specified)
        if (!fileName) {
            const cacheKey = botId;
            const expiresAt = Date.now() + (expiresIn * 1000);
            signedUrlCache.set(cacheKey, {
                url: signedUrl,
                expiresAt: expiresAt
            });
            // Clean up old cache entries periodically (keep cache size reasonable)
            if (signedUrlCache.size > 1000) {
                const now = Date.now();
                for (const [key, value] of signedUrlCache.entries()) {
                    if (value.expiresAt <= now) {
                        signedUrlCache.delete(key);
                    }
                }
            }
        }
        
        console.log(`🔐 Generated signed URL for ${s3Key} (${contentType}, expires in ${expiresIn}s)`);
        return signedUrl;
        
    } catch (error) {
        console.error(`❌ Failed to generate signed URL for ${botId}:`, error.message);
        return null;
    }
}

/**
 * Get public S3 URL (for reference, but use signed URLs instead)
 * @param {string} botId - Bot ID
 * @param {string} fileName - Video file name (default: tries {botId}.mp4 then {botId}.webm)
 * @returns {string|null} Public S3 URL or null if not configured
 */
function getPublicS3VideoUrl(botId, fileName = null) {
    const client = initS3();
    if (!client) return null;
    
    const file = fileName || `${botId}.mp4`; // Default to .mp4 (compressed files)
    const s3Key = `videos/${botId}/${file}`;
    
    // Return public URL (requires bucket to be public)
    return `https://${s3Config.bucket}.s3.${s3Config.region}.amazonaws.com/${s3Key}`;
}

/**
 * Check if S3 is configured
 * @returns {boolean}
 */
function isS3Configured() {
    return initS3() !== null;
}

/**
 * Delete video from S3
 * @param {string} botId - Bot ID
 * @param {string} fileName - Video file name (default: tries {botId}.mp4 then {botId}.webm)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteVideoFromS3(botId, fileName = null) {
    try {
        const client = initS3();
        if (!client) {
            return { success: false, error: 'S3 not configured' };
        }
        
        let file = fileName;
        
        // If no filename provided, try to find the actual file
        if (!file) {
            const RUNTIME_ROOT = path.join(__dirname, '../runtime');
            const videoDir = path.join(RUNTIME_ROOT, botId, 'video');
            
            // Try .mp4 first (compressed files), then .webm
            const mp4Path = path.join(videoDir, `${botId}.mp4`);
            const webmPath = path.join(videoDir, `${botId}.webm`);
            
            if (await fs.pathExists(mp4Path)) {
                file = `${botId}.mp4`;
            } else if (await fs.pathExists(webmPath)) {
                file = `${botId}.webm`;
            } else {
                // Default to .mp4 if file not found locally
                file = `${botId}.mp4`;
            }
        }
        
        const s3Key = `videos/${botId}/${file}`;
        
        await client.send(new DeleteObjectCommand({
            Bucket: s3Config.bucket,
            Key: s3Key
        }));
        
        console.log(`🗑️  Video deleted from S3: ${s3Key}`);
        return { success: true };
    } catch (error) {
        console.error(`❌ S3 delete failed:`, error.message || error);
        return {
            success: false,
            error: error.message || 'Unknown error'
        };
    }
}


module.exports = {
    uploadVideoToS3,
    getS3VideoUrl,
    getPublicS3VideoUrl,
    isS3Configured,
    deleteVideoFromS3,
    testS3Connection,
    initS3
};

