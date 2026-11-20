/**
 * GET /internal/economy/params (parâmetros de balanceamento das Petalitas para o painel da ravena-ai).
 *
 * A rota não toca no banco: o app de teste registra só as rotas internas (mesmo preHandler requireBotApiKey
 * da rota de resumo), com um prisma vazio no lugar do client.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import Fastify, { FastifyInstance } from 'fastify';

const API_KEY = 'chave-de-teste-economia-params';
process.env.API_KEY = API_KEY;

const { internalRoutes } = await import('../src/routes/internal.js');
const { buildEconomyParams, PLANT_PARAM_FIELDS, DECORATION_PARAM_FIELDS, CONSUMABLE_PARAM_FIELDS } = await import(
  '../src/utils/economyParams.js'
);
const { PLANTS, DECORATIONS, CONSUMABLES } = await import('../src/utils/catalog.js');
const { dailyBag } = await import('../src/utils/economy.js');
const { config } = await import('../src/config.js');

const ROUTE = '/internal/economy/params';
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Arquivos de onde saem os parâmetros. Toda `export const NOME_EM_MAIUSCULAS` deles precisa estar na rota ou em
 * IGNORED_CONSTANTS; toda chave de config.ts, na rota ou em IGNORED_CONFIG_KEYS; todo campo dos JSONs do
 * catálogo e da sacola, na rota ou em IGNORED_FIELDS.
 */
const SOURCE_FILES = [
  'src/utils/catalog.ts',
  'src/utils/economy.ts',
  'src/services/FarmService.ts',
  'src/services/ShopService.ts',
  'src/config.ts',
];

const IGNORED_CONSTANTS: Record<string, string> = {};

const IGNORED_CONFIG_KEYS: Record<string, string> = {
  PORT: 'infraestrutura',
  NODE_ENV: 'infraestrutura',
  DATABASE_URL: 'URL com credencial',
  API_KEY: 'segredo',
  CORS_ORIGINS: 'infraestrutura',
  ASSETS_PATH: 'caminho local',
  PUBLIC_URL: 'URL',
  DATA_PATH: 'caminho local',
  SUPER_ADMIN_PASSWORD: 'segredo',
  BOT_API_URL: 'URL',
  BOT_API_TOKEN: 'segredo',
};

/** Campos dos itens do catálogo que não mexem na economia. */
const IGNORED_FIELDS: Record<string, Record<string, string>> = {
  'plants.json': {
    index: 'posição no catálogo',
    id: 'identificador (a chave do item já está no nome do parâmetro)',
    name: 'texto de exibição',
    bonusDescription: 'texto de exibição',
    spriteBaseName: 'arte',
  },
  'decorations.json': {
    index: 'posição no catálogo',
    id: 'identificador',
    key: 'identificador (vira a chave do item no parâmetro)',
    name: 'texto de exibição',
    spriteName: 'arte',
  },
  'consumables.json': {
    index: 'posição no catálogo',
    id: 'identificador',
    name: 'texto de exibição',
    color: 'texto de exibição',
    description: 'texto de exibição',
    spriteName: 'arte',
  },
};

function flat(prefix: string, value: unknown, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === undefined) return out;
  if (value === null) out[prefix] = 'none';
  else if (Array.isArray(value)) value.forEach((v, i) => flat(`${prefix}.${i}`, v, out));
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value as object)) flat(`${prefix}.${k}`, v, out);
  else out[prefix] = value;
  return out;
}

function exposedNames(params: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(params).map((k) => k.split('.')[1]));
}

const readData = (file: string) => JSON.parse(readFileSync(path.join(config.DATA_PATH, file), 'utf-8'));

