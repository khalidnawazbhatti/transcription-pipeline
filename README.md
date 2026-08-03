# Transcription Pipeline

## What this does

Accepts audio file uploads (any format: mp3, m4a, wav, ogg, flac, etc.) via HTTP and returns a transcription asynchronously. The caller gets a `jobId` immediately, then polls a status endpoint until the transcript is ready. Transcription runs fully locally using Whisper via ONNX — no API keys, no cloud calls after the model is cached.

## Architecture

```
POST /transcribe
  → multer saves audio to /storage/audio/<uuid>.<ext>
  → Job row inserted (status: pending)
  → BullMQ job enqueued
  → { jobId } returned to caller immediately

BullMQ Worker (same process, could be a separate service)
  → ffmpeg: convert audio → 16 kHz mono PCM WAV
  → ffmpeg: split WAV into 30s chunks with 1s overlap
  → Whisper (Xenova/whisper-base, ONNX): transcribe each chunk
  → stitch segments, adjusting timestamps by chunk start offset
  → Transcript row written to SQLite
  → Job status → "done" (or "failed" with error message)

GET /transcribe/:jobId
  → return job status + transcript segments + fullText when done
```

## Key design decisions

### Why SQLite + Prisma instead of Postgres

SQLite requires zero infrastructure — a reviewer clones the repo, runs `npx prisma migrate dev`, and it works with no Docker, no DB server, no connection string beyond a file path. That matters for a take-home assignment that someone else has to run.

The trade-off: SQLite uses a single-writer lock. Concurrent write transactions can hit `SQLITE_BUSY` under load. Postgres uses MVCC and handles many concurrent writers natively. At this assignment's scale (one upload at a time in dev) that limitation is never exercised, but it's the concrete reason to migrate to Postgres before this handles real production traffic.

Migration path when needed: change `provider = "sqlite"` to `provider = "postgresql"` in `prisma/schema.prisma`, point `DATABASE_URL` at a Postgres connection string, and re-run `npx prisma migrate dev`. The only data-type change is `Transcript.segments` which goes from `String` (JSON stringified) to `Json` (native `jsonb`) — a one-field schema change.

### Why ffmpeg normalization before transcription

Audio files arrive in arbitrary formats: m4a (AAC), mp3, ogg, flac, webm, wav at various sample rates. Whisper requires 16 kHz mono PCM. Rather than handling every codec/container combination inside the transcription code, ffmpeg normalizes everything to a single known format (16 kHz mono WAV) before any STT call. This keeps the transcription service simple (it only ever sees one format) and lets ffmpeg's battle-tested codec support handle format variety.

### Why 30s chunks with 1s overlap

Whisper's context window is 30 seconds. Files longer than that must be split. A 1-second overlap at each boundary prevents words from being silently dropped at chunk edges — if a word straddles the 30s boundary, it appears in both chunks and the stitching logic keeps the earlier occurrence.

Each chunk is processed independently, which means:
- Memory is bounded regardless of file length (only one 30s WAV chunk in memory at a time)
- A failure on chunk N doesn't prevent chunks 1–(N-1) from completing
- This is a natural fit for a BullMQ sub-job per chunk if horizontal scaling is needed

### Why BullMQ + Redis instead of an in-memory queue

An in-process array queue (e.g. a simple `setImmediate` loop) disappears if the server crashes — all pending jobs are lost silently. BullMQ persists job state in Redis, so:
- A crashed worker restarts and resumes the queue
- Retry with exponential backoff is two lines of config
- Job history (completed/failed) is queryable
- Workers can be scaled horizontally to multiple processes/machines

The cost is an external Redis dependency, but Redis runs in a single Docker container and requires no configuration.

### Why the API returns jobId immediately instead of blocking

Audio transcription is CPU-bound. A 2-second clip takes 1–5 seconds on CPU; a 30-minute file would take minutes. Holding the HTTP connection open for that duration is impractical — it ties up a connection slot, hits proxy timeouts, and makes the client API useless for anything except tiny clips.

Returning `{ jobId }` immediately and letting the caller poll `GET /transcribe/:jobId` decouples upload latency from transcription latency. The caller can display "processing…" UI, retry on its own schedule, and handle failures without hanging on a socket.

## How different audio formats are handled

Before any transcription starts, the uploaded file is passed through `fluent-ffmpeg` with these output settings:

```
audioFrequency(16000)  // 16 kHz sample rate required by Whisper
audioChannels(1)       // mono
audioCodec('pcm_s16le') // signed 16-bit little-endian PCM
format('wav')
```

ffmpeg-static bundles the ffmpeg binary directly in node_modules — no system install required. The input can be any format ffmpeg supports: mp3, m4a (AAC), ogg, flac, wav at any sample rate, webm, etc. The output is always the same 16 kHz mono WAV that Whisper expects.

## How long audio files are handled

After normalization, the WAV is split into 30-second chunks with 1-second overlap using ffmpeg's `-ss` (start time) and `-t` (duration) options. Each chunk is a separate file under `storage/audio/<jobId>-chunks/`.

Whisper transcribes each chunk independently, returning segments with timestamps relative to the chunk start. After transcription, each segment's `start` and `end` are shifted by the chunk's start offset before stitching, so the final segments in the database are relative to the start of the original file.

Chunk detection uses file size: ffmpeg always writes a valid WAV header (44 bytes) even when the start offset exceeds the file's duration, producing a ~78-byte empty file. The chunking loop stops as soon as an extracted chunk is smaller than 4800 bytes (0.15 seconds of 16 kHz mono PCM) — that threshold reliably distinguishes an empty-EOF chunk from real audio.

