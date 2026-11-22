import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface DailyBagEconomy {
  minPercent: number; // % do saldo
  maxPercent: number;
  floorMin: number; // mínimo absoluto
  floorMax: number;
  cap: number; // teto absoluto
}

/** Sementes comuns garantidas em toda Sacola do Coveiro. */
export const DAILY_BAG_GUARANTEED_SEEDS = 3;

/** Chance base (%) do item bônus da Sacola do Coveiro, por raridade (sorteio único: épico, raro, incomum). */
export const DAILY_BAG_BONUS_CHANCE_PERCENT = { epic: 3, rare: 10, uncommon: 20 } as const;

/**
 * Peso da sorte extra na chance de cada raridade: cada ponto percentual de dailySpecialItemBonus (ex.: Cinzas
 * Líquidas +5) soma `ponto × peso` à chance base, antes do multiplicador de sorte (ex.: Filtro da Viúva 2x).
 */
export const DAILY_BAG_LUCK_WEIGHT = { epic: 0.15, rare: 0.35, uncommon: 0.5 } as const;

/** Cinzas Líquidas: sorte extra permanente (aditiva) na Sacola do Coveiro (0,05 = +5 pontos de sorte). */
export const LIQUID_ASHES_BAG_BONUS = 0.05;

/** Filtro da Viúva: multiplicador das chances do item bônus da Sacola do Coveiro (por 7 dias). */
export const WIDOWS_FILTER_BAG_LUCK_MULTIPLIER = 2.0;

/** Néctar do Vazio: fator do tempo restante das plantas crescendo e do buff growth_halve de 24 h. */
export const VOID_NECTAR_GROWTH_FACTOR = 0.5;

/** Lágrima de Midas: bônus permanente (aditivo) no multiplicador de Petalitas da colheita. */
export const MIDAS_TEAR_COIN_BONUS = 0.1;

/** Teto do multiplicador de Petalitas da fazenda (somando todos os buffs). */
export const FARM_COIN_MULTIPLIER_CAP = 2.0;

/** Teto da redução somada do tempo de crescimento (75%) e piso do multiplicador de crescimento. */
export const FARM_GROWTH_REDUCTION_CAP = 0.75;
export const FARM_GROWTH_MULTIPLIER_FLOOR = 0.1;

const DEFAULT_BAG: DailyBagEconomy = { minPercent: 0.2, maxPercent: 0.4, floorMin: 150, floorMax: 300, cap: 6000 };

export let dailyBag: DailyBagEconomy = DEFAULT_BAG;

export function loadEconomy(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.DATA_PATH, 'economy.json'), 'utf-8'));
    dailyBag = { ...DEFAULT_BAG, ...(raw.dailyBag || {}) };
  } catch {
    dailyBag = DEFAULT_BAG;
  }
}

/** Petalitas da sacola diária: sorteio uniforme entre min e max (% do saldo com piso), limitado ao teto. */
export function rollDailyBagCoins(balance: number): number {
  const b = dailyBag;
  const cap = Math.max(b.cap, 1);
  const min = Math.min(cap, Math.max(b.floorMin, Math.floor((balance * b.minPercent) / 100)));
  const max = Math.min(cap, Math.max(b.floorMax, Math.floor((balance * b.maxPercent) / 100), min));
  return min + Math.floor(Math.random() * (max - min + 1));
}

loadEconomy();
