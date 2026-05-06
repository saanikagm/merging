import type {
  BrewPlanningInput,
  BrewPlanningResult,
  ProductForecastInput,
  ServiceLevel,
} from "./brewPlanningService";

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

export type ProductLevelPivotRow = {
  brand: string;
  Week1: number; Week2: number; Week3: number; Week4: number;
  Week5: number; Week6: number; Week7: number; Week8: number;
};

export type InventoryDbRow = {
  name: string;
  startInv: number;
  finalSS: number;
};

export type BuildBrewPlanningInputArgs = {
  forecastCycleId: string;
  generatedAt?: string;
  weekStartDates: string[];
  productLevelRows: ProductLevelPivotRow[];
  inventoryDB: InventoryDbRow[];
  historicalRows: HistoricalDemandRow[];
  manualBrewPlan: Record<string, Record<number, number>>;
  globalServiceLevel: ServiceLevel;
  serviceLevelOverridesByProduct?: Record<string, ServiceLevel>;
  wipByProduct?: Record<string, number>;
  minWeeklyBrewByProduct?: Record<string, number>;
  planningHorizonWeeks?: number;
  brewLeadTimeWeeks?: number;
  batchSizeBarrels?: number;
  targetCapacityBarrels?: number;
  maxCapacityBarrels?: number;
  priorPlanRows?: BrewPlanningResult["productLevelBrewPlan"];
};

export function buildBrewPlanningInput(args: BuildBrewPlanningInputArgs): BrewPlanningInput {
  const horizonWeeks = args.planningHorizonWeeks ?? 8;
  const productForecasts: ProductForecastInput[] = args.productLevelRows.map((row) => ({
    product_id: row.brand,
    product_name: row.brand,
    weeklyForecastBarrels: [row.Week1, row.Week2, row.Week3, row.Week4, row.Week5, row.Week6, row.Week7, row.Week8].slice(0, horizonWeeks),
    weekStartDates: args.weekStartDates.slice(0, horizonWeeks),
  }));

  const productIds = productForecasts.map((p) => p.product_id);
  const currentInventoryByProduct: Record<string, number> = {};
  const safetyStockOverrideByProduct: Record<string, number> = {};
  args.inventoryDB.forEach((inv) => {
    currentInventoryByProduct[inv.name] = inv.startInv;
    safetyStockOverrideByProduct[inv.name] = inv.finalSS;
  });
  productIds.forEach((productId) => {
    if (currentInventoryByProduct[productId] === undefined) currentInventoryByProduct[productId] = 0;
  });

  const scheduledReceiptsByProduct: Record<string, number[]> = {};
  const wipSpreadWeeks = Math.max(1, args.brewLeadTimeWeeks ?? 2);
  if (args.wipByProduct) {
    Object.entries(args.wipByProduct).forEach(([productId, wipBbl]) => {
      if (wipBbl > 0) {
        const weekly = Array(horizonWeeks).fill(0) as number[];
        const perWeek = wipBbl / wipSpreadWeeks;
        for (let w = 0; w < wipSpreadWeeks && w < horizonWeeks; w += 1) {
          weekly[w] = perWeek;
        }
        scheduledReceiptsByProduct[productId] = weekly;
      }
    });
  }

  return {
    forecastCycleId: args.forecastCycleId,
    generatedAt: args.generatedAt,
    planningHorizonWeeks: horizonWeeks,
    brewLeadTimeWeeks: args.brewLeadTimeWeeks,
    batchSizeBarrels: args.batchSizeBarrels,
    targetCapacityBarrels: args.targetCapacityBarrels,
    maxCapacityBarrels: args.maxCapacityBarrels,
    serviceLevelByProduct: buildServiceLevelByProduct(productIds, args.globalServiceLevel, args.serviceLevelOverridesByProduct ?? {}),
    currentInventoryByProduct,
    historicalDemandByProduct: buildHistoricalDemandByProduct(args.historicalRows, productIds),
    scheduledReceiptsByProduct: Object.keys(scheduledReceiptsByProduct).length > 0 ? scheduledReceiptsByProduct : undefined,
    productForecasts,
    manualReleasesByProduct: args.manualBrewPlan,
    safetyStockOverrideByProduct,
    minWeeklyBrewByProduct: args.minWeeklyBrewByProduct,
    priorPlanRows: args.priorPlanRows,
  };
}

export function computeDefaultMinWeeklyBrewByProduct(
  historicalDemandByProduct: Record<string, number[]>,
  batchSizeBarrels = 50,
  recentLookbackWeeks = 4,
): Record<string, number> {
  const result: Record<string, number> = {};
  Object.entries(historicalDemandByProduct).forEach(([productId, weeklyDemand]) => {
    const recent = weeklyDemand.slice(0, recentLookbackWeeks);
    const sum = recent.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
    if (sum <= 0 || recent.length === 0) {
      result[productId] = 0;
      return;
    }
    const avgWeekly = sum / recent.length;
    result[productId] = Math.floor(avgWeekly / batchSizeBarrels) * batchSizeBarrels;
  });
  return result;
}

export function computeImpliedWipByProduct(
  historicalDemandByProduct: Record<string, number[]>,
  brewLeadTimeWeeks = 2,
  recentLookbackWeeks = 4,
): Record<string, number> {
  const result: Record<string, number> = {};
  Object.entries(historicalDemandByProduct).forEach(([productId, weeklyDemand]) => {
    const recent = weeklyDemand.slice(0, recentLookbackWeeks);
    const sum = recent.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
    if (sum <= 0 || recent.length === 0) {
      result[productId] = 0;
      return;
    }
    const avgWeekly = sum / recent.length;
    result[productId] = avgWeekly * brewLeadTimeWeeks;
  });
  return result;
}

export function derivePastDueReceiptsByProduct(
  result: BrewPlanningResult,
  brewLeadTimeWeeks = 2,
): Record<string, number> {
  const rowsByProduct: Record<string, BrewPlanningResult["productLevelBrewPlan"]> = {};
  result.productLevelBrewPlan.forEach((row) => {
    if (!rowsByProduct[row.product_id]) rowsByProduct[row.product_id] = [];
    rowsByProduct[row.product_id].push(row);
  });
  const pastDue: Record<string, number> = {};
  Object.entries(rowsByProduct).forEach(([productId, rows]) => {
    pastDue[productId] = rows
      .slice(0, brewLeadTimeWeeks)
      .reduce((sum, row) => sum + row.planned_order_receipt, 0);
  });
  return pastDue;
}