## How language is handled

`POST /transcribe` accepts an optional `language` field (ISO 639-1 code: `"en"`, `"es"`, `"hi"`, etc.). If omitted or empty, it defaults to `"en"`.

The language is stored on the `Job` row and passed to Whisper's generation options:

```ts
await model(audioData, {
  language: language,   // e.g. "en", "es"
  task: 'transcribe',
  return_timestamps: true,
});
```

Whisper's multilingual model can also auto-detect language, but auto-detection is unreliable on short or noisy clips — it may silently return a transcript in the wrong language. Defaulting to `"en"` avoids that failure mode for the common case. Callers who need another language pass it explicitly.

## Concurrency

Express handles concurrent HTTP requests without any changes — 10 simultaneous uploads would all return `{ jobId }` within milliseconds. The actual bottleneck is the BullMQ worker, which processes one job at a time by default (concurrency: 1) because Whisper inference is CPU-bound and running multiple instances in parallel would thrash the CPU without improving throughput.

To scale: run multiple worker processes (one per CPU core) and set `concurrency: 1` per worker. BullMQ's Redis-backed queue distributes jobs across workers automatically. The HTTP server never blocks.

## Retry & failure handling

The BullMQ queue is configured with:

```ts
defaultJobOptions: {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 }, // 5s → 10s → 20s
}
```

If a job fails after all 3 attempts, the `worker.on('failed')` handler updates the `Job` row:

```ts
{ status: 'failed', error: err.message }
```

A caller polling `GET /transcribe/:jobId` sees `{ "status": "failed", "error": "..." }` — the failure is visible and diagnosable without looking at logs. The full error stack is also written to `logs/error.log` by Winston.

To trace a failed transcription:
1. Check `GET /transcribe/:jobId` for the `error` field
2. Search `logs/error.log` for the jobId
3. The combined log at `logs/combined.log` has the full pipeline trace for that jobId

## API

Interactive docs at: `http://localhost:3000/docs`

### Upload audio

```bash
curl -X POST http://localhost:3000/transcribe \
  -F "audio=@recording.m4a" \
  -F "language=en"
```

Response (202):
```json
{ "jobId": "550e8400-e29b-41d4-a716-446655440000" }
```

`language` is optional — omit it to use the default (`en`).

### Poll status

```bash
curl http://localhost:3000/transcribe/550e8400-e29b-41d4-a716-446655440000
```

Response while processing:
```json
{ "jobId": "...", "status": "processing", "language": "en", "durationSeconds": null }
```

Response when done:
```json
{
  "jobId": "...",
  "status": "done",
  "language": "en",
  "durationSeconds": 27.4,
  "transcript": {
    "fullText": "Hello, this is a test recording.",
    "segments": [
      { "start": 0.0, "end": 2.1, "text": "Hello, this is a test recording." }
    ]
  }
}
```

Response on failure:
```json
{ "jobId": "...", "status": "failed", "error": "ffmpeg exited with code 1" }
```

## What I'd change for production

| Concern | Current | Production path |
|---|---|---|
| Database | SQLite (single-writer lock) | Postgres — MVCC handles concurrent writes; `Transcript.segments` becomes `jsonb` |
| Audio storage | Local disk (`storage/audio/`) | S3 or GCS — durable, shared across worker instances, no disk capacity limits |
| Worker scaling | 1 worker, same process as HTTP server | Separate worker containers, one per CPU core, sharing Redis queue |
| Auth | None | API key or JWT middleware on all routes |
| Model | `Xenova/whisper-base` (~74M params) | `Xenova/whisper-large-v3` for better accuracy, or a batched GPU inference service |
| Transcripts storage | `String` (JSON stringified) | `jsonb` column in Postgres for queryable segment data |

## Setup

### Prerequisites

- Node.js 18+
- Docker (required for Redis in both methods; required for the full Docker method)

---

### Option A — Node.js (development)

**1. Clone and install**

```bash
git clone <repo-url>
cd transcription-pipeline
npm install --legacy-peer-deps
```

**2. Configure**

```bash
cp .env.example .env
# No changes needed — defaults work out of the box
```

**3. Set up the database**

```bash
npx prisma migrate dev
```

**4. Start Redis**

```bash
docker compose up -d redis
```

**5. Start the server**

```bash
npx tsx src/server.ts
```

Server: `http://localhost:3000`  
Swagger: `http://localhost:3000/docs`

On first upload, the Whisper model (`Xenova/whisper-base`, ~74 MB) is downloaded and cached. Subsequent uploads skip the download.

---

### Option B — Docker Compose (full stack)

Runs Redis + the app in containers. No Node.js or local Redis install required.

**1. Clone**

```bash
git clone <repo-url>
cd transcription-pipeline
```

**2. Build and start everything**

```bash
docker compose up --build
```

This builds the app image, runs `prisma migrate deploy` inside the container, and starts both Redis and the API server.

Server: `http://localhost:3000`  
Swagger: `http://localhost:3000/docs`

**3. Stop**

```bash
docker compose down
```

Audio files are persisted in `./storage/` and logs in `./logs/` on your host machine (bind-mounted volumes). The SQLite database persists in the `db-data` Docker named volume.

---

### Logs

```
logs/combined.log   — full pipeline trace for every job
logs/error.log      — errors only, with full stack traces
```