describe('GET /internal/economy/params', () => {
  let app: FastifyInstance;
  const exporter = new InMemorySpanExporter();

  const get = (headers: Record<string, string> = { 'x-api-key': API_KEY }) =>
    app.inject({ method: 'GET', url: ROUTE, headers });

  beforeAll(async () => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    app = Fastify();
    app.decorate('prisma', {} as never);
    await app.register(internalRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => exporter.reset());

  describe('autenticação', () => {
    it('401 sem chave', async () => {
      expect((await get({})).statusCode).toBe(401);
    });
    it('401 com chave errada', async () => {
      expect((await get({ 'x-api-key': 'errada' })).statusCode).toBe(401);
    });
    it('401 com token de sessão de jogador (só a API_KEY do bot vale)', async () => {
      expect((await get({ authorization: 'Bearer token-qualquer' })).statusCode).toBe(401);
    });
  });

  it('formato do contrato', async () => {
    const before = Date.now();
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['currency', 'generatedAt', 'params', 'schemaVersion', 'startedAt', 'version']);
    expect(body.currency).toBe('petalitas');
    expect(body.schemaVersion).toBe(1);
    expect(body.generatedAt).toBeGreaterThanOrEqual(before);
    expect(body.generatedAt).toBeLessThanOrEqual(Date.now());
    expect(Number.isInteger(body.startedAt)).toBe(true);
    expect(body.startedAt).toBeLessThanOrEqual(body.generatedAt);
    expect(body.version).toBe(process.env.GIT_SHA || process.env.APP_VERSION || null);

    const keys = Object.keys(body.params);
    expect(keys.length).toBeGreaterThan(100);
    expect(keys).toEqual([...keys].sort());
    for (const [k, v] of Object.entries(body.params)) {
      expect(k).toMatch(/^[a-z]+\.[A-Z][A-Z0-9_]*(\.[A-Za-z0-9_]+)+$/);
      expect(['number', 'string', 'boolean']).toContain(typeof v);
      expect(k).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD|_URL/);
      if (typeof v === 'string') expect(v).not.toMatch(/:\/\//);
    }
  });

  it('valores iguais ao catálogo e à sacola diária carregados', async () => {
    const { params } = (await get()).json();
    const expected: Record<string, unknown> = {};
    for (const [key, p] of Object.entries(PLANTS)) {
      for (const f of PLANT_PARAM_FIELDS) flat(`catalog.PLANTS.${key}.${f}`, p[f], expected);
    }
    for (const [key, d] of Object.entries(DECORATIONS)) {
      for (const f of DECORATION_PARAM_FIELDS) flat(`catalog.DECORATIONS.${key}.${f}`, d[f], expected);
    }
    for (const [key, c] of Object.entries(CONSUMABLES)) {
      for (const f of CONSUMABLE_PARAM_FIELDS) flat(`catalog.CONSUMABLES.${key}.${f}`, c[f], expected);
    }
    flat('daily.DAILY_BAG', dailyBag, expected);
    expect(params).toEqual(expected);

    const [plantKey, plant] = Object.entries(PLANTS)[0];
    expect(params[`catalog.PLANTS.${plantKey}.seedPrice`]).toBe(plant.seedPrice);
    expect(params['daily.DAILY_BAG.cap']).toBe(dailyBag.cap);
  });

  it('span de negócio economy params com a contagem e outcome ok', async () => {
    const res = await get();
    const span = exporter.getFinishedSpans().find((s) => s.name === 'economy params')!;
    expect(span).toBeDefined();
    expect(span.attributes['jds.economy.params']).toBe(Object.keys(res.json().params).length);
    expect(span.attributes['app.outcome']).toBe('ok');
  });

  it('guarda: toda constante exportada dos arquivos de origem está na rota ou na lista de ignoradas', () => {
    const exposed = exposedNames(buildEconomyParams());
    const found = new Set<string>();
    for (const file of SOURCE_FILES) {
      const src = readFileSync(path.join(API_DIR, file), 'utf8');
      for (const m of src.matchAll(/export const ([A-Z][A-Z0-9_]+)/g)) found.add(m[1]);
    }
    expect(found.size).toBeGreaterThan(0);
    const missing = [...found].filter((n) => !exposed.has(n) && !(n in IGNORED_CONSTANTS));
    expect(missing, 'constante nova: exponha em utils/economyParams.ts ou ignore aqui com o motivo').toEqual([]);
    expect(Object.keys(IGNORED_CONSTANTS).filter((n) => !found.has(n))).toEqual([]);
  });

  it('guarda: toda chave de config.ts está na rota ou na lista de ignoradas', () => {
    const exposed = exposedNames(buildEconomyParams());
    const src = readFileSync(path.join(API_DIR, 'src/config.ts'), 'utf8');
    const keys = [...src.matchAll(/^ {2}([A-Z][A-Z0-9_]+): z\./gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    const missing = keys.filter((k) => !exposed.has(k) && !(k in IGNORED_CONFIG_KEYS));
    expect(missing, 'variável nova em config.ts: exponha em utils/economyParams.ts ou ignore aqui com o motivo').toEqual([]);
  });

  it('guarda: todo campo dos JSONs do catálogo e da sacola está na rota ou na lista de ignoradas', () => {
    const exposedFields: Record<string, readonly string[]> = {
      'plants.json': PLANT_PARAM_FIELDS,
      'decorations.json': DECORATION_PARAM_FIELDS,
      'consumables.json': CONSUMABLE_PARAM_FIELDS,
    };
    for (const [file, fields] of Object.entries(exposedFields)) {
      const seen = new Set<string>();
      for (const item of readData(file) as Record<string, unknown>[]) for (const k of Object.keys(item)) seen.add(k);
      const missing = [...seen].filter((k) => !fields.includes(k) && !(k in IGNORED_FIELDS[file]));
      expect(missing, `campo novo em data/${file}: exponha em utils/economyParams.ts ou ignore aqui`).toEqual([]);
    }
    // economy.json: toda chave da sacola diária sai em daily.DAILY_BAG.*
    const params = buildEconomyParams();
    const bag = readData('economy.json').dailyBag ?? {};
    const missingBag = Object.keys(bag).filter((k) => !(`daily.DAILY_BAG.${k}` in params));
    expect(missingBag, 'campo novo em data/economy.json (dailyBag)').toEqual([]);
    const otherSections = Object.keys(readData('economy.json')).filter((k) => k !== 'dailyBag');
    expect(otherSections, 'seção nova em data/economy.json: exponha em utils/economyParams.ts').toEqual([]);
  });
});
