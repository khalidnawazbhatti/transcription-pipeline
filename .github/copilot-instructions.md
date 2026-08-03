# Copilot Instructions — Audio Transcription Pipeline 

## Ground rules for the agent (read first)

1. Only use the libraries listed below. Do not invent package names, APIs, or
   config options. If a package needs a version, check `npm view <pkg> versions`
   or npmjs.com before pinning one — don't guess a version number.
2. Do not silently swap in a paid/cloud STT API (OpenAI API, Google Speech,
   AssemblyAI, etc.). This must run fully local and free, per the assignment.
3. Keep the implementation simple and readable — this is an assignment being
   evaluated on engineering judgment, not a production system. Prefer clear
   code over cleverness.
4. Every design decision (format handling, long-file handling, concurrency,
   storage, retries, API shape) must be written down in README.md in plain
   English, even where not fully implemented.
5. If unsure whether a package/API exists or behaves a certain way, say so in
   a `// TODO: verify` comment rather than fabricating behavior.

---

## Tech stack (all free / open-source, no API keys required)

| Concern | Package | Why |
|---|---|---|
| Web server | `express` | Standard, minimal, well documented |
| File upload | `multer` | Standard multipart/form-data handling for Express |
| Audio format conversion | `fluent-ffmpeg` + `ffmpeg-static` | Normalizes any input (mp3, m4a, ogg, wav, etc.) to a consistent WAV (16kHz mono PCM) before transcription — this is the actual answer to "how do you handle different audio formats" |
| Speech-to-text (local, free) | `@xenova/transformers` (Transformers.js — runs Whisper models like `Xenova/whisper-tiny.en` or `Xenova/whisper-base` fully in Node via ONNX runtime, no API key, no internet call at inference time after the model is cached) | Free, open-source, runs offline. **Note:** this package was later renamed/moved to `@huggingface/transformers` — check npmjs.com for whichever is current before installing, since I can't verify that live right now. |
| Long-running job handling | `bullmq` + `ioredis` (Redis required, free/open-source) | Queue for async processing of long audio files, retries with backoff |
| Metadata/transcript storage | `prisma` + `@prisma/client`, SQLite provider | See DB recommendation below |
| API docs | `swagger-ui-express` + `swagger-jsdoc` | Serves interactive OpenAPI docs at `/docs` |
| Logging | `winston` | Structured logs to console + local file, with error trace capture |
| Env config | `dotenv` | Standard |
| IDs | `uuid` | Standard |
| Dev reload | `nodemon` | Standard |

Do not add cloud SDKs (AWS SDK, GCP, Azure) unless you're actually pointing at
a real bucket. For the assignment, local disk storage under `/storage/audio`
and `/storage/transcripts` is sufficient — say this explicitly in the README.

---

## Recommended DB: SQLite + Prisma (with Postgres noted as the production path)

Use **SQLite via Prisma ORM** for the actual running code in this assignment:

- The schema is simple and genuinely relational (jobs, transcripts, segments)
  — no need for Postgres-specific features to represent it correctly.
- Zero setup: no Docker, no separate DB server. A reviewer clones the repo,
  runs `npx prisma migrate dev`, and it works — this matters a lot for a
  take-home that someone else has to run.
- Prisma gives type-safe queries and migrations, and because the schema file
  is provider-agnostic, switching to Postgres later is a one-line change
  (`provider = "postgresql"` + a new `DATABASE_URL`) plus re-running
  migrations — not a rewrite.

**Write this trade-off explicitly in the README:** SQLite has a single-writer
lock (one write transaction at a time; concurrent writers can hit
`SQLITE_BUSY`), whereas Postgres uses MVCC and handles many concurrent
writers natively. At this assignment's scale that limitation is never
actually exercised, but call it out as the reason you'd migrate to Postgres
if this had to handle real concurrent load in production.

Store the raw audio files on **local disk** under `/storage/audio` — store
only the file *path* in the DB, never the audio bytes themselves.

`prisma/schema.prisma`:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL") // e.g. "file:./dev.db"
}

generator client {
  provider = "prisma-client-js"
}

model Job {
  id               String   @id @default(uuid())
  originalFilename String
  storedPath       String
  status           String   @default("pending") // pending | processing | done | failed
  error            String?
  language         String?  // requested/detected language, see language handling below
  durationSeconds  Float?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  transcript       Transcript?
}

