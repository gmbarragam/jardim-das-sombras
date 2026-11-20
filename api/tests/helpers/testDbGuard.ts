import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** .env que a API carrega (api/.env, pelo dotenv do config.ts) e o da raiz do repo (docker compose). */
export const REPO_ENV_FILES = [path.join(API_DIR, '.env'), path.join(API_DIR, '..', '.env')];

function dbKey(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase() === 'localhost' ? '127.0.0.1' : u.hostname.toLowerCase();
    return `${host}:${u.port || '5432'}/${decodeURIComponent(u.pathname.replace(/^\//, ''))}`;
  } catch {
    return null;
  }
}

/**
 * Motivo para NÃO rodar testes que apagam tabelas contra `url`, ou null se parece um banco descartável:
 * o nome do banco precisa conter "test" e não pode ser o mesmo banco (host, porta e nome) do DATABASE_URL
 * de algum .env do repo.
 */
export function unsafeTestDbReason(url: string, envFiles: string[] = REPO_ENV_FILES): string | null {
  const key = dbKey(url);
  if (!key) return 'JDS_TEST_DATABASE_URL não é uma URL válida';
  const db = key.slice(key.indexOf('/') + 1);
  if (!/test/i.test(db)) return `o nome do banco ("${db}") não contém "test"`;
  for (const file of envFiles) {
    if (!existsSync(file)) continue;
    const envUrl = dotenv.parse(readFileSync(file)).DATABASE_URL;
    if (envUrl && dbKey(envUrl) === key) return `é o mesmo banco do DATABASE_URL de ${path.relative(API_DIR, file) || file}`;
  }
  return null;
}
