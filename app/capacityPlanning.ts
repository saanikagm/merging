export function generateCapacityPlan(name: string, forecasts: number[], startInv: number, safetyStock: number, manualReleases: Record<number, number> = {}) {
    let projAvailable = [];
    let plannedReceipt = [];
    let plannedRelease = [];

    let currentInv = startInv;
    const batchSize = 50;
    const leadTime = 2;

    for (let i = 0; i < 8; i++) {
        let demand = forecasts[i] || 0;
        let projectedInv = currentInv - demand;
        let receipt = 0;

        let isManual = manualReleases[i - leadTime] !== undefined;

        if (isManual) {
            receipt = manualReleases[i - leadTime];
        } else {
            if (projectedInv < safetyStock) {
                let gap = safetyStock - projectedInv;
                receipt = Math.ceil(gap / batchSize) * batchSize;
            }
        }

        plannedReceipt.push(receipt);
        currentInv = projectedInv + receipt;
        projAvailable.push(currentInv);
    }

    // NEW: Aggregate any receipts that fall into the "past due" window
    let pastDueBrews = 0;
    for (let j = 0; j < leadTime; j++) {
        pastDueBrews += plannedReceipt[j] || 0;
    }

    for (let i = 0; i < 6; i++) {
        let release = manualReleases[i] !== undefined ? manualReleases[i] : (plannedReceipt[i + leadTime] || 0);

        // NEW: Force past-due brews into the immediate Week 0 "Start Brewing" schedule
        if (i === 0 && manualReleases[i] === undefined) {
            release += pastDueBrews;
        }

        plannedRelease.push(release);
    }

    const displayForecasts = forecasts.slice(0, 6);
    const displayAvailable = projAvailable.slice(0, 6);
    const displayReceipts = plannedReceipt.slice(0, 6);

    const totalForecast = displayForecasts.reduce((a, b) => a + b, 0);
    const avgWeeklyDemand = totalForecast / 6;

    return {
        productName: name,
        totalForecast,
        avgWeeklyDemand,
        startInv,
        safetyStock,
        forecasts: displayForecasts,
        projAvailable: displayAvailable,
        plannedReceipt: displayReceipts,
        plannedRelease
    };
}