export function generateCapacityPlan(name: string, forecasts: number[], startInv: number, safetyStock: number, manualReleases: Record<number, number> = {}) {
    let projAvailable = [];
    let plannedReceipt = [];
    let plannedRelease = [];

    let currentInv = startInv;
    const leadTime = 2;

    for (let i = 0; i < 8; i++) {
        let demand = forecasts[i] || 0;
        let projectedInv = currentInv - demand;
        let receipt = 0;

        let isManual = manualReleases[i - leadTime] !== undefined;

        if (isManual) {
            receipt = manualReleases[i - leadTime];
        } else if (demand > 0) {
            receipt = demand;
            if (projectedInv + receipt < safetyStock) {
                receipt += safetyStock - (projectedInv + receipt);
            }
            receipt = Math.round(receipt * 100) / 100;
        }

        plannedReceipt.push(receipt);
        currentInv = projectedInv + receipt;
        projAvailable.push(currentInv);
    }

    for (let i = 0; i < 6; i++) {
        plannedRelease.push(manualReleases[i] !== undefined ? manualReleases[i] : (plannedReceipt[i + leadTime] || 0));
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
