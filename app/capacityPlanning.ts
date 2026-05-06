export type CapacityPlanResult = {
    productName: string;
    totalForecast: number;
    avgWeeklyDemand: number;
    startInv: number;
    safetyStock: number;
    forecasts: number[];
    projAvailable: number[];
    plannedReceipt: number[];
    plannedRelease: number[];
    netRequirements: number[];
    grossRequirements: number[];
    startingInventoryByWeek: number[];
    batchSize: number;
    leadTimeWeeks: number;
    pastDueReceipts: number;
    displayWeeks: number;
};

export function generateCapacityPlan(
    name: string,
    forecasts: number[],
    startInv: number,
    safetyStock: number,
    manualReleases: Record<number, number> = {}
): CapacityPlanResult {
    // Revised MRP-style brewing logic: 50-BBL batch multiples, 2-week brewing offset,
    // 8-week internal horizon so weeks 5-6 are correctly served by 2-week-ahead releases.
    const internalHorizon = 8;
    const displayWeeks = 6;
    const leadTimeWeeks = 2;
    const batchSize = 50;

    const plannedReceipt: number[] = [];
    const projAvailable: number[] = [];
    const netRequirements: number[] = [];
    const startingInventoryByWeek: number[] = [];
    const grossRequirements: number[] = [];
    let priorAvailable = startInv;

    // Skip auto-recommended brews entirely for products with no forecasted demand
    // (e.g. The Roustabout) — top-up brews are wasteful when no one is drinking it.
    const horizonForecastTotal = forecasts.slice(0, internalHorizon).reduce((sum, value) => sum + (value || 0), 0);
    const hasNoDemand = horizonForecastTotal <= 0;

    for (let i = 0; i < internalHorizon; i++) {
        const gross = forecasts[i] || 0;
        const isManualReceipt = manualReleases[i - leadTimeWeeks] !== undefined;
        startingInventoryByWeek.push(priorAvailable);
        grossRequirements.push(gross);

        let net = 0;
        let receipt = 0;
        if (isManualReceipt) {
            receipt = manualReleases[i - leadTimeWeeks];
        } else if (!hasNoDemand) {
            net = Math.max(0, gross + safetyStock - priorAvailable);
            receipt = net > 0 ? Math.ceil(net / batchSize) * batchSize : 0;
        }
        netRequirements.push(net);
        plannedReceipt.push(receipt);

        const available = priorAvailable + receipt - gross;
        projAvailable.push(available);
        priorAvailable = available;
    }

    let pastDueReceipts = 0;
    for (let j = 0; j < leadTimeWeeks; j++) pastDueReceipts += plannedReceipt[j] || 0;

    const plannedRelease: number[] = [];
    for (let i = 0; i < displayWeeks; i++) {
        let release = manualReleases[i] !== undefined ? manualReleases[i] : (plannedReceipt[i + leadTimeWeeks] || 0);
        if (i === 0 && manualReleases[i] === undefined) release += pastDueReceipts;
        plannedRelease.push(release);
    }

    const displayForecasts = forecasts.slice(0, displayWeeks);
    const totalForecast = displayForecasts.reduce((a, b) => a + b, 0);
    const avgWeeklyDemand = totalForecast / displayWeeks;

    return {
        productName: name,
        totalForecast,
        avgWeeklyDemand,
        startInv,
        safetyStock,
        forecasts: displayForecasts,
        projAvailable: projAvailable.slice(0, displayWeeks),
        plannedReceipt: plannedReceipt.slice(0, displayWeeks),
        plannedRelease,
        netRequirements: netRequirements.slice(0, displayWeeks),
        grossRequirements: grossRequirements.slice(0, displayWeeks),
        startingInventoryByWeek: startingInventoryByWeek.slice(0, displayWeeks),
        batchSize,
        leadTimeWeeks,
        pastDueReceipts,
        displayWeeks,
    };
}