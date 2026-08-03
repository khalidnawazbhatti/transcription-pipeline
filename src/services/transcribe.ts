import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@xenova/transformers';
import type { AudioChunk } from './normalizeAudio.js';
import logger from '../logger.js';

export interface Segment {
  start: number;
  end: number;
  text: string;
}

// Loaded once on first use and reused for every subsequent request
let transcriber: AutomaticSpeechRecognitionPipeline | null = null;

async function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!transcriber) {
    logger.info('Loading Whisper model (first load — model will be cached after this)');
    transcriber = (await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-base',
    )) as AutomaticSpeechRecognitionPipeline;
    logger.info('Whisper model loaded');
  }
  return transcriber;
}

/**
 * Transcribe a list of audio chunks and stitch the segments back together.
 * Each chunk's startOffset is added to all returned timestamps so the final
 * segments are relative to the start of the original file, not each chunk.
 */
export async function transcribeChunks(
  chunks: AudioChunk[],
  language: string | null,
): Promise<{ segments: Segment[]; fullText: string }> {
  const model = await getTranscriber();
  const allSegments: Segment[] = [];

  for (const chunk of chunks) {
    const start = Date.now();
    logger.info('Transcribing chunk', { path: chunk.path, offset: chunk.startOffset });

    // Verified against @xenova/transformers v2.17.2 source (tokenizers.js:4230):
    // language accepts ISO 639-1 code ("en") or full name ("english") — both resolve correctly.
    // return_timestamps: true returns chunk-level timestamps; 'word' returns word-level.
    const result = (await model(chunk.path, {
      language: language ?? undefined,
      task: 'transcribe',
      return_timestamps: true,
    })) as {
      text: string;
      chunks?: { timestamp: [number, number]; text: string }[];
    };

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info('Chunk transcribed', { offset: chunk.startOffset, durationMs: elapsed });

    if (result.chunks) {
      for (const c of result.chunks) {
        allSegments.push({
          start: (c.timestamp[0] ?? 0) + chunk.startOffset,
          end: (c.timestamp[1] ?? 0) + chunk.startOffset,
          text: c.text.trim(),
        });
      }
    } else if (result.text) {
      // Fallback when timestamps are not returned: place the whole chunk as one segment
      allSegments.push({
        start: chunk.startOffset,
        end: chunk.startOffset,
        text: result.text.trim(),
      });
    }
  }

  const fullText = allSegments.map((s) => s.text).join(' ');
  return { segments: allSegments, fullText };
}
