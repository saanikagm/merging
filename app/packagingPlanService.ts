import {
  SAFETY_FACTORS,
  calculateHistoricalStdDev,
  type BrewPlanningResult,
  type ProductLevelBrewPlanRow,
  type ServiceLevel,
} from "./brewPlanningService.ts";

export type PackagingDemandRow = {
  product_id: string;
  packaging_format: string;
  weeklyDemandBarrels: number[];
  weekStartDates: string[];
};

export type PackagingHistoricalRow = {
  product_id: string;
  packaging_format: string;
  weeklyDemandBarrels: number[];
};

export type PackagingInventoryRow = {
  product_id: string;
  packaging_format: string;
  startingInventoryBarrels: number;
};

export type PackagingPlanInput = {
  brewPlan: BrewPlanningResult;
  packagingDemand: PackagingDemandRow[];
  packagingHistory: PackagingHistoricalRow[];
  packagingInventory: PackagingInventoryRow[];
  bblPerUnitByFormat: Record<string, number>;
  serviceLevelByProduct?: Record<string, ServiceLevel>;
  generatedAt?: string;
  weeksOfCoverFallback?: number;
  minNonzeroWeeksForSigma?: number;
};

export type SafetyStockMethod = "sigma_z" | "weeks_of_cover_fallback";
export type AllocationReason =
  | "gap_fill"
  | "mix_allocation"
  | "remainder_sweep"
  | "no_demand_share"
  | "no_liquid_ready";

export type PackagingPlanRow = {
  plan_id: string;
  brew_plan_id: string;
  forecast_cycle_id: string;
  generated_at: string;
  product_id: string;
  product_name: string;
  packaging_format: string;
  week_start_date: string;
  starting_inventory_bbl: number;
  forecast_demand_bbl: number;
  historical_demand_std_dev: number;
  service_level: ServiceLevel;
  safety_factor: number;
  safety_stock_bbl: number;
  safety_stock_method: SafetyStockMethod;
  target_inventory_bbl: number;
  projected_available_before_packaging_bbl: number;
  inventory_gap_bbl: number;
  allocated_bbl: number;
  projected_available_after_packaging_bbl: number;
  allocation_reason: AllocationReason;
  bbl_per_unit: number;
  package_units: number;
};

export type WeeklyPackagingSummaryRow = {
  plan_id: string;
  product_id: string;
  week_start_date: string;
  ready_to_package_bbl: number;
  total_allocated_bbl: number;
  unallocated_bbl: number;
};

export type PackagingPlanResult = {
  planId: string;
  brewPlanId: string;
  forecastCycleId: string;
  generatedAt: string;
  packagingPlan: PackagingPlanRow[];
  weeklySummary: WeeklyPackagingSummaryRow[];
};

const DEFAULT_WEEKS_OF_COVER_FALLBACK = 2;
const DEFAULT_MIN_NONZERO_WEEKS_FOR_SIGMA = 4;
const DEFAULT_SERVICE_LEVEL: ServiceLevel = 95;

