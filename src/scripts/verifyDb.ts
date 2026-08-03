import 'dotenv/config';
import prisma from '../db.js';

async function main() {
  const jobsBefore = await prisma.job.count();
  process.stdout.write(`Jobs before: ${jobsBefore}\n`);

  const job = await prisma.job.create({
    data: {
      id: 'verify-001',
      originalFilename: 'test.mp3',
      storedPath: '/storage/audio/test.mp3',
      status: 'pending',
    },
  });
  process.stdout.write(`Created Job: ${job.id} | status: ${job.status}\n`);

  const transcript = await prisma.transcript.create({
    data: {
      jobId: job.id,
      segments: JSON.stringify([{ start: 0, end: 2.5, text: 'Hello world' }]),
      fullText: 'Hello world',
    },
  });
  process.stdout.write(`Created Transcript: ${transcript.id}\n`);

  const found = await prisma.job.findUnique({
    where: { id: job.id },
    include: { transcript: true },
  });
  process.stdout.write(`Read back Job with transcript: ${found?.transcript ? 'yes' : 'no'}\n`);

  await prisma.job.delete({ where: { id: job.id } });
  process.stdout.write(`Cleanup OK\n`);

  process.stdout.write(`Prisma + SQLite: OK\n`);
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
