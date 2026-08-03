import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

// Strip the "file:" prefix that Prisma uses but better-sqlite3 does not
const url = (process.env['DATABASE_URL'] ?? 'file:./dev.db').replace(/^file:/, '');
const adapter = new PrismaBetterSqlite3({ url });

// Single instance reused across the process — avoids exhausting SQLite connections
const prisma = new PrismaClient({ adapter });

export default prisma;
