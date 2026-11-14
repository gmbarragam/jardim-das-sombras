import { describe, it, expect } from 'vitest';
import { sanitizePath, sanitizeQuery } from '../src/telemetryUrl.js';
import { withSpan, userIdAttr, isEnabled } from '../src/telemetry.js';
import { DomainError } from '../src/errors/DomainError.js';

describe('telemetryUrl', () => {
  it('mascara IDs crus no path', () => {
    expect(sanitizePath('/farm/5511999998888/image')).toBe('/farm/{id}/image');
    expect(sanitizePath('/inventory/123456789@c.us')).toBe('/inventory/{id}');
    expect(sanitizePath('/farm/share/image')).toBe('/farm/share/image');
  });

  it('redige parâmetros fora da allowlist', () => {
    expect(sanitizeQuery('?id=abc&token=xyz&format=base64&user_name=Fulano')).toBe(
      'id=REDACTED&token=REDACTED&format=base64&user_name=REDACTED',
    );
    expect(sanitizeQuery('apiKey=1&key=2&auth=3')).toBe('apiKey=REDACTED&key=REDACTED&auth=REDACTED');
  });
});

describe('telemetry (desligada)', () => {
  it('é no-op e repassa resultado/erros', async () => {
    expect(isEnabled()).toBe(false);
    expect(userIdAttr('123')).toBeUndefined();
    expect(await withSpan('x', {}, async () => 42)).toBe(42);
    await expect(
      withSpan('x', {}, async () => {
        throw new DomainError('sem saldo', 'INSUFFICIENT_COINS');
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
