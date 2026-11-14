/**
 * Peças do SDK do OpenTelemetry usadas só com a telemetria ligada (importadas por instrumentation.ts).
 *
 * - FastifyClientErrorProcessor: o @fastify/otel marca `request` e `handler - *` como ERROR (com a
 *   mensagem do erro) em todo erro lançado, inclusive rejeições de negócio 4xx (DomainError). Aqui
 *   esses spans voltam para UNSET (o `request` 4xx vai para OK, ver onEnd), sem mensagem e sem evento
 *   de exceção. 5xx continuam ERROR. O resultado (`app.outcome`/`app.reject.reason`) NÃO vai para
 *   esses spans internos: fica só no span de negócio (`farm plant`...), senão a mesma rejeição
 *   aparecia 3x no painel "Top operações rejeitadas" (span de negócio + `request` + `handler - *`).
 * - ThrottledDiagLogger: diag do SDK sem stack trace (só a 1ª linha) e no máximo 1 linha por minuto
 *   por tipo de mensagem (collector fora do ar gera ECONNREFUSED a cada export).
 */
import { SpanStatusCode, type DiagLogger } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

const FASTIFY_SCOPE = '@fastify/otel';
const STATUS_ATTR = 'http.response.status_code';
const PENDING_TTL_MS = 60_000;
const PENDING_MAX = 2000;

type MutableSpan = {
  status: { code: SpanStatusCode; message?: string };
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
  attributes: Record<string, unknown>;
};

function scopeName(span: ReadableSpan): string | undefined {
  return span.instrumentationScope?.name;
}

function parentId(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId;
}

/** Troca ERROR→UNSET e remove a mensagem e os eventos de exceção (que trazem input do usuário). */
export function downgradeClientError(span: ReadableSpan): void {
  const s = span as unknown as MutableSpan;
  for (let i = s.events.length - 1; i >= 0; i--) {
    if (s.events[i].name === 'exception') s.events.splice(i, 1);
  }
  s.status = { code: SpanStatusCode.UNSET };
}

/**
 * Deve vir ANTES do BatchSpanProcessor na lista spanProcessors (o onEnd roda na ordem da lista).
 *
 * O span `request` tem http.response.status_code e decide na hora. Os filhos (`handler - *`,
 * `preHandler - *`) terminam antes do pai e não sabem o status: ficam pendentes por spanId do pai
 * e são corrigidos (no mesmo objeto que já está na fila do batch) quando o `request` termina,
 * microssegundos depois; o batch só exporta a cada 2 s, então na prática a correção chega antes.
 */
export class FastifyClientErrorProcessor implements SpanProcessor {
  private pending = new Map<string, { at: number; spans: ReadableSpan[] }>();

  onStart(_span: Span, _ctx: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (scopeName(span) !== FASTIFY_SCOPE) return;
    const status = span.attributes[STATUS_ATTR];

    if (typeof status === 'number') {
      // span `request`: decide por ele e pelos filhos pendentes.
      const id = span.spanContext().spanId;
      const kids = this.pending.get(id);
      this.pending.delete(id);
      if (status >= 500) return;
      if (span.status.code === SpanStatusCode.ERROR) downgradeClientError(span);
      if (kids) for (const k of kids.spans) downgradeClientError(k);
      // O `request` é INTERNAL e carrega http.response.status_code. Com status UNSET, o tradutor
      // OTLP→Jaeger (Jaeger v2) infere ERROR para span não-SERVER com status HTTP >= 400; OK
      // explícito evita o falso erro na UI (spanmetrics trata OK e UNSET igual: não-erro).
      if (status >= 400) (span as unknown as MutableSpan).status = { code: SpanStatusCode.OK };
      return;
    }

    if (span.status.code !== SpanStatusCode.ERROR) return;
    const pid = parentId(span);
    if (!pid) return;
    const now = Date.now();
    this.gc(now);
    const entry = this.pending.get(pid);
    if (entry) entry.spans.push(span);
    else this.pending.set(pid, { at: now, spans: [span] });
  }

