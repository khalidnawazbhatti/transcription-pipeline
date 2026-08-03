import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';
import logger from '../logger.js';

// Use the bundled static binary so no system ffmpeg install is required
ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);

export interface AudioChunk {
  path: string;
  startOffset: number; // seconds from start of original file
}

/**
 * Convert any audio file to 16 kHz mono PCM WAV.
 * This is the single normalization step that lets Whisper always receive
 * a consistent format regardless of what the caller uploaded.
 */
export function normalizeToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('error', reject)
      .on('end', () => resolve())
      .save(outputPath);
  });
}

/**
 * Split a WAV file into fixed-length chunks with overlap.
 * 30 s windows with 1 s overlap keeps memory bounded for arbitrarily long
 * files and gives Whisper enough context at chunk boundaries.
 * 
 * Strategy: Extract 30s chunks sequentially, stopping when ffmpeg reports
 * the input is exhausted (instead of pre-computing duration with ffprobe).
 */
export async function chunkWav(
  wavPath: string,
  chunkDir: string,
  chunkSeconds = 30,
  overlapSeconds = 1,
): Promise<AudioChunk[]> {
  logger.info('chunkWav starting', { wavPath, chunkDir, chunkSeconds, overlapSeconds });
  fs.mkdirSync(chunkDir, { recursive: true });

  const chunks: AudioChunk[] = [];
  const step = chunkSeconds - overlapSeconds;
  let start = 0;

  // A WAV file with no audio is just a 44-byte header. We need at least
  // ~4800 bytes (0.15s of 16kHz mono PCM) to be worth transcribing.
  const MIN_AUDIO_BYTES = 4800;

  while (true) {
    const index = chunks.length;
    const chunkPath = path.join(chunkDir, `chunk-${index}.wav`);
    logger.info('Extracting chunk', { index, start, chunkSeconds });

    try {
      await extractSegmentWithTimeout(wavPath, chunkPath, start, chunkSeconds);

      const size = fs.existsSync(chunkPath) ? fs.statSync(chunkPath).size : 0;
      if (size < MIN_AUDIO_BYTES) {
        // Past EOF — the extracted file is empty or near-empty; stop here
        fs.rmSync(chunkPath, { force: true });
        logger.info('Chunk empty (EOF reached)', { index, start, size });
        break;
      }

      chunks.push({ path: chunkPath, startOffset: start });
      logger.info('Chunk extracted', { index, start, chunkPath, size });
      start += step;
    } catch (err) {
      logger.info('Chunk extraction failed (EOF)', { index, start, error: err instanceof Error ? err.message : String(err) });
      break;
    }
  }

  logger.info('chunkWav complete', { totalChunks: chunks.length });
  return chunks;
}

function extractSegmentWithTimeout(
  src: string,
  dest: string,
  startSeconds: number,
  durationSeconds: number,
  timeoutMs = 30000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`FFmpeg extraction timeout after ${timeoutMs}ms (likely EOF)`));
    }, timeoutMs);

    ffmpeg(src)
      .setStartTime(startSeconds)
      .setDuration(durationSeconds)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .on('end', () => {
        clearTimeout(timer);
        resolve();
      })
      .save(dest);
  });
}
