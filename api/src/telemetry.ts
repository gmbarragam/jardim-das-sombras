/**
 * Helpers de tracing de negócio do Jardim das Sombras (mesma API do src/telemetry/index.js da ravena-ai).
 *
 * Só depende de @opentelemetry/api: com a telemetria desligada tudo vira no-op barato
 * (tracer no-op; hashId devolve undefined sem calcular HMAC).
 *
 * Privacidade (ver OBSERVABILITY.md): NUNCA passar para atributos/eventos ID cru de usuário,
 * nome de jogador/fazenda, textos livres ou segredos. Usuário só via hashUserId() → `jds.user.id_hash`.
 */
import crypto from 'node:crypto';
import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  ROOT_CONTEXT,
  type Attributes,
  type AttributeValue,
  type Context,
  type Link,
  type Span,
} from '@opentelemetry/api';
import { DomainError } from './errors/DomainError.js';

export { SpanKind, SpanStatusCode, trace, context };
export type { Span };

export const tracer = trace.getTracer('jardim-das-sombras');

const ID_SALT = process.env.OTEL_ID_SALT || crypto.randomBytes(32).toString('hex');

type AttrInput = Record<string, AttributeValue | object | null | undefined>;

export interface SpanOptions {
  attributes?: AttrInput;
  kind?: SpanKind;
  /** Começa um trace novo (ignora o contexto ativo). */
  root?: boolean;
  links?: Link[];
  /** false = não grava app.outcome (ex.: spans de banco). Padrão: true. */
  outcome?: boolean;
}

export function isEnabled(): boolean {
  return (globalThis as Record<string, unknown>).__OTEL_ENABLED === true;
}

/** Pseudônimo estável (HMAC-SHA256 truncado em 16 hex) para IDs de usuário. undefined se desligado. */
export function hashId(id: unknown): string | undefined {
  if (!isEnabled() || id === undefined || id === null || id === '') return undefined;
  return crypto.createHmac('sha256', ID_SALT).update(String(id)).digest('hex').slice(0, 16);
}

/**
 * Forma canônica do ID de pessoa para o HMAC, IGUAL à da ravena-ai (src/telemetry/index.js →
 * hashUserId): tira o sufixo `@c.us`/`@lid`/`@s.whatsapp.net` e o `:device`. Idempotente.
 * A ravena já manda só dígitos ao JDS; a normalização garante o mesmo hash se isso mudar e
 * permite a um operador com o OTEL_ID_SALT recomputar o hash localmente.
 */
export function normalizeUserId(id: unknown): string | undefined {
  if (id === undefined || id === null || id === '') return undefined;
  const raw = String(id);
  return raw.split('@')[0].split(':')[0] || raw;
}

/** hashId da forma canônica do usuário (ver normalizeUserId). Use sempre este para pessoas. */
export function hashUserId(id: unknown): string | undefined {
  return hashId(normalizeUserId(id));
}

const kServerSpan = Symbol.for('ravena.otel.server_span');

/**
 * Grava atributos nos spans da requisição HTTP de entrada: o SERVER (`GET /farm/:user_id`, guardado
 * pelo requestHook do instrumentation.ts) e o `request` do @fastify/otel. Para rotas sem span de negócio.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setRequestAttrs(request: any, attrs: AttrInput): void {
  if (!isEnabled() || !request) return;
  const clean = cleanAttrs(attrs);
  if (!clean || Object.keys(clean).length === 0) return;
  const spans = new Set<Span>();
  const server = request.raw?.[kServerSpan] as Span | undefined;
  if (server) spans.add(server);
  try {
    const reqSpan = typeof request.opentelemetry === 'function' ? (request.opentelemetry().span as Span | undefined) : undefined;
    if (reqSpan) spans.add(reqSpan);
  } catch {
    /* sem @fastify/otel */
  }
  for (const s of spans) if (s.isRecording()) s.setAttributes(clean);
}

function pick(keys: string[], ...sources: unknown[]): unknown {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const key of keys) {
      const v = (src as Record<string, unknown>)[key];
      if (typeof v === 'string' || typeof v === 'number') return v;
    }
  }
  return undefined;
}

/**
 * Hook global (preValidation, depois do parse do corpo): `user_id`/`userId` de params, corpo ou query
 * vira `jds.user.id_hash`; `fromUserId`/`toUserId` (transferência) viram `jds.from_user.id_hash`/`jds.to_user.id_hash`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tagRequestIds(request: any): void {
  if (!isEnabled() || !request) return;
  const user = pick(['user_id', 'userId'], request.params, request.body, request.query);
  const from = pick(['fromUserId'], request.body);
  const to = pick(['toUserId'], request.body);
  if (user === undefined && from === undefined && to === undefined) return;
  setRequestAttrs(request, {
    'jds.user.id_hash': hashUserId(user),
    'jds.from_user.id_hash': hashUserId(from),
    'jds.to_user.id_hash': hashUserId(to),
  });
}

function cleanAttrs(attrs?: AttrInput): Attributes | undefined {
  if (!attrs) return undefined;
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = typeof v === 'object' && !Array.isArray(v) ? String(v) : (v as AttributeValue);
  }
  return out;
}

/** Marca o span como erro (exceção registrada + error.type). */
export function recordError(span: Span | undefined, err: unknown, errorType?: string): void {
  if (!span || !span.isRecording()) return;
  const e = err instanceof Error ? err : new Error(String(err));
  span.recordException(e);
  span.setAttribute('error.type', errorType || (e as { code?: string }).code || e.name || 'Error');
  span.setStatus({ code: SpanStatusCode.ERROR, message: e.name });
}

