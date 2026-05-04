import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCapacityStatus,
  calculateSafetyStock,
  compareToPriorPlan,
  generateBrewPlan,
  roundUpToBatch,
  type ProductLevelBrewPlanRow,
} from "./brewPlanningService.ts";
import { fixtureBrewPlanningInput } from "./brewPlanningService.fixtures.ts";
import {
  advanceRevisedBrewPlanHistory,
  buildHistoricalDemandByProduct,
  buildServiceLevelByProduct,
  buildWipByProduct,
  isWipPackaging,
  mapProductLevelForecasts,
} from "./revisedBrewPlanMapper.ts";

function row(rows: ProductLevelBrewPlanRow[], productId: string, weekStartDate: string): ProductLevelBrewPlanRow {
  const found = rows.find((item) => item.product_id === productId && item.week_start_date === weekStartDate);
  assert.ok(found, `Expected row for ${productId} ${weekStartDate}`);
  return found;
}

test("calculates safety stock from historical standard deviation and service factor", () => {
  const result = calculateSafetyStock([10, 20, 30], 95);
  assert.equal(result.safetyFactor, 1.65);
  assert.equal(result.stdDev, 10);
  assert.equal(result.safetyStock, 16.5);
});

test("calculates level production and level projected inventory", () => {
  const plan = generateBrewPlan({
    forecastCycleId: "level-test",
    generatedAt: "2026-05-04T12:00:00.000Z",
    planningHorizonWeeks: 4,
    currentInventoryByProduct: { p1: 100 },
    historicalDemandByProduct: { p1: [10, 10, 10, 10] },
    productForecasts: [{
      product_id: "p1",
      product_name: "Product 1",
      weeklyForecastBarrels: [100, 100, 100, 100],
      weekStartDates: ["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25"],
    }],
  });
  const first = row(plan.productLevelBrewPlan, "p1", "2026-05-04");
  const second = row(plan.productLevelBrewPlan, "p1", "2026-05-11");
  assert.equal(first.level_production_barrels, 75);
  assert.equal(first.level_projected_inventory, 75);
  assert.equal(second.level_projected_inventory, 50);
});

test("rounds planned order receipts to 50 barrel multiples", () => {
  assert.equal(roundUpToBatch(1, 50), 50);
  assert.equal(roundUpToBatch(50, 50), 50);
  assert.equal(roundUpToBatch(51, 50), 100);
});

test("creates planned receipts and applies 2 week release offset", () => {
  const plan = generateBrewPlan({
    forecastCycleId: "offset-test",
    generatedAt: "2026-05-04T12:00:00.000Z",
    planningHorizonWeeks: 4,
    currentInventoryByProduct: { p1: 200 },
    historicalDemandByProduct: { p1: [10, 10, 10, 10] },
    productForecasts: [{
      product_id: "p1",
      product_name: "Product 1",
      weeklyForecastBarrels: [0, 0, 250, 0],
      weekStartDates: ["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25"],
    }],
  });

  assert.equal(row(plan.productLevelBrewPlan, "p1", "2026-05-18").planned_order_receipt, 50);
  assert.equal(row(plan.productLevelBrewPlan, "p1", "2026-05-04").planned_order_release, 50);
  assert.equal(row(plan.productLevelBrewPlan, "p1", "2026-05-04").actual_brew_barrels, 50);
});

test("pulls past-due receipts from the lead-time window into the immediate release week", () => {
  const plan = generateBrewPlan({
    forecastCycleId: "past-due-test",
    generatedAt: "2026-05-04T12:00:00.000Z",
    planningHorizonWeeks: 4,
    currentInventoryByProduct: { p1: 0 },
    historicalDemandByProduct: { p1: [10, 10, 10, 10] },
    productForecasts: [{
      product_id: "p1",
      product_name: "Product 1",
      weeklyForecastBarrels: [10, 10, 0, 0],
      weekStartDates: ["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25"],
    }],
  });

  assert.equal(row(plan.productLevelBrewPlan, "p1", "2026-05-04").planned_order_receipt, 50);
  assert.equal(row(plan.productLevelBrewPlan, "p1", "2026-05-04").planned_order_release, 50);
  assert.match(row(plan.productLevelBrewPlan, "p1", "2026-05-04").notes, /Immediate release/);
});

test("assigns capacity status OK, WARNING, and OVER_CAPACITY", () => {
  assert.equal(calculateCapacityStatus(400, 400, 500), "OK");
  assert.equal(calculateCapacityStatus(450, 400, 500), "WARNING");
  assert.equal(calculateCapacityStatus(550, 400, 500), "OVER_CAPACITY");
});

test("produces weekly capacity summary from fixture data", () => {
  const plan = generateBrewPlan(fixtureBrewPlanningInput);
  assert.equal(plan.weeklyCapacitySummary.length, 8);
  assert.ok(plan.weeklyCapacitySummary.some((week) => week.capacity_status === "WARNING" || week.capacity_status === "OVER_CAPACITY"));
  assert.ok(plan.productLevelBrewPlan.every((item) => item.forecast_cycle_id === fixtureBrewPlanningInput.forecastCycleId));
});

