import swaggerJsdoc from 'swagger-jsdoc';
import { fileURLToPath } from 'url';
import path from 'path';

// glob requires forward slashes on all platforms
const routesGlob = path
  .join(path.dirname(fileURLToPath(import.meta.url)), '../routes/*.ts')
  .replace(/\\/g, '/');

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'Transcription Pipeline API', version: '1.0.0' },
  },
  apis: [routesGlob],
});

export default spec;
