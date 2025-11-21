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
        preset = 'ultrafast',         // Encoding speed vs compression (ultrafast for maximum speed)
        crf = 35,                     // Constant Rate Factor (higher = faster encoding, still acceptable quality)
        codec = 'libx264',            // H.264 codec (much faster than VP9)
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
        
        // Add remaining options optimized for speed
        args.push(
            '-c:a', 'aac',            // AAC audio (faster than Opus)
            '-b:a', audioBitrate,
            '-preset', 'ultrafast',   // H.264 ultrafast preset for maximum speed
            '-tune', 'zerolatency',   // Optimize for speed over compression
            '-threads', '0',          // Use all available threads (0 = auto)
            '-movflags', '+faststart', // Enable fast start for web playback
            '-y',                     // Overwrite output
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

        // Use fast compression settings optimized for speed
        if (sizeMB > 100) {
            // Large file - fast compression with higher CRF
            recommendations.shouldCompress = true;
            recommendations.reason = `Large file size (${sizeMB.toFixed(1)} MB) - fast compression recommended`;
            recommendations.settings = {
                videoBitrate: null,  // Use CRF mode
                crf: 38,             // Higher CRF = much faster encoding
                preset: 'ultrafast',
                audioBitrate: '64k',
                codec: 'libx264'     // H.264 for speed
            };
        } else if (sizeMB > 50) {
            // Medium file - moderate fast compression
            recommendations.shouldCompress = true;
            recommendations.reason = `Medium file size (${sizeMB.toFixed(1)} MB) - fast compression recommended`;
            recommendations.settings = {
                videoBitrate: null,  // Use CRF mode
                crf: 35,             // Fast encoding with acceptable quality
                preset: 'ultrafast',
                audioBitrate: '64k',
                codec: 'libx264'     // H.264 for speed
            };
        } else if (durationMinutes > 30 && sizeMB > 30) {
            // Long duration - light compression with CRF
            recommendations.shouldCompress = true;
            recommendations.reason = `Long meeting (${durationMinutes.toFixed(1)} min) - fast compression recommended`;
            recommendations.settings = {
                videoBitrate: null,  // Use CRF mode
                crf: 33,             // Fast encoding
                preset: 'ultrafast',
                audioBitrate: '64k',
                codec: 'libx264'     // H.264 for speed
            };
        } else if (sizeMB > 20) {
            // Small but could be optimized
            recommendations.shouldCompress = true;
            recommendations.reason = `File size (${sizeMB.toFixed(1)} MB) - fast optimization recommended`;
            recommendations.settings = {
                videoBitrate: null,  // Use CRF mode
                crf: 32,             // Fast encoding
                preset: 'ultrafast',
                audioBitrate: '64k',
                codec: 'libx264'     // H.264 for speed
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

