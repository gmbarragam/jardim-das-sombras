import { FastifyPluginAsync } from 'fastify';
import { requireBotApiKey } from '../plugins/auth.js';
import {
  getEconomyPlayers,
  getEconomySummary,
  parsePlayersWindow,
  parseSummaryOptions,
  parseSummaryWindow,
} from '../services/EconomySummaryService.js';
import { setAttrs, withSpan } from '../telemetry.js';
import { getEconomyParams } from '../utils/economyParams.js';

/** Rotas internas consumidas só pela ravena-ai (x-api-key). */
export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /internal/economy/summary?from=<epoch_ms>&to=<epoch_ms>[&balances=0|1][&received=0|1] — resumo agregado das Petalitas
  fastify.get<{ Querystring: { from?: string; to?: string; balances?: string; received?: string } }>(
    '/internal/economy/summary',
    { preHandler: [requireBotApiKey] },
    async (req, reply) => {
      const summary = await withSpan('economy summary', {}, async (span) => {
        const now = Date.now();
        const window = parseSummaryWindow(req.query, now);
        const options = parseSummaryOptions(req.query);
        setAttrs(
          {
            'jds.economy.window_ms': window.to - window.from,
            'jds.economy.full_history': window.from === 0,
            'jds.economy.balances': options.balances,
          },
          span,
        );
        const s = await getEconomySummary(fastify.prisma, window, now, options);
        setAttrs({
          'jds.economy.ledger_available': s.ledger.available,
          'jds.economy.accounts': s.balances?.accounts,
          'jds.economy.holders': s.balances?.holders,
        }, span);
        return s;
      });
      return reply.send(summary);
    },
  );

  // GET /internal/economy/players?from=<epoch_ms>&to=<epoch_ms> — saldo por jogador (janela de até 8 dias)
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    '/internal/economy/players',
    { preHandler: [requireBotApiKey] },
    async (req, reply) => {
      const result = await withSpan('economy players', {}, async (span) => {
        const now = Date.now();
        const window = parsePlayersWindow(req.query, now);
        setAttrs({ 'jds.economy.window_ms': window.to - window.from }, span);
        const r = await getEconomyPlayers(fastify.prisma, window, now);
        setAttrs({ 'jds.economy.players': r.players.length }, span);
        return r;
      });
      return reply.send(result);
    },
  );
  // GET /internal/economy/params — parâmetros de balanceamento das Petalitas (catálogo e sacola diária), mapa plano
  fastify.get('/internal/economy/params', { preHandler: [requireBotApiKey] }, async (_req, reply) => {
    const result = withSpan('economy params', {}, (span) => {
      const r = getEconomyParams();
      setAttrs({ 'jds.economy.params': Object.keys(r.params).length }, span);
      return r;
    });
    return reply.send(result);
  });
};
