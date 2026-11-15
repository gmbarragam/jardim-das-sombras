import { describe, it, expect, beforeAll } from 'vitest';

// Mesmo formato de ID de usuário nos 3 serviços (ravena-ai/src/telemetry/index.js → userIdAttr):
// sem sufixo do WhatsApp nem :device.
let t: typeof import('../src/telemetry.js');

beforeAll(async () => {
  (globalThis as Record<string, unknown>).__OTEL_ENABLED = true;
  t = await import('../src/telemetry.js');
});

describe('telemetry userIdAttr (mesmo formato da ravena-ai)', () => {
  it('normaliza sufixo do WhatsApp e :device, de forma idempotente', () => {
    expect(t.normalizeUserId('5511900000081@c.us')).toBe('5511900000081');
    expect(t.normalizeUserId('5511900000081:3@s.whatsapp.net')).toBe('5511900000081');
    expect(t.normalizeUserId('5511900000081@lid')).toBe('5511900000081');
    expect(t.normalizeUserId(t.normalizeUserId('5511900000081:3@s.whatsapp.net'))).toBe('5511900000081');
    expect(t.normalizeUserId('')).toBeUndefined();
  });

  it('mesmo ID para as formas do mesmo usuário (inclusive número)', () => {
    expect(t.userIdAttr('5511900000081@c.us')).toBe('5511900000081');
    expect(t.userIdAttr('5511900000081')).toBe('5511900000081');
    expect(t.userIdAttr('5511900000081:3@s.whatsapp.net')).toBe('5511900000081');
    expect(t.userIdAttr(5511900000081)).toBe('5511900000081');
  });

  it('desligado: não grava ID', () => {
    (globalThis as Record<string, unknown>).__OTEL_ENABLED = false;
    try {
      expect(t.userIdAttr('5511900000081')).toBeUndefined();
    } finally {
      (globalThis as Record<string, unknown>).__OTEL_ENABLED = true;
    }
  });
});
