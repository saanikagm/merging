import assert from "node:assert/strict";
import test from "node:test";
import {
  generateBrewPlan,
  type BrewPlanningResult,
  type ProductLevelBrewPlanRow,
} from "./brewPlanningService.ts";
import { fixtureBrewPlanningInput } from "./brewPlanningService.fixtures.ts";
import {
  calculatePackagingSafetyStock,
  generatePackagingPlan,
  type PackagingPlanRow,
  type PackagingPlanInput,
} from "./packagingPlanService.ts";
import {
  collectProductPackagingPairs,
  mapPackagingDemand,
  mapPackagingHistory,
  mapPackagingInventory,
} from "./packagingPlanMapper.ts";

const KEG_BBL_PER_UNIT = 0.5;
const CAN_24X12_BBL_PER_UNIT = 0.073;
const CAN_6X4_16_BBL_PER_UNIT = 0.097;

const BBL_PER_UNIT_BY_FORMAT: Record<string, number> = {
  "Keg - 1/2 bbl": KEG_BBL_PER_UNIT,
  "Case - 24x - 12oz - Can": CAN_24X12_BBL_PER_UNIT,
  "Case - 6x4 - 16oz - Can": CAN_6X4_16_BBL_PER_UNIT,
};

function makeBrewRow(
  productId: string,
  weekStartDate: string,
  plannedOrderReceipt: number,
  productName?: string,
): ProductLevelBrewPlanRow {
  return {
    plan_id: "brew-plan-test",
    forecast_cycle_id: "test-cycle",
    generated_at: "2026-05-04T12:00:00.000Z",
    product_id: productId,
    product_name: productName ?? productId,
    week_start_date: weekStartDate,
    forecast_barrels: 0,
    starting_inventory: 0,
    historical_demand_std_dev: 0,
    service_level: 95,
    safety_factor: 1.65,
    safety_stock: 0,
    level_production_barrels: 0,
    level_projected_inventory: 0,
    gross_requirements: 0,
    scheduled_receipts: 0,
    projected_available: 0,
    net_requirement: 0,
    planned_order_receipt: plannedOrderReceipt,
    planned_order_release: 0,
    actual_brew_barrels: 0,
    capacity_status: "OK",
    notes: "",
  };
}

function makeBrewPlanResult(rows: ProductLevelBrewPlanRow[]): BrewPlanningResult {
  return {
    planId: "brew-plan-test",
    forecastCycleId: "test-cycle",
    generatedAt: "2026-05-04T12:00:00.000Z",
    productLevelBrewPlan: rows,
    weeklyCapacitySummary: [],
    changeFromPriorPlan: [],
  };
}

function findRow(
  rows: PackagingPlanRow[],
  productId: string,
  packagingFormat: string,
  weekStartDate: string,
): PackagingPlanRow {
  const found = rows.find(
    (row) =>
      row.product_id === productId &&
      row.packaging_format === packagingFormat &&
      row.week_start_date === weekStartDate,
  );
  assert.ok(found, `Expected row for ${productId}/${packagingFormat}/${weekStartDate}`);
  return found;
}

const WEEKS_4 = ["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25"];

test("single SKU absorbs all ready barrels via mix allocation when it has all the historical share", () => {
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([
      makeBrewRow("p1", WEEKS_4[0], 100),
    ]),
    packagingDemand: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      weeklyDemandBarrels: [5, 5, 5, 5],
      weekStartDates: WEEKS_4,
    }],
    packagingHistory: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      weeklyDemandBarrels: [5, 5, 5, 5, 5, 5, 5, 5],
    }],
    packagingInventory: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      startingInventoryBarrels: 200,
    }],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  const week0 = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[0]);
  assert.equal(week0.allocated_bbl, 100);
  assert.equal(week0.package_units, 200);
  assert.equal(week0.allocation_reason, "mix_allocation");
});