  private gc(now: number): void {
    if (this.pending.size < PENDING_MAX) {
      // varredura barata: só olha o mais antigo (Map mantém ordem de inserção).
      const first = this.pending.entries().next().value;
      if (!first || now - first[1].at < PENDING_TTL_MS) return;
    }
    for (const [k, v] of this.pending) {
      if (now - v.at >= PENDING_TTL_MS || this.pending.size >= PENDING_MAX) this.pending.delete(k);
      else break;
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.pending.clear();
    return Promise.resolve();
  }
}

/** Resumo de um erro/objeto: `código: mensagem` (1ª linha), nunca a stack nem o JSON inteiro. */
function summarizeObject(o: Record<string, unknown>): string {
  const code = typeof o.code === 'string' || typeof o.code === 'number' ? String(o.code) : '';
  let msg = typeof o.message === 'string' ? o.message.split('\n', 1)[0].trim() : '';
  // AggregateError (ECONNREFUSED em IPv4 + IPv6) vem com message vazia e os erros em `errors`.
  if (!msg && o.errors !== undefined) {
    const first = Array.isArray(o.errors) ? o.errors[0] : String(o.errors).split(',', 1)[0];
    msg = first && typeof first === 'object' ? summarizeObject(first as Record<string, unknown>) : String(first ?? '').split('\n', 1)[0].trim();
  }
  // Sem message: só o cabeçalho da stack ("AggregateError [ECONNREFUSED]: "), nunca os frames.
  if (!msg && typeof o.stack === 'string') msg = o.stack.split('\n', 1)[0].trim();
  if (code && msg.includes(code)) return msg;
  return code && msg ? `${code}: ${msg}` : code || msg || '[objeto]';
}

/** 1ª linha de uma mensagem do diag; JSON embutido (o exporter serializa o erro) vira só message/code. */
export function firstLine(v: unknown): string {
  if (v instanceof Error) {
    const s = summarizeObject(v as unknown as Record<string, unknown>);
    return s.startsWith(v.name) ? s : `${v.name}: ${s}`;
  }
  if (v && typeof v === 'object') return summarizeObject(v as Record<string, unknown>);
  const str = String(v);
  const at = str.indexOf('{');
  if (at >= 0) {
    const tail = str.slice(at);
    const end = tail.lastIndexOf('}');
    try {
      const o = JSON.parse(end >= 0 ? tail.slice(0, end + 1) : tail);
      if (o && typeof o === 'object') return `${str.slice(0, at)}${summarizeObject(o)}`.split('\n', 1)[0];
    } catch {
      /* não é JSON */
    }
  }
  return str.split('\n', 1)[0];
}

/** Diag logger: 1ª linha da mensagem, no máximo 1 vez por intervalo por (nível + mensagem). */
export class ThrottledDiagLogger implements DiagLogger {
  private last = new Map<string, { at: number; suppressed: number }>();

  constructor(
    private readonly intervalMs = 60_000,
    private readonly out: (line: string) => void = (l) => console.warn(l),
    private readonly now: () => number = Date.now,
  ) {}

  private log(level: string, message: string, args: unknown[]): void {
    const head = firstLine(message);
    // Tipo = nível + mensagem sem números (portas, contagens, ids variam a cada export).
    const key = `${level}|${head.replace(/\d+/g, '#').slice(0, 120)}`;
    const t = this.now();
    const prev = this.last.get(key);
    if (prev && t - prev.at < this.intervalMs) {
      prev.suppressed++;
      return;
    }
    if (this.last.size > 500) this.last.clear();
    this.last.set(key, { at: t, suppressed: 0 });
    const detail = args.length ? ` ${args.map(firstLine).join(' ').slice(0, 500)}` : '';
    const rep = prev && prev.suppressed ? ` (+${prev.suppressed} repetidas suprimidas)` : '';
    this.out(`[otel] ${level}: ${head}${detail}${rep}`);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.log('info', message, args);
  }
  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, args);
  }
  verbose(message: string, ...args: unknown[]): void {
    this.log('verbose', message, args);
  }
}
