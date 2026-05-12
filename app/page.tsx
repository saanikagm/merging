"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { generateBrewPlan, type ProductLevelBrewPlanRow, type ServiceLevel } from "./brewPlanningService";
import {
  buildBrewPlanningInput,
  buildHistoricalDemandByProduct,
  buildWipByProduct,
  computeImpliedWipByProduct,
  isWipPackaging,
} from "./revisedBrewPlanMapper";
import { generatePackagingPlan } from "./packagingPlanService";
import {
  collectProductPackagingPairs,
  mapPackagingDemand,
  mapPackagingHistory,
  mapPackagingInventory,
} from "./packagingPlanMapper";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";

// --- TYPES ---
type DemandPlanRow = {
  id: string; brand: string; channel: string; packaging_format: string;
  week_number: number; year: number; previous_value: number | null;
  effective_value: number | null; session_id: string;
  override_rationale?: string | null;
};

type HistoricalRow = {
  Date: string; ProductName: string; Channel: string;
  PackagingTypeName: string; "Sales Vol": number;
};

type PivotRow = {
  key: string; brand: string; channel: string; packaging_format: string;
  Week1: number | null; Week2: number | null; Week3: number | null; Week4: number | null;
  Week5: number | null; Week6: number | null; Week7: number | null; Week8: number | null;
};

type ProductLevelRow = {
  brand: string;
  Week1: number; Week2: number; Week3: number; Week4: number;
  Week5: number; Week6: number; Week7: number; Week8: number;
};

type InventoryRow = {
  name: string; startInv: number; originalStartInv: number; baseSafetyStock: number; finalSS: number;
};

type RevisedServiceLevel = ServiceLevel;

type PackagingInventoryRow = {
  brand: string;
  packaging_format: string;
  startInv: number;
};

type PendingAudit = {
  context: "demand" | "inventory" | "brewing";
  brand: string;
  newValue: string;
  demandPivotRow?: PivotRow;
  weekNumber?: number;
  inventoryField?: "startInv" | "finalSS";
};

const TABS = ["Overview", "Forecasted Demand", "Inventory", "Brewing Plan", "Packaging Plan", "Plan Summary"] as const;
type TabName = (typeof TABS)[number];

// --- HELPER MATH ---
function getEffectiveOrForecast(row: DemandPlanRow) { return row.effective_value ?? row.previous_value ?? 0; }
function formatNumber(value: number | null | undefined) { return value == null ? "" : Number(value).toFixed(2).replace(/\.00$/, ""); }
const REVISED_SERVICE_LEVELS: RevisedServiceLevel[] = [90, 95, 96, 99, 99.9];
const REVISED_SAFETY_FACTORS: Record<RevisedServiceLevel, number> = { 90: 1.28, 95: 1.65, 96: 1.75, 99: 2.33, 99.9: 4.00 };
const LONG_LOOKBACK_PRODUCTS = ["the pupil", "pupil", "bulbous flowers"];

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function usesLongSafetyStockLookback(product: string): boolean {
  const normalized = product.trim().toLowerCase();
  return LONG_LOOKBACK_PRODUCTS.some((name) => normalized === name || normalized.includes(name));
}

// --- UNIT CONVERSION (BBL → CE & PHYSICAL UNITS) ---
const CE_PER_BBL_DEFAULT = 13.78;
const PACKAGING_CONVERSIONS: Record<string, { bblPerUnit: number; cePerUnit: number }> = {
  "Keg - 50L": { bblPerUnit: 0.426, cePerUnit: 5.87 },
  "Keg - 20L - Petainer": { bblPerUnit: 0.168, cePerUnit: 2.32 },
  "Keg - GCT - One Way": { bblPerUnit: 0.167, cePerUnit: 2.30 },
  "Keg - Sixtel": { bblPerUnit: 0.167, cePerUnit: 2.30 },
  "Keg - GCT Sixtel": { bblPerUnit: 0.167, cePerUnit: 2.30 },
  "Case - 6x4 - 16oz - Can": { bblPerUnit: 0.097, cePerUnit: 1.34 },
  "Case - 24x - 12oz - Can": { bblPerUnit: 0.073, cePerUnit: 1.00 },
  "Case - 6x4 - 12oz - Can": { bblPerUnit: 0.073, cePerUnit: 1.00 },
  "Case - 4x6 - 12oz - Can": { bblPerUnit: 0.073, cePerUnit: 1.00 },
  "Single - 12oz - Can": { bblPerUnit: 0.073, cePerUnit: 1.00 },
  "Case - 12x - 19.2oz - Can": { bblPerUnit: 0.058, cePerUnit: 0.80 },
  "Case - 12x - 16oz - Can": { bblPerUnit: 0.048, cePerUnit: 0.66 },
  "Keg - 1/2 bbl": { bblPerUnit: 0.500, cePerUnit: 6.89 },
  "Keg - 1/4 bbl": { bblPerUnit: 0.250, cePerUnit: 3.45 },
  "Keg - 1/6 bbl": { bblPerUnit: 0.167, cePerUnit: 2.30 },
  "Keg - 1/2 BBL KLPPF": { bblPerUnit: 0.500, cePerUnit: 6.89 },
  "Keg - 1/6 BBL KLPPF": { bblPerUnit: 0.167, cePerUnit: 2.30 },
  "Case - 2x12 - 12oz - Can": { bblPerUnit: 0.073, cePerUnit: 1.00 },
  "Case - 12x - 500ml - Bottle": { bblPerUnit: 0.051, cePerUnit: 0.70 },
  "Case - 24x - 16oz - Can": { bblPerUnit: 0.097, cePerUnit: 1.34 },
  "Single - Magnum 1.5 L": { bblPerUnit: 0.013, cePerUnit: 0.18 },
};

const CE_PER_BBL: Record<string, number> = Object.fromEntries(
  Object.entries(PACKAGING_CONVERSIONS).map(([packaging, conversion]) => [
    packaging,
    conversion.cePerUnit / conversion.bblPerUnit,
  ])
);

function convertBblTo(value: number, packaging: string, unit: "BBL" | "CE"): number {
  if (unit === "BBL") return value;
  const ratio = CE_PER_BBL[packaging] ?? CE_PER_BBL_DEFAULT;
  return value * ratio;
}

