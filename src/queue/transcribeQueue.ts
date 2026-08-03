import { Queue } from 'bullmq';

export interface TranscribeJobData {
  jobId: string;
  storedPath: string;
  language: string | null;
}

export const transcribeQueue = new Queue<TranscribeJobData>('transcribe', {
  connection: {
    host: process.env['REDIS_HOST'] ?? '127.0.0.1',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});
