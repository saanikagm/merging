export type ServiceLevel = 90 | 95 | 96 | 99 | 99.9;
export type CapacityStatus = "OK" | "WARNING" | "OVER_CAPACITY";
export type ChangeType = "NEW" | "INCREASED" | "DECREASED" | "REMOVED" | "UNCHANGED";

export type ProductForecastInput = {
  product_id: string;
  product_name: string;
  weeklyForecastBarrels: number[];
  weekStartDates: string[];
};

export type BrewPlanningInput = {
  forecastCycleId: string;
  generatedAt?: string;
  planningHorizonWeeks?: number;
  serviceLevelByProduct?: Record<string, ServiceLevel>;
  currentInventoryByProduct: Record<string, number>;
  historicalDemandByProduct: Record<string, number[]>;
  scheduledReceiptsByProduct?: Record<string, number[]>;
  brewLeadTimeWeeks?: number;
  batchSizeBarrels?: number;
  targetCapacityBarrels?: number;
  maxCapacityBarrels?: number;
  productForecasts: ProductForecastInput[];
  priorPlanRows?: ProductLevelBrewPlanRow[];
  manualReleasesByProduct?: Record<string, Record<number, number>>;
  safetyStockOverrideByProduct?: Record<string, number>;
  minWeeklyBrewByProduct?: Record<string, number>;
};

export type ProductLevelBrewPlanRow = {
  plan_id: string;
  forecast_cycle_id: string;
  generated_at: string;
  product_id: string;
  product_name: string;
  week_start_date: string;
  forecast_barrels: number;
  starting_inventory: number;
  historical_demand_std_dev: number;
  service_level: ServiceLevel;
  safety_factor: number;
  safety_stock: number;
  level_production_barrels: number;
  level_projected_inventory: number;
  gross_requirements: number;
  scheduled_receipts: number;
  projected_available: number;
  net_requirement: number;
  planned_order_receipt: number;
  planned_order_release: number;
  actual_brew_barrels: number;
  capacity_status: CapacityStatus;
  notes: string;
};

export type WeeklyCapacitySummaryRow = {
  plan_id: string;
  forecast_cycle_id: string;
  week_start_date: string;
  total_planned_order_release_barrels: number;
  target_capacity_barrels: number;
  max_capacity_barrels: number;
  utilization_percent_of_max: number;
  capacity_status: CapacityStatus;
};

export type ChangeFromPriorPlanRow = {
  current_plan_id: string;
  prior_plan_id: string;
  product_id: string;
  product_name: string;
  week_start_date: string;
  prior_planned_order_release: number;
  current_planned_order_release: number;
  change_in_barrels: number;
  change_type: ChangeType;
};

export type BrewPlanningResult = {
  planId: string;
  forecastCycleId: string;
  generatedAt: string;
  productLevelBrewPlan: ProductLevelBrewPlanRow[];
  weeklyCapacitySummary: WeeklyCapacitySummaryRow[];
  changeFromPriorPlan: ChangeFromPriorPlanRow[];
};

export const SAFETY_FACTORS: Record<ServiceLevel, number> = {
  90: 1.28,
  95: 1.65,
  96: 1.75,
  99: 2.33,
  99.9: 4.00,
};

export function calculateHistoricalStdDev(values: number[]): number {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2) return 0;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance);
}

export function calculateSafetyStock(historicalWeeklyDemand: number[], serviceLevel: ServiceLevel): { stdDev: number; safetyFactor: number; safetyStock: number } {
  const stdDev = calculateHistoricalStdDev(historicalWeeklyDemand);
  const safetyFactor = SAFETY_FACTORS[serviceLevel];
  return {
    stdDev,
    safetyFactor,
    safetyStock: stdDev * safetyFactor,
  };
}

export function calculateCapacityStatus(totalReleaseBarrels: number, targetCapacityBarrels = 400, maxCapacityBarrels = 500): CapacityStatus {
  if (totalReleaseBarrels > maxCapacityBarrels) return "OVER_CAPACITY";
  if (totalReleaseBarrels > targetCapacityBarrels) return "WARNING";
  return "OK";
}

export function roundUpToBatch(value: number, batchSizeBarrels = 50): number {
  if (value <= 0) return 0;
  return Math.ceil(value / batchSizeBarrels) * batchSizeBarrels;
}

