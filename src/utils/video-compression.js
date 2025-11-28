/**
 * Video Compression Utility (Optimized for Web Playback)
 *
 * - Downscale to 720p (configurable)
 * - H.264 MP4 with streaming-friendly settings
 * - Smooth seeking, minimal buffering
 */

const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const { sendWebhook } = require('./webhook');

/**
 * Compress + (optionally) downscale video using FFmpeg
 *
 * @param {string} inputPath   - Path to input video file
 * @param {string} outputPath  - Path to output compressed video file
 * @param {Object} options
 * @returns {Promise<Object>}
 */
async function compressVideo(inputPath, outputPath, options = {}) {
  const {
    // resolution
    targetHeight = 720,        // null = keep original, 720 = downscale to 720p

    // quality / bitrate
    videoBitrate = null,       // null = CRF only (recommended)
    maxrate = '900k',          // cap peaks for smoother streaming
    bufsize = '1800k',
    audioBitrate = '64k',

    // encoder
    crf = 30,                  // 26–32 is typical for meetings
    preset = 'veryfast',       // much better than ultrafast for compression efficiency
    codec = 'libx264',

    removeOriginal = false
  } = options;

  console.log(`🗜️  Compressing video: ${inputPath}`);
  console.log(`   targetHeight=${targetHeight}, crf=${crf}, preset=${preset}, codec=${codec}`);

  return new Promise(async (resolve, reject) => {
    if (!(await fs.pathExists(inputPath))) {
      // Notify webhook and reject
      try { sendWebhook('error.occurred', { code: 'video_compression_error', message: 'Input file not found', details: { inputPath } }); } catch (e) {}
      return reject(new Error(`Input file not found: ${inputPath}`));
    }

    const inputStats = await fs.stat(inputPath);
    const inputSizeMB = (inputStats.size / 1024 / 1024).toFixed(2);

    const args = [];

    // Overwrite output if exists
    args.push('-y');

    // Input
    args.push('-i', inputPath);

    // --- DOWNSCALE (if targetHeight given) ---
    if (targetHeight) {
      // Keep aspect ratio, width auto & divisible by 2
      args.push('-vf', `scale=-2:${targetHeight}`);
    }

    // Video codec & quality
    args.push(
      '-c:v', codec,
      '-preset', preset,
      '-tune', 'fastdecode',    // helps decoding & seeking
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p'     // best browser compatibility
    );

    // Bitrate / streaming control
    if (videoBitrate) {
      // If you explicitly set a bitrate, use it as both target & cap
      args.push(
        '-b:v', videoBitrate,
        '-maxrate', videoBitrate,
        '-bufsize', videoBitrate
      );
    } else {
      // Pure CRF mode with peak caps for smooth streaming
      if (maxrate && bufsize) {
        args.push(
          '-maxrate', maxrate,
          '-bufsize', bufsize
        );
      }
    }

    // Audio
    args.push(
      '-c:a', 'aac',
      '-b:a', audioBitrate
    );

    // Web playback optimizations
    args.push(
      '-movflags', '+faststart' // moov atom at beginning => fast start & seeking
    );

    // IMPORTANT: No custom -x264-params (no fixed keyint/scenecut=0)
    // Let x264 decide GOP & scenecuts for smoother bit distribution.

    // Output
    args.push(outputPath);

    console.log(`   FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);

    const startTime = Date.now();
    const ffmpeg = spawn(ffmpegPath, args);

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      const match = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (match) {
        process.stdout.write(`\r   Progress: ${match[1]}`);
      }
    });

    ffmpeg.on('close', async (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      if (code === 0) {
        if (await fs.pathExists(outputPath)) {
          const outputStats = await fs.stat(outputPath);
          const outputSizeMB = (outputStats.size / 1024 / 1024).toFixed(2);
          const reduction = ((1 - outputStats.size / inputStats.size) * 100).toFixed(1);

          console.log(`\n✅ Compression complete in ${duration}s`);
          console.log(`   Original: ${inputSizeMB} MB → Compressed: ${outputSizeMB} MB`);
          console.log(`   Reduction: ${reduction}%`);

          if (removeOriginal) {
            await fs.remove(inputPath);
            console.log('   🗑️  Original file removed');
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
        const message = `FFmpeg exited with code ${code}`;
        console.error(`\n❌ FFmpeg compression failed with code ${code}`);
        console.error(`   Error output (tail): ${stderr.slice(-500)}`);
        try { sendWebhook('error.occurred', { code: 'video_compression_error', message, details: { inputPath, outputPath, exitCode: code, stderr: stderr.slice(-2000) } }); } catch (e) {}
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (error) => {
      try { sendWebhook('error.occurred', { code: 'video_compression_error', message: 'Failed to start FFmpeg', details: { inputPath, error: error && error.message ? error.message : String(error) } }); } catch (e) {}
      reject(new Error(`Failed to start FFmpeg: ${error.message}`));
    });
  });
}

/**
 * Compress video in place (replaces original)
 *
 * @param {string} filePath  - Path to video file
 * @param {Object} options   - Compression options
 * @returns {Promise<Object>}
 */
async function compressVideoInPlace(filePath, options = {}) {
  const codec = options.codec || 'libx264';
  const extension = (codec === 'libx264' || codec === 'libx265') ? '.mp4' : '.webm';
  const tempPath = filePath + '.compressed' + extension;

  try {
    const result = await compressVideo(filePath, tempPath, {
      targetHeight: options.targetHeight ?? 720, // default: 720p downscale
      ...options
    });

    const pathObj = path.parse(filePath);
    const finalPath = path.join(pathObj.dir, pathObj.name + extension);

    // Remove original file
    await fs.remove(filePath);
    // Rename compressed temp to final path
    await fs.rename(tempPath, finalPath);

    console.log('✅ Original file replaced with compressed version');

    return {
      ...result,
      outputPath: finalPath
    };
  } catch (error) {
    if (await fs.pathExists(tempPath)) {
      await fs.remove(tempPath);
    }
    try { sendWebhook('error.occurred', { code: 'video_compression_error', message: 'compressVideoInPlace failed', details: { filePath, error: error && error.message ? error.message : String(error) } }); } catch (e) {}
    throw error;
  }
}

/**
 * Get video file information (duration, bitrate, codecs, resolution)
 *
 * @param {string} filePath
 * @returns {Promise<Object>}
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
        const hours = parseInt(durationMatch[1], 10);
        const minutes = parseInt(durationMatch[2], 10);
        const seconds = parseFloat(durationMatch[3]);
        info.duration = hours * 3600 + minutes * 60 + seconds;
      }

      if (bitrateMatch) {
        info.bitrate = parseInt(bitrateMatch[1], 10);
      }

      if (videoMatch) {
        info.videoCodec = videoMatch[1].trim();
        info.resolution = videoMatch[3]; // e.g. "1920x1080"
      }

      if (audioMatch) {
        info.audioCodec = audioMatch[1].trim();
        info.sampleRate = parseInt(audioMatch[2], 10);
      }

      resolve(info);
    });

    ffprobe.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Get compression recommendations based on size & duration
 * (for meetings / screen recordings)
 *
 * @param {string} filePath
 * @returns {Promise<{shouldCompress:boolean, reason:string, settings:Object}>}
 */
async function getCompressionRecommendations(filePath) {
  const stats = await fs.stat(filePath);
  const sizeMB = stats.size / 1024 / 1024;

  const recommendations = {
    shouldCompress: false,
    reason: '',
    settings: {}
  };

  try {
    const info = await getVideoInfo(filePath);
    const durationSeconds = info.duration || 0;
    const durationMinutes = durationSeconds / 60;

    // Skip tiny videos
    if (sizeMB < 5 && durationSeconds < 15) {
      recommendations.shouldCompress = false;
      recommendations.reason =
        `Very small/short video (${sizeMB.toFixed(1)} MB, ${durationSeconds.toFixed(1)}s) - skipping compression`;
      return recommendations;
    }

    recommendations.shouldCompress = true;

    // Base streaming-friendly defaults
    let settings = {
      videoBitrate: null,     // pure CRF
      maxrate: '900k',        // ~0.9 Mbps peaks (good for most networks)
      bufsize: '1800k',
      crf: 30,
      preset: 'veryfast',
      audioBitrate: '64k',
      codec: 'libx264',
      targetHeight: 720       // downscale to 720p
    };

    if (sizeMB > 200 || durationMinutes > 60) {
      recommendations.reason =
        `Large/long recording (${sizeMB.toFixed(1)} MB, ${durationMinutes.toFixed(1)} min) - compressing for web playback`;
      // Optionally slightly higher CRF to shrink more
      settings.crf = 31;
    } else if (sizeMB > 50 || durationMinutes > 30) {
      recommendations.reason =
        `Medium/long video (${sizeMB.toFixed(1)} MB, ${durationMinutes.toFixed(1)} min) - compressing with 720p streaming settings`;
    } else {
      recommendations.reason =
        `File size ${sizeMB.toFixed(1)} MB - compressing for smoother browser playback`;
    }

    recommendations.settings = settings;
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