test("allocation follows historical mix once all gaps are filled (80/20 split → 80/20 BBL)", () => {
  // Starting inventory is high enough that target − projectedBefore ≤ 0 for both SKUs,
  // so phase 1 (gap fill) is a no-op and the entire 100 BBL flows through phase 2 by velocity.
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([makeBrewRow("p1", WEEKS_4[0], 100)]),
    packagingDemand: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", weeklyDemandBarrels: [10, 10, 10, 10], weekStartDates: WEEKS_4 },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", weeklyDemandBarrels: [10, 10, 10, 10], weekStartDates: WEEKS_4 },
    ],
    packagingHistory: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", weeklyDemandBarrels: [80, 80, 80, 80] },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", weeklyDemandBarrels: [20, 20, 20, 20] },
    ],
    packagingInventory: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", startingInventoryBarrels: 1000 },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", startingInventoryBarrels: 1000 },
    ],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  const keg = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[0]);
  const can = findRow(plan.packagingPlan, "p1", "Case - 24x - 12oz - Can", WEEKS_4[0]);
  assert.ok(keg.allocated_bbl >= 79 && keg.allocated_bbl <= 80, `keg should get ~80 BBL (got ${keg.allocated_bbl})`);
  assert.ok(can.allocated_bbl >= 19 && can.allocated_bbl <= 20, `can should get ~20 BBL (got ${can.allocated_bbl})`);
  assert.equal(keg.allocation_reason, "mix_allocation");
  assert.equal(can.allocation_reason, "mix_allocation");
});

test("falls back to forecast mix when no SKU has historical demand (and gaps are already filled)", () => {
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([makeBrewRow("p1", WEEKS_4[0], 100)]),
    packagingDemand: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", weeklyDemandBarrels: [60, 60, 60, 60], weekStartDates: WEEKS_4 },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", weeklyDemandBarrels: [40, 40, 40, 40], weekStartDates: WEEKS_4 },
    ],
    packagingHistory: [],
    packagingInventory: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", startingInventoryBarrels: 1000 },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", startingInventoryBarrels: 1000 },
    ],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  const keg = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[0]);
  const can = findRow(plan.packagingPlan, "p1", "Case - 24x - 12oz - Can", WEEKS_4[0]);
  assert.ok(keg.allocated_bbl >= 59 && keg.allocated_bbl <= 60, `keg should get ~60 BBL via forecast mix (got ${keg.allocated_bbl})`);
  assert.ok(can.allocated_bbl >= 39 && can.allocated_bbl <= 40, `can should get ~40 BBL via forecast mix (got ${can.allocated_bbl})`);
});

test("gap-fill phase prioritizes the SKU with the lowest weeks-of-cover", () => {
  // Both SKUs have equal historical velocity (mix-allocation would split 50/50). But the keg
  // is already at 3 weeks of cover while the can is at < 1 week. Gap-fill should send the
  // limited ready beer to the can first, even though historical mix would say otherwise.
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([makeBrewRow("p1", WEEKS_4[0], 20)]),
    packagingDemand: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", weeklyDemandBarrels: [10, 10, 10, 10], weekStartDates: WEEKS_4 },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", weeklyDemandBarrels: [10, 10, 10, 10], weekStartDates: WEEKS_4 },
    ],
    packagingHistory: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", weeklyDemandBarrels: [10, 10, 10, 10] },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", weeklyDemandBarrels: [10, 10, 10, 10] },
    ],
    packagingInventory: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", startingInventoryBarrels: 30 },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", startingInventoryBarrels: 5 },
    ],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  const keg = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[0]);
  const can = findRow(plan.packagingPlan, "p1", "Case - 24x - 12oz - Can", WEEKS_4[0]);
  assert.ok(can.allocated_bbl > keg.allocated_bbl, `can should beat keg on allocation (keg ${keg.allocated_bbl}, can ${can.allocated_bbl})`);
  assert.equal(can.allocation_reason, "gap_fill");
});

