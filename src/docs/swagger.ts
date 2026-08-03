import swaggerJsdoc from 'swagger-jsdoc';

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'Transcription Pipeline API', version: '1.0.0' },
  },
  // Points to source .ts files; swagger-jsdoc parses JSDoc comments from them
  apis: ['./src/routes/*.ts'],
});

export default spec;
