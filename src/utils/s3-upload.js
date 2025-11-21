const AWS = require('aws-sdk');
const fs = require('fs-extra');
const path = require('path');

/**
 * S3 Upload Utility
 * Handles uploading video files to AWS S3 bucket
 */

let s3Client = null;
let s3Config = null;

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
    
    s3Client = new AWS.S3({
        accessKeyId,
        secretAccessKey,
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
            return { success: false, error: 'S3 not configured' };
        }
        
        // Test bucket access by listing objects (with limit 1)
        await client.listObjectsV2({
            Bucket: s3Config.bucket,
            MaxKeys: 1
        }).promise();
        
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
            return { success: false, error: 'Local file not found' };
        }
        
        const fileName = path.basename(localFilePath);
        const s3Key = `videos/${botId}/${fileName}`;
        
        // Test connection first
        const connectionTest = await testS3Connection();
        if (!connectionTest.success) {
            return { success: false, error: connectionTest.error };
        }
        
        console.log(`📤 Uploading video to S3: ${s3Key}...`);
        
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
                    Bucket: s3Config.bucket,
                    Key: s3Key,
                    Body: fileStream,
                    ContentType: 'video/webm',
                    // Remove ACL to avoid permission issues - use bucket policy instead
                    Metadata: {
                        'bot-id': botId,
                        'uploaded-at': new Date().toISOString(),
                        'file-size': fileStats.size.toString(),
                        'attempt': attempt.toString()
                    }
                };
                
                // Add progress tracking for large files
                const upload = client.upload(uploadParams);
                
                // Track upload progress
                upload.on('httpUploadProgress', (progress) => {
                    const percent = Math.round((progress.loaded / progress.total) * 100);
                    if (percent % 25 === 0 || percent === 100) { // Log every 25%
                        console.log(`📈 Upload progress: ${percent}% (${(progress.loaded / 1024 / 1024).toFixed(1)} MB / ${fileSizeMB} MB)`);
                    }
                });
                
                const result = await upload.promise();
                
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
                if (error.code === 'NoSuchBucket' || 
                    error.code === 'InvalidAccessKeyId' || 
                    error.code === 'SignatureDoesNotMatch') {
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
        throw lastError || new Error('Upload failed after all retries');
        
    } catch (error) {
        console.error(`❌ S3 upload failed:`, {
            message: error.message,
            code: error.code,
            statusCode: error.statusCode,
            region: s3Config?.region,
            bucket: s3Config?.bucket,
            key: s3Key
        });
        
        // Provide more specific error messages
        let errorMessage = error.message || 'Unknown error';
        if (error.code === 'NoSuchBucket') {
            errorMessage = `S3 bucket '${s3Config.bucket}' does not exist`;
        } else if (error.code === 'AccessDenied') {
            errorMessage = 'Access denied - check AWS credentials and bucket permissions';
        } else if (error.code === 'InvalidAccessKeyId') {
            errorMessage = 'Invalid AWS Access Key ID';
        } else if (error.code === 'SignatureDoesNotMatch') {
            errorMessage = 'Invalid AWS Secret Access Key';
        }
        
        return {
            success: false,
            error: errorMessage,
            awsError: {
                code: error.code,
                statusCode: error.statusCode
            }
        };
    }
}

/**
 * Get signed S3 URL for a video (secure, time-limited access)
 * @param {string} botId - Bot ID
 * @param {string} fileName - Video file name (default: {botId}.webm)
 * @param {number} expiresIn - URL expiration time in seconds (default: 1 hour)
 * @returns {Promise<string|null>} Signed S3 URL or null if not configured
 */
async function getS3VideoUrl(botId, fileName = null, expiresIn = 3600) {
    const client = initS3();
    if (!client) return null;
    
    try {
        const file = fileName || `${botId}.webm`;
        const s3Key = `videos/${botId}/${file}`;
        
        // Generate signed URL for secure access
        const signedUrl = await client.getSignedUrlPromise('getObject', {
            Bucket: s3Config.bucket,
            Key: s3Key,
            Expires: expiresIn, // URL expires in 1 hour by default
            ResponseContentType: 'video/webm'
        });
        
        console.log(`🔐 Generated signed URL for ${s3Key} (expires in ${expiresIn}s)`);
        return signedUrl;
        
    } catch (error) {
        console.error(`❌ Failed to generate signed URL for ${botId}:`, error.message);
        return null;
    }
}

/**
 * Get public S3 URL (for reference, but use signed URLs instead)
 * @param {string} botId - Bot ID
 * @param {string} fileName - Video file name (default: {botId}.webm)
 * @returns {string|null} Public S3 URL or null if not configured
 */
function getPublicS3VideoUrl(botId, fileName = null) {
    const client = initS3();
    if (!client) return null;
    
    const file = fileName || `${botId}.webm`;
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
 * @param {string} fileName - Video file name (default: {botId}.webm)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteVideoFromS3(botId, fileName = null) {
    try {
        const client = initS3();
        if (!client) {
            return { success: false, error: 'S3 not configured' };
        }
        
        const file = fileName || `${botId}.webm`;
        const s3Key = `videos/${botId}/${file}`;
        
        await client.deleteObject({
            Bucket: s3Config.bucket,
            Key: s3Key
        }).promise();
        
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

