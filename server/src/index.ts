// REST API bootstrap (Fastify).

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config.ts';
import { getDb } from './db.ts';
import { registerRoutes } from './routes/api.ts';

async function main() {
  getDb(); // open + create schema up front

  const app = Fastify({ logger: { level: 'info', transport: undefined } });
  await app.register(cors, { origin: true });
  await app.register(registerRoutes, { prefix: '/api' });

  app.get('/', async () => ({
    name: 'tennis-predictor API',
    docs: 'See /api/health, /api/tours, /api/matches/upcoming, /api/predictions/:id',
  }));

  try {
    await app.listen({ port: env.port, host: '0.0.0.0' });
    app.log.info(`Tennis Predictor API listening on http://localhost:${env.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