test("gap-fill caps each SKU at its own gap; surplus spills to historical mix", () => {
  // Can has a tiny gap (~15 BBL) and keg has none. Plenty of beer (200 BBL ready). Phase 1
  // closes can's gap, phase 2 distributes the rest by historical velocity (keg = 90% history).
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([makeBrewRow("p1", WEEKS_4[0], 200)]),
    packagingDemand: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", weeklyDemandBarrels: [10, 10, 10, 10], weekStartDates: WEEKS_4 },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", weeklyDemandBarrels: [10, 10, 10, 10], weekStartDates: WEEKS_4 },
    ],
    packagingHistory: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", weeklyDemandBarrels: [90, 90, 90, 90] },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", weeklyDemandBarrels: [10, 10, 10, 10] },
    ],
    packagingInventory: [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", startingInventoryBarrels: 1000 },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", startingInventoryBarrels: 0 },
    ],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  const keg = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[0]);
  const can = findRow(plan.packagingPlan, "p1", "Case - 24x - 12oz - Can", WEEKS_4[0]);
  // Keg got mix-allocation surplus; can got its small gap fill.
  assert.equal(keg.allocation_reason, "mix_allocation");
  assert.equal(can.allocation_reason, "gap_fill");
  assert.ok(keg.allocated_bbl > can.allocated_bbl, `keg surplus should dominate (keg ${keg.allocated_bbl}, can ${can.allocated_bbl})`);
});

test("legacy: ties on gap are broken by velocity (faster mover wins)", { skip: true }, () => {
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([makeBrewRow("p1", WEEKS_4[0], 0.5)]),
    packagingDemand: [
      {
        product_id: "p1",
        packaging_format: "Keg - 1/2 bbl",
        weeklyDemandBarrels: [10, 0, 0, 0],
        weekStartDates: WEEKS_4,
      },
      {
        product_id: "p1",
        packaging_format: "Case - 6x4 - 16oz - Can",
        weeklyDemandBarrels: [10, 0, 0, 0],
        weekStartDates: WEEKS_4,
      },
    ],
    packagingHistory: [
      {
        product_id: "p1",
        packaging_format: "Keg - 1/2 bbl",
        weeklyDemandBarrels: [50, 50, 50, 50],
      },
      {
        product_id: "p1",
        packaging_format: "Case - 6x4 - 16oz - Can",
        weeklyDemandBarrels: [1, 1, 1, 1],
      },
    ],
    packagingInventory: [
      {
        product_id: "p1",
        packaging_format: "Keg - 1/2 bbl",
        startingInventoryBarrels: 0,
      },
      {
        product_id: "p1",
        packaging_format: "Case - 6x4 - 16oz - Can",
        startingInventoryBarrels: 0,
      },
    ],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  const keg = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[0]);
  const can = findRow(plan.packagingPlan, "p1", "Case - 6x4 - 16oz - Can", WEEKS_4[0]);
  assert.ok(keg.allocated_bbl >= can.allocated_bbl, "higher-velocity SKU should win when gaps are tied");
});

test("safety stock uses sigma-z method when SKU has enough nonzero history", () => {
  const result = calculatePackagingSafetyStock([10, 20, 30, 40], 95, 2, 4);
  assert.equal(result.method, "sigma_z");
  const expectedStdDev = Math.sqrt(((10 - 25) ** 2 + (20 - 25) ** 2 + (30 - 25) ** 2 + (40 - 25) ** 2) / 3);
  assert.ok(Math.abs(result.stdDev - expectedStdDev) < 1e-9);
  assert.ok(Math.abs(result.safetyStock - expectedStdDev * 1.65) < 1e-9);
});

