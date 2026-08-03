import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';

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
 */
export async function chunkWav(
  wavPath: string,
  chunkDir: string,
  chunkSeconds = 30,
  overlapSeconds = 1,
): Promise<AudioChunk[]> {
  const duration = await getAudioDuration(wavPath);
  fs.mkdirSync(chunkDir, { recursive: true });

  const chunks: AudioChunk[] = [];
  const step = chunkSeconds - overlapSeconds;

  for (let start = 0; start < duration; start += step) {
    const end = Math.min(start + chunkSeconds, duration);
    const index = chunks.length;
    const chunkPath = path.join(chunkDir, `chunk-${index}.wav`);

    await extractSegment(wavPath, chunkPath, start, end - start);
    chunks.push({ path: chunkPath, startOffset: start });

    if (end >= duration) break;
  }

  return chunks;
}

function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration ?? 0);
    });
  });
}

function extractSegment(
  src: string,
  dest: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(src)
      .setStartTime(startSeconds)
      .setDuration(durationSeconds)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('error', reject)
      .on('end', () => resolve())
      .save(dest);
  });
}
