import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

const exporter = new InMemorySpanExporter();
let BotNotifier: typeof import('../src/services/BotNotifier.js').BotNotifier;

const item = { plantId: '01_nightshade', name: 'Erva-Moura', bonusType: 'bait', count: 1 } as never;

async function notifyWith(response: Promise<Response>) {
  exporter.reset();
  vi.stubGlobal('fetch', vi.fn(() => response));
  BotNotifier.notifyHarvest('jogador-teste', [item]);
  await new Promise((r) => setTimeout(r, 20));
  return exporter.getFinishedSpans().find((s) => s.name === 'notify harvest')!;
}

describe('BotNotifier (span notify harvest)', () => {
  beforeAll(async () => {
    process.env.BOT_API_URL = 'http://bot.local:5001';
    process.env.BOT_API_TOKEN = 'k';
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    ({ BotNotifier } = await import('../src/services/BotNotifier.js'));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('2xx: sent=true com status_code', async () => {
    const span = await notifyWith(Promise.resolve(new Response('{}', { status: 200 })));
    expect(span.attributes['jds.notify.sent']).toBe(true);
    expect(span.attributes['jds.notify.status_code']).toBe(200);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('422 da ravena: sent=false, rejected, sem ERROR', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const span = await notifyWith(Promise.resolve(new Response('nope', { status: 422 })));
    expect(span.attributes['jds.notify.sent']).toBe(false);
    expect(span.attributes['jds.notify.status_code']).toBe(422);
    expect(span.attributes['app.outcome']).toBe('rejected');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('falha de rede: sent=false e ERROR com error.type', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = Object.assign(new Error('x'), { name: 'TimeoutError' });
    const span = await notifyWith(Promise.reject(err));
    expect(span.attributes['jds.notify.sent']).toBe(false);
    expect(span.attributes['error.type']).toBe('TimeoutError');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});