test("safety stock falls back to weeks-of-cover when nonzero history is sparse", () => {
  const result = calculatePackagingSafetyStock([5, 0, 5, 0, 0, 0], 95, 2, 4);
  assert.equal(result.method, "weeks_of_cover_fallback");
  assert.equal(result.stdDev, 0);
  const expectedAvg = (5 + 5) / 6;
  assert.ok(Math.abs(result.safetyStock - expectedAvg * 2) < 1e-9);
});

test("sub-unit remainder is reported as negligible loss (unallocated_bbl), never over-packaged", () => {
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([makeBrewRow("p1", WEEKS_4[0], 0.4)]),
    packagingDemand: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      weeklyDemandBarrels: [10, 0, 0, 0],
      weekStartDates: WEEKS_4,
    }],
    packagingHistory: [],
    packagingInventory: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      startingInventoryBarrels: 100,
    }],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  const keg = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[0]);
  assert.equal(keg.package_units, 0);
  assert.equal(keg.allocated_bbl, 0);
  const summary = plan.weeklySummary.find((row) => row.week_start_date === WEEKS_4[0]);
  assert.ok(summary);
  assert.ok(Math.abs(summary.unallocated_bbl - 0.4) < 1e-9);
});

test("SKU with no history and no forecast receives no allocation; ready barrels stay unallocated", () => {
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([makeBrewRow("p1", WEEKS_4[0], 5)]),
    packagingDemand: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      weeklyDemandBarrels: [0, 0, 0, 0],
      weekStartDates: WEEKS_4,
    }],
    packagingHistory: [],
    packagingInventory: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      startingInventoryBarrels: 0,
    }],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  const keg = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[0]);
  assert.equal(keg.package_units, 0);
  assert.equal(keg.allocation_reason, "no_demand_share");
  const summary = plan.weeklySummary.find((row) => row.week_start_date === WEEKS_4[0]);
  assert.ok(summary);
  assert.equal(summary.unallocated_bbl, 5);
});

test("whole-units floor invariant: package_units * bbl_per_unit equals allocated_bbl", () => {
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([
      makeBrewRow("p1", WEEKS_4[0], 30),
      makeBrewRow("p1", WEEKS_4[1], 30),
    ]),
    packagingDemand: [
      {
        product_id: "p1",
        packaging_format: "Keg - 1/2 bbl",
        weeklyDemandBarrels: [20, 20, 0, 0],
        weekStartDates: WEEKS_4,
      },
      {
        product_id: "p1",
        packaging_format: "Case - 24x - 12oz - Can",
        weeklyDemandBarrels: [10, 10, 0, 0],
        weekStartDates: WEEKS_4,
      },
    ],
    packagingHistory: [],
    packagingInventory: [
      {
        product_id: "p1",
        packaging_format: "Keg - 1/2 bbl",
        startingInventoryBarrels: 0,
      },
      {
        product_id: "p1",
        packaging_format: "Case - 24x - 12oz - Can",
        startingInventoryBarrels: 0,
      },
    ],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  plan.packagingPlan.forEach((row) => {
    const expected = row.bbl_per_unit * row.package_units;
    assert.ok(
      Math.abs(row.allocated_bbl - expected) < 1e-9,
      `allocated_bbl ${row.allocated_bbl} should equal ${expected} for ${row.packaging_format} ${row.week_start_date}`,
    );
  });
});

test("inventory rolls forward: prior projected_after equals current starting_inventory", () => {
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([
      makeBrewRow("p1", WEEKS_4[0], 10),
      makeBrewRow("p1", WEEKS_4[1], 10),
      makeBrewRow("p1", WEEKS_4[2], 10),
      makeBrewRow("p1", WEEKS_4[3], 10),
    ]),
    packagingDemand: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      weeklyDemandBarrels: [5, 5, 5, 5],
      weekStartDates: WEEKS_4,
    }],
    packagingHistory: [],
    packagingInventory: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      startingInventoryBarrels: 50,
    }],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  for (let i = 1; i < WEEKS_4.length; i += 1) {
    const prior = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[i - 1]);
    const current = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[i]);
    assert.ok(
      Math.abs(prior.projected_available_after_packaging_bbl - current.starting_inventory_bbl) < 1e-9,
      `roll-forward break between ${WEEKS_4[i - 1]} and ${WEEKS_4[i]}`,
    );
  }
});

