/**
 * GET /internal/economy/summary (painel da economia, seção 1 do contrato).
 *
 * Os testes de rota precisam de um Postgres descartável com o schema aplicado; sem
 * JDS_TEST_DATABASE_URL eles são pulados. Exemplo:
 *   docker run -d --rm --name jds-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=jds_test -p 127.0.0.1:55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/jds_test npx prisma db push --skip-generate
 *   JDS_TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/jds_test npm test
 * NUNCA aponte para um banco real: os testes apagam a tabela players.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { FastifyInstance } from 'fastify';
import { parseSummaryOptions, parseSummaryWindow, toQuintiles } from '../src/services/EconomySummaryService.js';
import { DomainError } from '../src/errors/DomainError.js';

const NOW = 1_763_400_000_000;

describe('parseSummaryWindow', () => {
  const bad = (q: Record<string, unknown> | undefined) => {
    let err: unknown;
    try {
      parseSummaryWindow(q as never, NOW);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).statusCode).toBe(400);
  };

  it('aceita from=0 (histórico inteiro) e devolve números', () => {
    expect(parseSummaryWindow({ from: '0', to: String(NOW) }, NOW)).toEqual({ from: 0, to: NOW });
  });

  it('aceita to até 60 s no futuro', () => {
    expect(parseSummaryWindow({ from: '1', to: String(NOW + 60_000) }, NOW).to).toBe(NOW + 60_000);
  });

  it('rejeita parâmetros ausentes, não numéricos, negativos ou decimais', () => {
    bad(undefined);
    bad({});
    bad({ from: '0' });
    bad({ to: String(NOW) });
    bad({ from: 'abc', to: String(NOW) });
    bad({ from: '-1', to: String(NOW) });
    bad({ from: '1.5', to: String(NOW) });
    bad({ from: '', to: String(NOW) });
    bad({ from: ['0', '1'], to: String(NOW) });
    bad({ from: '0', to: '99999999999999999' });
  });

  it('rejeita to <= from e to mais de 60 s no futuro', () => {
    bad({ from: '10', to: '10' });
    bad({ from: '11', to: '10' });
    bad({ from: '0', to: String(NOW + 60_001) });
  });
});

describe('parseSummaryOptions', () => {
  it('padrão: balances=1, received=0', () => {
    expect(parseSummaryOptions(undefined)).toEqual({ balances: true, received: false });
    expect(parseSummaryOptions({})).toEqual({ balances: true, received: false });
  });

  it('aceita 0 e 1', () => {
    expect(parseSummaryOptions({ balances: '0', received: '1' })).toEqual({ balances: false, received: true });
    expect(parseSummaryOptions({ balances: '1', received: '0' })).toEqual({ balances: true, received: false });
  });

  it.each([['balances', 'true'], ['balances', '2'], ['balances', ''], ['received', 'sim'], ['received', '-1']])(
    'rejeita %s=%s com 400',
    (name, value) => {
      let err: unknown;
      try {
        parseSummaryOptions({ [name]: value });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).statusCode).toBe(400);
    },
  );
});

describe('toQuintiles', () => {
  it('não anula quintos pequenos (n < 10); quinto vazio fica com nulos', () => {
    const out = toQuintiles([
      { q: 1, n: 9, min: 1, max: 5, sum: 20 },
      { q: 2, n: 10, min: 6, max: 9, sum: 70 },
      { q: 3, n: 0, min: null, max: null, sum: null },
    ]);
    expect(out[0]).toEqual({ q: 1, n: 9, min: 1, max: 5, sum: 20 });
    expect(out[1]).toEqual({ q: 2, n: 10, min: 6, max: 9, sum: 70 });
    expect(out[2]).toEqual({ q: 3, n: 0, min: null, max: null, sum: null });
  });
});

const DB_URL = process.env.JDS_TEST_DATABASE_URL;
const API_KEY = 'chave-de-teste-economia';
const ROUTE = '/internal/economy/summary';

describe.skipIf(!DB_URL)('GET /internal/economy/summary (Postgres)', () => {
  let app: FastifyInstance;
  const exporter = new InMemorySpanExporter();

  const get = (query: string, headers: Record<string, string> = { 'x-api-key': API_KEY }) =>
    app.inject({ method: 'GET', url: `${ROUTE}${query}`, headers });
  const okQuery = () => `?from=0&to=${Date.now()}`;

  async function seed(coins: number[]) {
    await app.prisma.player.createMany({
      data: coins.map((c, i) => ({ id: `econ-seed-${String(i).padStart(3, '0')}`, coins: c })),
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.API_KEY = API_KEY;
    process.env.NODE_ENV = 'test';
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    const { buildServer } = await import('../src/server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.prisma.player.deleteMany({});
      await app.close();
    }
  });

  beforeEach(async () => {
    await app.prisma.player.deleteMany({});
    exporter.reset();
  });

  describe('autenticação', () => {
    it('401 sem chave', async () => {
      expect((await get(okQuery(), {})).statusCode).toBe(401);
    });
    it('401 com chave errada', async () => {
      expect((await get(okQuery(), { 'x-api-key': 'errada' })).statusCode).toBe(401);
    });
    it('401 com token de sessão de jogador (só a API_KEY do bot vale)', async () => {
      expect((await get(okQuery(), { authorization: 'Bearer token-qualquer' })).statusCode).toBe(401);
    });
    it('200 com x-api-key correta', async () => {
      expect((await get(okQuery())).statusCode).toBe(200);
    });
  });

  describe('validação', () => {
    it.each([
      ['sem parâmetros', ''],
      ['sem to', '?from=0'],
      ['from não numérico', '?from=abc&to=1000'],
      ['from negativo', '?from=-5&to=1000'],
      ['to igual a from', '?from=1000&to=1000'],
      ['to menor que from', '?from=2000&to=1000'],
      ['balances inválido', '?from=0&to=1000&balances=2'],
      ['balances=true', '?from=0&to=1000&balances=true'],
      ['received inválido', '?from=0&to=1000&received=x'],
    ])('400 com %s', async (_label, q) => {
      const res = await get(q);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_PAYLOAD');
    });

    it('400 com to no futuro (> agora + 60 s)', async () => {
      const res = await get(`?from=0&to=${Date.now() + 5 * 60_000}`);
      expect(res.statusCode).toBe(400);
    });

    it('a rejeição vira app.outcome=rejected no span, sem erro', async () => {
      await get('?from=5&to=1');
      const span = exporter.getFinishedSpans().find((s) => s.name === 'economy summary')!;
      expect(span.attributes['app.outcome']).toBe('rejected');
    });
  });

  it('forma da resposta: Petalitas, sem extrato e sem receivedByQuintile', async () => {
    const to = Date.now();
    const res = await get(`?from=1000&to=${to}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currency).toBe('petalitas');
    expect(body.schemaVersion).toBe(1);
    expect(body.window).toEqual({ from: 1000, to });
    expect(typeof body.generatedAt).toBe('number');
    expect(body.ledger).toEqual({ available: false, flows: [] });
    expect(body.receivedByQuintile).toEqual([]);
  });

  it('balances=0 pula o retrato e devolve balances: null; o resto da resposta não muda', async () => {
    await seed([100, 200, 300]);
    const to = Date.now();
    const spy = vi.spyOn(app.prisma, '$queryRaw');
    const res = await get(`?from=0&to=${to}&balances=0`);
    // Nenhuma consulta de saldos foi feita.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.balances).toBeNull();
    expect(body).toMatchObject({
      currency: 'petalitas',
      schemaVersion: 1,
      window: { from: 0, to },
      ledger: { available: false, flows: [] },
      receivedByQuintile: [],
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === 'economy summary')!;
    expect(span.attributes['jds.economy.balances']).toBe(false);
    expect(span.attributes['jds.economy.holders']).toBeUndefined();
  });

  it('balances=1 explícito e received=0|1 aceitos (received ignorado: sem extrato)', async () => {
    await seed([100, 200, 300]);
    for (const q of ['&balances=1', '&received=1', '&received=0', '&balances=1&received=1']) {
      const res = await get(`?from=0&to=${Date.now()}${q}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.balances).toMatchObject({ total: 600, holders: 3, accounts: 3 });
      expect(body.receivedByQuintile).toEqual([]);
    }
  });

  it('sanidade do espião: balances padrão chama a consulta de saldos uma vez', async () => {
    const spy = vi.spyOn(app.prisma, '$queryRaw');
    expect((await get(okQuery())).statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('banco vazio: zeros, percentis nulos e 5 quintos vazios', async () => {
    const { balances } = (await get(okQuery())).json();
    expect(balances).toMatchObject({ total: 0, holders: 0, accounts: 0, p50: null, p90: null, top10Share: null });
    expect(balances.quintiles).toHaveLength(5);
    for (const q of balances.quintiles) expect(q).toMatchObject({ n: 0, min: null, max: null, sum: null });
  });

  it('saldos, percentis, top10Share e quintos com 50 holders (+ contas zeradas e negativa)', async () => {
    // 50 holders: 100, 200, ..., 5000 (fora de ordem), 3 contas zeradas e 1 negativa.
    const holders = Array.from({ length: 50 }, (_, i) => (i + 1) * 100).reverse();
    await seed([...holders, 0, 0, 0, -200]);

    const res = await get(okQuery());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const b = body.balances;

    expect(b.accounts).toBe(54);
    expect(b.holders).toBe(50);
    expect(b.total).toBe(127_500 - 200); // a massa inclui o saldo negativo
    expect(b.p50).toBe(2500);
    expect(b.p90).toBe(4500);
    // top 10% dos holders = 5 contas (4600..5000) sobre a massa dos holders
    expect(b.top10Share).toBeCloseTo(24_000 / 127_500, 10);
    expect(b.quintiles).toEqual([
      { q: 1, n: 10, min: 100, max: 1000, sum: 5500 },
      { q: 2, n: 10, min: 1100, max: 2000, sum: 15500 },
      { q: 3, n: 10, min: 2100, max: 3000, sum: 25500 },
      { q: 4, n: 10, min: 3100, max: 4000, sum: 35500 },
      { q: 5, n: 10, min: 4100, max: 5000, sum: 45500 },
    ]);

    // Nenhum ID de jogador na resposta.
    expect(res.body).not.toContain('econ-seed-');

    const span = exporter.getFinishedSpans().find((s) => s.name === 'economy summary')!;
    expect(span).toBeDefined();
    expect(span.attributes['app.outcome']).toBe('ok');
    expect(span.attributes['jds.economy.holders']).toBe(50);
    expect(span.attributes['jds.economy.accounts']).toBe(54);
    expect(span.attributes['jds.economy.ledger_available']).toBe(false);
    expect(Object.keys(span.attributes).some((k) => k.includes('user'))).toBe(false);
    expect(JSON.stringify(span.attributes)).not.toContain('econ-seed-');
  });

  it('quintos com n < 10 saem preenchidos', async () => {
    // 23 holders: ntile(5) = 5, 5, 5, 4, 4
    await seed(Array.from({ length: 23 }, (_, i) => (i + 1) * 10));
    const b = (await get(okQuery())).json().balances;
    expect(b.holders).toBe(23);
    expect(b.total).toBe(10 * (23 * 24) / 2);
    expect(b.quintiles).toEqual([
      { q: 1, n: 5, min: 10, max: 50, sum: 150 },
      { q: 2, n: 5, min: 60, max: 100, sum: 400 },
      { q: 3, n: 5, min: 110, max: 150, sum: 650 },
      { q: 4, n: 4, min: 160, max: 190, sum: 700 },
      { q: 5, n: 4, min: 200, max: 230, sum: 860 },
    ]);
    // top 10% = ceil(2.3) = 3 contas: 230 + 220 + 210
    expect(b.top10Share).toBeCloseTo(660 / 2760, 10);
  });

  it('quinto com 10 e com 9 contas saem preenchidos', async () => {
    // 49 holders: ntile(5) = 10, 10, 10, 10, 9
    await seed(Array.from({ length: 49 }, (_, i) => i + 1));
    const qs = (await get(okQuery())).json().balances.quintiles;
    expect(qs.map((q: { n: number }) => q.n)).toEqual([10, 10, 10, 10, 9]);
    expect(qs[3]).toEqual({ q: 4, n: 10, min: 31, max: 40, sum: 355 });
    expect(qs[4]).toEqual({ q: 5, n: 9, min: 41, max: 49, sum: 405 });
  });

  it('com 2 holders, os quintos com membros saem preenchidos e os vazios com n=0 e nulos', async () => {
    await seed([300, 700, 0]);
    const qs = (await get(okQuery())).json().balances.quintiles;
    expect(qs).toEqual([
      { q: 1, n: 1, min: 300, max: 300, sum: 300 },
      { q: 2, n: 1, min: 700, max: 700, sum: 700 },
      { q: 3, n: 0, min: null, max: null, sum: null },
      { q: 4, n: 0, min: null, max: null, sum: null },
      { q: 5, n: 0, min: null, max: null, sum: null },
    ]);
  });
});
