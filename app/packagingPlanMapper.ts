import type {
  PackagingDemandRow,
  PackagingHistoricalRow,
  PackagingInventoryRow,
} from "./packagingPlanService.ts";

export type RawPackagingForecastRow = {
  brand: string;
  packaging_format: string;
  week_number: number;
  previous_value: number | null;
  effective_value: number | null;
};

export type RawPackagingHistoricalRow = {
  Date: string;
  ProductName: string;
  PackagingTypeName: string;
  "Sales Vol": number;
};

export type RawPackagingInventoryRow = {
  brand: string;
  packaging_format: string;
  startInv: number;
};

function effectiveForecastValue(row: RawPackagingForecastRow): number {
  return row.effective_value ?? row.previous_value ?? 0;
}

function isWipOrAll(packagingFormat: string): boolean {
  const normalized = packagingFormat.trim().toLowerCase();
  return normalized === "all" || normalized === "wip" || normalized.includes("work in progress");
}

export function mapPackagingDemand(
  rows: RawPackagingForecastRow[],
  weekStartDates: string[],
  planningHorizonWeeks = 8,
): PackagingDemandRow[] {
  const grouped = new Map<string, PackagingDemandRow>();
  const horizonWeeks = weekStartDates.slice(0, planningHorizonWeeks);

  rows.forEach((row) => {
    if (isWipOrAll(row.packaging_format)) return;
    if (row.week_number < 1 || row.week_number > planningHorizonWeeks) return;
    const key = `${row.brand}||${row.packaging_format}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        product_id: row.brand,
        packaging_format: row.packaging_format,
        weeklyDemandBarrels: Array(planningHorizonWeeks).fill(0),
        weekStartDates: horizonWeeks,
      });
    }
    grouped.get(key)!.weeklyDemandBarrels[row.week_number - 1] += effectiveForecastValue(row);
  });

  return Array.from(grouped.values()).sort(
    (a, b) =>
      a.product_id.localeCompare(b.product_id) ||
      a.packaging_format.localeCompare(b.packaging_format),
  );
}

export function mapPackagingHistory(
  rows: RawPackagingHistoricalRow[],
  productPackagingPairs: Array<{ product_id: string; packaging_format: string }>,
  lookbackWeeks = 13,
): PackagingHistoricalRow[] {
  let maxTime = 0;
  rows.forEach((row) => {
    const time = new Date(row.Date).getTime();
    if (!Number.isNaN(time) && time > maxTime) maxTime = time;
  });
  const anchorMs = maxTime > 0 ? maxTime : Date.now();
  const oneWeekMs = 7 * 24 * 3600 * 1000;
  const buckets = new Map<string, Record<number, number>>();

  rows.forEach((row) => {
    const time = new Date(row.Date).getTime();
    if (Number.isNaN(time)) return;
    const weeksAgo = Math.floor((anchorMs - time) / oneWeekMs);
    if (weeksAgo < 0 || weeksAgo >= lookbackWeeks) return;
    if (isWipOrAll(row.PackagingTypeName)) return;
    const key = `${row.ProductName}||${row.PackagingTypeName}`;
    if (!buckets.has(key)) buckets.set(key, {});
    const bucket = buckets.get(key)!;
    bucket[weeksAgo] = (bucket[weeksAgo] || 0) + (Number(row["Sales Vol"]) || 0);
  });

  return productPackagingPairs.map(({ product_id, packaging_format }) => {
    const bucket = buckets.get(`${product_id}||${packaging_format}`) ?? {};
    return {
      product_id,
      packaging_format,
      weeklyDemandBarrels: Array.from({ length: lookbackWeeks }, (_, i) => bucket[i] || 0),
    };
  });
}

export function mapPackagingInventory(
  rows: RawPackagingInventoryRow[],
): PackagingInventoryRow[] {
  return rows
    .filter((row) => !isWipOrAll(row.packaging_format))
    .map((row) => ({
      product_id: row.brand,
      packaging_format: row.packaging_format,
      startingInventoryBarrels: Number(row.startInv) || 0,
    }));
}

export function collectProductPackagingPairs(
  packagingDemand: PackagingDemandRow[],
  packagingInventory: PackagingInventoryRow[],
): Array<{ product_id: string; packaging_format: string }> {
  const seen = new Set<string>();
  const pairs: Array<{ product_id: string; packaging_format: string }> = [];
  const consider = (product_id: string, packaging_format: string) => {
    const key = `${product_id}||${packaging_format}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ product_id, packaging_format });
  };
  packagingDemand.forEach((row) => consider(row.product_id, row.packaging_format));
  packagingInventory.forEach((row) => consider(row.product_id, row.packaging_format));
  return pairs.sort(
    (a, b) =>
      a.product_id.localeCompare(b.product_id) ||
      a.packaging_format.localeCompare(b.packaging_format),
  );
}
