import 'dotenv/config';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import spec from './docs/swagger.js';
import transcribeRouter from './routes/transcribe.js';
import logger from './logger.js';
import './queue/transcribeWorker.js';

const app = express();
const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

app.use(express.json());

// serveFiles(spec) bakes the spec into the init JS — required for swagger-ui-express v5
app.use('/docs', swaggerUi.serveFiles(spec), swaggerUi.setup(spec));
app.use('/transcribe', transcribeRouter);

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
});

export default app;