test("compares current plan to prior plan", () => {
  const current = generateBrewPlan({
    forecastCycleId: "current",
    generatedAt: "2026-05-11T12:00:00.000Z",
    planningHorizonWeeks: 3,
    currentInventoryByProduct: { p1: 200 },
    historicalDemandByProduct: { p1: [10, 10, 10] },
    productForecasts: [{
      product_id: "p1",
      product_name: "Product 1",
      weeklyForecastBarrels: [0, 0, 250],
      weekStartDates: ["2026-05-04", "2026-05-11", "2026-05-18"],
    }],
  });
  const priorRows = current.productLevelBrewPlan.map((item) => ({
    ...item,
    plan_id: "prior-plan",
    planned_order_release: item.week_start_date === "2026-05-04" ? 100 : 0,
  }));
  const changes = compareToPriorPlan(current.productLevelBrewPlan, priorRows);
  const changed = changes.find((item) => item.week_start_date === "2026-05-04");
  assert.ok(changed);
  assert.equal(changed.prior_planned_order_release, 100);
  assert.equal(changed.current_planned_order_release, 50);
  assert.equal(changed.change_in_barrels, -50);
  assert.equal(changed.change_type, "DECREASED");
});

test("maps only product-level forecast rows into revised brew inputs", () => {
  const forecasts = mapProductLevelForecasts([
    { brand: "The Pupil", packaging_format: "ALL", week_number: 1, previous_value: 100, effective_value: null },
    { brand: "The Pupil", packaging_format: "Case - 24x - 12oz - Can", week_number: 1, previous_value: 999, effective_value: null },
    { brand: "The Pupil", packaging_format: "ALL", week_number: 2, previous_value: 100, effective_value: 120 },
  ], ["2026-05-04", "2026-05-11"], 2);

  assert.equal(forecasts.length, 1);
  assert.deepEqual(forecasts[0].weeklyForecastBarrels, [100, 120]);
});

test("selects 13 week history normally and 52 weeks for long-lookback beers", () => {
  const rows = Array.from({ length: 52 }, (_, index) => {
    const date = new Date("2026-05-04T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() - index * 7);
    return [
      { Date: date.toISOString(), ProductName: "The Coachman", "Sales Vol": index + 1 },
      { Date: date.toISOString(), ProductName: "The Pupil", "Sales Vol": index + 1 },
      { Date: date.toISOString(), ProductName: "Bulbous Flowers", "Sales Vol": index + 1 },
    ];
  }).flat();

  const history = buildHistoricalDemandByProduct(rows, ["The Coachman", "The Pupil", "Bulbous Flowers"]);
  assert.equal(history["The Coachman"].length, 13);
  assert.equal(history["The Pupil"].length, 52);
  assert.equal(history["Bulbous Flowers"].length, 52);
});

test("defaults service level map to the portfolio level with optional product overrides", () => {
  const serviceLevels = buildServiceLevelByProduct(["The Pupil", "The Coachman"], 95, { "The Coachman": 99 });
  assert.deepEqual(serviceLevels, { "The Pupil": 95, "The Coachman": 99 });
});

test("identifies WIP inventory separately from finished/package inventory", () => {
  assert.equal(isWipPackaging("WIP"), true);
  assert.equal(isWipPackaging("Work in Progress"), true);
  assert.equal(isWipPackaging("Case - 24x - 12oz - Can"), false);

  const wip = buildWipByProduct([
    { brand: "Bulbous Flowers", packaging_format: "WIP", startInv: 145 },
    { brand: "Bulbous Flowers", packaging_format: "Case - 24x - 16oz - Can", startInv: 10 },
    { brand: "The Pupil", packaging_format: "WIP", startInv: 300 },
  ]);

  assert.deepEqual(wip, { "Bulbous Flowers": 145, "The Pupil": 300 });
});

test("preserves forecast cycle id and generated date on generated plan rows", () => {
  const generatedAt = "2026-05-04T10:30:00.000Z";
  const plan = generateBrewPlan({ ...fixtureBrewPlanningInput, forecastCycleId: "cycle-123", generatedAt });
  assert.equal(plan.forecastCycleId, "cycle-123");
  assert.equal(plan.generatedAt, generatedAt);
  assert.ok(plan.productLevelBrewPlan.every((item) => item.forecast_cycle_id === "cycle-123"));
  assert.ok(plan.productLevelBrewPlan.every((item) => item.generated_at === generatedAt));
});

test("advances browser-only revised brew plan history after a new generation", () => {
  const prior = generateBrewPlan({ ...fixtureBrewPlanningInput, forecastCycleId: "prior", generatedAt: "2026-05-04T12:00:00.000Z" });
  const current = generateBrewPlan({ ...fixtureBrewPlanningInput, forecastCycleId: "current", generatedAt: "2026-05-11T12:00:00.000Z" });
  const history = advanceRevisedBrewPlanHistory(prior, current);

  assert.equal(history.currentRevisedBrewPlan.planId, current.planId);
  assert.equal(history.priorRevisedBrewPlan?.planId, prior.planId);
});
