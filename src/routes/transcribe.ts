import { Router } from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import upload from '../middleware/upload.js';
import prisma from '../db.js';
import { transcribeQueue } from '../queue/transcribeQueue.js';
import logger from '../logger.js';

const router = Router();

/**
 * @openapi
 * /transcribe:
 *   post:
 *     summary: Upload an audio file for transcription
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [audio]
 *             properties:
 *               audio:
 *                 type: string
 *                 format: binary
 *                 description: Audio file (mp3, wav, m4a, ogg, flac, etc.)
 *               language:
 *                 type: string
 *                 description: ISO 639-1 language code (e.g. "en", "es"). Omit for auto-detect.
 *     responses:
 *       202:
 *         description: Job accepted, returns jobId for polling
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:
 *                   type: string
 *       400:
 *         description: No audio file provided
 */
router.post('/', upload.single('audio'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No audio file provided. Use field name "audio".' });
    return;
  }

  const jobId = uuidv4();
  const language = typeof req.body['language'] === 'string' ? req.body['language'] : null;

  await prisma.job.create({
    data: {
      id: jobId,
      originalFilename: req.file.originalname,
      storedPath: req.file.path,
      status: 'pending',
      language,
    },
  });

  await transcribeQueue.add('transcribe', { jobId, storedPath: req.file.path, language });

  logger.info('Job created', { jobId, filename: req.file.originalname, language });

  res.status(202).json({ jobId });
});

/**
 * @openapi
 * /transcribe/{jobId}:
 *   get:
 *     summary: Poll transcription job status and result
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job status and transcript when done
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:
 *                   type: string
 *                 status:
 *                   type: string
 *                   enum: [pending, processing, done, failed]
 *                 error:
 *                   type: string
 *                 language:
 *                   type: string
 *                 durationSeconds:
 *                   type: number
 *                 transcript:
 *                   type: object
 *                   properties:
 *                     fullText:
 *                       type: string
 *                     segments:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           start:
 *                             type: number
 *                           end:
 *                             type: number
 *                           text:
 *                             type: string
 *       404:
 *         description: Job not found
 */
router.get('/:jobId', async (req: Request, res: Response) => {
  const job = await prisma.job.findUnique({
    where: { id: String(req.params['jobId']) },
    include: { transcript: true },
  }) as (Awaited<ReturnType<typeof prisma.job.findUnique>> & { transcript: { fullText: string; segments: string } | null }) | null;

  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  const response: Record<string, unknown> = {
    jobId: job.id,
    status: job.status,
    language: job.language,
    durationSeconds: job.durationSeconds,
  };

  if (job.status === 'failed') {
    response['error'] = job.error;
  }

  if (job.transcript) {
    response['transcript'] = {
      fullText: job.transcript.fullText,
      segments: JSON.parse(job.transcript.segments) as unknown[],
    };
  }

  res.json(response);
});

export default router;
