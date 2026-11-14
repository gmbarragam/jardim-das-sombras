import { describe, it, expect } from 'vitest';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { FastifyClientErrorProcessor, ThrottledDiagLogger } from '../src/telemetryProcessors.js';
import { DomainError } from '../src/errors/DomainError.js';

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new FastifyClientErrorProcessor(), new SimpleSpanProcessor(exporter)],
  });
  return { exporter, fastify: provider.getTracer('@fastify/otel'), app: provider.getTracer('jardim-das-sombras') };
}

function simulate(tracer: ReturnType<typeof setup>['fastify'], err: Error, status: number) {
  const req = tracer.startSpan('request');
  const handler = tracer.startSpan('handler - farmRoutes', {}, trace.setSpan(context.active(), req));
  handler.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  handler.recordException(err);
  handler.end();
  req.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  req.setAttribute('http.response.status_code', status);
  req.end();
}

describe('FastifyClientErrorProcessor', () => {
  it('4xx de negócio: request e handler sem ERROR, sem mensagem e sem evento de exceção', () => {
    const { exporter, fastify } = setup();
    simulate(fastify, new DomainError('Planta desconhecida: "texto do usuário"', 'PLANT_NOT_FOUND', 404), 404);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const s of spans) {
      expect(s.status.code).toBe(s.name === 'request' ? SpanStatusCode.OK : SpanStatusCode.UNSET);
      expect(s.status.message).toBeUndefined();
      expect(s.events.some((e) => e.name === 'exception')).toBe(false);
      expect(JSON.stringify(s.attributes)).not.toContain('texto do usuário');
    }
    const handler = spans.find((s) => s.name.startsWith('handler'))!;
    expect(handler.attributes['app.reject.reason']).toBe('plant_not_found');
  });

  it('5xx continua ERROR com exceção', () => {
    const { exporter, fastify } = setup();
    simulate(fastify, new Error('boom'), 500);
    for (const s of exporter.getFinishedSpans()) expect(s.status.code).toBe(SpanStatusCode.ERROR);
    const handler = exporter.getFinishedSpans().find((s) => s.name.startsWith('handler'))!;
    expect(handler.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('não mexe em spans de outros escopos', () => {
    const { exporter, app } = setup();
    const s = app.startSpan('farm render');
    s.setStatus({ code: SpanStatusCode.ERROR });
    s.setAttribute('http.response.status_code', 400);
    s.end();
    expect(exporter.getFinishedSpans()[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('ThrottledDiagLogger', () => {
  it('imprime só a 1ª linha e no máximo 1x por intervalo por tipo', () => {
    const lines: string[] = [];
    let now = 0;
    const log = new ThrottledDiagLogger(60_000, (l) => lines.push(l), () => now);
    const err = new Error('connect ECONNREFUSED 127.0.0.1:4318\n    at TCPConnectWrap.afterConnect');
    log.error('{"stack":"Error: connect ECONNREFUSED\\n at x","message":"connect ECONNREFUSED"}\n  at y', err);
    log.error('{"stack":"Error: connect ECONNREFUSED\\n at x","message":"connect ECONNREFUSED"}\n  at y', err);
    now = 30_000;
    log.error('{"stack":"Error: connect ECONNREFUSED\\n at x","message":"connect ECONNREFUSED"}\n  at y', err);
    log.warn('outro tipo');
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
    now = 61_000;
    log.error('{"stack":"Error: connect ECONNREFUSED\\n at x","message":"connect ECONNREFUSED"}\n  at y', err);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('+2 repetidas suprimidas');
  });
});
