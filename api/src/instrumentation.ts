/**
 * Bootstrap do OpenTelemetry do Jardim das Sombras.
 *
 * Carregado antes do servidor:  node --import ./dist/instrumentation.js dist/server.js
 *
 * Fica totalmente desligado (nenhum pacote do SDK é carregado; o @opentelemetry/api devolve
 * tracer no-op) a menos que OTEL_EXPORTER_OTLP_ENDPOINT (ou OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
 * esteja definido e OTEL_SDK_DISABLED != "true". Qualquer falha aqui só gera um aviso: a API
 * sobe normalmente sem telemetria. Ver OBSERVABILITY.md na raiz do repo.
 *
 * Hook ESM (module.register) NÃO é registrado de propósito: as bibliotecas instrumentadas
 * são CommonJS carregadas por require (fastify → http/pino, cobertos pelo require-in-the-middle),
 * o undici usa diagnostics_channel e o @fastify/otel usa o canal 'fastify.initialization'.
 */
import { readFileSync } from 'node:fs';
import { sanitizePath, sanitizeQuery, REDACTED_QUERY_PARAMS } from './telemetryUrl.js';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const disabled = String(process.env.OTEL_SDK_DISABLED || '').toLowerCase() === 'true';

// Health check, favicon e assets estáticos não ajudam a achar gargalo.
const IGNORED_INCOMING = [/^\/health/, /^\/favicon/, /^\/farm\/bg\//, /^\/farm\/sprites\//, /^\/media\//, /^\/assets\//];
// Nunca rastrear o próprio export para o collector.
const IGNORED_OUTGOING = [/\/v1\/(traces|metrics|logs)$/];

if (endpoint && !disabled) {
  try {
    await start();
  } catch (err) {
    console.warn(`[otel] falha ao iniciar a telemetria; seguindo sem ela: ${(err as Error)?.message}`);
  }
}

async function start(): Promise<void> {
  const { diag, DiagLogLevel } = await import('@opentelemetry/api');
  const { FastifyClientErrorProcessor, ThrottledDiagLogger } = await import('./telemetryProcessors.js');
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
  const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-proto');
  const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
  const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
  const { HttpInstrumentation } = await import('@opentelemetry/instrumentation-http');
  const { UndiciInstrumentation } = await import('@opentelemetry/instrumentation-undici');
  const { PinoInstrumentation } = await import('@opentelemetry/instrumentation-pino');
  const { RuntimeNodeInstrumentation } = await import('@opentelemetry/instrumentation-runtime-node');
  const { FastifyOtelInstrumentation } = await import('@fastify/otel');

  // Erros de export (collector fora do ar) só aparecem no diag logger, nunca derrubam o processo.
  // Sem stack: 1ª linha da mensagem, no máximo 1x/minuto por tipo (ECONNREFUSED a cada export).
  const levelName = (process.env.OTEL_LOG_LEVEL || 'error').toUpperCase() as keyof typeof DiagLogLevel;
  diag.setLogger(new ThrottledDiagLogger(), DiagLogLevel[levelName] ?? DiagLogLevel.ERROR);

  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {}

  const serviceName = process.env.OTEL_SERVICE_NAME || 'jardim-das-sombras';
  const resource = resourceFromAttributes({
    'service.name': serviceName,
    'service.namespace': 'ravena',
    'service.version': version,
    'deployment.environment.name': process.env.OTEL_DEPLOYMENT_ENVIRONMENT || process.env.NODE_ENV || 'production',
  });

  const noHeaders = { requestHeaders: [] as string[], responseHeaders: [] as string[] };

  const sdk = new NodeSDK({
    resource,
    // Fila limitada: se o collector cair, spans excedentes são descartados (nunca bloqueia).
    spanProcessors: [
      // Antes do batch: 4xx de negócio no @fastify/otel deixam de ser ERROR (e perdem a mensagem).
      new FastifyClientErrorProcessor(),
      new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: 10000 }), {
        maxQueueSize: 4096,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 2000,
      }),
    ],
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ timeoutMillis: 10000 }),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 30000),
    }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => IGNORED_INCOMING.some((re) => re.test(req.url || '')),
        ignoreOutgoingRequestHook: (opts) => IGNORED_OUTGOING.some((re) => re.test((opts as { path?: string }).path || '')),
        // Não grava headers. Query: redige segredos/IDs; path: mascara IDs crus (ex.: /farm/:user_id).
        headersToSpanAttributes: { client: noHeaders, server: noHeaders },
        redactedQueryParamsServer: REDACTED_QUERY_PARAMS,
        requestHook: (span, req) => {
          const url = (req as { url?: string }).url;
          if (typeof url === 'string' && url.startsWith('/')) {
            const [p, q] = url.split('?', 2);
            span.setAttribute('url.path', sanitizePath(p));
            if (q) span.setAttribute('url.query', sanitizeQuery(q));
          }
          // Guarda o span SERVER no IncomingMessage: o hook global do server.ts grava nele o hash
          // do usuário (telemetry.ts → setRequestAttrs).
          if ((span as unknown as { kind?: number }).kind === 1) (req as unknown as Record<symbol, unknown>)[Symbol.for('ravena.otel.server_span')] = span;
        },
      }),
      new UndiciInstrumentation({
        ignoreRequestHook: (req) => IGNORED_OUTGOING.some((re) => re.test(req.path || '')),
        requestHook: (span, req) => {
          try {
            const u = new URL(req.path, req.origin);
            const q = u.search ? sanitizeQuery(u.search.slice(1)) : '';
            span.setAttribute('url.full', `${u.origin}${sanitizePath(u.pathname)}${q ? `?${q}` : ''}`);
            if (q) span.setAttribute('url.query', `?${q}`);
          } catch {}
        },
      }),
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        // Só o preHandler (auth) vira span; onRequest de cors/helmet/rate-limit é ruído e custa ~0,3 ms/req.
        instrumentHooks: ['preHandler'],
        ignorePaths: (route: { url: string }) => IGNORED_INCOMING.some((re) => re.test(route.url)),
        requestHook: (span: { setAttribute: (k: string, v: string) => void }, request: { url: string }) => {
          const [p, q] = String(request.url || '').split('?', 2);
          span.setAttribute('url.path', sanitizePath(p));
          if (q) span.setAttribute('url.query', sanitizeQuery(q));
        },
      }),
      // Injeta trace_id/span_id nos logs do fastify (pino); não envia logs via OTLP.
      new PinoInstrumentation({ disableLogSending: true }),
      new RuntimeNodeInstrumentation(),
    ],
  });

  // O construtor do NodeSDK troca o logger de diagnóstico quando OTEL_LOG_LEVEL está definido;
  // reaplica o logger compacto (sem stack, com limite de frequência).
  diag.setLogger(new ThrottledDiagLogger(), DiagLogLevel[levelName] ?? DiagLogLevel.ERROR);
  sdk.start();
  (globalThis as Record<string, unknown>).__OTEL_ENABLED = true;

  // O servidor não registra handlers de sinal; aqui só oferecemos um flush com teto de 3 s
  // (chamado no onClose do Fastify) sem mudar o comportamento de saída do processo.
  (globalThis as Record<string, unknown>).__OTEL_SHUTDOWN = () =>
    Promise.race([sdk.shutdown().catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref())]);

  console.log(`[otel] telemetria ligada → ${endpoint} (service.name=${serviceName})`);
}