test("WIP from brew plan scheduled_receipts contributes to ready-to-package alongside planned_order_receipt", () => {
  const wipBrewRow: ProductLevelBrewPlanRow = {
    ...makeBrewRow("p1", WEEKS_4[0], 0),
    scheduled_receipts: 80,
  };
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([wipBrewRow]),
    packagingDemand: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      weeklyDemandBarrels: [10, 10, 10, 10],
      weekStartDates: WEEKS_4,
    }],
    packagingHistory: [],
    packagingInventory: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      startingInventoryBarrels: 0,
    }],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  const summary = plan.weeklySummary.find((row) => row.week_start_date === WEEKS_4[0]);
  assert.ok(summary);
  assert.equal(summary.ready_to_package_bbl, 80);
  const keg = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[0]);
  assert.ok(keg.allocated_bbl > 0, "WIP should be allocated to the keg SKU");
});

test("ready_to_package_bbl in summary matches brew plan planned_order_receipt", () => {
  const input: PackagingPlanInput = {
    brewPlan: makeBrewPlanResult([
      makeBrewRow("p1", WEEKS_4[0], 33),
      makeBrewRow("p1", WEEKS_4[1], 0),
      makeBrewRow("p1", WEEKS_4[2], 17),
    ]),
    packagingDemand: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      weeklyDemandBarrels: [10, 10, 10, 10],
      weekStartDates: WEEKS_4,
    }],
    packagingHistory: [],
    packagingInventory: [{
      product_id: "p1",
      packaging_format: "Keg - 1/2 bbl",
      startingInventoryBarrels: 0,
    }],
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: { p1: 95 },
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
  const plan = generatePackagingPlan(input);
  assert.equal(plan.weeklySummary[0].ready_to_package_bbl, 33);
  assert.equal(plan.weeklySummary[1].ready_to_package_bbl, 0);
  assert.equal(plan.weeklySummary[2].ready_to_package_bbl, 17);
  const week2 = findRow(plan.packagingPlan, "p1", "Keg - 1/2 bbl", WEEKS_4[1]);
  assert.equal(week2.allocation_reason, "no_liquid_ready");
});

test("end-to-end: real brew plan, multiple products and formats, every (product, format, week) has a row", () => {
  const brewPlan = generateBrewPlan(fixtureBrewPlanningInput);
  const productIds = ["high-volume", "low-volume-excess", "capacity-trigger"];
  const horizon = brewPlan.productLevelBrewPlan
    .filter((row) => row.product_id === productIds[0])
    .map((row) => row.week_start_date);

  const packagingDemand = productIds.flatMap((productId) => [
    {
      product_id: productId,
      packaging_format: "Keg - 1/2 bbl",
      weeklyDemandBarrels: horizon.map(() => 30),
      weekStartDates: horizon,
    },
    {
      product_id: productId,
      packaging_format: "Case - 24x - 12oz - Can",
      weeklyDemandBarrels: horizon.map(() => 15),
      weekStartDates: horizon,
    },
  ]);
  const packagingInventory = productIds.flatMap((productId) => [
    { product_id: productId, packaging_format: "Keg - 1/2 bbl", startingInventoryBarrels: 20 },
    { product_id: productId, packaging_format: "Case - 24x - 12oz - Can", startingInventoryBarrels: 10 },
  ]);

  const plan = generatePackagingPlan({
    brewPlan,
    packagingDemand,
    packagingHistory: [],
    packagingInventory,
    bblPerUnitByFormat: BBL_PER_UNIT_BY_FORMAT,
    serviceLevelByProduct: fixtureBrewPlanningInput.serviceLevelByProduct,
    generatedAt: "2026-05-04T12:00:00.000Z",
  });

  const expectedRows = productIds.length * 2 * horizon.length;
  assert.equal(plan.packagingPlan.length, expectedRows);
  assert.equal(plan.weeklySummary.length, productIds.length * horizon.length);
  assert.equal(plan.brewPlanId, brewPlan.planId);
  assert.equal(plan.forecastCycleId, brewPlan.forecastCycleId);
  assert.ok(plan.packagingPlan.every((row) => row.brew_plan_id === brewPlan.planId));
});

