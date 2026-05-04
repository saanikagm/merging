import type { BrewPlanningInput, ProductForecastInput } from "./brewPlanningService";

export const fixtureWeekStartDates = [
  "2026-05-04",
  "2026-05-11",
  "2026-05-18",
  "2026-05-25",
  "2026-06-01",
  "2026-06-08",
  "2026-06-15",
  "2026-06-22",
];

export const fixtureProductForecasts: ProductForecastInput[] = [
  {
    product_id: "high-volume",
    product_name: "High Volume Beer",
    weeklyForecastBarrels: [200, 200, 200, 200, 200, 200, 200, 200],
    weekStartDates: fixtureWeekStartDates,
  },
  {
    product_id: "low-volume-excess",
    product_name: "Low Volume Excess Inventory",
    weeklyForecastBarrels: [10, 10, 10, 10, 10, 10, 10, 10],
    weekStartDates: fixtureWeekStartDates,
  },
  {
    product_id: "capacity-trigger",
    product_name: "Capacity Trigger Beer",
    weeklyForecastBarrels: [0, 0, 450, 450, 450, 450, 450, 450],
    weekStartDates: fixtureWeekStartDates,
  },
];

export const fixtureBrewPlanningInput: BrewPlanningInput = {
  forecastCycleId: "fixture-cycle-2026-05-04",
  generatedAt: "2026-05-04T12:00:00.000Z",
  planningHorizonWeeks: 8,
  serviceLevelByProduct: {
    "high-volume": 95,
    "low-volume-excess": 90,
    "capacity-trigger": 99,
  },
  currentInventoryByProduct: {
    "high-volume": 100,
    "low-volume-excess": 500,
    "capacity-trigger": 0,
  },
  historicalDemandByProduct: {
    "high-volume": [180, 200, 220, 200, 210, 190, 205, 195],
    "low-volume-excess": [8, 10, 9, 11, 10, 10, 12, 10],
    "capacity-trigger": [300, 450, 500, 400, 450, 550, 350, 500],
  },
  scheduledReceiptsByProduct: {
    "high-volume": [0, 0, 0, 0, 0, 0, 0, 0],
    "low-volume-excess": [0, 0, 0, 0, 0, 0, 0, 0],
    "capacity-trigger": [0, 0, 0, 0, 0, 0, 0, 0],
  },
  productForecasts: fixtureProductForecasts,
};