function makePlanId(brewPlanId: string, generatedAt: string): string {
  return `packaging-plan-${brewPlanId}-${generatedAt}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function valueAt(values: number[] | undefined, index: number): number {
  const value = values?.[index] ?? 0;
  return Number.isFinite(value) ? value : 0;
}

function countNonzero(values: number[]): number {
  return values.reduce((count, value) => count + (value !== 0 ? 1 : 0), 0);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function calculatePackagingSafetyStock(
  historicalDemand: number[],
  serviceLevel: ServiceLevel,
  weeksOfCoverFallback: number,
  minNonzeroWeeksForSigma: number,
): { stdDev: number; safetyFactor: number; safetyStock: number; method: SafetyStockMethod } {
  const safetyFactor = SAFETY_FACTORS[serviceLevel];
  const nonzeroCount = countNonzero(historicalDemand);
  if (nonzeroCount >= minNonzeroWeeksForSigma) {
    const stdDev = calculateHistoricalStdDev(historicalDemand);
    return { stdDev, safetyFactor, safetyStock: stdDev * safetyFactor, method: "sigma_z" };
  }
  return {
    stdDev: 0,
    safetyFactor,
    safetyStock: average(historicalDemand) * weeksOfCoverFallback,
    method: "weeks_of_cover_fallback",
  };
}

export function generatePackagingPlan(input: PackagingPlanInput): PackagingPlanResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const planId = makePlanId(input.brewPlan.planId, generatedAt);
  const weeksOfCoverFallback = input.weeksOfCoverFallback ?? DEFAULT_WEEKS_OF_COVER_FALLBACK;
  const minNonzeroWeeksForSigma = input.minNonzeroWeeksForSigma ?? DEFAULT_MIN_NONZERO_WEEKS_FOR_SIGMA;

  const brewRowByKey = new Map<string, ProductLevelBrewPlanRow>();
  input.brewPlan.productLevelBrewPlan.forEach((row) => {
    brewRowByKey.set(`${row.product_id}||${row.week_start_date}`, row);
  });

  const productOrder: string[] = [];
  const weeksByProduct = new Map<string, string[]>();
  const productNameById = new Map<string, string>();
  input.brewPlan.productLevelBrewPlan.forEach((row) => {
    if (!weeksByProduct.has(row.product_id)) {
      weeksByProduct.set(row.product_id, []);
      productOrder.push(row.product_id);
      productNameById.set(row.product_id, row.product_name);
    }
    weeksByProduct.get(row.product_id)!.push(row.week_start_date);
  });

  const demandByProduct = new Map<string, PackagingDemandRow[]>();
  input.packagingDemand.forEach((row) => {
    if (!demandByProduct.has(row.product_id)) demandByProduct.set(row.product_id, []);
    demandByProduct.get(row.product_id)!.push(row);
  });
  const inventoryByProduct = new Map<string, PackagingInventoryRow[]>();
  input.packagingInventory.forEach((row) => {
    if (!inventoryByProduct.has(row.product_id)) inventoryByProduct.set(row.product_id, []);
    inventoryByProduct.get(row.product_id)!.push(row);
  });
  const historyByKey = new Map<string, number[]>();
  input.packagingHistory.forEach((row) => {
    historyByKey.set(`${row.product_id}||${row.packaging_format}`, row.weeklyDemandBarrels);
  });

  const packagingRows: PackagingPlanRow[] = [];
  const summaryRows: WeeklyPackagingSummaryRow[] = [];

  productOrder.forEach((productId) => {
    const weeks = weeksByProduct.get(productId) ?? [];
    if (weeks.length === 0) return;

    const demandRows = demandByProduct.get(productId) ?? [];
    const inventoryRows = inventoryByProduct.get(productId) ?? [];
    const productName = productNameById.get(productId) ?? productId;
    const serviceLevel = input.serviceLevelByProduct?.[productId] ?? DEFAULT_SERVICE_LEVEL;

    const skuSet = new Set<string>();
    demandRows.forEach((row) => skuSet.add(row.packaging_format));
    inventoryRows.forEach((row) => skuSet.add(row.packaging_format));
    const skus = Array.from(skuSet).sort();
    if (skus.length === 0) return;

    const projectedAfterByFormat: Record<string, number> = {};
    skus.forEach((format) => {
      projectedAfterByFormat[format] =
        inventoryRows.find((row) => row.packaging_format === format)?.startingInventoryBarrels ?? 0;
    });

    const demandByFormat: Record<string, number[]> = {};
    skus.forEach((format) => {
      demandByFormat[format] =
        demandRows.find((row) => row.packaging_format === format)?.weeklyDemandBarrels ?? [];
    });

    const velocityByFormat: Record<string, number> = {};
    const totalForecastByFormat: Record<string, number> = {};
    const safetyByFormat: Record<string, ReturnType<typeof calculatePackagingSafetyStock>> = {};
    skus.forEach((format) => {
      const history = historyByKey.get(`${productId}||${format}`) ?? [];
      velocityByFormat[format] = history.reduce((sum, value) => sum + value, 0);
      totalForecastByFormat[format] = (demandByFormat[format] ?? []).reduce((sum, value) => sum + value, 0);
      safetyByFormat[format] = calculatePackagingSafetyStock(
        history,
        serviceLevel,
        weeksOfCoverFallback,
        minNonzeroWeeksForSigma,
      );
    });

    weeks.forEach((weekStartDate, weekIndex) => {
      const brewRow = brewRowByKey.get(`${productId}||${weekStartDate}`);
      const readyToPackageBbl = (brewRow?.planned_order_receipt ?? 0) + (brewRow?.scheduled_receipts ?? 0);
      let remainingReady = readyToPackageBbl;

      type SkuState = {
        format: string;
        startingInventoryBbl: number;
        forecastDemandBbl: number;
        targetInventoryBbl: number;
        projectedBeforePackagingBbl: number;
        gapBbl: number;
        bblPerUnit: number;
        velocity: number;
      };

      const states: SkuState[] = skus.map((format) => {
        const startingInv = projectedAfterByFormat[format];
        const demand = valueAt(demandByFormat[format], weekIndex);
        const nextWeekDemand = valueAt(demandByFormat[format], weekIndex + 1);
        const target = nextWeekDemand + safetyByFormat[format].safetyStock;
        const projectedBefore = startingInv - demand;
        const gap = Math.max(0, target - projectedBefore);
        return {
          format,
          startingInventoryBbl: startingInv,
          forecastDemandBbl: demand,
          targetInventoryBbl: target,
          projectedBeforePackagingBbl: projectedBefore,
          gapBbl: gap,
          bblPerUnit: input.bblPerUnitByFormat[format] ?? 0,
          velocity: velocityByFormat[format],
        };
      });

      const allocByFormat: Record<string, { bbl: number; reason: AllocationReason }> = {};
      skus.forEach((format) => {
        allocByFormat[format] = { bbl: 0, reason: "no_demand_share" };
      });

      if (readyToPackageBbl <= 0) {
        skus.forEach((format) => {
          allocByFormat[format].reason = "no_liquid_ready";
        });
      } else {
        // Phase 1 — gap fill, ordered by lowest weeks-of-cover (most likely to stock out first).
        // SKUs whose projected inventory already covers next-week demand + safety stock have gap = 0
        // and are skipped here entirely.
        const weeksOfCover = (state: SkuState): number => {
          if (state.forecastDemandBbl <= 0) return Number.POSITIVE_INFINITY;
          return state.projectedBeforePackagingBbl / state.forecastDemandBbl;
        };
        const gapFillOrder = states
          .filter((state) => state.gapBbl > 0 && state.bblPerUnit > 0)
          .sort((a, b) =>
            weeksOfCover(a) - weeksOfCover(b) ||
            b.gapBbl - a.gapBbl ||
            a.format.localeCompare(b.format),
          );
        for (const state of gapFillOrder) {
          if (remainingReady <= 0) break;
          const bblToAllocate = Math.min(state.gapBbl, remainingReady);
          const units = Math.floor(bblToAllocate / state.bblPerUnit);
          if (units > 0) {
            const actualBbl = units * state.bblPerUnit;
            allocByFormat[state.format] = { bbl: actualBbl, reason: "gap_fill" };
            remainingReady -= actualBbl;
          }
        }

        // Phase 2 — distribute any beer left over after gaps are filled by historical mix
        // (or, for products with no history, by forecast demand). Surplus follows where the
        // brewery normally moves volume.
        if (remainingReady > 0) {
          const useHistorical = states.some((state) => state.velocity > 0);
          const weightOf = (state: SkuState): number =>
            useHistorical ? state.velocity : (totalForecastByFormat[state.format] ?? 0);
          const totalWeight = states.reduce((sum, state) => sum + weightOf(state), 0);

          if (totalWeight > 0) {
            const sweepPool = remainingReady;
            states.forEach((state) => {
              if (state.bblPerUnit <= 0) return;
              const weight = weightOf(state);
              if (weight <= 0) return;
              const share = weight / totalWeight;
              const targetBbl = sweepPool * share;
              const units = Math.floor(targetBbl / state.bblPerUnit);
              if (units > 0) {
                const actualBbl = units * state.bblPerUnit;
                const prior = allocByFormat[state.format];
                allocByFormat[state.format] = {
                  bbl: prior.bbl + actualBbl,
                  reason: prior.bbl > 0 ? prior.reason : "mix_allocation",
                };
                remainingReady -= actualBbl;
              }
            });
          }
        }

        // Phase 3 — sub-unit slack from floor rounding goes to the fastest mover.
        if (remainingReady > 0) {
          const sweepCandidate = states
            .filter((state) => state.bblPerUnit > 0 && (state.velocity > 0 || (totalForecastByFormat[state.format] ?? 0) > 0))
            .sort((a, b) =>
              b.velocity - a.velocity ||
              (totalForecastByFormat[b.format] ?? 0) - (totalForecastByFormat[a.format] ?? 0) ||
              a.bblPerUnit - b.bblPerUnit ||
              a.format.localeCompare(b.format),
            )[0];

          if (sweepCandidate) {
            const unitsToAdd = Math.floor(remainingReady / sweepCandidate.bblPerUnit);
            if (unitsToAdd > 0) {
              const additionalBbl = unitsToAdd * sweepCandidate.bblPerUnit;
              const prior = allocByFormat[sweepCandidate.format];
              allocByFormat[sweepCandidate.format] = {
                bbl: prior.bbl + additionalBbl,
                reason: prior.bbl > 0 ? prior.reason : "remainder_sweep",
              };
              remainingReady -= additionalBbl;
            }
          }
        }
      }

      let totalAllocated = 0;
      states.forEach((state) => {
        const alloc = allocByFormat[state.format];
        const units = state.bblPerUnit > 0 ? Math.round(alloc.bbl / state.bblPerUnit) : 0;
        const actualBbl = state.bblPerUnit * units;
        const projectedAfter = state.projectedBeforePackagingBbl + actualBbl;
        projectedAfterByFormat[state.format] = projectedAfter;
        totalAllocated += actualBbl;

        const safety = safetyByFormat[state.format];
        packagingRows.push({
          plan_id: planId,
          brew_plan_id: input.brewPlan.planId,
          forecast_cycle_id: input.brewPlan.forecastCycleId,
          generated_at: generatedAt,
          product_id: productId,
          product_name: productName,
          packaging_format: state.format,
          week_start_date: weekStartDate,
          starting_inventory_bbl: state.startingInventoryBbl,
          forecast_demand_bbl: state.forecastDemandBbl,
          historical_demand_std_dev: safety.stdDev,
          service_level: serviceLevel,
          safety_factor: safety.safetyFactor,
          safety_stock_bbl: safety.safetyStock,
          safety_stock_method: safety.method,
          target_inventory_bbl: state.targetInventoryBbl,
          projected_available_before_packaging_bbl: state.projectedBeforePackagingBbl,
          inventory_gap_bbl: state.gapBbl,
          allocated_bbl: actualBbl,
          projected_available_after_packaging_bbl: projectedAfter,
          allocation_reason: alloc.reason,
          bbl_per_unit: state.bblPerUnit,
          package_units: units,
        });
      });

      summaryRows.push({
        plan_id: planId,
        product_id: productId,
        week_start_date: weekStartDate,
        ready_to_package_bbl: readyToPackageBbl,
        total_allocated_bbl: totalAllocated,
        unallocated_bbl: Math.max(0, readyToPackageBbl - totalAllocated),
      });
    });
  });

  return {
    planId,
    brewPlanId: input.brewPlan.planId,
    forecastCycleId: input.brewPlan.forecastCycleId,
    generatedAt,
    packagingPlan: packagingRows,
    weeklySummary: summaryRows,
  };
}
