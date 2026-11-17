import { FastifyPluginAsync } from 'fastify';
import { requireBotApiKey } from '../plugins/auth.js';
import { getEconomySummary, parseSummaryWindow } from '../services/EconomySummaryService.js';
import { setAttrs, withSpan } from '../telemetry.js';

/** Rotas internas consumidas só pela ravena-ai (x-api-key). */
export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /internal/economy/summary?from=<epoch_ms>&to=<epoch_ms> — resumo agregado das Petalitas
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    '/internal/economy/summary',
    { preHandler: [requireBotApiKey] },
    async (req, reply) => {
      const summary = await withSpan('economy summary', {}, async (span) => {
        const now = Date.now();
        const window = parseSummaryWindow(req.query, now);
        setAttrs({ 'jds.economy.window_ms': window.to - window.from, 'jds.economy.full_history': window.from === 0 }, span);
        const s = await getEconomySummary(fastify.prisma, window, now);
        setAttrs({
          'jds.economy.ledger_available': s.ledger.available,
          'jds.economy.accounts': s.balances.accounts,
          'jds.economy.holders': s.balances.holders,
        }, span);
        return s;
      });
      return reply.send(summary);
    },
  );
};
