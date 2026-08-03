import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@xenova/transformers';
import fs from 'fs';
import type { AudioChunk } from './normalizeAudio.js';
import logger from '../logger.js';

export interface Segment {
  start: number;
  end: number;
  text: string;
}

// Loaded once on first use and reused for every subsequent request
let transcriber: AutomaticSpeechRecognitionPipeline | null = null;

/**
 * Read a 16kHz mono PCM WAV into a Float32Array.
 * AudioContext is unavailable in Node.js, so we decode the WAV manually.
 * WAV header is 44 bytes; remaining bytes are int16 little-endian samples.
 */
function readWavToFloat32(filePath: string): Float32Array {
  const buf = fs.readFileSync(filePath);
  const headerSize = 44;
  const samples = (buf.length - headerSize) / 2; // int16 = 2 bytes each
  const float32 = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const int16 = buf.readInt16LE(headerSize + i * 2);
    float32[i] = int16 / 32768.0;
  }
  return float32;
}

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
  language: string,
): Promise<{ segments: Segment[]; fullText: string }> {
  logger.info('transcribeChunks starting', { chunkCount: chunks.length, language });
  const model = await getTranscriber();
  logger.info('Transcriber loaded', { chunkCount: chunks.length });
  const allSegments: Segment[] = [];

  for (const chunk of chunks) {
    const start = Date.now();
    logger.info('Transcribing chunk', { path: chunk.path, offset: chunk.startOffset });

    try {
      // AudioContext unavailable in Node.js — pass decoded Float32Array directly.
      // Verified against @xenova/transformers v2.17.2: language accepts ISO 639-1 or full name.
      const audioData = readWavToFloat32(chunk.path);
      const result = (await model(audioData, {
        language: language,
        task: 'transcribe',
        return_timestamps: true,
      })) as {
        text: string;
        chunks?: { timestamp: [number, number]; text: string }[];
      };

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      logger.info('Chunk transcribed', { offset: chunk.startOffset, durationMs: elapsed, textLength: result.text.length });

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
    } catch (err) {
      logger.error('Chunk transcription error', { path: chunk.path, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  const fullText = allSegments.map((s) => s.text).join(' ');
  logger.info('transcribeChunks complete', { segmentCount: allSegments.length, fullTextLength: fullText.length });
  return { segments: allSegments, fullText };
}
