/**
 * Sanitização de URL para spans (sem dependências: é carregado pelo bootstrap mesmo com OTel desligado).
 *
 * - Path: segmentos que parecem ID de pessoa (≥ 6 dígitos, ou com '@' como `...@c.us`/`@lid`)
 *   viram `{id}`. A rota parametrizada fica em `http.route`.
 * - Query: só os parâmetros da allowlist mantêm o valor; os demais (token, user_id, user_name,
 *   id, key, apiKey, auth, ...) viram `REDACTED`.
 */

/** Parâmetros sem dados pessoais/segredos (opções de render). */
const SAFE_QUERY_PARAMS = new Set([
  'format',
  'include_image',
  'time_override',
  'tooltips',
  'include_tooltips',
  'tooltip_style',
  'header_style',
  'harvested_slots',
  'planted_slots',
  'all',
  'quantity',
]);

/** Lista explícita para o redator interno do instrumentation-http (redactedQueryParamsServer). */
export const REDACTED_QUERY_PARAMS = [
  'token',
  'key',
  'apiKey',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'access_token',
  'sig',
  'signature',
  'user_id',
  'user_name',
  'id',
];

export function sanitizePath(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch {}
      return /\d{6,}/.test(s) || s.includes('@') ? '{id}' : seg;
    })
    .join('/');
}

export function sanitizeQuery(query: string): string {
  const q = query.startsWith('?') ? query.slice(1) : query;
  const out: string[] = [];
  for (const part of q.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    if (eq === -1) out.push(key);
    else out.push(`${key}=${SAFE_QUERY_PARAMS.has(key) ? part.slice(eq + 1) : 'REDACTED'}`);
  }
  return out.join('&');
}
