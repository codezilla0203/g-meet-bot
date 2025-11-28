const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { sendWebhook } = require('./webhook');

/**
 * Remux a .webm file into an .mp4 container using ffmpeg -c copy -movflags +faststart
 * This does not re-encode streams; it's an I/O-bound operation and is much faster than re-encoding.
 *
 * @param {string} inputPath - existing .webm local path
 * @param {string} outputPath - desired output .mp4 path (will be overwritten)
 * @returns {Promise<void>}
 */
async function remuxWebmToMp4(inputPath, outputPath, overrideUrl = null) {
  if (!inputPath || !outputPath) throw new Error('inputPath and outputPath are required');
  if (!(await fs.pathExists(inputPath))) throw new Error(`Input file not found: ${inputPath}`);

  // Ensure destination directory exists
  await fs.ensureDir(path.dirname(outputPath));

  return new Promise((resolve, reject) => {
    // Build ffmpeg args
    const args = [
      '-y', // overwrite
      '-i', inputPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath
    ];

    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ff.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    ff.on('error', (err) => reject(err));
    ff.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(`ffmpeg remux failed with code ${code}: ${stderr.slice(0, 2000)}`);
        // Best-effort webhook notify
        try { sendWebhook('error.occurred', { code: 'remux_error', message: err.message, details: { inputPath, outputPath, exitCode: code, stderr: stderr.slice(0,2000) } }, overrideUrl || null); } catch (e) {}
        reject(err);
      }
    });
  });
}

module.exports = { remuxWebmToMp4 };
