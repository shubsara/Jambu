/**
 * GET /health (docs/API.md §2). Unauthenticated.
 *
 * Reports only that the process is up and which version it is. It performs no
 * database round-trip and exposes no dependency detail: an unauthenticated
 * endpoint should not let anyone probe the health of our infrastructure.
 */
import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(app: FastifyInstance, version: string): void {
  app.get('/health', async () => ({ status: 'ok', version }));
}
