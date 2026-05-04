import type { BrewPlanningResult, ProductForecastInput, ServiceLevel } from "./brewPlanningService";

export type ForecastDemandRow = {
  brand: string;
  packaging_format: string;
  week_number: number;
  previous_value: number | null;
  effective_value: number | null;
};

export type HistoricalDemandRow = {
  Date: string;
  ProductName: string;
  "Sales Vol": number;
};

export type PackagingInventoryInput = {
  brand: string;
  packaging_format: string;
  startInv: number;
};

const LONG_LOOKBACK_PRODUCTS = ["the pupil", "pupil", "bulbous flowers"];

function effectiveForecastValue(row: ForecastDemandRow): number {
  return row.effective_value ?? row.previous_value ?? 0;
}

export function usesLongSafetyStockLookback(product: string): boolean {
  const normalized = product.trim().toLowerCase();
  return LONG_LOOKBACK_PRODUCTS.some((name) => normalized === name || normalized.includes(name));
}

export function mapProductLevelForecasts(
  rows: ForecastDemandRow[],
  weekStartDates: string[],
  planningHorizonWeeks = 8
): ProductForecastInput[] {
  const grouped: Record<string, ProductForecastInput> = {};

  rows.forEach((row) => {
    if (row.packaging_format !== "ALL") return;
    if (row.week_number < 1 || row.week_number > planningHorizonWeeks) return;

    grouped[row.brand] ||= {
      product_id: row.brand,
      product_name: row.brand,
      weeklyForecastBarrels: Array(planningHorizonWeeks).fill(0),
      weekStartDates: weekStartDates.slice(0, planningHorizonWeeks),
    };

    grouped[row.brand].weeklyForecastBarrels[row.week_number - 1] += effectiveForecastValue(row);
  });

  return Object.values(grouped).sort((a, b) => a.product_name.localeCompare(b.product_name));
}

export function buildHistoricalDemandByProduct(
  historicalRows: HistoricalDemandRow[],
  products: string[]
): Record<string, number[]> {
  let maxTime = 0;
  historicalRows.forEach((row) => {
    const time = new Date(row.Date).getTime();
    if (!Number.isNaN(time) && time > maxTime) maxTime = time;
  });

  const anchorMs = maxTime > 0 ? maxTime : Date.now();
  const oneWeekMs = 7 * 24 * 3600 * 1000;
  const weeklyHistory: Record<string, Record<number, number>> = {};

  historicalRows.forEach((row) => {
    const time = new Date(row.Date).getTime();
    if (Number.isNaN(time)) return;
    const weeksAgo = Math.floor((anchorMs - time) / oneWeekMs);
    if (weeksAgo < 0) return;
    const product = row.ProductName || "Unknown";
    weeklyHistory[product] ||= {};
    weeklyHistory[product][weeksAgo] = (weeklyHistory[product][weeksAgo] || 0) + (Number(row["Sales Vol"]) || 0);
  });

  return Object.fromEntries(products.map((product) => {
    const lookbackWeeks = usesLongSafetyStockLookback(product) ? 52 : 13;
    const buckets = weeklyHistory[product] || {};
    const demand = Array.from({ length: lookbackWeeks }, (_, index) => buckets[index] || 0);
    return [product, demand];
  }));
}

export function buildServiceLevelByProduct(
  products: string[],
  portfolioServiceLevel: ServiceLevel,
  productOverrides: Record<string, ServiceLevel> = {}
): Record<string, ServiceLevel> {
  return Object.fromEntries(products.map((product) => [
    product,
    productOverrides[product] ?? portfolioServiceLevel,
  ]));
}

export function isWipPackaging(packagingFormat: string): boolean {
  const normalized = packagingFormat.trim().toLowerCase();
  return normalized === "wip" || normalized.includes("work in progress");
}

export function buildWipByProduct(packagingInventoryRows: PackagingInventoryInput[]): Record<string, number> {
  return packagingInventoryRows.reduce<Record<string, number>>((totals, row) => {
    if (!isWipPackaging(row.packaging_format)) return totals;
    totals[row.brand] = (totals[row.brand] || 0) + (Number(row.startInv) || 0);
    return totals;
  }, {});
}

export function advanceRevisedBrewPlanHistory(
  currentPlan: BrewPlanningResult | null,
  nextPlan: BrewPlanningResult
): { currentRevisedBrewPlan: BrewPlanningResult; priorRevisedBrewPlan: BrewPlanningResult | null } {
  return {
    currentRevisedBrewPlan: nextPlan,
    priorRevisedBrewPlan: currentPlan,
  };
}