test("mapPackagingDemand aggregates SKU forecast rows and excludes ALL/WIP rows", () => {
  const demand = mapPackagingDemand(
    [
      { brand: "p1", packaging_format: "ALL", week_number: 1, previous_value: 50, effective_value: null },
      { brand: "p1", packaging_format: "Keg - 1/2 bbl", week_number: 1, previous_value: 10, effective_value: 12 },
      { brand: "p1", packaging_format: "Keg - 1/2 bbl", week_number: 1, previous_value: 5, effective_value: null },
      { brand: "p1", packaging_format: "WIP", week_number: 1, previous_value: 100, effective_value: null },
    ],
    WEEKS_4,
    4,
  );
  assert.equal(demand.length, 1);
  assert.equal(demand[0].weeklyDemandBarrels[0], 17);
});

test("mapPackagingHistory buckets rows by week-ago using max date as anchor", () => {
  const anchor = new Date("2026-05-04T00:00:00.000Z");
  const history = mapPackagingHistory(
    [
      { Date: anchor.toISOString(), ProductName: "p1", PackagingTypeName: "Keg - 1/2 bbl", "Sales Vol": 10 },
      { Date: new Date(anchor.getTime() - 7 * 24 * 3600 * 1000).toISOString(), ProductName: "p1", PackagingTypeName: "Keg - 1/2 bbl", "Sales Vol": 20 },
      { Date: new Date(anchor.getTime() - 14 * 24 * 3600 * 1000).toISOString(), ProductName: "p1", PackagingTypeName: "Keg - 1/2 bbl", "Sales Vol": 30 },
    ],
    [{ product_id: "p1", packaging_format: "Keg - 1/2 bbl" }],
    13,
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].weeklyDemandBarrels[0], 10);
  assert.equal(history[0].weeklyDemandBarrels[1], 20);
  assert.equal(history[0].weeklyDemandBarrels[2], 30);
});

test("mapPackagingInventory drops WIP and ALL rows", () => {
  const inv = mapPackagingInventory([
    { brand: "p1", packaging_format: "Keg - 1/2 bbl", startInv: 100 },
    { brand: "p1", packaging_format: "WIP", startInv: 50 },
    { brand: "p1", packaging_format: "ALL", startInv: 200 },
  ]);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].packaging_format, "Keg - 1/2 bbl");
  assert.equal(inv[0].startingInventoryBarrels, 100);
});

test("collectProductPackagingPairs unions demand and inventory and dedupes", () => {
  const pairs = collectProductPackagingPairs(
    [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", weeklyDemandBarrels: [], weekStartDates: [] },
      { product_id: "p1", packaging_format: "Case - 24x - 12oz - Can", weeklyDemandBarrels: [], weekStartDates: [] },
    ],
    [
      { product_id: "p1", packaging_format: "Keg - 1/2 bbl", startingInventoryBarrels: 0 },
      { product_id: "p1", packaging_format: "Single - 12oz - Can", startingInventoryBarrels: 0 },
    ],
  );
  assert.equal(pairs.length, 3);
  assert.deepEqual(
    pairs.map((p) => p.packaging_format).sort(),
    ["Case - 24x - 12oz - Can", "Keg - 1/2 bbl", "Single - 12oz - Can"],
  );
});
