/**
 * Helpers de tracing de negócio do Jardim das Sombras (mesma API do src/telemetry/index.js da ravena-ai).
 *
 * Só depende de @opentelemetry/api: com a telemetria desligada tudo vira no-op barato
 * (tracer no-op; hashId devolve undefined sem calcular HMAC).
 *
 * Privacidade (ver OBSERVABILITY.md): NUNCA passar para atributos/eventos ID cru de usuário,
 * nome de jogador/fazenda, textos livres ou segredos. Usuário só via hashId() → `jds.user.id_hash`.
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
