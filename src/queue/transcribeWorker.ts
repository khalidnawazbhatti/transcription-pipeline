import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { Worker } from 'bullmq';
import type { TranscribeJobData } from './transcribeQueue.js';
import { normalizeToWav, chunkWav } from '../services/normalizeAudio.js';
import { transcribeChunks } from '../services/transcribe.js';
import prisma from '../db.js';
import logger from '../logger.js';

export const worker = new Worker<TranscribeJobData>(
  'transcribe',
  async (job) => {
    const { jobId, storedPath, language } = job.data;
    logger.info('Job processing started', { jobId, storedPath, language });

    try {
      await prisma.job.update({ where: { id: jobId }, data: { status: 'processing' } });

      // 1. Normalize to 16 kHz mono WAV
      const wavPath = storedPath.replace(/\.[^.]+$/, '.wav');
      const t0 = Date.now();
      logger.info('Starting FFmpeg normalization', { jobId, storedPath, wavPath });
      await normalizeToWav(storedPath, wavPath);
      logger.info('FFmpeg normalization done', { jobId, wavPath, ms: Date.now() - t0 });

      // 2. Chunk the WAV into 30 s windows with 1 s overlap
      const chunkDir = path.join('storage', 'audio', `${jobId}-chunks`);
      logger.info('Starting chunking', { jobId, chunkDir });
      const chunks = await chunkWav(wavPath, chunkDir);
      logger.info('Chunking complete', { jobId, chunkCount: chunks.length, chunks });

      // 3. Transcribe each chunk and stitch segments
      const t1 = Date.now();
      logger.info('Transcription started', { jobId, chunks: chunks.length });
      const { segments, fullText } = await transcribeChunks(chunks, language);
      const transcribeSecs = ((Date.now() - t1) / 1000).toFixed(1);
      logger.info('Transcription complete', { jobId, segments: segments.length, transcribeSecs });

      // 4. Persist transcript and mark job done
      logger.info('Creating transcript record', { jobId, segmentCount: segments.length });
      await prisma.transcript.create({
        data: {
          jobId,
          segments: JSON.stringify(segments),
          fullText,
        },
      });

      // Store total audio duration from the last segment's end timestamp
      const durationSeconds = segments.at(-1)?.end ?? null;
      logger.info('Updating job status to done', { jobId, durationSeconds });
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', durationSeconds },
      });

      logger.info('Job completed successfully', { jobId, durationSeconds });

      // 5. Clean up chunk files — original audio is kept, only temp chunks removed
      fs.rmSync(chunkDir, { recursive: true, force: true });
    } catch (err) {
      logger.error('Job worker error', { jobId, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : '' });
      throw err;
    }
  },
  {
    connection: {
      host: process.env['REDIS_HOST'] ?? '127.0.0.1',
      port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
    },
  },
);

worker.on('failed', async (job, err) => {
  if (!job) return;
  // Only write to DB on the final attempt — earlier failures will be retried
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await prisma.job.update({
      where: { id: job.data.jobId },
      data: { status: 'failed', error: err.message },
    });
    logger.error('Job failed permanently', { jobId: job.data.jobId, error: err });
  }
});
