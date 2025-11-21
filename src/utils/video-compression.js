/**
 * Video Compression Utility
 * 
 * Provides post-processing video compression using FFmpeg
 * Reduces file size without changing resolution
 */

const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

/**
 * Compress video file using FFmpeg
 * @param {string} inputPath - Path to input video file
 * @param {string} outputPath - Path to output compressed video file  
 * @param {Object} options - Compression options
 * @returns {Promise<Object>} Compression result
 */
async function compressVideo(inputPath, outputPath, options = {}) {
    const {
        videoBitrate = null,          // If null, use CRF mode (better quality at same size)
        audioBitrate = '64k',         // Lower audio bitrate (voice doesn't need much)
        preset = 'medium',            // Encoding speed vs compression (ultrafast, fast, medium, slow, veryslow)
        crf = 30,                     // Constant Rate Factor (18-31, higher = smaller file, VP9: 30-32 is good)
        codec = 'libvpx-vp9',         // VP9 codec for WebM (best compression)
        twoPass = false,              // Two-pass encoding for better quality
        removeOriginal = false        // Remove original file after compression
    } = options;

    console.log(`🗜️  Compressing video: ${inputPath}`);
    if (videoBitrate) {
        console.log(`   Mode: Bitrate-based (${videoBitrate}), CRF: ${crf}, Preset: ${preset}`);
    } else {
        console.log(`   Mode: Quality-based (CRF: ${crf}), Preset: ${preset}`);
    }

    return new Promise((resolve, reject) => {
        // Check if input file exists
        if (!fs.existsSync(inputPath)) {
            return reject(new Error(`Input file not found: ${inputPath}`));
        }

        // Get input file size
        const inputStats = fs.statSync(inputPath);
        const inputSizeMB = (inputStats.size / 1024 / 1024).toFixed(2);

        // Build FFmpeg command
        // Use CRF mode (quality-based) for better compression efficiency
        const args = [
            '-i', inputPath,
            '-c:v', codec
        ];
        
        // If bitrate is explicitly set, use bitrate mode
        if (videoBitrate) {
            args.push('-b:v', videoBitrate);
        } else {
            // Use CRF mode (quality-based) - better for maintaining quality at smaller size
            args.push('-crf', String(crf), '-b:v', '0');
        }
        
        // Add remaining options
        args.push(
            '-c:a', 'libopus',        // Opus for better audio compression
            '-b:a', audioBitrate,
            '-cpu-used', '1',          // VP9 encoder speed (0-5, lower = better quality, 1 is good balance)
            '-row-mt', '1',            // Enable row-based multithreading
            '-threads', '0',           // Use all available threads (0 = auto)
            '-deadline', 'good',       // Quality/speed trade-off (good = balance)
            '-auto-alt-ref', '1',      // Enable automatic alternate reference frames (better compression)
            '-lag-in-frames', '16',    // Look-ahead frames for better compression
            '-y',                      // Overwrite output
            outputPath
        );

        console.log(`   FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);

        const startTime = Date.now();
        const ffmpeg = spawn(ffmpegPath, args);

        let stderr = '';

        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
            // Log progress
            const match = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
            if (match) {
                process.stdout.write(`\r   Progress: ${match[1]}`);
            }
        });

        ffmpeg.on('close', (code) => {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            if (code === 0) {
                // Check output file
                if (fs.existsSync(outputPath)) {
                    const outputStats = fs.statSync(outputPath);
                    const outputSizeMB = (outputStats.size / 1024 / 1024).toFixed(2);
                    const reduction = ((1 - outputStats.size / inputStats.size) * 100).toFixed(1);

                    console.log(`\n✅ Compression complete in ${duration}s`);
                    console.log(`   Original: ${inputSizeMB} MB → Compressed: ${outputSizeMB} MB`);
                    console.log(`   Reduction: ${reduction}% (saved ${(inputSizeMB - outputSizeMB).toFixed(2)} MB)`);

                    // Remove original if requested
                    if (removeOriginal) {
                        fs.removeSync(inputPath);
                        console.log(`   🗑️  Original file removed`);
                    }

                    resolve({
                        success: true,
                        inputSize: inputStats.size,
                        outputSize: outputStats.size,
                        inputSizeMB: parseFloat(inputSizeMB),
                        outputSizeMB: parseFloat(outputSizeMB),
                        reductionPercent: parseFloat(reduction),
                        duration: parseFloat(duration),
                        outputPath
                    });
                } else {
                    reject(new Error('Output file not created'));
                }
            } else {
                console.error(`\n❌ FFmpeg compression failed with code ${code}`);
                console.error(`   Error output: ${stderr.slice(-500)}`);
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });

        ffmpeg.on('error', (error) => {
            reject(new Error(`Failed to start FFmpeg: ${error.message}`));
        });
    });
}

/**
 * Compress video in place (replaces original)
 * @param {string} filePath - Path to video file
 * @param {Object} options - Compression options
 * @returns {Promise<Object>} Compression result
 */
async function compressVideoInPlace(filePath, options = {}) {
    const tempPath = filePath + '.compressed.webm';
    
    try {
        const result = await compressVideo(filePath, tempPath, options);
        
        // Replace original with compressed version
        fs.removeSync(filePath);
        fs.renameSync(tempPath, filePath);
        
        console.log(`✅ Original file replaced with compressed version`);
        
        return {
            ...result,
            outputPath: filePath
        };
    } catch (error) {
        // Clean up temp file if it exists
        if (fs.existsSync(tempPath)) {
            fs.removeSync(tempPath);
        }
        throw error;
    }
}

/**
 * Get video file information
 * @param {string} filePath - Path to video file
 * @returns {Promise<Object>} Video information
 */
async function getVideoInfo(filePath) {
    return new Promise((resolve, reject) => {
        const args = [
            '-i', filePath,
            '-hide_banner'
        ];

        const ffprobe = spawn(ffmpegPath, args);
        let stderr = '';

        ffprobe.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ffprobe.on('close', () => {
            // Parse video info from stderr
            const durationMatch = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
            const bitrateMatch = stderr.match(/bitrate: (\d+) kb\/s/);
            const videoMatch = stderr.match(/Video: ([^,]+), ([^,]+), (\d+x\d+)/);
            const audioMatch = stderr.match(/Audio: ([^,]+), (\d+) Hz/);

            const info = {
                duration: null,
                bitrate: null,
                videoCodec: null,
                resolution: null,
                audioCodec: null,
                sampleRate: null
            };

            if (durationMatch) {
                const hours = parseInt(durationMatch[1]);
                const minutes = parseInt(durationMatch[2]);
                const seconds = parseFloat(durationMatch[3]);
                info.duration = hours * 3600 + minutes * 60 + seconds;
            }

            if (bitrateMatch) {
                info.bitrate = parseInt(bitrateMatch[1]);
            }

            if (videoMatch) {
                info.videoCodec = videoMatch[1].trim();
                info.resolution = videoMatch[3];
            }

            if (audioMatch) {
                info.audioCodec = audioMatch[1].trim();
                info.sampleRate = parseInt(audioMatch[2]);
            }

            resolve(info);
        });

        ffprobe.on('error', (error) => {
            reject(error);
        });
    });
}

/**
 * Get compression recommendations based on file size and duration
 * @param {string} filePath - Path to video file
 * @returns {Promise<Object>} Recommended settings
 */
async function getCompressionRecommendations(filePath) {
    const stats = fs.statSync(filePath);
    const sizeMB = stats.size / 1024 / 1024;
    
    let recommendations = {
        shouldCompress: false,
        reason: '',
        settings: {}
    };

    try {
        const info = await getVideoInfo(filePath);
        const durationMinutes = info.duration ? (info.duration / 60) : 0;

        // Use CRF mode (quality-based) for better compression
        if (sizeMB > 100) {
            // Large file - aggressive compression with CRF
            recommendations.shouldCompress = true;
            recommendations.reason = `Large file size (${sizeMB.toFixed(1)} MB) - aggressive compression recommended`;
            recommendations.settings = {
                videoBitrate: null,  // Use CRF mode
                crf: 32,             // Higher CRF = smaller file (still good quality for VP9)
                preset: 'medium',
                audioBitrate: '64k'
            };
        } else if (sizeMB > 50) {
            // Medium file - moderate compression with CRF
            recommendations.shouldCompress = true;
            recommendations.reason = `Medium file size (${sizeMB.toFixed(1)} MB) - moderate compression recommended`;
            recommendations.settings = {
                videoBitrate: null,  // Use CRF mode
                crf: 30,             // Good balance for VP9
                preset: 'medium',
                audioBitrate: '64k'
            };
        } else if (durationMinutes > 30 && sizeMB > 30) {
            // Long duration - light compression with CRF
            recommendations.shouldCompress = true;
            recommendations.reason = `Long meeting (${durationMinutes.toFixed(1)} min) - light compression recommended`;
            recommendations.settings = {
                videoBitrate: null,  // Use CRF mode
                crf: 28,             // Lower CRF = better quality
                preset: 'fast',
                audioBitrate: '64k'
            };
        } else if (sizeMB > 20) {
            // Small but could be optimized
            recommendations.shouldCompress = true;
            recommendations.reason = `File size (${sizeMB.toFixed(1)} MB) - light optimization recommended`;
            recommendations.settings = {
                videoBitrate: null,  // Use CRF mode
                crf: 28,
                preset: 'fast',
                audioBitrate: '64k'
            };
        } else {
            recommendations.reason = `File size acceptable (${sizeMB.toFixed(1)} MB)`;
        }

        return recommendations;
    } catch (error) {
        console.error('Error getting compression recommendations:', error);
        return recommendations;
    }
}

module.exports = {
    compressVideo,
    compressVideoInPlace,
    getVideoInfo,
    getCompressionRecommendations
};