function parseVolume(value: unknown): number {
  const parsed = Number(String(value ?? 0).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getRecordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

function getProductName(record: Record<string, unknown>): string {
  return String(getRecordValue(record, [
    "ProductName",
    "Product Name",
    "product_name",
    "brand",
    "Brand",
    "Product",
  ]) || "Unknown").trim();
}

function getPackagingName(record: Record<string, unknown>): string {
  return String(getRecordValue(record, [
    "PackagingTypeName",
    "packaging_format",
    "packaging",
    "Packaging",
    "Package",
    "Package Type",
    "Packaging Type",
  ]) || "").trim();
}

function isWipRow(record: Record<string, unknown>): boolean {
  const flag = String(record.WIP ?? record.wip ?? "").trim().toLowerCase();
  if (flag === "wip" || flag === "true" || flag === "yes" || flag === "1") return true;
  return isWipPackaging(getPackagingName(record));
}

function getInventoryVolume(record: Record<string, unknown>): number {
  return parseVolume(getRecordValue(record, [
    "Inventory Volume",
    "InventoryVolume",
    "inventory_volume",
    "startInv",
    "starting_inventory",
    "inventory_bbl",
    "inventory",
    "On Hand",
    "On Hand BBL",
  ]));
}

function getZRatio(serviceLevel: number): number {
  if (serviceLevel === 99) return 2.33 / 1.645;
  if (serviceLevel === 95) return 1.0;
  if (serviceLevel === 90) return 1.28 / 1.645;
  if (serviceLevel === 85) return 1.04 / 1.645;
  return 1.0;
}

function csvEscape(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsvFile(filename: string, lines: string[]) {
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function fetchWipScheduleAligned(
  apiUrl: string,
  apiKey: string,
  weekStartDates: string[],
): Promise<Record<string, number[]>> {
  try {
    const url = `${apiUrl}/wip-schedule?week_dates=${encodeURIComponent(weekStartDates.join(","))}`;
    const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
    if (!res.ok) return {};
    const json = await res.json();
    const rows: Array<{ product_name: string; week_start_date: string; bbl: number }> = json.rows || [];
    const aligned: Record<string, number[]> = {};
    rows.forEach((r) => {
      const idx = weekStartDates.indexOf(r.week_start_date);
      if (idx < 0) return;
      const bbl = Number(r.bbl);
      if (!Number.isFinite(bbl) || bbl <= 0) return;
      if (!aligned[r.product_name]) aligned[r.product_name] = Array(weekStartDates.length).fill(0);
      aligned[r.product_name][idx] += bbl;
    });
    return aligned;
  } catch {
    return {};
  }
}

function getNextMonday(fromDate = new Date()) {
  const date = new Date(fromDate);
  const day = date.getDay();
  if (day === 1) { date.setHours(0, 0, 0, 0); return date; }
  date.setDate(date.getDate() + (day === 0 ? 1 : 8 - day));
  date.setHours(0, 0, 0, 0);
  return date;
}
function formatWeekLabel(date: Date) { return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); }

// --- MAIN COMPONENT ---
export default function Home() {
  const [activeTab, setActiveTab] = useState<TabName>("Overview");
  const [rows, setRows] = useState<DemandPlanRow[]>([]);
  const [historicalRows, setHistoricalRows] = useState<HistoricalRow[]>([]);
  const [inventoryDB, setInventoryDB] = useState<InventoryRow[]>([]);
  const [packagingInventoryDB, setPackagingInventoryDB] = useState<PackagingInventoryRow[]>([]);
  const [wipScheduleByProductWeek, setWipScheduleByProductWeek] = useState<Record<string, number[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [sessionId, setSessionId] = useState("");
  const [latestForecastDate, setLatestForecastDate] = useState<string | null>(null);
  const [showDemandContent, setShowDemandContent] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateStartedAt, setGenerateStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(0);

  useEffect(() => {
    if (!isGenerating) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isGenerating]);

  const [productFilter, setProductFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [packagingFilter, setPackagingFilter] = useState("");
  const [demandViewLevel, setDemandViewLevel] = useState<"packaging" | "product">("product");
  const [unitMode, setUnitMode] = useState<"BBL" | "CE">("BBL");

  type PlanWorkflow = {
    demandLockedAt: string | null;
    inventoryLockedAt: string | null;
    brewingLockedAt: string | null;
  };
  const PLAN_WORKFLOW_KEY = "planWorkflow";
  const emptyPlanWorkflow: PlanWorkflow = { demandLockedAt: null, inventoryLockedAt: null, brewingLockedAt: null };
  const [planWorkflow, setPlanWorkflow] = useState<PlanWorkflow>(emptyPlanWorkflow);
  const [showLockDemandModal, setShowLockDemandModal] = useState(false);
  const [showLockInventoryModal, setShowLockInventoryModal] = useState(false);
  const [showLockBrewingModal, setShowLockBrewingModal] = useState(false);

  const QUICK_START_KEY = "quickStartSeen";
  const [showQuickStart, setShowQuickStart] = useState(false);
  const [quickStartStep, setQuickStartStep] = useState(0);

  useEffect(() => {
    try {
      if (!localStorage.getItem(QUICK_START_KEY)) setShowQuickStart(true);
    } catch {}
  }, []);

  const QUICK_START_STEPS: Array<{ title: string; body: string }> = [
    {
      title: "Welcome to the Brewery Planning App",
      body: "This tool helps you build a weekly Sales, Inventory & Operations plan. You'll move through five tabs in order: Overview, Forecasted Demand, Inventory, Brewing Plan, and Packaging Plan. Each stage locks before the next one starts.",
    },
    {
      title: "Step 1 — Overview",
      body: "The Overview tab gives you a read-only snapshot: a yearly demand comparison chart and high-level metrics. Start here to orient yourself before making any changes.",
    },
    {
      title: "Step 2 — Forecasted Demand",
      body: "Click Load Latest Forecast to pull the most recent plan, or Generate New Forecast to run a fresh one (20–30 min, runs on the server — safe to close the tab). Edit any cell to override, with an audit reason. When finished, click Lock Demand Plan.",
    },
    {
      title: "Step 3 — Inventory",
      body: "Starting inventory is pulled live from Tableau. Adjust the global service level or override safety stock values per product. Click Refresh Inventory from Tableau for fresh numbers any time. Click Lock Inventory Plan when ready.",
    },
    {
      title: "Step 4 — Brewing Plan",
      body: "See weekly facility load at the top, per-product brew schedule below. Use the dropdown to open a specific product and fine-tune individual brews — zero out small ones, shift timing, or override any planned quantity.",
    },
    {
      title: "Step 5 — Packaging Plan",
      body: "Select a brand to translate beer ready from the Brewing Plan into whole-unit package work orders. The plan rolls current packaged inventory forward, uses SKU-level demand targets, and drains ready tanks into the fastest-moving packages when needed.",
    },
    {
      title: "Starting a new plan",
      body: "To start over any time, go back to Forecasted Demand and click Load Latest Forecast or Generate New Forecast. A confirmation will clear all locks and edits. You can reopen this guide any time from the Quick Start button at the top.",
    },
  ];

  function closeQuickStart() {
    setShowQuickStart(false);
    setQuickStartStep(0);
    try { localStorage.setItem(QUICK_START_KEY, "1"); } catch {}
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PLAN_WORKFLOW_KEY);
      if (raw) setPlanWorkflow(JSON.parse(raw));
    } catch {}
  }, []);

  function persistPlanWorkflow(next: PlanWorkflow) {
    setPlanWorkflow(next);
    try { localStorage.setItem(PLAN_WORKFLOW_KEY, JSON.stringify(next)); } catch {}
  }

  const [refreshingInventory, setRefreshingInventory] = useState(false);
  const [inventoryLastRefreshedAt, setInventoryLastRefreshedAt] = useState<string | null>(null);
  const [inventoryRefreshError, setInventoryRefreshError] = useState("");

  async function refreshInventoryFromTableau() {
    if (refreshingInventory) return;
    setRefreshingInventory(true);
    setInventoryRefreshError("");
    try {
      const apiUrl = process.env.NEXT_PUBLIC_FORECAST_API_URL || "http://localhost:8000";
      const apiKey = process.env.NEXT_PUBLIC_FORECAST_API_KEY || "";
      const invRes = await fetch(`${apiUrl}/inventory`, { headers: { "X-API-Key": apiKey } });
      if (!invRes.ok) throw new Error(`Inventory fetch failed: ${invRes.status}`);
      const invJson = await invRes.json();
      const tableauRows: Array<Record<string, string>> = invJson.rows || [];
      const totalsByProduct: Record<string, number> = {};
      const packagingTotals: Record<string, PackagingInventoryRow> = {};
      tableauRows.forEach((r) => {
        const name = getProductName(r);
        const packaging = getPackagingName(r);
        const vol = getInventoryVolume(r);
        if (!Number.isFinite(vol)) return;
        if (!isWipRow(r)) totalsByProduct[name] = (totalsByProduct[name] || 0) + vol;
        if (packaging && packaging !== "ALL") {
          const key = `${name}||${packaging}`;
          packagingTotals[key] ||= { brand: name, packaging_format: packaging, startInv: 0 };
          packagingTotals[key].startInv += vol;
        }
      });
      setInventoryDB((prev) => {
        const existingNames = new Set(prev.map((item) => item.name));
        const updated = prev.map((item) => {
          const fresh = totalsByProduct[item.name];
          if (fresh === undefined) return item;
          const rounded = Number(fresh.toFixed(2));
          return { ...item, startInv: rounded, originalStartInv: rounded };
        });
        Object.entries(totalsByProduct).forEach(([name, total]) => {
          if (name === "Unknown" || existingNames.has(name)) return;
          const rounded = Number(total.toFixed(2));
          updated.push({ name, startInv: rounded, originalStartInv: rounded, baseSafetyStock: 0, finalSS: 0 });
        });
        return updated.sort((a, b) => a.name.localeCompare(b.name));
      });
      setPackagingInventoryDB(Object.values(packagingTotals).map((item) => ({
        ...item,
        startInv: Number(item.startInv.toFixed(2)),
      })).sort((a, b) => a.brand.localeCompare(b.brand) || a.packaging_format.localeCompare(b.packaging_format)));
      const wip = await fetchWipScheduleAligned(apiUrl, apiKey, weekStartDates);
      setWipScheduleByProductWeek(wip);
      setInventoryLastRefreshedAt(new Date().toISOString());
    } catch (e) {
      console.error("Inventory refresh failed:", e);
      setInventoryRefreshError(e instanceof Error ? e.message : "Inventory refresh failed.");
      alert("Failed to refresh inventory from Tableau. See console for details.");
    } finally {
      setRefreshingInventory(false);
    }
  }

  function lockDemandPlan() {
    persistPlanWorkflow({ ...planWorkflow, demandLockedAt: new Date().toISOString() });
    setShowLockDemandModal(false);
    setActiveTab("Inventory");
  }

  function lockInventoryPlan() {
    persistPlanWorkflow({ ...planWorkflow, inventoryLockedAt: new Date().toISOString() });
    setShowLockInventoryModal(false);
    setActiveTab("Brewing Plan");
  }

  function lockBrewingPlan() {
    persistPlanWorkflow({ ...planWorkflow, brewingLockedAt: new Date().toISOString() });
    setShowLockBrewingModal(false);
    setActiveTab("Packaging Plan");
  }

  async function resetPlanWorkflow() {
    persistPlanWorkflow(emptyPlanWorkflow);
    setInventoryDB((prev) => prev.map((item) => ({
      ...item,
      startInv: item.originalStartInv,
      finalSS: item.baseSafetyStock,
    })));
    setManualBrewPlan({});
    if (sessionId) {
      const { error: resetErr } = await supabase
        .from("demand_plans")
        .update({ effective_value: null, override_rationale: null })
        .eq("session_id", sessionId);
      if (resetErr) {
        console.error("Failed to reset demand overrides:", resetErr.message);
        return;
      }
      setRows((prev) => prev.map((r) => ({ ...r, effective_value: null })));
    }
  }

  const hasAnyLock = !!(planWorkflow.demandLockedAt || planWorkflow.inventoryLockedAt || planWorkflow.brewingLockedAt);
  const [showResetModal, setShowResetModal] = useState(false);
  const [pendingResetAction, setPendingResetAction] = useState<null | (() => void)>(null);

  function requestResetThen(action: () => void) {
    if (hasAnyLock) {
      setPendingResetAction(() => action);
      setShowResetModal(true);
    } else {
      action();
    }
  }

  function formatLockedAt(iso: string): string {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  const [chartBrand, setChartBrand] = useState("");
  const [chartChannel, setChartChannel] = useState("");
  const [chartPackaging, setChartPackaging] = useState("");
  const demandChartRef = useRef<HTMLDivElement>(null);

  // Operations States
  const [globalServiceLevel, setGlobalServiceLevel] = useState<RevisedServiceLevel>(95);
  const [selectedOpsProduct, setSelectedOpsProduct] = useState("");
  const [manualBrewPlan, setManualBrewPlan] = useState<Record<string, Record<number, number>>>({});

  // Universal Audit State
  const [pendingEdit, setPendingEdit] = useState<PendingAudit | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [cancelTick, setCancelTick] = useState(0);

  // --- DATA FETCHING ---
  async function fetchLatestSession() {
    try {
      const { data, error } = await supabase
        .from("planning_sessions")
        .select("id, created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }

      if (data) {
        setSessionId(data.id);
        setLatestForecastDate(
          new Date(data.created_at).toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        );
      } else {
        setError("No planning session found. Create or load forecast data first.");
        setLoading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load latest session.");
      setLoading(false);
    }
  }

  async function handleGenerateForecast() {
    if (isGenerating) return;
    setIsGenerating(true);
    setGenerateStartedAt(Date.now());
    setError("");
    try {
      const apiUrl = process.env.NEXT_PUBLIC_FORECAST_API_URL || "http://localhost:8000";
      const apiKey = process.env.NEXT_PUBLIC_FORECAST_API_KEY || "";
      const startRes = await fetch(`${apiUrl}/run-forecast`, {
        method: "POST",
        headers: { "X-API-Key": apiKey },
      });
      if (!startRes.ok) throw new Error(`Forecast failed to start: ${startRes.status}`);
      const startJson = await startRes.json();
      const jobId: string = startJson.job_id;
      if (!jobId) throw new Error("No job_id returned");

      while (true) {
        await new Promise((r) => setTimeout(r, 10_000));
        const statusRes = await fetch(`${apiUrl}/forecast-status/${jobId}`, {
          headers: { "X-API-Key": apiKey },
        });
        if (!statusRes.ok) continue;
        const statusJson = await statusRes.json();
        if (statusJson.status === "done") {
          await fetchLatestSession();
          setShowDemandContent(true);
          return;
        }
        if (statusJson.status === "error") {
          throw new Error(statusJson.error || "Forecast job failed");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate forecast.");
    } finally {
      setIsGenerating(false);
      setGenerateStartedAt(null);
    }
  }

  function formatElapsed(ms: number): string {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${s}s`;
  }

  useEffect(() => {
    fetchLatestSession();
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    async function loadData() {
      setLoading(true);

      const fetchedDemand: DemandPlanRow[] = [];
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const { data, error: demandErr } = await supabase
          .from("demand_plans")
          .select("*")
          .eq("session_id", sessionId)
          .range(from, from + pageSize - 1);
        if (demandErr) { setError(demandErr.message); setLoading(false); return; }
        const batch = (data || []) as DemandPlanRow[];
        fetchedDemand.push(...batch);
        if (batch.length < pageSize) break;
      }
      setRows(fetchedDemand);

      const fetchedHist: HistoricalRow[] = [];
      for (let from = 0; ; from += pageSize) {
        const { data: histData, error: histErr } = await supabase
          .from("societehistoricaldemand")
          .select("*")
          .range(from, from + pageSize - 1);
        if (histErr) { console.error("Historical fetch error:", histErr.message); break; }
        const batch = (histData || []) as HistoricalRow[];
        fetchedHist.push(...batch);
        if (batch.length < pageSize) break;
      }
      setHistoricalRows(fetchedHist);

      const { data: invData, error: invErr } = await supabase.from("inventory").select("*");
      if (invErr) { console.error("Inventory fetch error:", invErr.message); }
      const rawInv = invData || [];

      const totalsByProduct: Record<string, number> = {};
      const ssByProduct: Record<string, number> = {};
      const packagingTotals: Record<string, PackagingInventoryRow> = {};

      rawInv.forEach((item: Record<string, unknown>) => {
          const name = getProductName(item);
          const packaging = getPackagingName(item);
          const startVol = getInventoryVolume(item);
          const ssVol = parseVolume(item.finalSS ?? item.safetyStock ?? item.safety_stock ?? item.baseSafetyStock ?? 10);

          if (Number.isFinite(startVol) && !isWipRow(item)) totalsByProduct[name] = startVol;
          if (Number.isFinite(ssVol)) ssByProduct[name] = ssVol;
          if (packaging && packaging !== "ALL" && Number.isFinite(startVol)) {
            const key = `${name}||${packaging}`;
            packagingTotals[key] ||= { brand: name, packaging_format: packaging, startInv: 0 };
            packagingTotals[key].startInv += startVol;
          }
      });

      try {
        const apiUrl = process.env.NEXT_PUBLIC_FORECAST_API_URL || "http://localhost:8000";
        const apiKey = process.env.NEXT_PUBLIC_FORECAST_API_KEY || "";
        if (apiUrl) {
            const invRes = await fetch(`${apiUrl}/inventory`, { headers: { "X-API-Key": apiKey } });
            if (invRes.ok) {
                const invJson = await invRes.json();
                const tableauRows: Array<Record<string, string>> = invJson.rows || [];
                const tableauTotals: Record<string, number> = {};
                const tableauPackagingTotals: Record<string, PackagingInventoryRow> = {};
                tableauRows.forEach((r) => {
                  const name = getProductName(r);
                  const packaging = getPackagingName(r);
                  const vol = getInventoryVolume(r);
                  if (Number.isFinite(vol) && !isWipRow(r)) tableauTotals[name] = (tableauTotals[name] || 0) + vol;
                  if (packaging && packaging !== "ALL" && Number.isFinite(vol)) {
                    const key = `${name}||${packaging}`;
                    tableauPackagingTotals[key] ||= { brand: name, packaging_format: packaging, startInv: 0 };
                    tableauPackagingTotals[key].startInv += vol;
                  }
                });
                Object.entries(tableauTotals).forEach(([name, total]) => {
                  totalsByProduct[name] = total;
                });
                Object.keys(packagingTotals).forEach((key) => {
                  delete packagingTotals[key];
                });
                Object.entries(tableauPackagingTotals).forEach(([key, value]) => {
                  packagingTotals[key] = value;
                });
            }
        }
      } catch (e) {
        console.log("External API offline or unavailable. Using Supabase inventory.");
      }

      let maxTime = 0;
      fetchedHist.forEach((r) => {
        const t = new Date(r.Date).getTime();
        if (!Number.isNaN(t) && t > maxTime) maxTime = t;
      });
      const anchorMs = maxTime > 0 ? maxTime : Date.now();
      const ONE_WEEK_MS = 7 * 24 * 3600 * 1000;

      const weeklyHistory: Record<string, Record<number, number>> = {};
      fetchedHist.forEach((r) => {
        const t = new Date(r.Date).getTime();
        if (Number.isNaN(t)) return;

        const weeksAgo = Math.floor((anchorMs - t) / ONE_WEEK_MS);
        if (weeksAgo < 0) return;

        const name = r.ProductName || "Unknown";
        weeklyHistory[name] ||= {};
        weeklyHistory[name][weeksAgo] = (weeklyHistory[name][weeksAgo] || 0) + (Number(r["Sales Vol"]) || 0);
      });

      function baseSSFor(product: string): number {
        const buckets = weeklyHistory[product] || {};

        let recentTotal = 0;
        for (let i = 0; i < 13; i++) {
            recentTotal += buckets[i] || 0;
        }
        const recentAvg = recentTotal / 13;
        const isLowVolume = recentAvg < 2.0;
        const lookbackWindow = isLowVolume ? 13 : 52;

        const valuesWindow: number[] = [];
        for (let i = 0; i < lookbackWindow; i++) {
            valuesWindow.push(buckets[i] || 0);
        }

        const sigma = stdDev(valuesWindow);
        const baselineSafetyStock = sigma * 1.645;
        return Number(baselineSafetyStock.toFixed(2));
      }

      const initialInv = Object.entries(totalsByProduct).map(([name, total]) => {
        const base = baseSSFor(name);
        return {
          name,
          startInv: Number(total.toFixed(2)),
          originalStartInv: Number(total.toFixed(2)),
          baseSafetyStock: base,
          finalSS: base,
        };
      });

      const uniqueDemandBrands = [...new Set(fetchedDemand.map(r => r.brand))];
      uniqueDemandBrands.forEach(brand => {
          if (!initialInv.find(i => i.name === brand)) {
              const base = baseSSFor(brand);
              initialInv.push({ name: brand, startInv: 0, originalStartInv: 0, baseSafetyStock: base, finalSS: base });
          }
      });

      const sortedInv = initialInv.sort((a,b) => a.name.localeCompare(b.name));
      setInventoryDB(sortedInv);
      setPackagingInventoryDB(Object.values(packagingTotals).map((item) => ({
        ...item,
        startInv: Number(item.startInv.toFixed(2)),
      })).sort((a, b) => a.brand.localeCompare(b.brand) || a.packaging_format.localeCompare(b.packaging_format)));
      if (sortedInv.length > 0) setSelectedOpsProduct(sortedInv[0].name);

      try {
        const apiUrl = process.env.NEXT_PUBLIC_FORECAST_API_URL || "http://localhost:8000";
        const apiKey = process.env.NEXT_PUBLIC_FORECAST_API_KEY || "";
        const wip = await fetchWipScheduleAligned(apiUrl, apiKey, weekStartDates);
        setWipScheduleByProductWeek(wip);
      } catch (e) {
        console.log("WIP schedule fetch failed; falling back to implied WIP:", e);
      }

      setLoading(false);
    }
    loadData();
  }, [sessionId]);

  const products = useMemo(() => [...new Set([...rows.map(r => r.brand), ...inventoryDB.map(i => i.name)])].filter(Boolean).sort(), [rows, inventoryDB]);
  const channels = useMemo(() => [...new Set(rows.map((r) => r.channel))].sort(), [rows]);
  const packagingFormats = useMemo(() => [...new Set(rows.map((r) => r.packaging_format))].sort(), [rows]);

  const filteredRows = useMemo(() => rows.filter((row) => (!productFilter || row.brand === productFilter) && (!channelFilter || row.channel === channelFilter) && (!packagingFilter || row.packaging_format === packagingFilter)), [rows, productFilter, channelFilter, packagingFilter]);

  const weekLabels = useMemo(() => Array.from({ length: 8 }, (_, i) => { const d = new Date(getNextMonday()); d.setDate(d.getDate() + i * 7); return formatWeekLabel(d); }), []);
  const weekStartDates = useMemo(() => Array.from({ length: 8 }, (_, i) => { const d = new Date(getNextMonday()); d.setDate(d.getDate() + i * 7); return d.toISOString().slice(0, 10); }), []);

  const BREW_DISPLAY_WEEKS = 6;
  const BREW_LEAD_TIME_WEEKS = 2;
  const BREW_BATCH_SIZE = 50;
  const PACKAGING_DISPLAY_WEEKS = 4;

  const chartData = useMemo(() => {
    const map: Record<number, { week: string; forecast: number; effective: number }> = {};
    for (let w = 1; w <= 8; w++) map[w] = { week: weekLabels[w - 1], forecast: 0, effective: 0 };
    filteredRows.forEach((r) => {
      if (r.week_number >= 1 && r.week_number <= 8) {
        map[r.week_number].forecast += r.previous_value ?? 0;
        map[r.week_number].effective += getEffectiveOrForecast(r);
      }
    });
    return Object.values(map);
  }, [filteredRows, weekLabels]);

  const demandChartData = useMemo(() => {
    const toDateKey = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    const normalize = (raw: string) => {
      if (!raw) return "";
      const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (slash) {
        const [, m, d, y] = slash;
        return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      }
      const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return iso[0];
      const dt = new Date(raw);
      if (isNaN(dt.getTime())) return "";
      return toDateKey(dt);
    };

    const histDateSet = new Set<string>();
    historicalRows.forEach((r) => {
      const k = normalize(r.Date);
      if (k) histDateSet.add(k);
    });
    const sortedHistDates = Array.from(histDateSet).sort();
    const usableHistDates = sortedHistDates.slice(0, -1);

    let histEnd: Date | null = null;
    if (usableHistDates.length > 0) {
      const last = usableHistDates[usableHistDates.length - 1];
      const [y, m, d] = last.split("-").map(Number);
      histEnd = new Date(y, m - 1, d);
      histEnd.setHours(0, 0, 0, 0);
    }
    const forecastStart = histEnd
      ? (() => { const d = new Date(histEnd); d.setDate(d.getDate() + 7); return d; })()
      : getNextMonday();

    const data: Array<{ week: string; historical: number | null; forecastOriginal: number | null; forecastAdjusted: number | null }> = [];

    if (histEnd) {
      for (let i = 7; i >= 0; i--) {
        const d = new Date(histEnd);
        d.setDate(d.getDate() - i * 7);
        const key = toDateKey(d);
        let total = 0;
        historicalRows.forEach((r) => {
          if (normalize(r.Date) !== key) return;
          if (chartBrand && r.ProductName !== chartBrand) return;
          if (demandViewLevel === "packaging") {
            if (chartChannel && r.Channel !== chartChannel) return;
            if (chartPackaging && r.PackagingTypeName !== chartPackaging) return;
          }
          const bbl = Number(r["Sales Vol"]) || 0;
          total += convertBblTo(bbl, r.PackagingTypeName, unitMode);
        });
        data.push({ week: formatWeekLabel(d), historical: total, forecastOriginal: null, forecastAdjusted: null });
      }
    }

    const scoped = rows.filter((r) => {
      const levelMatch = demandViewLevel === "product"
        ? r.packaging_format === "ALL"
        : r.packaging_format !== "ALL";
      if (!levelMatch) return false;
      if (chartBrand && r.brand !== chartBrand) return false;
      if (chartChannel && r.channel !== chartChannel) return false;
      if (chartPackaging && r.packaging_format !== chartPackaging) return false;
      return true;
    });
    let hasOverrides = false;
    for (let w = 1; w <= 8; w++) {
      const d = new Date(forecastStart);
      d.setDate(d.getDate() + (w - 1) * 7);
      let original = 0;
      let adjusted = 0;
      scoped.forEach((r) => {
        if (r.week_number === w) {
          original += convertBblTo(r.previous_value ?? 0, r.packaging_format, unitMode);
          adjusted += convertBblTo(getEffectiveOrForecast(r), r.packaging_format, unitMode);
          if (r.effective_value != null && r.effective_value !== r.previous_value) hasOverrides = true;
        }
      });
      data.push({ week: formatWeekLabel(d), historical: null, forecastOriginal: original, forecastAdjusted: adjusted });
    }
    return { data, hasOverrides };
  }, [rows, historicalRows, demandViewLevel, chartBrand, chartChannel, chartPackaging, unitMode]);

  const yearlyComparisonChart = useMemo(() => {
    const byYearWeek: Record<number, Record<number, number>> = {};
    const lastWeekByYear: Record<number, number> = {};
    historicalRows.forEach((r) => {
      const d = new Date(r.Date);
      if (Number.isNaN(d.getTime())) return;
      const year = d.getUTCFullYear();
      const start = Date.UTC(year, 0, 1);
      const week = Math.min(52, Math.floor((d.getTime() - start) / (7 * 24 * 3600 * 1000)) + 1);
      byYearWeek[year] ||= {};
      byYearWeek[year][week] = (byYearWeek[year][week] || 0) + (Number(r["Sales Vol"]) || 0);
      lastWeekByYear[year] = Math.max(lastWeekByYear[year] || 0, week);
    });
    const years = Object.keys(byYearWeek).map(Number).sort((a, b) => a - b);
    if (years.length > 0) {
      const latest = years[years.length - 1];
      lastWeekByYear[latest] = Math.max(0, (lastWeekByYear[latest] || 0) - 1);
    }
    const data = Array.from({ length: 52 }, (_, i) => {
      const week = i + 1;
      const row: Record<string, number | string | null> = { week };
      years.forEach((y) => {
        row[String(y)] = week > lastWeekByYear[y] ? null : (byYearWeek[y][week] || 0);
      });
      return row;
    });
    return { data, years };
  }, [historicalRows]);

  const pivotRows = useMemo(() => {
    const grouped: Record<string, PivotRow> = {};
    const scopedRows = filteredRows.filter((r) =>
      demandViewLevel === "product"
        ? r.packaging_format === "ALL"
        : r.packaging_format !== "ALL"
    );
    scopedRows.forEach((r) => {
      const key = `${r.brand}||${r.channel}||${r.packaging_format}`;
      if (!grouped[key]) grouped[key] = { key, brand: r.brand, channel: r.channel, packaging_format: r.packaging_format, Week1: null, Week2: null, Week3: null, Week4: null, Week5: null, Week6: null, Week7: null, Week8: null };
      if (r.week_number >= 1 && r.week_number <= 8) grouped[key][`Week${r.week_number}` as keyof PivotRow] = getEffectiveOrForecast(r) as never;
    });
    const isAllZero = (r: PivotRow) =>
      [1, 2, 3, 4, 5, 6, 7, 8].every((w) => {
        const v = r[`Week${w}` as keyof PivotRow];
        return v == null || Number(v) === 0;
      });
    return Object.values(grouped).sort((a, b) => {
      const az = isAllZero(a), bz = isAllZero(b);
      if (az !== bz) return az ? 1 : -1;
      return a.brand.localeCompare(b.brand);
    });
  }, [filteredRows, demandViewLevel]);

  const productLevelRows = useMemo(() => {
    const grouped: Record<string, ProductLevelRow> = {};
    rows.forEach((r) => {
      if (r.packaging_format !== "ALL") return;
      if (!grouped[r.brand]) grouped[r.brand] = { brand: r.brand, Week1: 0, Week2: 0, Week3: 0, Week4: 0, Week5: 0, Week6: 0, Week7: 0, Week8: 0 };
      if (r.week_number >= 1 && r.week_number <= 8) (grouped[r.brand][`Week${r.week_number}` as keyof ProductLevelRow] as number) += getEffectiveOrForecast(r);
    });
    const brandsWithAll = new Set(Object.keys(grouped));
    rows.forEach((r) => {
      if (r.packaging_format === "ALL") return;
      if (brandsWithAll.has(r.brand)) return;
      if (!grouped[r.brand]) grouped[r.brand] = { brand: r.brand, Week1: 0, Week2: 0, Week3: 0, Week4: 0, Week5: 0, Week6: 0, Week7: 0, Week8: 0 };
      if (r.week_number >= 1 && r.week_number <= 8) (grouped[r.brand][`Week${r.week_number}` as keyof ProductLevelRow] as number) += getEffectiveOrForecast(r);
    });
    return Object.values(grouped).sort((a, b) => a.brand.localeCompare(b.brand));
  }, [rows]);

  const enrichedInventoryDB = useMemo(() => {
    return inventoryDB.map(inv => {
        const prod = productLevelRows.find(p => p.brand === inv.name);
        const totalD = prod ? (prod.Week1 + prod.Week2 + prod.Week3 + prod.Week4 + prod.Week5 + prod.Week6 + prod.Week7 + prod.Week8) : 0;
        return { ...inv, avgDemand: totalD / 8 };
    });
  }, [productLevelRows, inventoryDB]);

  const revisedSafetyStatsByProduct = useMemo(() => {
    let maxTime = 0;
    historicalRows.forEach((r) => {
      const t = new Date(r.Date).getTime();
      if (!Number.isNaN(t) && t > maxTime) maxTime = t;
    });
    const anchorMs = maxTime > 0 ? maxTime : Date.now();
    const oneWeekMs = 7 * 24 * 3600 * 1000;
    const weeklyHistory: Record<string, Record<number, number>> = {};

    historicalRows.forEach((r) => {
      const t = new Date(r.Date).getTime();
      if (Number.isNaN(t)) return;
      const weeksAgo = Math.floor((anchorMs - t) / oneWeekMs);
      if (weeksAgo < 0) return;
      const name = r.ProductName || "Unknown";
      weeklyHistory[name] ||= {};
      weeklyHistory[name][weeksAgo] = (weeklyHistory[name][weeksAgo] || 0) + (Number(r["Sales Vol"]) || 0);
    });

    const stats: Record<string, { lookbackWeeks: number; stdDev: number }> = {};
    products.forEach((product) => {
      const lookbackWeeks = usesLongSafetyStockLookback(product) ? 52 : 13;
      const buckets = weeklyHistory[product] || {};
      const values = Array.from({ length: lookbackWeeks }, (_, i) => buckets[i] || 0);
      stats[product] = { lookbackWeeks, stdDev: stdDev(values) };
    });
    return stats;
  }, [historicalRows, products]);

  const MAX_CAPACITY = 500;
  const WARNING_THRESHOLD = 400;

  const brewPlanResult = useMemo(() => {
      if (productLevelRows.length === 0 || inventoryDB.length === 0) return null;
      const productIds = productLevelRows.map((row) => row.brand);
      const explicitWip = buildWipByProduct(packagingInventoryDB);
      const historicalByProduct = buildHistoricalDemandByProduct(historicalRows, productIds);
      const impliedWip = computeImpliedWipByProduct(historicalByProduct, BREW_LEAD_TIME_WEEKS);
      const wipByProduct = Object.fromEntries(
        productIds.map((p) => [p, (explicitWip[p] ?? 0) > 0 ? explicitWip[p] : (impliedWip[p] ?? 0)]),
      );
      const input = buildBrewPlanningInput({
          forecastCycleId: sessionId || "current",
          generatedAt: new Date().toISOString(),
          weekStartDates,
          productLevelRows,
          inventoryDB,
          historicalRows,
          manualBrewPlan,
          globalServiceLevel,
          wipByProduct,
          scheduledReceiptsByProduct: wipScheduleByProductWeek,
          planningHorizonWeeks: 8,
          brewLeadTimeWeeks: BREW_LEAD_TIME_WEEKS,
          batchSizeBarrels: BREW_BATCH_SIZE,
          targetCapacityBarrels: WARNING_THRESHOLD,
          maxCapacityBarrels: MAX_CAPACITY,
      });
      return generateBrewPlan(input);
  }, [sessionId, weekStartDates, productLevelRows, inventoryDB, historicalRows, manualBrewPlan, globalServiceLevel, packagingInventoryDB, wipScheduleByProductWeek]);

  const masterSchedule = useMemo(() => {
      const weeklyTotals = Array(BREW_DISPLAY_WEEKS).fill(0) as number[];
      const productBreakdown: Record<string, number[]> = {};
      const productUrgency: Record<string, 'RED' | 'YELLOW' | 'GREEN'> = {};
      let hasWarning = false;

      products.forEach(p => {
          const prod = productLevelRows.find(r => r.brand === p) || { Week1: 0, Week2: 0, Week3: 0, Week4: 0, Week5: 0, Week6: 0, Week7: 0, Week8: 0 };
          const wf = [prod.Week1, prod.Week2, prod.Week3, prod.Week4, prod.Week5, prod.Week6, prod.Week7, prod.Week8];
          const inv = inventoryDB.find(i => i.name === p) || { startInv: 0, finalSS: 10 };
          const avgDemand = wf.reduce((a, b) => a + b, 0) / 8;
          const reorderPoint = inv.finalSS + avgDemand * BREW_LEAD_TIME_WEEKS;
          if (inv.startInv <= inv.finalSS) productUrgency[p] = 'RED';
          else if (inv.startInv <= reorderPoint) productUrgency[p] = 'YELLOW';
          else productUrgency[p] = 'GREEN';
      });

      if (brewPlanResult) {
          products.forEach((p) => {
              const productRows = brewPlanResult.productLevelBrewPlan
                  .filter((row) => row.product_id === p)
                  .slice(0, BREW_DISPLAY_WEEKS);
              const releases = productRows.map((row) => row.planned_order_release);
              while (releases.length < BREW_DISPLAY_WEEKS) releases.push(0);
              productBreakdown[p] = releases;
              releases.forEach((release, weekIndex) => { weeklyTotals[weekIndex] += release; });
          });
      }

      weeklyTotals.forEach(t => { if (t > WARNING_THRESHOLD) hasWarning = true; });
      return { weeklyTotals, productBreakdown, productUrgency, hasWarning };
  }, [products, productLevelRows, inventoryDB, brewPlanResult]);

  const opsProductData = useMemo(() => {
    if (!selectedOpsProduct || inventoryDB.length === 0) return null;
    const prod = productLevelRows.find(p => p.brand === selectedOpsProduct);
    const wf = prod ? [prod.Week1, prod.Week2, prod.Week3, prod.Week4, prod.Week5, prod.Week6, prod.Week7, prod.Week8] : [0,0,0,0,0,0,0,0];
    const inv = inventoryDB.find(i => i.name === selectedOpsProduct) || { startInv: 0, finalSS: 10 };
    return { name: selectedOpsProduct, forecasts: wf, startInv: inv.startInv, finalSS: inv.finalSS, manualReleases: manualBrewPlan[selectedOpsProduct] || {} };
  }, [productLevelRows, selectedOpsProduct, inventoryDB, manualBrewPlan]);

  const packagingPlanResult = useMemo(() => {
    if (!brewPlanResult) return null;
    const packagingDemand = mapPackagingDemand(
      rows.map((r) => ({ brand: r.brand, packaging_format: r.packaging_format, week_number: r.week_number, previous_value: r.previous_value, effective_value: r.effective_value })),
      weekStartDates,
      8,
    );
    const packagingInventory = mapPackagingInventory(
      packagingInventoryDB.map((p) => ({ brand: p.brand, packaging_format: p.packaging_format, startInv: p.startInv })),
    );
    const productPackagingPairs = collectProductPackagingPairs(packagingDemand, packagingInventory);
    const packagingHistory = mapPackagingHistory(
      historicalRows.map((h) => ({ Date: h.Date, ProductName: h.ProductName, PackagingTypeName: h.PackagingTypeName, "Sales Vol": h["Sales Vol"] })),
      productPackagingPairs,
    );
    const bblPerUnitByFormat = Object.fromEntries(
      Object.entries(PACKAGING_CONVERSIONS).map(([format, conv]) => [format, conv.bblPerUnit]),
    );
    return generatePackagingPlan({
      brewPlan: brewPlanResult,
      packagingDemand,
      packagingHistory,
      packagingInventory,
      bblPerUnitByFormat,
      serviceLevelByProduct: Object.fromEntries(products.map((p) => [p, globalServiceLevel])) as Record<string, ServiceLevel>,
    });
  }, [brewPlanResult, rows, packagingInventoryDB, historicalRows, weekStartDates, products, globalServiceLevel]);

  const packagingPlan = useMemo(() => {
    if (!packagingPlanResult || !selectedOpsProduct) return [];
    const result = packagingPlanResult;

    const productRows = result.packagingPlan.filter((r) => r.product_id === selectedOpsProduct);
    const summaries = result.weeklySummary.filter((s) => s.product_id === selectedOpsProduct);

    const sixWeekVelocityByFormat: Record<string, number> = {};
    productRows.slice(0, PACKAGING_DISPLAY_WEEKS * Math.max(1, new Set(productRows.map((r) => r.packaging_format)).size)).forEach((r) => {
      sixWeekVelocityByFormat[r.packaging_format] = (sixWeekVelocityByFormat[r.packaging_format] ?? 0) + r.forecast_demand_bbl;
    });

    const reasonText = (reason: string): string => {
      if (reason === "mix_allocation") return "Historical mix split";
      if (reason === "remainder_sweep") return "Surplus to fastest mover";
      if (reason === "no_demand_share") return "No demand history or forecast";
      return "No liquid ready";
    };

    return weekStartDates.slice(0, PACKAGING_DISPLAY_WEEKS).map((weekStart, weekIndex) => {
      const summary = summaries.find((s) => s.week_start_date === weekStart);
      const weekRows = productRows.filter((r) => r.week_start_date === weekStart);
      const detailRows = weekRows.map((r) => ({
        format: r.packaging_format,
        bblPerUnit: r.bbl_per_unit,
        startInvBbl: r.starting_inventory_bbl,
        demandBbl: r.forecast_demand_bbl,
        targetBbl: r.target_inventory_bbl,
        gapBbl: r.inventory_gap_bbl,
        velocityBbl: sixWeekVelocityByFormat[r.packaging_format] ?? 0,
        beforePackagingBbl: r.projected_available_before_packaging_bbl,
        units: r.package_units,
        packagedBbl: r.allocated_bbl,
        projectedEndBbl: r.projected_available_after_packaging_bbl,
        reason: reasonText(r.allocation_reason),
      })).sort((a, b) => b.units - a.units || b.velocityBbl - a.velocityBbl || a.format.localeCompare(b.format));

      const totalPackagedBbl = detailRows.reduce((sum, r) => sum + r.packagedBbl, 0);
      const readyBbl = summary?.ready_to_package_bbl ?? 0;
      return {
        label: weekLabels[weekIndex],
        readyBbl,
        totalPackagedBbl,
        varianceBbl: readyBbl - totalPackagedBbl,
        rows: detailRows,
      };
    });
  }, [packagingPlanResult, selectedOpsProduct, weekLabels, weekStartDates]);


  const handleGlobalSLChange = (newSL: RevisedServiceLevel) => {
    setGlobalServiceLevel(newSL);
    setInventoryDB(prev => prev.map(item => ({
      ...item,
      finalSS: Number(((item.baseSafetyStock ?? 0) * getZRatio(newSL)).toFixed(2)),
    })));
  };

  const handleInventoryUpdate = (name: string, field: "startInv" | "finalSS", value: string) => {
      setPendingEdit({ context: 'inventory', brand: name, newValue: value, inventoryField: field });
  };

  const handleBrewUpdate = (brand: string, weekIndex: number, value: string) => {
      if (planWorkflow.brewingLockedAt) return;
      if (value === "") {
          setManualBrewPlan(prev => {
              const plan = { ...(prev[brand] || {}) };
              delete plan[weekIndex];
              return { ...prev, [brand]: plan };
          });
      } else {
          setPendingEdit({ context: 'brewing', brand, weekNumber: weekIndex, newValue: value });
      }
  };

  function downloadDemandCsv() {
    const weekHeaders = weekLabels.map((l) => `${l} (${unitMode})`);
    const headers = demandViewLevel === "product"
      ? ["Brand", ...weekHeaders]
      : ["Brand", "Channel", "Packaging", ...weekHeaders];
    const lines = [headers.map(csvEscape).join(",")];
    pivotRows.forEach((row) => {
      const cells = demandViewLevel === "product"
        ? [row.brand]
        : [row.brand, row.channel, row.packaging_format];
      [1, 2, 3, 4, 5, 6, 7, 8].forEach((w) => {
        const v = row[`Week${w}` as keyof PivotRow];
        if (v == null || v === "") {
          cells.push("");
        } else {
          const converted = convertBblTo(Number(v), row.packaging_format, unitMode);
          cells.push(converted.toFixed(4));
        }
      });
      lines.push(cells.map(csvEscape).join(","));
    });
    downloadCsvFile(
      `demand-plan-${demandViewLevel}-${unitMode.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`,
      lines,
    );
  }

  function downloadOverviewCsv() {
    const yearKeys = yearlyComparisonChart.years.map(String);
    const headers = ["Week of Year", ...yearKeys.map((y) => `${y} BBL`)];
    const lines = [headers.map(csvEscape).join(",")];
    yearlyComparisonChart.data.forEach((row) => {
      const cells: (string | number)[] = [Number(row.week)];
      yearKeys.forEach((y) => {
        const v = row[y];
        cells.push(v == null ? "" : Number(v).toFixed(4));
      });
      lines.push(cells.map(csvEscape).join(","));
    });
    downloadCsvFile(`overview-yearly-demand-${new Date().toISOString().slice(0, 10)}.csv`, lines);
  }

  function downloadInventoryCsv() {
    const zRatio = getZRatio(globalServiceLevel);
    const headers = [
      "Product",
      "Starting Inventory (BBL)",
      "Avg Weekly Demand (BBL)",
      "Calculated Safety Stock (BBL)",
      "Audited Safety Stock (BBL)",
      "Service Level (%)",
      "Audit Reason",
    ];
    const lines = [headers.map(csvEscape).join(",")];
    enrichedInventoryDB.forEach((item) => {
      const calculatedSS = (item.baseSafetyStock ?? 0) * zRatio;
      const cells = [
        item.name,
        Number(item.startInv ?? 0).toFixed(4),
        Number(item.avgDemand ?? 0).toFixed(4),
        Number(calculatedSS).toFixed(4),
        Number(item.finalSS ?? 0).toFixed(4),
        globalServiceLevel,
        (item as { auditReason?: string }).auditReason ?? "",
      ];
      lines.push(cells.map(csvEscape).join(","));
    });
    downloadCsvFile(
      `inventory-${globalServiceLevel}sl-${new Date().toISOString().slice(0, 10)}.csv`,
      lines,
    );
  }

  function downloadBrewingCsv() {
    if (!brewPlanResult) return;
    const headers = [
      "Product",
      "Week Start Date",
      "Forecast (BBL)",
      "Starting Inventory (BBL)",
      "Safety Stock (BBL)",
      "Service Level (%)",
      "Scheduled Receipts (BBL)",
      "Net Requirement (BBL)",
      "Planned Receipt (BBL)",
      "Planned Release (BBL)",
      "Projected Available (BBL)",
      "Capacity Status",
      "Notes",
    ];
    const lines = [headers.map(csvEscape).join(",")];
    brewPlanResult.productLevelBrewPlan.forEach((row) => {
      const cells = [
        row.product_name,
        row.week_start_date,
        Number(row.forecast_barrels).toFixed(4),
        Number(row.starting_inventory).toFixed(4),
        Number(row.safety_stock).toFixed(4),
        row.service_level,
        Number(row.scheduled_receipts).toFixed(4),
        Number(row.net_requirement).toFixed(4),
        Number(row.planned_order_receipt).toFixed(4),
        Number(row.planned_order_release).toFixed(4),
        Number(row.projected_available).toFixed(4),
        row.capacity_status,
        row.notes,
      ];
      lines.push(cells.map(csvEscape).join(","));
    });
    downloadCsvFile(`brewing-plan-${new Date().toISOString().slice(0, 10)}.csv`, lines);
  }

  function downloadPackagingCsv() {
    if (!packagingPlanResult) return;
    const headers = ["Product", "PackagingType", "Item", "Quantity", "Volume", "Week Start Date"];
    const lines = [headers.map(csvEscape).join(",")];
    packagingPlanResult.packagingPlan
      .filter((row) => row.package_units > 0)
      .forEach((row) => {
        const cells = [
          row.product_name,
          row.packaging_format,
          `${row.product_name} (${row.packaging_format})`,
          Number(row.package_units).toFixed(14),
          Number(row.allocated_bbl).toFixed(14),
          row.week_start_date,
        ];
        lines.push(cells.map(csvEscape).join(","));
      });
    const pad = (n: number) => String(n).padStart(2, "0");
    const d = new Date();
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    downloadCsvFile(`planned_production_${ts}.csv`, lines);
  }

  async function savePendingEdit() {
    if (!pendingEdit) return;
    if (!overrideReason.trim()) { alert("Please enter a reason for the change."); return; }
    const parsed = Number(pendingEdit.newValue);
    if (Number.isNaN(parsed)) return;

    if (pendingEdit.context === 'demand' && pendingEdit.demandPivotRow) {
        const row = rows.find(r => r.brand === pendingEdit.demandPivotRow!.brand && r.channel === pendingEdit.demandPivotRow!.channel && r.packaging_format === pendingEdit.demandPivotRow!.packaging_format && r.week_number === pendingEdit.weekNumber);
        if (row) {
            await supabase.from("demand_plans").update({ effective_value: parsed, override_rationale: overrideReason.trim() }).eq("id", row.id);
            setRows(prev => prev.map(r => r.id === row.id ? { ...r, effective_value: parsed } : r));
        }
    } else if (pendingEdit.context === 'inventory' && pendingEdit.inventoryField) {
        if (pendingEdit.inventoryField === 'startInv') {
            await supabase.from("inventory").update({ startInv: parsed }).eq("name", pendingEdit.brand);
            await supabase.from("inventory").update({ starting_inventory: parsed }).eq("ProductName", pendingEdit.brand);
        } else {
            await supabase.from("inventory").update({ finalSS: parsed, safetyStock: parsed }).eq("name", pendingEdit.brand);
            await supabase.from("inventory").update({ safety_stock: parsed }).eq("ProductName", pendingEdit.brand);
        }

        setInventoryDB(prev => prev.map(item =>
            item.name === pendingEdit.brand ? { ...item, [pendingEdit.inventoryField!]: parsed } : item
        ));
    } else if (pendingEdit.context === 'brewing') {
        setManualBrewPlan(prev => {
            const plan = { ...(prev[pendingEdit.brand] || {}) };
            plan[pendingEdit.weekNumber!] = parsed;
            return { ...prev, [pendingEdit.brand]: plan };
        });
    }

    setPendingEdit(null);
    setOverrideReason("");
  }


  function renderOverviewTab() {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={chartCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: "28px", fontWeight: 700 }}>Overview</h2>
              <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>Snapshot of the current demand forecast and effective demand plan.</p>
              <p style={{ marginTop: "12px", marginBottom: 0, color: "#9ca3af", fontSize: "12px" }}>
                Forecast last generated: {latestForecastDate || "—"} · Inventory last refreshed: pulled live from Tableau on page load
              </p>
            </div>
            <button
              onClick={downloadOverviewCsv}
              style={{ background: "white", color: "#111827", border: "1px solid #d1d5db", borderRadius: "10px", padding: "8px 14px", fontWeight: 600, fontSize: "13px", cursor: "pointer" }}
            >
              Download CSV
            </button>
          </div>
        </div>
        <div style={overviewGridStyle}>
          <div style={overviewLeftColumnStyle}>
            {(() => {
              const totalBbl = chartData.reduce((s, r) => s + r.effective, 0);
              const weeks = chartData.length || 1;
              const avgWeekly = totalBbl / weeks;
              const peakWeek = chartData.reduce((max, r) => r.effective > max ? r.effective : max, 0);
              const brandCount = new Set(rows.map((r) => r.brand)).size;
              return renderMetricCard("Demand Plan", [
                `${formatNumber(totalBbl)} BBL forecast (next ${weeks} wks)`,
                `${formatNumber(avgWeekly)} BBL avg/week`,
                `${formatNumber(peakWeek)} BBL peak week`,
                `${brandCount} brands`,
              ]);
            })()}
            {renderMetricCard("Inventory Plan", ["4.4 WOH Avg", "-0.2 - 10.0 WOH Range", "6% Weeks Above Target"])}
          </div>
          <div style={overviewMainGridStyle}>
            <div style={overviewPanelStyle}>
              <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Yearly Demand Comparison</h3>
              <p style={{ margin: 0, marginTop: "4px", color: "#6b7280", fontSize: "13px" }}>Weekly sales volume (BBL) by year. Compare current year vs prior years at a glance.</p>
              <div style={{ width: "100%", height: 300, marginTop: "12px" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={yearlyComparisonChart.data}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="week" label={{ value: "Week of Year", position: "insideBottom", offset: -4, fill: "#6b7280", fontSize: 12 }} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    {yearlyComparisonChart.years.map((y, i) => {
                      const isLatest = i === yearlyComparisonChart.years.length - 1;
                      const priorPalette = ["#f59e0b", "#10b981", "#a855f7", "#ef4444", "#0ea5e9"];
                      const priorIndex = yearlyComparisonChart.years.length - 2 - i;
                      const stroke = isLatest ? "#2563eb" : priorPalette[priorIndex % priorPalette.length];
                      return (
                        <Line
                          key={y}
                          type="monotone"
                          dataKey={String(y)}
                          stroke={stroke}
                          strokeOpacity={isLatest ? 1 : 0.35}
                          strokeWidth={isLatest ? 3 : 2}
                          dot={false}
                          connectNulls={false}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            {renderPlaceholderPanel("Brewing Plan", "Visuals coming soon.")}
          </div>
        </div>
      </div>
    );
  }

  function renderInventoryTab() {
    const inventoryLocked = !!planWorkflow.inventoryLockedAt;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={chartCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: "28px", fontWeight: 700 }}>Inventory</h2>
              <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>
                Starting inventory comes from Tableau. Safety stock = historical std dev × service-level factor; override per product if needed.
              </p>
            </div>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <button
                onClick={downloadInventoryCsv}
                style={{ background: "white", color: "#111827", border: "1px solid #d1d5db", borderRadius: "12px", padding: "12px 18px", fontWeight: 600, cursor: "pointer" }}
              >
                Download CSV
              </button>
              <button
                onClick={refreshInventoryFromTableau}
                disabled={refreshingInventory}
                style={{ background: refreshingInventory ? "#6b7280" : "#111827", color: "white", border: "none", borderRadius: "12px", padding: "12px 18px", fontWeight: 600, cursor: refreshingInventory ? "wait" : "pointer" }}
              >
                {refreshingInventory ? "Refreshing..." : "Refresh Inventory from Tableau"}
              </button>
              {!inventoryLocked && (
                <button
                  onClick={() => setShowLockInventoryModal(true)}
                  style={{ background: "#047857", color: "white", border: "none", borderRadius: "12px", padding: "12px 18px", fontWeight: 600, cursor: "pointer" }}
                >
                  Lock Inventory Plan
                </button>
              )}
              {inventoryLocked && (
                <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0", borderRadius: "12px", padding: "12px 18px", fontWeight: 600 }}>
                  Inventory Plan Locked — {formatLockedAt(planWorkflow.inventoryLockedAt!)}
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{...filterCardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap'}}>
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>Target Service Level</h3>
            <p style={{ margin: "4px 0 0 0", color: "#6b7280", fontSize: "13px" }}>Recalculates safety stock targets for all products.</p>
            <p style={{ margin: "6px 0 0 0", color: inventoryRefreshError ? "#b91c1c" : "#6b7280", fontSize: "12px", fontWeight: inventoryRefreshError ? 700 : 500 }}>
              {inventoryRefreshError
                ? `Tableau refresh failed: ${inventoryRefreshError}`
                : inventoryLastRefreshedAt
                  ? `Tableau inventory refreshed ${formatLockedAt(inventoryLastRefreshedAt)}`
                  : "Tableau inventory has not been manually refreshed in this session."}
            </p>
          </div>
          <select
            value={globalServiceLevel}
            disabled={inventoryLocked}
            onChange={(e) => handleGlobalSLChange(Number(e.target.value) as RevisedServiceLevel)}
            style={{...selectStyle, width: '200px', fontWeight: 'bold', cursor: inventoryLocked ? 'not-allowed' : 'pointer', background: inventoryLocked ? '#f3f4f6' : undefined}}
          >
            {REVISED_SERVICE_LEVELS.map((level) => (
              <option key={level} value={level}>{level}%</option>
            ))}
          </select>
        </div>

        <div style={tableCardStyle}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: "1000px", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  <th style={{ textAlign: "left", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#374151" }}>Brand</th>
                  <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#374151" }}>Starting Inv</th>
                  <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#9ca3af" }}>Std Dev Lookback</th>
                  <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#9ca3af" }}>Std Dev</th>
                  <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#7e22ce", background: "#f3e8ff" }}>Safety Stock</th>
                  <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#9ca3af" }}>Avg Demand</th>
                </tr>
              </thead>
              <tbody>
                {enrichedInventoryDB.map((item, index) => {
                  const safetyStats = revisedSafetyStatsByProduct[item.name] || { lookbackWeeks: 13, stdDev: 0 };
                  const calcSS = Number(((item.baseSafetyStock ?? 0) * getZRatio(globalServiceLevel)).toFixed(2));
                  const isSSAudited = Number(item.finalSS).toFixed(2) !== calcSS.toFixed(2);
                  const isInvAudited = item.startInv !== item.originalStartInv;

                  return (
                    <tr key={item.name} style={{ background: index % 2 === 0 ? "white" : "#fcfcfd" }}>
                      <td style={{...cellStyle, fontWeight: 'bold'}}>{item.name}</td>
                      <td style={{...cellStyle, textAlign: 'center'}}>
                        <input
                          key={`inv-${item.name}-${item.startInv}-${cancelTick}`}
                          type="number"
                          defaultValue={item.startInv}
                          disabled={inventoryLocked}
                          onBlur={(e) => {
                            if (inventoryLocked) return;
                            if (e.target.value !== "" && Number(e.target.value) !== item.startInv) {
                              handleInventoryUpdate(item.name, 'startInv', e.target.value);
                            }
                          }}
                          style={{
                            ...inputStyle,
                            textAlign: 'center',
                            background: isInvAudited ? '#fef3c7' : '#f8fafc',
                            border: isInvAudited ? '2px solid #f59e0b' : '1px solid #d1d5db',
                            color: isInvAudited ? '#b45309' : '#111827',
                            fontWeight: isInvAudited ? 'bold' : 'normal'
                          }}
                        />
                      </td>
                      <td style={{...cellStyle, textAlign: "center", color: "#6b7280"}}>{safetyStats.lookbackWeeks} wks</td>
                      <td style={{...cellStyle, textAlign: "center", color: "#6b7280"}}>{formatNumber(safetyStats.stdDev)}</td>
                      <td style={{...cellStyle, textAlign: 'center', background: '#f3e8ff'}}>
                        <input
                          key={`ss-${item.name}-${item.finalSS}-${cancelTick}`}
                          type="number"
                          defaultValue={item.finalSS}
                          disabled={inventoryLocked}
                          onBlur={(e) => {
                            if (inventoryLocked) return;
                            if (e.target.value !== "" && Number(e.target.value) !== item.finalSS) {
                              handleInventoryUpdate(item.name, 'finalSS', e.target.value);
                            }
                          }}
                          style={{...inputStyle, textAlign: 'center', fontWeight: 'bold', color: isSSAudited ? '#b45309' : '#7e22ce', border: isSSAudited ? '2px solid #f59e0b' : '1px solid #d1d5db'}}
                        />
                        <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>Math suggests {formatNumber(calcSS)}</div>
                      </td>
                      <td style={{...cellStyle, textAlign: 'center', color: '#6b7280'}}>{formatNumber(item.avgDemand)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {showLockInventoryModal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(17, 24, 39, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "white", borderRadius: "16px", padding: "28px", maxWidth: "440px", width: "92%", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
              <h3 style={{ margin: 0, marginBottom: "12px", fontSize: "20px", fontWeight: 700 }}>Lock Inventory Plan</h3>
              <p style={{ margin: 0, marginBottom: "24px", color: "#4b5563", lineHeight: 1.5 }}>
                Once locked, the starting inventory and safety stock values cannot be edited. The locked values will flow into the Brewing Plan as the basis for production scheduling. Are you sure you want to continue?
              </p>
              <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
                <button
                  onClick={() => setShowLockInventoryModal(false)}
                  style={{ background: "white", color: "#111827", border: "1px solid #d1d5db", borderRadius: "10px", padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  onClick={lockInventoryPlan}
                  style={{ background: "#047857", color: "white", border: "none", borderRadius: "10px", padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
                >
                  Lock Inventory Plan
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }


  function adaptBrewRowsToLegacyShape(rows: ProductLevelBrewPlanRow[], displayWeeks: number, leadTimeWeeks: number) {
    const slice = rows.slice(0, displayWeeks);
    const totalForecast = slice.reduce((sum, row) => sum + row.forecast_barrels, 0);
    return {
      productName: rows[0]?.product_name ?? "",
      totalForecast,
      avgWeeklyDemand: displayWeeks > 0 ? totalForecast / displayWeeks : 0,
      startInv: rows[0]?.starting_inventory ?? 0,
      safetyStock: rows[0]?.safety_stock ?? 0,
      forecasts: slice.map((row) => row.forecast_barrels),
      projAvailable: slice.map((row) => row.projected_available),
      plannedReceipt: slice.map((row) => row.planned_order_receipt),
      scheduledReceipts: slice.map((row) => row.scheduled_receipts),
      plannedRelease: slice.map((row) => row.planned_order_release),
      netRequirements: slice.map((row) => row.net_requirement),
      grossRequirements: slice.map((row) => row.gross_requirements),
      startingInventoryByWeek: slice.map((row) => row.starting_inventory),
      batchSize: BREW_BATCH_SIZE,
      leadTimeWeeks,
      pastDueReceipts: rows.slice(0, leadTimeWeeks).reduce((sum, row) => sum + row.planned_order_receipt, 0),
      displayWeeks,
    };
  }

  function renderBrewingTab() {
    if (!masterSchedule || !opsProductData || !brewPlanResult) return null;
    const productRows = brewPlanResult.productLevelBrewPlan.filter((row) => row.product_id === opsProductData.name);
    const productPlan = adaptBrewRowsToLegacyShape(productRows, BREW_DISPLAY_WEEKS, BREW_LEAD_TIME_WEEKS);
    const brewingLocked = !!planWorkflow.brewingLockedAt;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>

        <div style={{...chartCardStyle, background: "#111827", color: "white"}}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
                <div>
                    <h2 style={{ margin: 0, fontSize: "22px", fontWeight: 700 }}>Facility Load vs Capacity</h2>
                    <p style={{ margin: 0, marginTop: "4px", color: "#9ca3af", fontSize: "13px" }}>If capacity exceeds 500 BBL, refer to the color-coded breakdown to prioritize critical restocks. Brews are scheduled in 50-BBL batches with a 2-week lead time.</p>
                    {masterSchedule.hasWarning && <p style={{ color: "#f87171", fontSize: "14px", marginTop: "8px", margin: 0, fontWeight: "bold" }}>⚠️ WARNING: Approaching absolute limit of {MAX_CAPACITY} bbls.</p>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button
                      onClick={downloadBrewingCsv}
                      style={{
                        background: "white",
                        color: "#111827",
                        border: "1px solid #475569",
                        borderRadius: "10px",
                        padding: "10px 14px",
                        fontWeight: 700,
                        fontSize: "13px",
                        cursor: "pointer",
                      }}
                    >
                      Download CSV
                    </button>
                    <button
                      onClick={refreshInventoryFromTableau}
                      disabled={refreshingInventory}
                      style={{
                        background: refreshingInventory ? "#475569" : "white",
                        color: refreshingInventory ? "#cbd5e1" : "#111827",
                        border: "1px solid #475569",
                        borderRadius: "10px",
                        padding: "10px 14px",
                        fontWeight: 700,
                        fontSize: "13px",
                        cursor: refreshingInventory ? "wait" : "pointer",
                      }}
                    >
                      {refreshingInventory ? "Refreshing..." : "Refresh Inventory from Tableau"}
                    </button>
                    {!brewingLocked && (
                      <button
                        onClick={() => setShowLockBrewingModal(true)}
                        style={{ background: "#047857", color: "white", border: "none", borderRadius: "10px", padding: "10px 14px", fontWeight: 700, fontSize: "13px", cursor: "pointer" }}
                      >
                        Lock Brewing Plan
                      </button>
                    )}
                    {brewingLocked && (
                      <span style={{ background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "8px 12px", fontWeight: 700, fontSize: "12px" }}>
                        Locked — {formatLockedAt(planWorkflow.brewingLockedAt!)}
                      </span>
                    )}
                    <span style={{ color: "#a78bfa", fontWeight: 'bold', fontSize: "18px" }}>{MAX_CAPACITY} bbl max</span>
                </div>
            </div>

            {/* URGENCY LEGEND */}
            <div style={{ display: 'flex', gap: '16px', marginTop: '12px', marginBottom: '8px', fontSize: '13px', color: '#cbd5e1' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#f87171' }}/> Critical (Below Safety Stock)</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#fbbf24' }}/> Needs Brew (Below Reorder Point)</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#34d399' }}/> Healthy (Future Restock)</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '16px', marginTop: '12px' }}>
                {masterSchedule.weeklyTotals.map((total, i) => {
                    const isOver = total > WARNING_THRESHOLD;
                    return (
                        <div key={i} style={{ padding: '16px', borderRadius: '12px', background: isOver ? '#450a0a' : '#1e293b', border: isOver ? '1px solid #7f1d1d' : '1px solid #334155', textAlign: 'center' }}>
                            <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px' }}>{weekLabels[i]}</div>
                            <div style={{ fontSize: '24px', fontWeight: 'black', color: isOver ? '#f87171' : '#34d399' }}>{total}</div>
                            <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold', marginTop: '4px', marginBottom: '12px' }}>{Math.round((total/MAX_CAPACITY)*100)}% Full</div>

                            {/* COLOR CODED BREAKDOWN */}
                            <div style={{ width: '100%', borderTop: '1px solid #475569', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {Object.entries(masterSchedule.productBreakdown).map(([prod, releases]) => {
                                    if (releases[i] > 0) {
                                        const urg = masterSchedule.productUrgency[prod];
                                        const color = urg === 'RED' ? '#f87171' : urg === 'YELLOW' ? '#fbbf24' : '#34d399';
                                        return (
                                            <div key={prod} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color }}>
                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{prod}</span>
                                                <span style={{ fontWeight: 'bold' }}>{releases[i]}</span>
                                            </div>
                                        )
                                    }
                                    return null;
                                })}
                            </div>
                        </div>
                    )
                })}
            </div>

            <div style={{ marginTop: '24px', borderTop: '1px solid #334155', paddingTop: '20px' }}>
              <h3 style={{ margin: 0, marginBottom: '16px', fontSize: '16px', fontWeight: 700, color: '#94a3b8' }}>Brew Schedule by Product</h3>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid #334155", fontSize: "12px", color: "#64748b" }}>Brand</th>
                    {weekLabels.slice(0, 6).map(lbl => (
                      <th key={lbl} style={{ textAlign: "center", padding: "8px 12px", borderBottom: "1px solid #334155", fontSize: "12px", color: "#64748b" }}>{lbl}</th>
                    ))}
                    <th style={{ textAlign: "center", padding: "8px 12px", borderBottom: "1px solid #334155", fontSize: "12px", color: "#64748b" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(masterSchedule.productBreakdown).sort(([a], [b]) => a.localeCompare(b)).map(([brand, weeks]) => {
                    const total = weeks.reduce((s, v) => s + v, 0);
                    if (total === 0) return null;
                    return (
                      <tr key={brand} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '10px 12px', color: '#e2e8f0', fontWeight: 600, fontSize: '13px' }}>{brand}</td>
                        {weeks.map((v, i) => (
                          <td key={i} style={{ padding: '10px 12px', textAlign: 'center', fontSize: '14px', fontWeight: v > 0 ? 700 : 400, color: v > 0 ? '#34d399' : '#475569' }}>
                            {v > 0 ? formatNumber(v) : "-"}
                          </td>
                        ))}
                        <td style={{ padding: '10px 12px', textAlign: 'center', fontSize: '14px', fontWeight: 700, color: '#e2e8f0' }}>{formatNumber(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
        </div>

        <div style={filterCardStyle}>
            <label style={labelStyle}>View Specific Brewing Instructions</label>
            <select value={selectedOpsProduct} onChange={(e) => setSelectedOpsProduct(e.target.value)} style={selectStyle}>
                {products.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
        </div>

        <div style={tableCardStyle}>
            <div style={{ padding: "24px", display: "flex", justifyContent: "space-between" }}>
                <h3 style={{ margin: 0, fontSize: "20px" }}>{opsProductData.name} - Action Plan</h3>
                <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#7e22ce' }}>Locked SS: {formatNumber(opsProductData.finalSS)}</span>
            </div>

            {(() => {
              if (opsProductData.startInv < opsProductData.finalSS) {
                return (
                  <div style={{ margin: "0 24px 16px 24px", padding: "12px 16px", background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: "12px", color: "#92400e", fontSize: "13px", fontWeight: 600 }}>
                    Notice: Current inventory is below the desired safety stock. Expedited brews have been automatically scheduled for immediate release (Wk 0).
                  </div>
                );
              }
              return null;
            })()}

            <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", minWidth: "900px", borderCollapse: "collapse" }}>
                    <thead>
                        <tr style={{ background: "#f8fafc" }}>
                            <th style={{ textAlign: "left", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>Weekly Flow</th>
                            <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>Wk 0</th>
                            {weekLabels.slice(0,6).map(lbl => <th key={lbl} style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", color: '#2563eb' }}>{lbl}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{...cellStyle, color: '#dc2626', fontWeight: 'bold'}}>➖ Forecasted Demand</td>
                            <td style={cellStyle}>-</td>
                            {productPlan.forecasts.map((f, i) => <td key={i} style={{...cellStyle, textAlign: 'center', color: '#dc2626'}}>{formatNumber(f)}</td>)}
                        </tr>
                        <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{...cellStyle, color: '#0891b2', fontWeight: 'bold'}}>🛢️ WIP Arriving</td>
                            <td style={cellStyle}>-</td>
                            {productPlan.scheduledReceipts.map((r, i) => <td key={i} style={{...cellStyle, textAlign: 'center', color: '#0891b2', fontWeight: 'bold'}}>{r > 0 ? formatNumber(r) : '-'}</td>)}
                        </tr>
                        <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{...cellStyle, color: '#16a34a', fontWeight: 'bold'}}>➕ Planned Brews Arriving</td>
                            <td style={cellStyle}>-</td>
                            {productPlan.plannedReceipt.map((r, i) => <td key={i} style={{...cellStyle, textAlign: 'center', color: '#16a34a', fontWeight: 'bold'}}>{r > 0 ? formatNumber(r) : '-'}</td>)}
                        </tr>
                        <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                            <td style={{...cellStyle, fontWeight: 'bold'}}>📦 Ending Inventory</td>
                            <td style={{...cellStyle, textAlign: 'center', fontWeight: 'bold'}}>{formatNumber(opsProductData.startInv)}</td>
                            {productPlan.projAvailable.map((p, i) => <td key={i} style={{...cellStyle, textAlign: 'center', fontWeight: 'bold', color: p < opsProductData.finalSS ? '#dc2626' : '#111827'}}>{formatNumber(p)}</td>)}
                        </tr>
                        <tr style={{ background: '#f3e8ff', borderBottom: '2px solid #d8b4fe' }}>
                            <td style={{...cellStyle, fontWeight: '900', color: '#7e22ce', fontSize: '15px'}}>⚙️ ACTION: Start Brewing</td>
                            <td style={cellStyle}>-</td>
                            {productPlan.plannedRelease.map((r, i) => {
                                const isManual = opsProductData.manualReleases[i] !== undefined;
                                const currentVal = isManual ? opsProductData.manualReleases[i] : "";
                                return (
                                    <td key={i} style={{ padding: '8px', textAlign: 'center' }}>
                                        <input
                                            key={`brew-${opsProductData.name}-${i}-${currentVal}-${cancelTick}`}
                                            type="number"
                                            defaultValue={currentVal}
                                            placeholder={r > 0 ? String(r) : "-"}
                                            disabled={brewingLocked}
                                            onBlur={(e) => {
                                                const val = e.target.value;
                                                if (String(val) !== String(currentVal)) {
                                                    handleBrewUpdate(opsProductData.name, i, val);
                                                }
                                            }}
                                            style={{...inputStyle, textAlign: 'center', fontWeight: '900', fontSize: '15px', color: '#7e22ce', border: isManual ? '2px solid #f59e0b' : '1px solid transparent', background: brewingLocked ? '#f3f4f6' : (isManual ? '#fef3c7' : 'transparent'), cursor: brewingLocked ? 'not-allowed' : 'text' }}
                                        />
                                    </td>
                                )
                            })}
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div style={tableCardStyle}>
            <div style={{ padding: "20px 24px", borderBottom: "1px solid #e5e7eb" }}>
                <h3 style={{ margin: 0, fontSize: "20px" }}>Calculation Details — {opsProductData.name}</h3>
                <p style={{ margin: "4px 0 0 0", color: "#6b7280", fontSize: "13px" }}>
                    Net requirement = max(0, forecast + safety stock - starting projected inventory). Receipts are rounded up to the next {productPlan.batchSize}-BBL batch and released {productPlan.leadTimeWeeks} weeks earlier.
                </p>
            </div>
            <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", minWidth: "900px", borderCollapse: "collapse" }}>
                    <thead>
                        <tr style={{ background: "#f8fafc" }}>
                            {["Week", "Forecast", "Start Inv", "Safety Stock", "WIP Arriving", "Net Req", "Rounded Receipt", "Ending Inv"].map((header) => (
                                <th key={header} style={{ textAlign: "center", padding: "12px 14px", borderBottom: "1px solid #e5e7eb", fontSize: "12px", color: "#6b7280" }}>{header}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {productPlan.forecasts.map((forecast, i) => (
                            <tr key={i} style={{ background: i % 2 === 0 ? "white" : "#fcfcfd" }}>
                                <td style={{...cellStyle, textAlign: "center", fontWeight: 700}}>{weekLabels[i]}</td>
                                <td style={{...cellStyle, textAlign: "center"}}>{formatNumber(forecast)}</td>
                                <td style={{...cellStyle, textAlign: "center"}}>{formatNumber(productPlan.startingInventoryByWeek[i])}</td>
                                <td style={{...cellStyle, textAlign: "center"}}>{formatNumber(productPlan.safetyStock)}</td>
                                <td style={{...cellStyle, textAlign: "center", color: "#0891b2", fontWeight: 700}}>{productPlan.scheduledReceipts[i] > 0 ? formatNumber(productPlan.scheduledReceipts[i]) : "-"}</td>
                                <td style={{...cellStyle, textAlign: "center"}}>{formatNumber(productPlan.netRequirements[i])}</td>
                                <td style={{...cellStyle, textAlign: "center", color: "#16a34a", fontWeight: 900}}>{productPlan.plannedReceipt[i] > 0 ? formatNumber(productPlan.plannedReceipt[i]) : "-"}</td>
                                <td style={{...cellStyle, textAlign: "center", fontWeight: 700, color: productPlan.projAvailable[i] < productPlan.safetyStock ? "#dc2626" : "#111827"}}>{formatNumber(productPlan.projAvailable[i])}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {productPlan.pastDueReceipts > 0 && (
                <div style={{ padding: "12px 24px", color: "#92400e", background: "#fef3c7", borderTop: "1px solid #fde68a", fontSize: "13px" }}>
                    {formatNumber(productPlan.pastDueReceipts)} BBL of receipts are needed inside the {productPlan.leadTimeWeeks}-week brewing lead time and have been rolled into the Wk 0 release.
                </div>
            )}
        </div>
      </div>
    );
  }

  function renderPackagingTab() {
    if (!opsProductData || !masterSchedule) return null;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={chartCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: "28px", fontWeight: 700 }}>Packaging Plan</h2>
              <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>
                Converts beer ready from the Brewing Plan into whole-unit package work orders. Math stays in BBL; the operator view shows units.
              </p>
            </div>
            <button
              onClick={downloadPackagingCsv}
              style={{ background: "white", color: "#111827", border: "1px solid #d1d5db", borderRadius: "10px", padding: "8px 14px", fontWeight: 600, fontSize: "13px", cursor: "pointer" }}
            >
              Download CSV
            </button>
          </div>
        </div>

        <div style={filterCardStyle}>
            <label style={labelStyle}>Select Brand to Package</label>
            <select value={selectedOpsProduct} onChange={(e) => setSelectedOpsProduct(e.target.value)} style={selectStyle}>
                {products.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
        </div>

        <div style={tableCardStyle}>
            <div style={{ padding: "24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                    <h3 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>{opsProductData.name} - Packaging Schedule</h3>
                    <p style={{ margin: 0, marginTop: "4px", color: "#6b7280", fontSize: "13px" }}>
                      Uses current packaged inventory, forecasted SKU demand, and the beer arriving from brewing.
                    </p>
                </div>
            </div>

            <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", minWidth: "900px", borderCollapse: "collapse" }}>
                    <thead>
                        <tr style={{ background: "#f8fafc" }}>
                            <th style={{ textAlign: "left", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>Week</th>
                            <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", color: '#92400e' }}>Beer Ready</th>
                            <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", color: '#047857' }}>Packaged</th>
                            <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>Unit Rounding / Loss</th>
                        </tr>
                    </thead>
                    <tbody>
                        {packagingPlan.map((week) => {
                          const varianceColor = Math.abs(week.varianceBbl) <= 1 ? "#047857" : week.varianceBbl > 0 ? "#b45309" : "#b91c1c";
                          return (
                            <tr key={week.label} style={{ background: week.readyBbl > 0 ? "white" : "#fcfcfd" }}>
                              <td style={{...cellStyle, fontWeight: 700}}>{week.label}</td>
                              <td style={{...cellStyle, textAlign: "center", color: "#92400e", fontWeight: 700}}>{formatNumber(week.readyBbl)} BBL</td>
                              <td style={{...cellStyle, textAlign: "center", color: "#047857", fontWeight: 700}}>{formatNumber(week.totalPackagedBbl)} BBL</td>
                              <td style={{...cellStyle, textAlign: "center", color: varianceColor, fontWeight: 700}}>
                                {week.varianceBbl >= 0 ? `${formatNumber(week.varianceBbl)} BBL unassigned` : `${formatNumber(Math.abs(week.varianceBbl))} BBL over by rounding`}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                </table>
            </div>
        </div>

        {packagingPlan.map((week) => (
          <div key={`detail-${week.label}`} style={tableCardStyle}>
            <div style={{ padding: "20px 24px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>{week.label} Work Orders</h3>
                <p style={{ margin: 0, marginTop: "4px", color: "#6b7280", fontSize: "13px" }}>
                  Package the whole units below from {formatNumber(week.readyBbl)} BBL ready to package.
                </p>
              </div>
              <span style={{ alignSelf: "center", color: "#6b7280", fontSize: "13px", fontWeight: 600 }}>
                {week.rows.filter((row) => row.units > 0).length} active SKUs
              </span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: "1120px", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ textAlign: "left", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>Packaging Format</th>
                    <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>Start Inv</th>
                    <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>Forecast Demand</th>
                    <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>Target Inv</th>
                    <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", color: "#047857" }}>Package Units</th>
                    <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>Projected End</th>
                    <th style={{ textAlign: "left", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  {week.rows.map((row, idx) => (
                    <tr key={`${week.label}-${row.format}`} style={{ background: idx % 2 === 0 ? "white" : "#fcfcfd" }}>
                      <td style={{...cellStyle, fontWeight: 700, color: "#374151"}}>
                        {row.format}
                        <div style={{ fontSize: "11px", color: "#9ca3af", fontWeight: 500 }}>{formatNumber(row.bblPerUnit)} BBL / unit</div>
                      </td>
                      <td style={{...cellStyle, textAlign: "center"}}>{formatNumber(row.startInvBbl)} BBL</td>
                      <td style={{...cellStyle, textAlign: "center"}}>{formatNumber(row.demandBbl)} BBL</td>
                      <td style={{...cellStyle, textAlign: "center"}}>{formatNumber(row.targetBbl)} BBL</td>
                      <td style={{...cellStyle, textAlign: "center"}}>
                        {row.units > 0 ? (
                          <div>
                            <div style={{ fontSize: "18px", fontWeight: 900, color: "#047857" }}>{row.units}</div>
                            <div style={{ fontSize: "12px", color: "#64748b" }}>{formatNumber(row.packagedBbl)} BBL</div>
                          </div>
                        ) : (
                          <span style={{ color: "#cbd5e1" }}>-</span>
                        )}
                      </td>
                      <td style={{...cellStyle, textAlign: "center", fontWeight: 700, color: row.projectedEndBbl < 0 ? "#b91c1c" : "#111827"}}>{formatNumber(row.projectedEndBbl)} BBL</td>
                      <td style={{...cellStyle, color: "#6b7280", fontSize: "13px"}}>{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderDemandPlanTab() {
    return (
      <>
        <div style={chartCardStyle}>
          <div style={{ marginBottom: "8px" }}>
            <h2 style={{ margin: 0, fontSize: "28px", fontWeight: 700 }}>Forecasted Demand</h2>
            <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>Current session: {sessionId}</p>
          </div>
          <div style={{ display: "flex", gap: "12px", marginTop: "20px", flexWrap: "wrap" }}>
            <button onClick={() => requestResetThen(async () => { await resetPlanWorkflow(); setShowDemandContent(true); })} style={{ background: "#111827", color: "white", border: "none", borderRadius: "12px", padding: "12px 18px", fontWeight: 600, cursor: "pointer" }}>
              Load Latest Forecast{latestForecastDate ? ` (${latestForecastDate})` : ""}
            </button>
            <button
              onClick={() => requestResetThen(async () => { await resetPlanWorkflow(); handleGenerateForecast(); })}
              disabled={isGenerating}
              style={{ background: isGenerating ? "#6b7280" : "#2563eb", color: "white", border: "none", borderRadius: "12px", padding: "12px 18px", fontWeight: 600, cursor: isGenerating ? "wait" : "pointer" }}
            >
              {isGenerating
                ? `Running on server${generateStartedAt ? ` — ${formatElapsed(Date.now() - generateStartedAt)}` : ""}`
                : "Generate New Forecast"}
            </button>
            {showDemandContent && (
              <button
                onClick={() => {
                  setShowDemandContent(true);
                  setTimeout(() => demandChartRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                }}
                style={{ background: "white", color: "#111827", border: "1px solid #d1d5db", borderRadius: "12px", padding: "12px 18px", fontWeight: 600, cursor: "pointer" }}
              >
                Visualize Forecast ↓
              </button>
            )}
            {showDemandContent && !planWorkflow.demandLockedAt && (
              <button
                onClick={() => setShowLockDemandModal(true)}
                style={{ background: "#047857", color: "white", border: "none", borderRadius: "12px", padding: "12px 18px", fontWeight: 600, cursor: "pointer" }}
              >
                Lock Demand Plan
              </button>
            )}
            {planWorkflow.demandLockedAt && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0", borderRadius: "12px", padding: "12px 18px", fontWeight: 600 }}>
                Demand Plan Locked — {formatLockedAt(planWorkflow.demandLockedAt)}
              </div>
            )}
          </div>
          {isGenerating && (
            <p style={{ marginTop: "16px", marginBottom: 0, color: "#6b7280", fontSize: "13px" }}>
              Forecast is running on the server (typically 10–30 minutes). You can safely close this tab — when you come back, click <strong>Load Latest Forecast</strong> to see the new results.
            </p>
          )}
        </div>

        {showDemandContent && (
          <div style={tableCardStyle}>
            <div style={{ padding: "24px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>Editable Demand Table</h3>
              <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                <button
                  onClick={downloadDemandCsv}
                  style={{ background: "white", color: "#111827", border: "1px solid #d1d5db", borderRadius: "10px", padding: "8px 14px", fontWeight: 600, fontSize: "13px", cursor: "pointer" }}
                >
                  Download CSV
                </button>
              <div style={{ display: "flex", gap: "4px", padding: "4px", background: "#f1f5f9", borderRadius: "10px" }}>
                <button
                  onClick={() => setDemandViewLevel("product")}
                  style={{
                    padding: "8px 16px", borderRadius: "8px", border: "none",
                    background: demandViewLevel === "product" ? "white" : "transparent",
                    color: demandViewLevel === "product" ? "#111827" : "#6b7280",
                    fontWeight: 600, fontSize: "13px", cursor: "pointer",
                    boxShadow: demandViewLevel === "product" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                  }}
                >
                  Product Level
                </button>
                <button
                  onClick={() => setDemandViewLevel("packaging")}
                  style={{
                    padding: "8px 16px", borderRadius: "8px", border: "none",
                    background: demandViewLevel === "packaging" ? "white" : "transparent",
                    color: demandViewLevel === "packaging" ? "#111827" : "#6b7280",
                    fontWeight: 600, fontSize: "13px", cursor: "pointer",
                    boxShadow: demandViewLevel === "packaging" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                  }}
                >
                  Packaging Level
                </button>
              </div>
              <div style={{ display: "flex", gap: "4px", padding: "4px", background: "#f1f5f9", borderRadius: "10px" }}>
                <button
                  onClick={() => setUnitMode("BBL")}
                  style={{
                    padding: "8px 14px", borderRadius: "8px", border: "none",
                    background: unitMode === "BBL" ? "white" : "transparent",
                    color: unitMode === "BBL" ? "#111827" : "#6b7280",
                    fontWeight: 600, fontSize: "13px", cursor: "pointer",
                    boxShadow: unitMode === "BBL" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                  }}
                >
                  BBL
                </button>
                <button
                  onClick={() => setUnitMode("CE")}
                  style={{
                    padding: "8px 14px", borderRadius: "8px", border: "none",
                    background: unitMode === "CE" ? "white" : "transparent",
                    color: unitMode === "CE" ? "#111827" : "#6b7280",
                    fontWeight: 600, fontSize: "13px", cursor: "pointer",
                    boxShadow: unitMode === "CE" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                  }}
                >
                  CE
                </button>
              </div>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: "1200px", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    {(demandViewLevel === "product"
                      ? ["Brand", ...weekLabels.map((l) => `${l} (${unitMode})`)]
                      : ["Brand", "Channel", "Packaging", ...weekLabels.map((l) => `${l} (${unitMode})`)]
                    ).map((h) => <th key={h} style={{ textAlign: "left", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", color: "#374151" }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {pivotRows.map((row, index) => (
                    <tr key={row.key} style={{ background: index % 2 === 0 ? "white" : "#fcfcfd" }}>
                      <td style={cellStyle}>{row.brand}</td>
                      {demandViewLevel === "packaging" && (
                        <>
                          <td style={cellStyle}>{row.channel}</td>
                          <td style={cellStyle}>{row.packaging_format}</td>
                        </>
                      )}
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((w) => {
                          const rawBbl = row[`Week${w}` as keyof PivotRow];
                          const displayVal = rawBbl == null || rawBbl === ""
                            ? ""
                            : convertBblTo(Number(rawBbl), row.packaging_format, unitMode);
                          const ratio = unitMode === "CE"
                            ? (CE_PER_BBL[row.packaging_format] ?? CE_PER_BBL_DEFAULT)
                            : 1;
                          return (
                            <td key={w} style={cellStyle}>
                                <input
                                    key={`demand-${row.key}-${w}-${unitMode}-${rawBbl}-${cancelTick}`}
                                    type="number"
                                    defaultValue={displayVal === "" ? "" : Number(displayVal).toFixed(2).replace(/\.00$/, "")}
                                    disabled={!!planWorkflow.demandLockedAt}
                                    onBlur={(e) => {
                                        if (planWorkflow.demandLockedAt) return;
                                        if (e.target.value === "") return;
                                        const enteredDisplay = Number(e.target.value);
                                        if (!Number.isFinite(enteredDisplay)) return;
                                        const enteredBbl = unitMode === "CE" ? enteredDisplay / ratio : enteredDisplay;
                                        const currentBbl = rawBbl == null || rawBbl === "" ? null : Number(rawBbl);
                                        if (currentBbl != null && Math.abs(enteredBbl - currentBbl) < 1e-6) return;
                                        setPendingEdit({ context: 'demand', demandPivotRow: row, weekNumber: w, newValue: String(enteredBbl), brand: row.brand })
                                    }}
                                    style={{ ...inputStyle, background: planWorkflow.demandLockedAt ? "#f3f4f6" : undefined, color: planWorkflow.demandLockedAt ? "#6b7280" : undefined, cursor: planWorkflow.demandLockedAt ? "not-allowed" : undefined }}
                                />
                            </td>
                          )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {showDemandContent && (
          <div ref={demandChartRef} style={chartCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px", flexWrap: "wrap", marginBottom: "16px" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Forecasted Demand</h3>
                <p style={{ margin: "4px 0 0 0", color: "#6b7280", fontSize: "13px" }}>
                  Prior 8 weeks of actuals vs next 8 weeks of forecast ({demandViewLevel === "product" ? "product-level" : "packaging-level"}, in {unitMode}).
                </p>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <select value={chartBrand} onChange={(e) => setChartBrand(e.target.value)} style={{ ...selectStyle, width: "160px" }}>
                  <option value="">All Brands</option>
                  {products.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                {demandViewLevel === "packaging" && (
                  <>
                    <select value={chartChannel} onChange={(e) => setChartChannel(e.target.value)} style={{ ...selectStyle, width: "140px" }}>
                      <option value="">All Channels</option>
                      {channels.filter((c) => c !== "all").map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select value={chartPackaging} onChange={(e) => setChartPackaging(e.target.value)} style={{ ...selectStyle, width: "200px" }}>
                      <option value="">All Packaging</option>
                      {packagingFormats.filter((p) => p !== "ALL").map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </>
                )}
              </div>
            </div>
            <div style={{ width: "100%", height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={demandChartData.data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="historical" name={`Actual (${unitMode})`} stroke="#94a3b8" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                  {demandChartData.hasOverrides ? (
                    <Line type="monotone" dataKey="forecastOriginal" name={`Original Forecast (${unitMode})`} stroke="#93c5fd" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} connectNulls={false} />
                  ) : null}
                  <Line
                    type="monotone"
                    dataKey="forecastAdjusted"
                    name={demandChartData.hasOverrides ? `Adjusted Forecast (${unitMode})` : `Forecast (${unitMode})`}
                    stroke={demandChartData.hasOverrides ? "#f59e0b" : "#2563eb"}
                    strokeWidth={demandChartData.hasOverrides ? 3 : 2.5}
                    dot={{ r: 3 }}
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {showResetModal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(17, 24, 39, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "white", borderRadius: "16px", padding: "28px", maxWidth: "440px", width: "92%", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
              <h3 style={{ margin: 0, marginBottom: "12px", fontSize: "20px", fontWeight: 700 }}>Start a New Plan?</h3>
              <p style={{ margin: 0, marginBottom: "24px", color: "#4b5563", lineHeight: 1.5 }}>
                You have a plan in progress. Starting a new plan will clear all locked stages and reset your workflow. Are you sure you want to continue?
              </p>
              <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
                <button
                  onClick={() => { setShowResetModal(false); setPendingResetAction(null); }}
                  style={{ background: "white", color: "#111827", border: "1px solid #d1d5db", borderRadius: "10px", padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => { const a = pendingResetAction; setShowResetModal(false); setPendingResetAction(null); if (a) a(); }}
                  style={{ background: "#b91c1c", color: "white", border: "none", borderRadius: "10px", padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
                >
                  Start New Plan
                </button>
              </div>
            </div>
          </div>
        )}

        {showLockDemandModal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(17, 24, 39, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "white", borderRadius: "16px", padding: "28px", maxWidth: "440px", width: "92%", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
              <h3 style={{ margin: 0, marginBottom: "12px", fontSize: "20px", fontWeight: 700 }}>Lock Demand Plan</h3>
              <p style={{ margin: 0, marginBottom: "24px", color: "#4b5563", lineHeight: 1.5 }}>
                Once locked, the demand values for this plan cannot be edited. The locked values will flow into the Inventory and Brewing tabs as the basis for the rest of your plan. Are you sure you want to continue?
              </p>
              <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
                <button
                  onClick={() => setShowLockDemandModal(false)}
                  style={{ background: "white", color: "#111827", border: "1px solid #d1d5db", borderRadius: "10px", padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  onClick={lockDemandPlan}
                  style={{ background: "#047857", color: "white", border: "none", borderRadius: "10px", padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
                >
                  Lock Demand Plan
                </button>
              </div>
            </div>
          </div>
        )}

      </>
    );
  }

  function renderSummaryTab() {
    const zRatio = getZRatio(globalServiceLevel);

    const inHorizon = (w: number) => w >= 1 && w <= 8;
    const demandChangesProduct = rows
      .filter((r) => r.packaging_format === "ALL" && inHorizon(r.week_number) && r.effective_value != null && r.effective_value !== r.previous_value)
      .sort((a, b) => a.brand.localeCompare(b.brand) || a.week_number - b.week_number);
    const demandChangesPackaging = rows
      .filter((r) => r.packaging_format !== "ALL" && inHorizon(r.week_number) && r.effective_value != null && r.effective_value !== r.previous_value)
      .sort((a, b) => a.brand.localeCompare(b.brand) || a.packaging_format.localeCompare(b.packaging_format) || a.week_number - b.week_number);

    const inventoryChanges = inventoryDB.filter((item) => {
      const calcSS = Number(((item.baseSafetyStock ?? 0) * zRatio).toFixed(2));
      const startEdited = Number(item.startInv).toFixed(2) !== Number(item.originalStartInv).toFixed(2);
      const ssEdited = Number(item.finalSS).toFixed(2) !== calcSS.toFixed(2);
      return startEdited || ssEdited;
    });

    const brewingChanges: Array<{ brand: string; weekIndex: number; weekLabel: string; value: number; suggested: number | null }> = [];
    Object.entries(manualBrewPlan).forEach(([brand, plan]) => {
      Object.entries(plan).forEach(([wkStr, val]) => {
        const wk = Number(wkStr);
        const productRows = brewPlanResult?.productLevelBrewPlan.filter((r) => r.product_id === brand) ?? [];
        const suggested = productRows[wk]?.planned_order_release ?? null;
        brewingChanges.push({ brand, weekIndex: wk, weekLabel: weekLabels[wk] ?? `Wk ${wk + 1}`, value: val, suggested });
      });
    });
    brewingChanges.sort((a, b) => a.brand.localeCompare(b.brand) || a.weekIndex - b.weekIndex);

    const totalDemandBbl = rows
      .filter((r) => r.packaging_format === "ALL" && inHorizon(r.week_number))
      .reduce((s, r) => s + getEffectiveOrForecast(r), 0);
    const brandCount = new Set(rows.map((r) => r.brand)).size;
    const totalBrewBbl = brewPlanResult
      ? brewPlanResult.productLevelBrewPlan.reduce((s, r) => s + r.planned_order_release, 0)
      : 0;
    const brewedProducts = brewPlanResult
      ? new Set(brewPlanResult.productLevelBrewPlan.filter((r) => r.planned_order_release > 0).map((r) => r.product_id)).size
      : 0;
    const totalPackagingUnits = packagingPlanResult
      ? Math.round(packagingPlanResult.packagingPlan.reduce((s, r) => s + r.package_units, 0))
      : 0;
    const totalPackagedBbl = packagingPlanResult
      ? packagingPlanResult.packagingPlan.reduce((s, r) => s + r.allocated_bbl, 0)
      : 0;

    const stageStatuses: Array<{ name: string; lockedAt: string | null }> = [
      { name: "Demand Plan", lockedAt: planWorkflow.demandLockedAt },
      { name: "Inventory Plan", lockedAt: planWorkflow.inventoryLockedAt },
      { name: "Brewing Plan", lockedAt: planWorkflow.brewingLockedAt },
    ];

    const headerCellStyle: React.CSSProperties = {
      textAlign: "left", padding: "12px 16px", borderBottom: "1px solid #e5e7eb",
      fontSize: "12px", fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.04em",
    };
    const numCellStyle: React.CSSProperties = { ...cellStyle, textAlign: "center" };

    const totalChanges = demandChangesProduct.length + demandChangesPackaging.length + inventoryChanges.length + brewingChanges.length;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={chartCardStyle}>
          <h2 style={{ margin: 0, fontSize: "28px", fontWeight: 700 }}>Plan Summary</h2>
          <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>
            Read-only snapshot of the plan you just built — totals, lock status, and every override you made along the way.
          </p>
          <p style={{ marginTop: "12px", marginBottom: 0, color: "#9ca3af", fontSize: "12px" }}>
            Forecast last generated: {latestForecastDate || "—"} · Session: {sessionId || "—"}
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "16px" }}>
          {stageStatuses.map((s) => (
            <div key={s.name} style={overviewMetricCardStyle}>
              <h3 style={{ margin: 0, marginBottom: "8px", fontSize: "15px", fontWeight: 700, color: "#374151" }}>{s.name}</h3>
              {s.lockedAt ? (
                <>
                  <p style={{ margin: 0, color: "#047857", fontWeight: 700, fontSize: "14px" }}>Locked</p>
                  <p style={{ margin: "4px 0 0 0", color: "#6b7280", fontSize: "12px" }}>{formatLockedAt(s.lockedAt)}</p>
                </>
              ) : (
                <p style={{ margin: 0, color: "#b45309", fontWeight: 700, fontSize: "14px" }}>Not yet locked</p>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "16px" }}>
          {renderMetricCard("Demand", [
            `${formatNumber(totalDemandBbl)} BBL`,
            `${brandCount} brands · 8 wks`,
            `Service level ${globalServiceLevel}%`,
          ])}
          {renderMetricCard("Brewing", [
            `${formatNumber(totalBrewBbl)} BBL planned`,
            `${brewedProducts} products to brew`,
            `${BREW_BATCH_SIZE}-BBL batches · ${BREW_LEAD_TIME_WEEKS}-wk lead`,
          ])}
          {renderMetricCard("Packaging", [
            `${totalPackagingUnits.toLocaleString()} units`,
            `${formatNumber(totalPackagedBbl)} BBL packaged`,
          ])}
          {renderMetricCard("Overrides", [
            `${totalChanges} total`,
            `${demandChangesProduct.length + demandChangesPackaging.length} demand`,
            `${inventoryChanges.length} inventory · ${brewingChanges.length} brewing`,
          ])}
        </div>

        <div style={tableCardStyle}>
          <div style={{ padding: "20px 24px", borderBottom: "1px solid #e5e7eb" }}>
            <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Demand Overrides</h3>
            <p style={{ margin: "4px 0 0 0", color: "#6b7280", fontSize: "13px" }}>
              Cells where you overrode the model&apos;s forecast.
            </p>
          </div>
          {demandChangesProduct.length === 0 && demandChangesPackaging.length === 0 ? (
            <p style={{ padding: "20px 24px", margin: 0, color: "#6b7280", fontSize: "14px" }}>No demand overrides.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: "900px", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={headerCellStyle}>Brand</th>
                    <th style={headerCellStyle}>Channel</th>
                    <th style={headerCellStyle}>Packaging</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Week</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Original</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Override</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Δ</th>
                    <th style={headerCellStyle}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {[...demandChangesProduct, ...demandChangesPackaging].map((r, idx) => {
                    const orig = r.previous_value ?? 0;
                    const next = r.effective_value ?? 0;
                    const delta = next - orig;
                    const wkLabel = weekLabels[r.week_number - 1] ?? `Week ${r.week_number}`;
                    return (
                      <tr key={r.id} style={{ background: idx % 2 === 0 ? "white" : "#fcfcfd" }}>
                        <td style={{ ...cellStyle, fontWeight: 600 }}>{r.brand}</td>
                        <td style={cellStyle}>{r.channel}</td>
                        <td style={cellStyle}>{r.packaging_format}</td>
                        <td style={numCellStyle}>{wkLabel}</td>
                        <td style={numCellStyle}>{formatNumber(orig)}</td>
                        <td style={{ ...numCellStyle, fontWeight: 700, color: "#b45309" }}>{formatNumber(next)}</td>
                        <td style={{ ...numCellStyle, fontWeight: 700, color: delta >= 0 ? "#047857" : "#b91c1c" }}>
                          {delta >= 0 ? "+" : ""}{formatNumber(delta)}
                        </td>
                        <td style={{ ...cellStyle, color: "#6b7280", fontSize: "13px" }}>{r.override_rationale || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={tableCardStyle}>
          <div style={{ padding: "20px 24px", borderBottom: "1px solid #e5e7eb" }}>
            <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Inventory Overrides</h3>
            <p style={{ margin: "4px 0 0 0", color: "#6b7280", fontSize: "13px" }}>
              Products where starting inventory or safety stock differs from the calculated baseline.
            </p>
          </div>
          {inventoryChanges.length === 0 ? (
            <p style={{ padding: "20px 24px", margin: 0, color: "#6b7280", fontSize: "14px" }}>No inventory overrides.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: "900px", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={headerCellStyle}>Brand</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Tableau Start</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Override Start</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Calc SS</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Override SS</th>
                  </tr>
                </thead>
                <tbody>
                  {inventoryChanges.map((item, idx) => {
                    const calcSS = Number(((item.baseSafetyStock ?? 0) * zRatio).toFixed(2));
                    const startEdited = Number(item.startInv).toFixed(2) !== Number(item.originalStartInv).toFixed(2);
                    const ssEdited = Number(item.finalSS).toFixed(2) !== calcSS.toFixed(2);
                    return (
                      <tr key={item.name} style={{ background: idx % 2 === 0 ? "white" : "#fcfcfd" }}>
                        <td style={{ ...cellStyle, fontWeight: 600 }}>{item.name}</td>
                        <td style={numCellStyle}>{formatNumber(item.originalStartInv)}</td>
                        <td style={{ ...numCellStyle, fontWeight: startEdited ? 700 : 400, color: startEdited ? "#b45309" : "#111827" }}>
                          {formatNumber(item.startInv)}
                        </td>
                        <td style={numCellStyle}>{formatNumber(calcSS)}</td>
                        <td style={{ ...numCellStyle, fontWeight: ssEdited ? 700 : 400, color: ssEdited ? "#b45309" : "#111827" }}>
                          {formatNumber(item.finalSS)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={tableCardStyle}>
          <div style={{ padding: "20px 24px", borderBottom: "1px solid #e5e7eb" }}>
            <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Brewing Overrides</h3>
            <p style={{ margin: "4px 0 0 0", color: "#6b7280", fontSize: "13px" }}>
              Manual changes to the planned brewing release for individual weeks.
            </p>
          </div>
          {brewingChanges.length === 0 ? (
            <p style={{ padding: "20px 24px", margin: 0, color: "#6b7280", fontSize: "14px" }}>No brewing overrides.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: "700px", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={headerCellStyle}>Brand</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Week</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Suggested (BBL)</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Override (BBL)</th>
                    <th style={{ ...headerCellStyle, textAlign: "center" }}>Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {brewingChanges.map((c, idx) => {
                    const delta = c.suggested == null ? null : c.value - c.suggested;
                    return (
                      <tr key={`${c.brand}-${c.weekIndex}`} style={{ background: idx % 2 === 0 ? "white" : "#fcfcfd" }}>
                        <td style={{ ...cellStyle, fontWeight: 600 }}>{c.brand}</td>
                        <td style={numCellStyle}>{c.weekLabel}</td>
                        <td style={numCellStyle}>{c.suggested == null ? "—" : formatNumber(c.suggested)}</td>
                        <td style={{ ...numCellStyle, fontWeight: 700, color: "#7e22ce" }}>{formatNumber(c.value)}</td>
                        <td style={{ ...numCellStyle, fontWeight: 700, color: delta == null ? "#6b7280" : delta >= 0 ? "#047857" : "#b91c1c" }}>
                          {delta == null ? "—" : `${delta >= 0 ? "+" : ""}${formatNumber(delta)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderMetricCard(title: string, lines: string[], accentLines: number[] = []) {
    return (
      <div style={overviewMetricCardStyle}>
        <h3 style={{ marginTop: 0, marginBottom: "14px", fontSize: "18px", textAlign: "center" }}>{title}</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {lines.map((line, index) => <p key={index} style={{ margin: 0, textAlign: "center", fontSize: index === 0 ? "15px" : "14px", fontWeight: index === 0 ? 700 : 500, color: accentLines.includes(index) ? "#15803d" : "#4b5563" }}>{line}</p>)}
        </div>
      </div>
    );
  }
  function renderPlaceholderPanel(title: string, subtitle: string) {
    return (<div style={overviewPanelStyle}><div style={{ marginBottom: "12px" }}><h3 style={{ margin: 0, fontSize: "18px" }}>{title}</h3><p style={{ margin: 0, color: "#6b7280", fontSize: "13px" }}>{subtitle}</p></div><div style={{ height: "300px", borderRadius: "14px", border: "1px dashed #cbd5e1", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8" }}>Placeholder content</div></div>);
  }

  return (
    <main style={{ minHeight: "100vh", background: "#f7f7f5", padding: "32px 24px 48px 24px", fontFamily: 'Inter, Arial, sans-serif', color: "#111827" }}>
      <div style={{ maxWidth: "1320px", margin: "0 auto" }}>
        <div style={{ marginBottom: "24px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "34px", fontFamily: 'Georgia, "Times New Roman", serif' }}>Brewery Planning App</h1>
            <p style={{ margin: 0, color: "#6b7280" }}>Central Coast Analytics</p>
          </div>
          <button
            onClick={() => { setQuickStartStep(0); setShowQuickStart(true); }}
            style={{ background: "white", color: "#111827", border: "1px solid #d1d5db", borderRadius: "12px", padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
          >
            Quick Start Guide
          </button>
        </div>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "24px", padding: "8px", background: "white", border: "1px solid #e5e7eb", borderRadius: "16px" }}>
          {TABS.map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: "12px 18px", borderRadius: "12px", border: activeTab === tab ? "1px solid #111827" : "1px solid transparent", background: activeTab === tab ? "#111827" : "transparent", color: activeTab === tab ? "white" : "#4b5563", cursor: "pointer", fontWeight: 600 }}>{tab}</button>
          ))}
        </div>

        {loading && <p>Loading...</p>}
        {error && <p style={{ color: "red" }}>Error: {error}</p>}

        {!loading && !error && (
          <>
            {activeTab === "Overview" && renderOverviewTab()}
            {activeTab === "Forecasted Demand" && renderDemandPlanTab()}
            {activeTab === "Inventory" && renderInventoryTab()}
            {activeTab === "Brewing Plan" && renderBrewingTab()}
            {activeTab === "Packaging Plan" && renderPackagingTab()}
            {activeTab === "Plan Summary" && renderSummaryTab()}
          </>
        )}
      </div>

      {showQuickStart && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(17, 24, 39, 0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}>
          <div style={{ background: "white", borderRadius: "16px", padding: "32px", maxWidth: "520px", width: "92%", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <span style={{ fontSize: "13px", color: "#6b7280", fontWeight: 600 }}>Step {quickStartStep + 1} of {QUICK_START_STEPS.length}</span>
              <button onClick={closeQuickStart} style={{ background: "transparent", border: "none", color: "#6b7280", fontSize: "14px", cursor: "pointer", fontWeight: 600 }}>Skip</button>
            </div>
            <h3 style={{ margin: 0, marginBottom: "12px", fontSize: "22px", fontWeight: 700 }}>{QUICK_START_STEPS[quickStartStep].title}</h3>
            <p style={{ margin: 0, marginBottom: "24px", color: "#374151", lineHeight: 1.6, fontSize: "15px" }}>{QUICK_START_STEPS[quickStartStep].body}</p>
            <div style={{ display: "flex", gap: "6px", marginBottom: "24px" }}>
              {QUICK_START_STEPS.map((_, i) => (
                <div key={i} style={{ flex: 1, height: "4px", borderRadius: "2px", background: i <= quickStartStep ? "#111827" : "#e5e7eb" }} />
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <button
                onClick={() => setQuickStartStep((s) => Math.max(0, s - 1))}
                disabled={quickStartStep === 0}
                style={{ background: "white", color: quickStartStep === 0 ? "#d1d5db" : "#111827", border: "1px solid #d1d5db", borderRadius: "10px", padding: "10px 16px", fontWeight: 600, cursor: quickStartStep === 0 ? "not-allowed" : "pointer" }}
              >
                Previous
              </button>
              {quickStartStep < QUICK_START_STEPS.length - 1 ? (
                <button
                  onClick={() => setQuickStartStep((s) => s + 1)}
                  style={{ background: "#111827", color: "white", border: "none", borderRadius: "10px", padding: "10px 20px", fontWeight: 600, cursor: "pointer" }}
                >
                  Next
                </button>
              ) : (
                <button
                  onClick={closeQuickStart}
                  style={{ background: "#047857", color: "white", border: "none", borderRadius: "10px", padding: "10px 20px", fontWeight: 600, cursor: "pointer" }}
                >
                  Get Started
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showLockBrewingModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(17, 24, 39, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "white", borderRadius: "16px", padding: "28px", maxWidth: "440px", width: "92%", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
            <h3 style={{ margin: 0, marginBottom: "12px", fontSize: "20px", fontWeight: 700 }}>Lock Brewing Plan</h3>
            <p style={{ margin: 0, marginBottom: "24px", color: "#4b5563", lineHeight: 1.5 }}>
              Once locked, the Start Brewing schedule cannot be edited. The locked weekly receipts will flow into the Packaging Plan as the basis for SKU-level work orders. Are you sure you want to continue?
            </p>
            <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowLockBrewingModal(false)}
                style={{ background: "white", color: "#111827", border: "1px solid #d1d5db", borderRadius: "10px", padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={lockBrewingPlan}
                style={{ background: "#047857", color: "white", border: "none", borderRadius: "10px", padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
              >
                Lock Brewing Plan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* UNIVERSAL AUDIT MODAL */}
      {pendingEdit && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.25)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fffaf0", border: "2px solid #f59e0b", borderRadius: "18px", padding: "24px", width: "420px", boxShadow: "0 10px 30px rgba(0,0,0,0.15)" }}>
            <h3 style={{ marginTop: 0, marginBottom: "12px", fontSize: "20px", color: "#b45309", fontFamily: 'Georgia, serif' }}>Why? (logged to audit trail)</h3>
            <p style={{ fontSize: '13px', color: '#b45309', marginBottom: '12px', marginTop: 0 }}>
                Modifying {pendingEdit.context === 'inventory' ? (pendingEdit.inventoryField === 'startInv' ? 'Starting Inventory' : 'Safety Stock') : pendingEdit.context === 'brewing' ? 'Brewing Schedule' : 'Demand Plan'} for {pendingEdit.brand}.
            </p>
            <input type="text" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="e.g., cycle count adjustment" style={{ width: "100%", padding: "12px", borderRadius: "10px", border: "1px solid #d1d5db", fontSize: "16px", marginBottom: "16px" }} />
            <div style={{ display: "flex", gap: "12px" }}>
              <button onClick={savePendingEdit} style={{ background: "#f59e0b", color: "white", border: "none", borderRadius: "10px", padding: "10px 18px", fontWeight: 600, cursor: "pointer" }}>Save</button>
              <button onClick={() => { setPendingEdit(null); setOverrideReason(""); setCancelTick(c => c + 1); }} style={{ background: "white", color: "#6b7280", border: "1px solid #d1d5db", borderRadius: "10px", padding: "10px 18px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// --- CSS CONSTANTS (SAANIKA'S DESIGN) ---
const filterCardStyle: React.CSSProperties = { background: "white", border: "1px solid #e5e7eb", borderRadius: "16px", padding: "16px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)", marginBottom: "20px" };
const labelStyle: React.CSSProperties = { display: "block", marginBottom: "8px", fontWeight: 600, fontSize: "14px" };
const selectStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: "10px", border: "1px solid #d1d5db", fontSize: "14px", background: "white" };
const chartCardStyle: React.CSSProperties = { background: "white", border: "1px solid #e5e7eb", borderRadius: "20px", padding: "24px", marginBottom: "20px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" };
const tableCardStyle: React.CSSProperties = { background: "white", border: "1px solid #e5e7eb", borderRadius: "20px", overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.03)", marginBottom: "20px" };
const cellStyle: React.CSSProperties = { padding: "14px 16px", borderBottom: "1px solid #f1f5f9", verticalAlign: "middle", fontSize: "14px" };
const inputStyle: React.CSSProperties = { width: "90px", padding: "8px 10px", borderRadius: "10px", border: "1px solid #d1d5db", fontSize: "13px", background: "white" };
const overviewGridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "260px minmax(0, 1fr)", gap: "20px", alignItems: "start" };
const overviewLeftColumnStyle: React.CSSProperties = { display: "grid", gap: "16px" };
const overviewMainGridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "20px", alignItems: "start" };
const overviewMetricCardStyle: React.CSSProperties = { background: "white", border: "1px solid #e5e7eb", borderRadius: "20px", padding: "24px 18px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" };
const overviewPanelStyle: React.CSSProperties = { background: "white", border: "1px solid #e5e7eb", borderRadius: "20px", padding: "20px 24px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" };