model Transcript {
  id        String   @id @default(uuid())
  jobId     String   @unique
  job       Job      @relation(fields: [jobId], references: [id], onDelete: Cascade)
  segments  String   // JSON.stringify'd array: [{ start, end, text }, ...]
  fullText  String
  createdAt DateTime @default(now())
}
```

If you later migrate to Postgres, the equivalent `Transcript.segments` column
becomes `Json` (mapped to native `jsonb`) instead of a stringified `String` —
note this in the README as the concrete migration step.

---

## Part 1 — build these three things

Ask Copilot to scaffold in this order (one small PR/commit each):

1. **`POST /transcribe`** (Express + Multer) — accepts an audio file upload,
   saves it to `/storage/audio/<uuid>.<ext>`, inserts a `jobs` row with
   status `pending`, returns `{ jobId }` immediately (don't block the
   response on transcription — see concurrency notes below).
2. **Format normalization step** — before running STT, pipe the uploaded
   file through `fluent-ffmpeg` to convert to 16kHz mono WAV regardless of
   input format (mp3, m4a, ogg, flac, wav). This is the real answer to the
   "different audio formats" question — normalize once, transcribe one
   format always.
3. **Transcription worker** — a separate function/worker (can be same
   process for the assignment, but structure it as a function you *could*
   move to a queue worker) that:
   - loads the Whisper model once (don't reload per request — cache in memory)
   - runs it on the normalized WAV
   - gets back segments with `start`, `end`, `text`
   - writes them into the `transcripts` table, flips job status to `done`
4. **`GET /transcribe/:jobId`** — returns job status, and the transcript
   (segments + full text) once done.

### Long audio files — what to actually implement
- Chunk the normalized WAV into fixed windows (e.g. 30s) with a small
  overlap (~1s) using ffmpeg, transcribe each chunk, then stitch segments
  back together adjusting timestamps by the chunk offset. This avoids
  loading a huge file into memory at once and keeps memory bounded
  regardless of input length.
- Note in the README that this is also a natural fit for a queue (BullMQ)
  where each chunk is a sub-job, so failures are isolated per chunk.

---

## Missing piece 1: Swagger / OpenAPI docs

Add `swagger-ui-express` + `swagger-jsdoc`. Write JSDoc `@openapi` comments
above each route in `src/routes/transcribe.js`, generate the spec at
startup, and mount it:

```js
// src/docs/swagger.js
import swaggerJsdoc from 'swagger-jsdoc';

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'Transcription Pipeline API', version: '1.0.0' },
  },
  apis: ['./src/routes/*.js'],
});

export default spec;
```

```js
// in server.js
import swaggerUi from 'swagger-ui-express';
import spec from './docs/swagger.js';

app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
```

Document at minimum: `POST /transcribe` (multipart body, `audio` field,
optional `language` field), `GET /transcribe/:jobId` (response schema for
`pending | processing | done | failed`, and the segments array shape).

## Missing piece 2: Retry implementation (concrete, not just written up)

Don't leave retries as a paragraph in Part 2 only — actually configure it on
the BullMQ queue, since it's a two-line config:

```js
// src/queue/transcribeQueue.js
import { Queue } from 'bullmq';

export const transcribeQueue = new Queue('transcribe', {
  connection: { host: '127.0.0.1', port: 6379 },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s
  },
});
```

On the worker side, on final failure (after all attempts exhausted), update
the `Job` row's `status` to `failed` and store the error message in the
`error` column — this is what makes the failure visible through
`GET /transcribe/:jobId` instead of disappearing silently:

```js
worker.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    await prisma.job.update({
      where: { id: job.data.jobId },
      data: { status: 'failed', error: err.message },
    });
  }
});
```

## Missing piece 3: Local file logging for tracing errors

Use `winston` with two file transports (errors-only, and combined) plus
console output in dev. Create one logger module and import it everywhere —
don't use `console.log` scattered through the codebase.

```js
// src/logger.js
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