function makePlanId(forecastCycleId: string, generatedAt: string): string {
  return `brew-plan-${forecastCycleId}-${generatedAt}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function valueAt(values: number[] | undefined, index: number): number {
  const value = values?.[index] ?? 0;
  return Number.isFinite(value) ? value : 0;
}

export function generateBrewPlan(input: BrewPlanningInput): BrewPlanningResult {
  const planningHorizonWeeks = input.planningHorizonWeeks ?? 8;
  const brewLeadTimeWeeks = input.brewLeadTimeWeeks ?? 2;
  const batchSizeBarrels = input.batchSizeBarrels ?? 50;
  const targetCapacityBarrels = input.targetCapacityBarrels ?? 400;
  const maxCapacityBarrels = input.maxCapacityBarrels ?? 500;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const planId = makePlanId(input.forecastCycleId, generatedAt);

  const productRows: ProductLevelBrewPlanRow[] = [];

  input.productForecasts.forEach((forecast) => {
    const serviceLevel = input.serviceLevelByProduct?.[forecast.product_id] ?? 95;
    const historicalDemand = input.historicalDemandByProduct[forecast.product_id] ?? [];
    const { stdDev, safetyFactor, safetyStock: calculatedSafetyStock } = calculateSafetyStock(historicalDemand, serviceLevel);
    const safetyStockOverride = input.safetyStockOverrideByProduct?.[forecast.product_id];
    const safetyStock = safetyStockOverride ?? calculatedSafetyStock;
    const currentInventory = input.currentInventoryByProduct[forecast.product_id] ?? 0;
    const scheduledReceipts = input.scheduledReceiptsByProduct?.[forecast.product_id] ?? [];
    const horizonForecast = forecast.weeklyForecastBarrels.slice(0, planningHorizonWeeks);
    const totalForecast = horizonForecast.reduce((sum, value) => sum + value, 0);
    const levelProduction = (totalForecast + safetyStock - currentInventory) / planningHorizonWeeks;

    const levelProjectedInventory: number[] = [];
    let priorLevelProjectedInventory = currentInventory;
    for (let weekIndex = 0; weekIndex < planningHorizonWeeks; weekIndex += 1) {
      priorLevelProjectedInventory = priorLevelProjectedInventory + levelProduction - valueAt(horizonForecast, weekIndex);
      levelProjectedInventory.push(priorLevelProjectedInventory);
    }

    const manualReleases = input.manualReleasesByProduct?.[forecast.product_id] ?? {};
    const plannedReceipts: number[] = Array(planningHorizonWeeks).fill(0);
    const projectedAvailable: number[] = [];
    const netRequirements: number[] = [];
    let priorProjectedAvailable = currentInventory;

    for (let weekIndex = 0; weekIndex < planningHorizonWeeks; weekIndex += 1) {
      const grossRequirements = valueAt(horizonForecast, weekIndex);
      const scheduledReceipt = valueAt(scheduledReceipts, weekIndex);
      const manualReleaseWeek = weekIndex - brewLeadTimeWeeks;
      const manualReceiptValue = manualReleases[manualReleaseWeek];
      let netRequirement: number;
      let plannedReceipt: number;
      if (manualReceiptValue !== undefined) {
        netRequirement = 0;
        plannedReceipt = manualReceiptValue;
      } else {
        netRequirement = Math.max(0, grossRequirements + safetyStock - priorProjectedAvailable - scheduledReceipt);
        plannedReceipt = roundUpToBatch(netRequirement, batchSizeBarrels);
      }
      const available = priorProjectedAvailable + scheduledReceipt + plannedReceipt - grossRequirements;

      netRequirements[weekIndex] = netRequirement;
      plannedReceipts[weekIndex] = plannedReceipt;
      projectedAvailable[weekIndex] = available;
      priorProjectedAvailable = available;
    }

    const pastDueReceipts = plannedReceipts
      .slice(0, brewLeadTimeWeeks)
      .reduce((sum, receipt) => sum + receipt, 0);

    const plannedReleases = plannedReceipts.map((_, weekIndex) => {
      const manualValue = manualReleases[weekIndex];
      if (manualValue !== undefined) return manualValue;
      const receiptIndex = weekIndex + brewLeadTimeWeeks;
      const release = plannedReceipts[receiptIndex] ?? 0;
      return weekIndex === 0 ? release + pastDueReceipts : release;
    });

    const minWeeklyBrew = input.minWeeklyBrewByProduct?.[forecast.product_id] ?? 0;
    if (minWeeklyBrew > 0) {
      for (let weekIndex = 0; weekIndex < planningHorizonWeeks; weekIndex += 1) {
        if (manualReleases[weekIndex] !== undefined) continue;
        if (plannedReleases[weekIndex] < minWeeklyBrew) {
          plannedReleases[weekIndex] = minWeeklyBrew;
        }
      }
      for (let weekIndex = brewLeadTimeWeeks; weekIndex < planningHorizonWeeks; weekIndex += 1) {
        const releaseWeek = weekIndex - brewLeadTimeWeeks;
        if (manualReleases[releaseWeek] !== undefined) continue;
        plannedReceipts[weekIndex] = plannedReleases[releaseWeek];
      }
      let priorAvail = currentInventory;
      for (let weekIndex = 0; weekIndex < planningHorizonWeeks; weekIndex += 1) {
        const gross = valueAt(horizonForecast, weekIndex);
        const sched = valueAt(scheduledReceipts, weekIndex);
        const recv = plannedReceipts[weekIndex];
        const avail = priorAvail + sched + recv - gross;
        projectedAvailable[weekIndex] = avail;
        priorAvail = avail;
      }
    }

    for (let weekIndex = 0; weekIndex < planningHorizonWeeks; weekIndex += 1) {
      const receiptReleaseBeforeHorizon = weekIndex < brewLeadTimeWeeks && plannedReceipts[weekIndex] > 0;
      const immediatePastDueRelease = weekIndex === 0 && pastDueReceipts > 0;
      productRows.push({
        plan_id: planId,
        forecast_cycle_id: input.forecastCycleId,
        generated_at: generatedAt,
        product_id: forecast.product_id,
        product_name: forecast.product_name,
        week_start_date: forecast.weekStartDates[weekIndex] ?? `Week ${weekIndex + 1}`,
        forecast_barrels: valueAt(horizonForecast, weekIndex),
        starting_inventory: weekIndex === 0 ? currentInventory : projectedAvailable[weekIndex - 1],
        historical_demand_std_dev: stdDev,
        service_level: serviceLevel,
        safety_factor: safetyFactor,
        safety_stock: safetyStock,
        level_production_barrels: levelProduction,
        level_projected_inventory: levelProjectedInventory[weekIndex],
        gross_requirements: valueAt(horizonForecast, weekIndex),
        scheduled_receipts: valueAt(scheduledReceipts, weekIndex),
        projected_available: projectedAvailable[weekIndex],
        net_requirement: netRequirements[weekIndex],
        planned_order_receipt: plannedReceipts[weekIndex],
        planned_order_release: plannedReleases[weekIndex],
        actual_brew_barrels: Math.max(0, plannedReleases[weekIndex]),
        capacity_status: "OK",
        notes: immediatePastDueRelease
          ? `Immediate release includes ${pastDueReceipts} BBL of receipts needed inside the first ${brewLeadTimeWeeks} weeks.`
          : receiptReleaseBeforeHorizon ? `Receipt requires release before visible horizon due to ${brewLeadTimeWeeks}-week lead time.` : "",
      });
    }
  });

  const weekDates = input.productForecasts[0]?.weekStartDates.slice(0, planningHorizonWeeks) ?? [];
  const capacityRows: WeeklyCapacitySummaryRow[] = weekDates.map((weekStartDate) => {
    const totalRelease = productRows
      .filter((row) => row.week_start_date === weekStartDate)
      .reduce((sum, row) => sum + row.planned_order_release, 0);
    const capacityStatus = calculateCapacityStatus(totalRelease, targetCapacityBarrels, maxCapacityBarrels);
    return {
      plan_id: planId,
      forecast_cycle_id: input.forecastCycleId,
      week_start_date: weekStartDate,
      total_planned_order_release_barrels: totalRelease,
      target_capacity_barrels: targetCapacityBarrels,
      max_capacity_barrels: maxCapacityBarrels,
      utilization_percent_of_max: maxCapacityBarrels > 0 ? (totalRelease / maxCapacityBarrels) * 100 : 0,
      capacity_status: capacityStatus,
    };
  });

  const capacityByWeek = Object.fromEntries(capacityRows.map((row) => [row.week_start_date, row.capacity_status]));
  productRows.forEach((row) => {
    row.capacity_status = capacityByWeek[row.week_start_date] ?? "OK";
  });

  return {
    planId,
    forecastCycleId: input.forecastCycleId,
    generatedAt,
    productLevelBrewPlan: productRows,
    weeklyCapacitySummary: capacityRows,
    changeFromPriorPlan: compareToPriorPlan(productRows, input.priorPlanRows ?? []),
  };
}

export function compareToPriorPlan(currentRows: ProductLevelBrewPlanRow[], priorRows: ProductLevelBrewPlanRow[]): ChangeFromPriorPlanRow[] {
  const currentPlanId = currentRows[0]?.plan_id ?? "";
  const priorPlanId = priorRows[0]?.plan_id ?? "";
  const currentByKey = new Map(currentRows.map((row) => [`${row.product_id}||${row.week_start_date}`, row]));
  const priorByKey = new Map(priorRows.map((row) => [`${row.product_id}||${row.week_start_date}`, row]));
  const keys = Array.from(new Set([...currentByKey.keys(), ...priorByKey.keys()])).sort();

  return keys.map((key) => {
    const current = currentByKey.get(key);
    const prior = priorByKey.get(key);
    const priorValue = prior?.planned_order_release ?? 0;
    const currentValue = current?.planned_order_release ?? 0;
    const productId = current?.product_id ?? prior?.product_id ?? "";
    const productName = current?.product_name ?? prior?.product_name ?? "";
    const weekStartDate = current?.week_start_date ?? prior?.week_start_date ?? "";
    const change = currentValue - priorValue;
    let changeType: ChangeType = "UNCHANGED";

    if (!prior && currentValue > 0) changeType = "NEW";
    else if (priorValue > 0 && (!current || currentValue === 0)) changeType = "REMOVED";
    else if (change > 0) changeType = "INCREASED";
    else if (change < 0) changeType = "DECREASED";

    return {
      current_plan_id: currentPlanId,
      prior_plan_id: priorPlanId,
      product_id: productId,
      product_name: productName,
      week_start_date: weekStartDate,
      prior_planned_order_release: priorValue,
      current_planned_order_release: currentValue,
      change_in_barrels: change,
      change_type: changeType,
    };
  });
}