/**
 * Executa fn dentro de um span ativo. Erros lançados marcam o span e são relançados.
 * Exceção: DomainError (rejeição de negócio esperada: sem saldo, cooldown, já colhido...)
 * NÃO vira ERROR — vira app.outcome=rejected + app.reject.reason=<código>.
 * Sucesso grava app.outcome=ok se fn não tiver definido outro.
 */
export function withSpan<T>(name: string, opts: SpanOptions, fn: (span: Span) => T): T {
  const spanOpts = { kind: opts.kind ?? SpanKind.INTERNAL, attributes: cleanAttrs(opts.attributes), links: opts.links };
  const parentCtx = opts.root ? ROOT_CONTEXT : context.active();
  return tracer.startActiveSpan(name, spanOpts, parentCtx, (span) => {
    const onError = (err: unknown) => {
      if (err instanceof DomainError) {
        if (opts.outcome !== false) markRejected(span, err.code);
      } else {
        if (opts.outcome !== false) setAttrs({ 'app.outcome': 'error' }, span);
        recordError(span, err);
      }
      span.end();
    };
    const onOk = () => {
      if (opts.outcome !== false && span.isRecording()) {
        // Não sobrescreve um app.outcome já definido pelo próprio fn (ex.: rejected).
        const current = (span as unknown as { attributes?: Attributes }).attributes?.['app.outcome'];
        if (current === undefined) span.setAttribute('app.outcome', 'ok');
      }
      span.end();
    };
    let result: T;
    try {
      result = fn(span);
    } catch (err) {
      onError(err);
      throw err;
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (v) => {
          onOk();
          return v;
        },
        (err) => {
          onError(err);
          throw err;
        },
      ) as T;
    }
    onOk();
    return result;
  });
}

/** Rejeição de negócio esperada: não é erro. */
export function markRejected(span: Span | undefined, reason: string): void {
  if (!span || !span.isRecording()) return;
  span.setAttributes({ 'app.outcome': 'rejected', 'app.reject.reason': String(reason).toLowerCase() });
}

/** Inicia um span manual (o chamador encerra). */
export function startSpan(name: string, opts: SpanOptions & { startTime?: number } = {}, parentCtx?: Context): Span {
  return tracer.startSpan(
    name,
    { kind: opts.kind ?? SpanKind.INTERNAL, attributes: cleanAttrs(opts.attributes), startTime: opts.startTime, links: opts.links },
    parentCtx || context.active(),
  );
}

export function activeSpan(): Span | undefined {
  return trace.getActiveSpan();
}

/** Define atributos no span ativo (ignora undefined). */
export function setAttrs(attrs: AttrInput, span?: Span): void {
  const s = span || trace.getActiveSpan();
  if (s && s.isRecording()) s.setAttributes(cleanAttrs(attrs) || {});
}

/** Span event (marco pontual) no span ativo. */
export function addEvent(name: string, attrs?: AttrInput, span?: Span): void {
  const s = span || trace.getActiveSpan();
  if (s && s.isRecording()) s.addEvent(name, cleanAttrs(attrs));
}

/**
 * Transação interativa do Prisma com a duração repartida em filhos nomeados:
 *  - `<name>.begin`: do pedido ao callback (BEGIN + ida e volta ao engine do Prisma);
 *  - `<name>.write`: o corpo (os `prisma *` ficam abaixo dele);
 *  - `<name>.commit`: do fim do corpo até a transação resolver (COMMIT).
 * Uso: `withTxSpans('farm plant tx', (inTx) => prisma.$transaction((tx) => inTx(() => corpo(tx))))`.
 * Com a telemetria desligada só executa `run`. Não muda o comportamento da transação.
 */
export function withTxSpans<T>(name: string, run: (inTx: <R>(fn: () => Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
  if (!isEnabled()) return run((fn) => fn());
  const parent = context.active();
  let begin: Span | undefined = startSpan(`${name}.begin`, {}, parent);
  let commit: Span | undefined;
  const inTx = async <R>(fn: () => Promise<R>): Promise<R> => {
    begin?.end();
    begin = undefined;
    const r = await context.with(parent, () => withSpan(`${name}.write`, { outcome: false }, () => fn()));
    commit = startSpan(`${name}.commit`, {}, parent);
    return r;
  };
  return run(inTx).then(
    (v) => {
      begin?.end();
      commit?.end();
      return v;
    },
    (err) => {
      if (!(err instanceof DomainError)) recordError(commit ?? begin, err);
      begin?.end();
      commit?.end();
      throw err;
    },
  );
}