export default logger;
```

Log at minimum: job created, job started processing, ffmpeg conversion
result, transcription start/end with duration taken, job completed, and the
full error stack on failure (Winston's `errors({ stack: true })` format
captures this). This is what you show in the video when explaining "how do
you trace a failed transcription."

## Missing piece 4: Language handling (currently dropped on the floor)

Whisper is multilingual, but if you never pass a language, the model
auto-detects — which is unreliable on short/noisy clips and silently
produces the wrong-language transcript. Fix this end to end:

1. Accept an optional `language` field in the `POST /transcribe` multipart
   body (e.g. `en`, `hi`, `es` — ISO 639-1 codes). Document it in Swagger.
2. Store it on the `Job` row (`language` column already in the schema above)
   — `null` means "auto-detect."
3. Pass it through to the Whisper call. In `@xenova/transformers`'s
   automatic-speech-recognition pipeline this is passed via generation
   options, roughly:

   ```js
   const output = await transcriber(audioPath, {
     language: job.language ?? undefined, // undefined = auto-detect
     task: 'transcribe',
     return_timestamps: true,
   });
   ```

   **Verify this exact option name/shape against the installed package's
   current docs before relying on it** — I'm not able to check the live
   package documentation from here, and pipeline option names have changed
   across versions of transformers.js.
4. If the model reports a detected language different from what was
   requested, log it (via winston) and include the detected language in the
   API response so the caller can see a mismatch instead of getting a
   silently wrong transcript.

---

## Part 2 — write-up only, put this in README.md

Don't over-implement Part 2. Write clear, short paragraphs on:

- **Concurrent uploads:** Express handles concurrent HTTP requests fine;
  the actual bottleneck is CPU-bound transcription. Push transcription work
  onto a BullMQ queue backed by Redis with a fixed number of worker
  processes/concurrency, so uploads never block on each other and you can
  scale workers horizontally.
- **Storage:** audio files on disk/S3, metadata + transcripts in Postgres
  (see schema above) — never store binary audio in the relational DB.
- **Retry/recovery:** BullMQ gives you retry with exponential backoff and a
  dead-letter/failed queue out of the box; on repeated failure, flip the job
  row to `status = failed` with an `error` message so it's visible via the
  API instead of silently disappearing.
- **API shape:** `POST /transcribe` (upload, returns job id immediately),
  `GET /transcribe/:jobId` (poll status/result), optionally a webhook or
  WebSocket/SSE push for when the job completes instead of polling.

---

## Required README.md structure

The README is graded on whether it explains *decisions*, not just what the
code does. Use this structure and actually fill in the "why" for each —
don't leave placeholder text:

```
# Transcription Pipeline

## What this does
[2-3 sentences]

## Architecture
[one diagram or bullet list: upload -> normalize -> queue -> transcribe -> store -> retrieve]

## Key design decisions
- Why SQLite + Prisma instead of Postgres/Mongo (the trade-off explained above)
- Why ffmpeg normalization to a single format before transcription
- Why chunking for long files, and the chunk size/overlap chosen and why
- Why BullMQ/Redis for the queue instead of just an in-memory array
- Why the API returns a jobId immediately instead of blocking until done

## How different audio formats are handled
[explain the ffmpeg normalization step]

## How long audio files are handled
[explain chunking + timestamp offset stitching]

## How language is handled
[explain the language field, auto-detect fallback, and where it's logged]

## Concurrency
[what happens today if 10 files are uploaded at once, and what the actual
bottleneck is — CPU-bound transcription, not the HTTP layer]

## Retry & failure handling
[BullMQ attempts/backoff config, what a caller sees via GET /transcribe/:jobId
when a job fails, where to find the error in logs/error.log]

## API
[link to /docs Swagger UI, plus a short curl example for POST /transcribe
and GET /transcribe/:jobId]

## What I'd change for production
[Postgres migration, S3 for audio, horizontal worker scaling, auth on the API]

## Setup
[npm install, npx prisma migrate dev, how to start Redis, npm run dev]
```

---

## Suggested repo structure

```
.
├── .github/copilot-instructions.md   (this file)
├── prisma/
│   └── schema.prisma
├── src/
│   ├── server.js
│   ├── logger.js
│   ├── docs/swagger.js
│   ├── routes/transcribe.js
│   ├── queue/transcribeQueue.js
│   ├── queue/transcribeWorker.js
│   ├── services/normalizeAudio.js    (ffmpeg conversion + chunking)
│   └── services/transcribe.js        (Whisper via transformers.js, language param)
├── storage/
│   ├── audio/
│   └── transcripts/
├── logs/
│   ├── error.log
│   └── combined.log
├── README.md
├── package.json
└── .env.example
```
