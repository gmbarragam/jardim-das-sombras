import { PrismaClient } from '@prisma/client';
import { DomainError } from '../errors/DomainError.js';

/**
 * Resumo agregado da economia de Petalitas para o painel da ravena-ai
 * (contrato "Painel da economia", seção 1).
 *
 * Só totais, contagens e faixas (quintos). Os quintos saem sempre preenchidos, mesmo com poucas
 * contas: é moeda de jogo e identificar jogadores não é problema (decisão do dono do produto).
 *
 * O Jardim ainda não tem extrato de Petalitas: `ledger.available = false` e
 * `receivedByQuintile = []` até existir um.
 */

export const SCHEMA_VERSION = 1;
/** Folga para relógios dessincronizados: `to` pode estar até 60 s no futuro. */
export const MAX_FUTURE_SKEW_MS = 60_000;

export interface SummaryWindow {
  from: number;
  to: number;
}

export interface SummaryOptions {
  /** false (`balances=0`) pula o retrato de saldos e devolve `balances: null`. Padrão: true. */
  balances: boolean;
  /** `received=0|1`: aceito por consistência do contrato; sem extrato, `receivedByQuintile` é sempre []. */
  received: boolean;
}

export interface Quintile {
  q: number;
  n: number;
  min: number | null;
  max: number | null;
  sum: number | null;
}

export interface EconomySummary {
  currency: 'petalitas';
  schemaVersion: number;
  generatedAt: number;
  window: SummaryWindow;
  ledger: { available: false; flows: never[] };
  balances: {
    total: number;
    holders: number;
    accounts: number;
    p50: number | null;
    p90: number | null;
    top10Share: number | null;
    quintiles: Quintile[];
  } | null;
  receivedByQuintile: never[];
}

const EPOCH_MS = /^\d{1,16}$/;

function parseEpochMs(name: string, raw: unknown): number {
  if (typeof raw !== 'string' || !EPOCH_MS.test(raw)) {
    throw new DomainError(`Parâmetro "${name}" deve ser epoch em milissegundos (inteiro >= 0).`, 'INVALID_PAYLOAD', 400);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(`Parâmetro "${name}" fora do intervalo.`, 'INVALID_PAYLOAD', 400);
  }
  return value;
}

/** Valida `from`/`to` da query: inteiros >= 0, `to > from` e `to <= agora + 60 s`. Erro: DomainError 400. */
export function parseSummaryWindow(query: { from?: unknown; to?: unknown } | undefined, now: number): SummaryWindow {
  const from = parseEpochMs('from', query?.from);
  const to = parseEpochMs('to', query?.to);
  if (to <= from) {
    throw new DomainError('Parâmetro "to" deve ser maior que "from".', 'INVALID_PAYLOAD', 400);
  }
  if (to > now + MAX_FUTURE_SKEW_MS) {
    throw new DomainError('Parâmetro "to" não pode estar no futuro.', 'INVALID_PAYLOAD', 400);
  }
  return { from, to };
}

/** Flag opcional `0`/`1` da query; ausente = `fallback`. Qualquer outro valor: DomainError 400. */
function parseFlag(name: string, raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === '0') return false;
  if (raw === '1') return true;
  throw new DomainError(`Parâmetro "${name}" deve ser 0 ou 1.`, 'INVALID_PAYLOAD', 400);
}

/** Lê `balances` (padrão 1) e `received` (padrão 0) da query. */
export function parseSummaryOptions(query: { balances?: unknown; received?: unknown } | undefined): SummaryOptions {
  return {
    balances: parseFlag('balances', query?.balances, true),
    received: parseFlag('received', query?.received, false),
  };
}

interface RawQuintile {
  q: number;
  n: number;
  min: number | null;
  max: number | null;
  sum: number | null;
}

interface RawBalances {
  accounts: bigint | number;
  total: bigint | number;
  holders: bigint | number;
  p50: bigint | number | null;
  p90: bigint | number | null;
  top_sum: bigint | number;
  holders_sum: bigint | number;
  quintiles: RawQuintile[] | null;
}

const num = (v: bigint | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/** Converte os quintos crus do Postgres em números. Quinto sem membros vem com n=0 e min/max/sum nulos. */
export function toQuintiles(raw: RawQuintile[]): Quintile[] {
  return raw.map((r) => ({
    q: Number(r.q),
    n: Number(r.n) || 0,
    min: num(r.min),
    max: num(r.max),
    sum: num(r.sum),
  }));
}

/**
 * Retrato dos saldos (players.coins) agregado no Postgres numa única consulta (um só snapshot),
 * sem carregar linhas de jogador na aplicação.
 *  - total: soma de todos os saldos (inclui eventuais negativos, para bater com o extrato);
 *  - holders: contas com saldo > 0; accounts: todas as contas;
 *  - p50/p90 (percentile_disc), top10Share e quintos (ntile(5), do menor para o maior): entre holders.
 */
export async function getBalancesSnapshot(prisma: PrismaClient): Promise<NonNullable<EconomySummary['balances']>> {
  const rows = await prisma.$queryRaw<RawBalances[]>`
    WITH h AS (
      SELECT coins::bigint AS c,
             ntile(5) OVER (ORDER BY coins ASC, id ASC) AS q,
             row_number() OVER (ORDER BY coins DESC, id ASC) AS rn,
             count(*) OVER () AS n
      FROM players
      WHERE coins > 0
    ),
    qs AS (
      SELECT g.q::int AS q, count(h.c)::int AS n, min(h.c) AS min, max(h.c) AS max, sum(h.c)::bigint AS sum
      FROM generate_series(1, 5) AS g(q)
      LEFT JOIN h ON h.q = g.q
      GROUP BY g.q
    )
    SELECT
      (SELECT count(*) FROM players)::bigint AS accounts,
      (SELECT coalesce(sum(coins), 0) FROM players)::bigint AS total,
      (SELECT count(*) FROM h)::bigint AS holders,
      (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY c) FROM h) AS p50,
      (SELECT percentile_disc(0.9) WITHIN GROUP (ORDER BY c) FROM h) AS p90,
      (SELECT coalesce(sum(c), 0) FROM h WHERE rn <= ceil(n * 0.1))::bigint AS top_sum,
      (SELECT coalesce(sum(c), 0) FROM h)::bigint AS holders_sum,
      (SELECT json_agg(qs ORDER BY qs.q) FROM qs) AS quintiles
  `;
  const r = rows[0];
  const holdersSum = Number(r.holders_sum);
  return {
    total: Number(r.total),
    holders: Number(r.holders),
    accounts: Number(r.accounts),
    p50: num(r.p50),
    p90: num(r.p90),
    top10Share: holdersSum > 0 ? Number(r.top_sum) / holdersSum : null,
    quintiles: toQuintiles(r.quintiles ?? []),
  };
}

export async function getEconomySummary(
  prisma: PrismaClient,
  window: SummaryWindow,
  now: number = Date.now(),
  options: SummaryOptions = { balances: true, received: false },
): Promise<EconomySummary> {
  // balances=0: pedaços históricos da carga inicial não precisam do retrato (que não depende da janela).
  const balances = options.balances ? await getBalancesSnapshot(prisma) : null;
  return {
    currency: 'petalitas',
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    window,
    ledger: { available: false, flows: [] },
    balances,
    // Sem extrato não há entradas por motivo de criação para distribuir por faixa,
    // com ou sem received=1.
    receivedByQuintile: [],
  };
}
