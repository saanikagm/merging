"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { generateCapacityPlan } from './capacityPlanning';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";

// --- TYPES ---
type DemandPlanRow = {
  id: string; brand: string; channel: string; packaging_format: string;
  week_number: number; year: number; previous_value: number | null;
  effective_value: number | null; session_id: string;
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

// UPGRADED: Added originalStartInv to track visual overrides
type InventoryRow = {
  name: string; startInv: number; originalStartInv: number; baseSafetyStock: number; finalSS: number;
};

// UPGRADED: Added inventoryField to differentiate between Starting Inv and Safety Stock audits
type PendingAudit = {
  context: "demand" | "inventory" | "brewing";
  brand: string;
  newValue: string;
  demandPivotRow?: PivotRow;
  weekNumber?: number;
  inventoryField?: "startInv" | "finalSS";
};

const TABS = ["Overview", "Forecasted Demand", "Inventory", "Brewing Plan", "Packaging Plan - Coming Soon", "Allocation Plan - Coming Soon"] as const;
type TabName = (typeof TABS)[number];

// --- HELPER MATH ---
function getEffectiveOrForecast(row: DemandPlanRow) { return row.effective_value ?? row.previous_value ?? 0; }
function formatNumber(value: number | null | undefined) { return value == null ? "" : Number(value).toFixed(2).replace(/\.00$/, ""); }
function getZRatio(sl: number) { return sl === 99 ? 2.33 / 1.645 : sl === 90 ? 1.28 / 1.645 : sl === 85 ? 1.04 / 1.645 : 1.0; }

// --- UNIT CONVERSION (BBL → CE) ---
// Ratios derived from CE-per-unit / BBL-per-unit in the brewery's reference table.
// For packaging types not in the map (or "ALL" rows), fall back to the industry
// standard 1 BBL = 13.78 CE.
const CE_PER_BBL_DEFAULT = 13.78;
const CE_PER_BBL: Record<string, number> = {
  "Keg - 50L": 5.87 / 0.426,
  "Keg - 20L - Petainer": 2.32 / 0.168,
  "Keg - GCT - One Way": 2.30 / 0.167,
  "Keg - Sixtel": 2.30 / 0.167,
  "Keg - GCT Sixtel": 2.30 / 0.167,
  "Case - 6x4 - 16oz - Can": 1.34 / 0.097,
  "Case - 24x - 12oz - Can": 1.00 / 0.073,
  "Case - 6x4 - 12oz - Can": 1.00 / 0.073,
  "Case - 4x6 - 12oz - Can": 1.00 / 0.073,
  "Single - 12oz - Can": 1.00 / 0.073,
  "Case - 12x - 19.2oz - Can": 0.80 / 0.058,
  "Case - 12x - 16oz - Can": 0.66 / 0.048,
  "Keg - 1/2 bbl": 6.89 / 0.500,
  "Keg - 1/4 bbl": 3.45 / 0.250,
  "Keg - 1/6 bbl": 2.30 / 0.167,
  "Keg - 1/2 BBL KLPPF": 6.89 / 0.500,
  "Keg - 1/6 BBL KLPPF": 2.30 / 0.167,
  "Case - 2x12 - 12oz - Can": 1.00 / 0.073,
  "Case - 12x - 500ml - Bottle": 0.70 / 0.051,
  "Case - 24x - 16oz - Can": 1.34 / 0.097,
  "Single - Magnum 1.5 L": 0.18 / 0.013,
};
function convertBblTo(value: number, packaging: string, unit: "BBL" | "CE"): number {
  if (unit === "BBL") return value;
  const ratio = CE_PER_BBL[packaging] ?? CE_PER_BBL_DEFAULT;
  return value * ratio;
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
      body: "This tool helps you build a weekly Sales, Inventory & Operations plan. You'll move through four tabs in order: Overview, Forecasted Demand, Inventory, and Brewing Plan. Each stage locks before the next one starts.",
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

  async function refreshInventoryFromTableau() {
    if (refreshingInventory) return;
    setRefreshingInventory(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_FORECAST_API_URL || "http://localhost:8000";
      const apiKey = process.env.NEXT_PUBLIC_FORECAST_API_KEY || "";
      const invRes = await fetch(`${apiUrl}/inventory`, { headers: { "X-API-Key": apiKey } });
      if (!invRes.ok) throw new Error(`Inventory fetch failed: ${invRes.status}`);
      const invJson = await invRes.json();
      const tableauRows: Array<Record<string, string>> = invJson.rows || [];
      const totalsByProduct: Record<string, number> = {};
      tableauRows.forEach((r) => {
        const name = r.ProductName || "Unknown";
        const vol = Number(r["Inventory Volume"] || 0);
        if (!Number.isFinite(vol)) return;
        totalsByProduct[name] = (totalsByProduct[name] || 0) + vol;
      });
      setInventoryDB((prev) => prev.map((item) => {
        const fresh = totalsByProduct[item.name];
        if (fresh === undefined) return item;
        const rounded = Number(fresh.toFixed(2));
        return { ...item, startInv: rounded, originalStartInv: rounded };
      }));
    } catch (e) {
      console.error("Inventory refresh failed:", e);
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

  // Demand Plan chart filters (independent from table filters)
  const [chartBrand, setChartBrand] = useState("");
  const [chartChannel, setChartChannel] = useState("");
  const [chartPackaging, setChartPackaging] = useState("");
  const demandChartRef = useRef<HTMLDivElement>(null);

  // Operations States
  const [globalServiceLevel, setGlobalServiceLevel] = useState(95);
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

      // Fetch all historical demand for the chart (filter client-side because
      // the Date column may be stored as text in M/D/YYYY format).
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

      const apiUrl = process.env.NEXT_PUBLIC_FORECAST_API_URL || "http://localhost:8000";
      const apiKey = process.env.NEXT_PUBLIC_FORECAST_API_KEY || "";
      const totalsByProduct: Record<string, number> = {};
      try {
        const invRes = await fetch(`${apiUrl}/inventory`, { headers: { "X-API-Key": apiKey } });
        if (!invRes.ok) throw new Error(`Inventory fetch failed: ${invRes.status}`);
        const invJson = await invRes.json();
        const tableauRows: Array<Record<string, string>> = invJson.rows || [];
        tableauRows.forEach((r) => {
          const name = r.ProductName || "Unknown";
          const vol = Number(r["Inventory Volume"] || 0);
          if (!Number.isFinite(vol)) return;
          totalsByProduct[name] = (totalsByProduct[name] || 0) + vol;
        });
      } catch (e) {
        console.error("Tableau inventory fetch error:", e);
      }

      // Compute per-product weekly standard deviation from historical sales.
      const weeklyByProduct: Record<string, Record<string, number>> = {};
      fetchedHist.forEach((r) => {
        const d = new Date(r.Date);
        if (Number.isNaN(d.getTime())) return;
        const year = d.getUTCFullYear();
        const start = Date.UTC(year, 0, 1);
        const week = Math.floor((d.getTime() - start) / (7 * 24 * 3600 * 1000)) + 1;
        const bucket = `${year}-${week}`;
        const name = r.ProductName || "Unknown";
        weeklyByProduct[name] ||= {};
        weeklyByProduct[name][bucket] = (weeklyByProduct[name][bucket] || 0) + (Number(r["Sales Vol"]) || 0);
      });

      function stdDev(values: number[]): number {
        if (values.length < 2) return 0;
        const mean = values.reduce((s, v) => s + v, 0) / values.length;
        const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
        return Math.sqrt(variance);
      }

      function baseSSFor(product: string): number {
        const buckets = weeklyByProduct[product];
        if (!buckets) return 10;
        const vals = Object.values(buckets);
        const sigma = stdDev(vals);
        return Number(sigma.toFixed(2)) || 10;
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
      if (sortedInv.length > 0) setSelectedOpsProduct(sortedInv[0].name);

      setLoading(false);
    }
    loadData();
  }, [sessionId]);

  // --- MEMOS (SAANIKA) ---
  const products = useMemo(() => [...new Set([...rows.map(r => r.brand), ...inventoryDB.map(i => i.name)])].filter(Boolean).sort(), [rows, inventoryDB]);
  const channels = useMemo(() => [...new Set(rows.map((r) => r.channel))].sort(), [rows]);
  const packagingFormats = useMemo(() => [...new Set(rows.map((r) => r.packaging_format))].sort(), [rows]);

  const filteredRows = useMemo(() => rows.filter((row) => (!productFilter || row.brand === productFilter) && (!channelFilter || row.channel === channelFilter) && (!packagingFilter || row.packaging_format === packagingFilter)), [rows, productFilter, channelFilter, packagingFilter]);

  const weekLabels = useMemo(() => Array.from({ length: 8 }, (_, i) => { const d = new Date(getNextMonday()); d.setDate(d.getDate() + i * 7); return formatWeekLabel(d); }), []);

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
      // Handle "M/D/YYYY", "MM/DD/YYYY", or ISO "YYYY-MM-DD"
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

    // Find the most recent COMPLETE historical week. The backend drops the
    // latest date as incomplete (matches the CSV cleaner). We do the same so
    // the chart anchors on real, fully-recorded weeks.
    const histDateSet = new Set<string>();
    historicalRows.forEach((r) => {
      const k = normalize(r.Date);
      if (k) histDateSet.add(k);
    });
    const sortedHistDates = Array.from(histDateSet).sort();
    const usableHistDates = sortedHistDates.slice(0, -1); // drop most recent (incomplete)

    let histEnd: Date | null = null;
    if (usableHistDates.length > 0) {
      const last = usableHistDates[usableHistDates.length - 1];
      const [y, m, d] = last.split("-").map(Number);
      histEnd = new Date(y, m - 1, d);
      histEnd.setHours(0, 0, 0, 0);
    }
    // Forecast starts the Monday immediately after the last complete historical week
    const forecastStart = histEnd
      ? (() => { const d = new Date(histEnd); d.setDate(d.getDate() + 7); return d; })()
      : getNextMonday();

    const data: Array<{ week: string; historical: number | null; forecastOriginal: number | null; forecastAdjusted: number | null }> = [];

    // 8 historical weeks ending at histEnd (inclusive)
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
          // Convert per-row using the row's actual packaging type so the sum
          // stays accurate regardless of which packagings are aggregated.
          total += convertBblTo(bbl, r.PackagingTypeName, unitMode);
        });
        data.push({ week: formatWeekLabel(d), historical: total, forecastOriginal: null, forecastAdjusted: null });
      }
    }

    // Next 8 forecast weeks
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
    return Object.values(grouped).sort((a, b) => a.brand.localeCompare(b.brand));
  }, [rows]);

  // --- MEMOS (OPERATIONS) ---
  const enrichedInventoryDB = useMemo(() => {
    return inventoryDB.map(inv => {
        const prod = productLevelRows.find(p => p.brand === inv.name);
        const totalD = prod ? (prod.Week1 + prod.Week2 + prod.Week3 + prod.Week4 + prod.Week5 + prod.Week6 + prod.Week7 + prod.Week8) : 0;
        return { ...inv, avgDemand: totalD / 8 };
    });
  }, [productLevelRows, inventoryDB]);

  const MAX_CAPACITY = 500;
  const WARNING_THRESHOLD = 400;

  const masterSchedule = useMemo(() => {
      const weeklyTotals = [0,0,0,0,0,0];
      const productBreakdown: Record<string, number[]> = {};
      let hasWarning = false;

      products.forEach(p => {
          const prod = productLevelRows.find(r => r.brand === p) || { Week1: 0, Week2: 0, Week3: 0, Week4: 0, Week5: 0, Week6: 0, Week7: 0, Week8: 0 };
          const wf = [prod.Week1, prod.Week2, prod.Week3, prod.Week4, prod.Week5, prod.Week6, prod.Week7, prod.Week8];
          const inv = inventoryDB.find(i => i.name === p) || { startInv: 0, finalSS: 10 };
          const manuals = manualBrewPlan[p] || {};

          const plan = generateCapacityPlan(p, wf, inv.startInv, inv.finalSS, manuals);
          productBreakdown[p] = plan.plannedRelease;
          plan.plannedRelease.forEach((r, i) => weeklyTotals[i] += r);
      });

      weeklyTotals.forEach(t => { if (t > WARNING_THRESHOLD) hasWarning = true; });
      return { weeklyTotals, productBreakdown, hasWarning };
  }, [products, productLevelRows, inventoryDB, manualBrewPlan]);

  const opsProductData = useMemo(() => {
    if (!selectedOpsProduct || inventoryDB.length === 0) return null;
    const prod = productLevelRows.find(p => p.brand === selectedOpsProduct);
    const wf = prod ? [prod.Week1, prod.Week2, prod.Week3, prod.Week4, prod.Week5, prod.Week6, prod.Week7, prod.Week8] : [0,0,0,0,0,0,0,0];
    const inv = inventoryDB.find(i => i.name === selectedOpsProduct) || { startInv: 0, finalSS: 10 };
    return { name: selectedOpsProduct, forecasts: wf, startInv: inv.startInv, finalSS: inv.finalSS, manualReleases: manualBrewPlan[selectedOpsProduct] || {} };
  }, [productLevelRows, selectedOpsProduct, inventoryDB, manualBrewPlan]);

  // --- ACTIONS & AUDITS ---
  const handleGlobalSLChange = (newSL: number) => {
    setGlobalServiceLevel(newSL);
    const z = getZRatio(newSL);
    setInventoryDB(prev => prev.map(item => ({ ...item, finalSS: Number((item.baseSafetyStock * z).toFixed(2)) })));
  };

  // UPGRADED: Starting Inventory now routes straight to the Audit Modal
  const handleInventoryUpdate = (name: string, field: "startInv" | "finalSS", value: string) => {
      setPendingEdit({ context: 'inventory', brand: name, newValue: value, inventoryField: field });
  };

  const handleBrewUpdate = (brand: string, weekIndex: number, value: string) => {
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
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.map(escape).join(",")];
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
      lines.push(cells.map(escape).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `demand-plan-${demandViewLevel}-${unitMode.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
        // UPGRADED: Handles dynamic saving of both startInv and finalSS
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


  // --- RENDERERS ---
  function renderOverviewTab() {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={chartCardStyle}>
          <h2 style={{ margin: 0, fontSize: "28px", fontWeight: 700 }}>Overview</h2>
          <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>Snapshot of the current demand forecast and effective demand plan.</p>
          <p style={{ marginTop: "12px", marginBottom: 0, color: "#9ca3af", fontSize: "12px" }}>
            Forecast last generated: {latestForecastDate || "—"} · Inventory last refreshed: pulled live from Tableau on page load
          </p>
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
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={chartCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: "28px", fontWeight: 700 }}>Inventory Parameters</h2>
                <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>Adjust global service levels or override specific safety stock buffers.</p>
              </div>
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                <button
                  onClick={refreshInventoryFromTableau}
                  disabled={refreshingInventory || !!planWorkflow.inventoryLockedAt}
                  style={{ background: refreshingInventory || planWorkflow.inventoryLockedAt ? "#6b7280" : "#111827", color: "white", border: "none", borderRadius: "12px", padding: "12px 18px", fontWeight: 600, cursor: refreshingInventory ? "wait" : planWorkflow.inventoryLockedAt ? "not-allowed" : "pointer" }}
                >
                  {refreshingInventory ? "Refreshing..." : "Refresh Inventory from Tableau"}
                </button>
                {!planWorkflow.inventoryLockedAt && (
                  <button
                    onClick={() => setShowLockInventoryModal(true)}
                    style={{ background: "#047857", color: "white", border: "none", borderRadius: "12px", padding: "12px 18px", fontWeight: 600, cursor: "pointer" }}
                  >
                    Lock Inventory Plan
                  </button>
                )}
                {planWorkflow.inventoryLockedAt && (
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0", borderRadius: "12px", padding: "12px 18px", fontWeight: 600 }}>
                    Inventory Plan Locked — {formatLockedAt(planWorkflow.inventoryLockedAt)}
                  </div>
                )}
              </div>
            </div>
        </div>

        <div style={{...filterCardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
            <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>Global Target Service Level</h3>
                <p style={{ margin: 0, color: "#6b7280", fontSize: "13px" }}>Recalculates safety stock targets for ALL products.</p>
            </div>
            <select value={globalServiceLevel} disabled={!!planWorkflow.inventoryLockedAt} onChange={(e) => handleGlobalSLChange(Number(e.target.value))} style={{...selectStyle, width: '200px', fontWeight: 'bold', cursor: planWorkflow.inventoryLockedAt ? 'not-allowed' : 'pointer', background: planWorkflow.inventoryLockedAt ? '#f3f4f6' : undefined }}>
                <option value={85}>85% - Lean</option>
                <option value={90}>90% - Moderate</option>
                <option value={95}>95% - Standard</option>
                <option value={99}>99% - Conservative</option>
            </select>
        </div>

        <div style={tableCardStyle}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: "900px", borderCollapse: "collapse" }}>
                <thead>
                    <tr style={{ background: "#f8fafc" }}>
                        <th style={{ textAlign: "left", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#374151" }}>Brand</th>
                        <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#374151" }}>Starting Inv</th>
                        <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#9ca3af" }}>Avg Demand</th>
                        <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#2563eb" }}>Calculated SS</th>
                        <th style={{ textAlign: "center", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", fontWeight: 700, color: "#7e22ce", background: "#f3e8ff" }}>Audited Final SS</th>
                    </tr>
                </thead>
                <tbody>
                    {enrichedInventoryDB.map((item, index) => {
                        const calcSS = item.baseSafetyStock * getZRatio(globalServiceLevel);
                        const isSSAudited = item.finalSS !== Number(calcSS.toFixed(2));
                        const isInvAudited = item.startInv !== item.originalStartInv; // Visual check for Starting Inventory overrides

                        return (
                            <tr key={item.name} style={{ background: index % 2 === 0 ? "white" : "#fcfcfd" }}>
                                <td style={{...cellStyle, fontWeight: 'bold'}}>{item.name}</td>

                                {/* UPGRADED: Starting Inventory is now fully auditable and visually highlights amber when changed */}
                                <td style={{...cellStyle, textAlign: 'center'}}>
                                    <input
                                        key={`inv-${item.name}-${item.startInv}-${cancelTick}`}
                                        type="number"
                                        defaultValue={item.startInv}
                                        disabled={!!planWorkflow.inventoryLockedAt}
                                        onBlur={(e) => {
                                            if (planWorkflow.inventoryLockedAt) return;
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

                                <td style={{...cellStyle, textAlign: 'center', color: '#6b7280'}}>{formatNumber(item.avgDemand)}</td>
                                <td style={{...cellStyle, textAlign: 'center', color: '#2563eb', fontWeight: 'bold'}}>{formatNumber(calcSS)}</td>
                                <td style={{...cellStyle, textAlign: 'center', background: '#f3e8ff'}}>
                                    <input
                                        key={`ss-${item.name}-${item.finalSS}-${cancelTick}`}
                                        type="number"
                                        defaultValue={item.finalSS}
                                        disabled={!!planWorkflow.inventoryLockedAt}
                                        onBlur={(e) => {
                                            if (planWorkflow.inventoryLockedAt) return;
                                            if (e.target.value !== "" && Number(e.target.value) !== item.finalSS) {
                                                handleInventoryUpdate(item.name, 'finalSS', e.target.value);
                                            }
                                        }}
                                        style={{...inputStyle, textAlign: 'center', fontWeight: 'bold', color: isSSAudited ? '#b45309' : '#7e22ce', border: isSSAudited ? '2px solid #f59e0b' : '1px solid #d1d5db'}}
                                    />
                                </td>
                            </tr>
                        )
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

  function renderBrewingTab() {
    if (!masterSchedule || !opsProductData) return null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>

        <div style={{...chartCardStyle, background: "#111827", color: "white"}}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px" }}>
                <div>
                    <h2 style={{ margin: 0, fontSize: "22px", fontWeight: 700 }}>Facility Load vs Capacity</h2>
                    {masterSchedule.hasWarning && <p style={{ color: "#f87171", fontSize: "14px", marginTop: "4px", margin: 0 }}>⚠️ WARNING: Approaching absolute limit of {MAX_CAPACITY} bbls.</p>}
                </div>
                <span style={{ color: "#a78bfa", fontWeight: 'bold', fontSize: "18px" }}>{MAX_CAPACITY} bbl max</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '16px', marginTop: '20px' }}>
                {masterSchedule.weeklyTotals.map((total, i) => {
                    const isOver = total > WARNING_THRESHOLD;
                    return (
                        <div key={i} style={{ padding: '16px', borderRadius: '12px', background: isOver ? '#450a0a' : '#1e293b', border: isOver ? '1px solid #7f1d1d' : '1px solid #334155', textAlign: 'center' }}>
                            <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px' }}>{weekLabels[i]}</div>
                            <div style={{ fontSize: '24px', fontWeight: 'black', color: isOver ? '#f87171' : '#34d399' }}>{total}</div>
                            <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold', marginTop: '4px' }}>{Math.round((total/MAX_CAPACITY)*100)}% Full</div>
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
                            {generateCapacityPlan(opsProductData.name, opsProductData.forecasts, opsProductData.startInv, opsProductData.finalSS, opsProductData.manualReleases).forecasts.map((f, i) => <td key={i} style={{...cellStyle, textAlign: 'center', color: '#dc2626'}}>{formatNumber(f)}</td>)}
                        </tr>
                        <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{...cellStyle, color: '#16a34a', fontWeight: 'bold'}}>➕ Brews Arriving</td>
                            <td style={cellStyle}>-</td>
                            {generateCapacityPlan(opsProductData.name, opsProductData.forecasts, opsProductData.startInv, opsProductData.finalSS, opsProductData.manualReleases).plannedReceipt.map((r, i) => <td key={i} style={{...cellStyle, textAlign: 'center', color: '#16a34a', fontWeight: 'bold'}}>{r > 0 ? r : '-'}</td>)}
                        </tr>
                        <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                            <td style={{...cellStyle, fontWeight: 'bold'}}>📦 Ending Inventory</td>
                            <td style={{...cellStyle, textAlign: 'center', fontWeight: 'bold'}}>{formatNumber(opsProductData.startInv)}</td>
                            {generateCapacityPlan(opsProductData.name, opsProductData.forecasts, opsProductData.startInv, opsProductData.finalSS, opsProductData.manualReleases).projAvailable.map((p, i) => <td key={i} style={{...cellStyle, textAlign: 'center', fontWeight: 'bold', color: p < opsProductData.finalSS ? '#dc2626' : '#111827'}}>{formatNumber(p)}</td>)}
                        </tr>
                        <tr style={{ background: '#f3e8ff', borderBottom: '2px solid #d8b4fe' }}>
                            <td style={{...cellStyle, fontWeight: '900', color: '#7e22ce', fontSize: '15px'}}>⚙️ ACTION: Start Brewing</td>
                            <td style={cellStyle}>-</td>
                            {generateCapacityPlan(opsProductData.name, opsProductData.forecasts, opsProductData.startInv, opsProductData.finalSS, opsProductData.manualReleases).plannedRelease.map((r, i) => {
                                const isManual = opsProductData.manualReleases[i] !== undefined;
                                const currentVal = isManual ? opsProductData.manualReleases[i] : "";
                                return (
                                    <td key={i} style={{ padding: '8px', textAlign: 'center' }}>
                                        <input
                                            key={`brew-${opsProductData.name}-${i}-${currentVal}-${cancelTick}`}
                                            type="number"
                                            defaultValue={currentVal}
                                            placeholder={r > 0 ? String(r) : "-"}
                                            onBlur={(e) => {
                                                const val = e.target.value;
                                                if (String(val) !== String(currentVal)) {
                                                    handleBrewUpdate(opsProductData.name, i, val);
                                                }
                                            }}
                                            style={{...inputStyle, textAlign: 'center', fontWeight: '900', fontSize: '15px', color: '#7e22ce', border: isManual ? '2px solid #f59e0b' : '1px solid transparent', background: isManual ? '#fef3c7' : 'transparent'}}
                                        />
                                    </td>
                                )
                            })}
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
      </div>
    );
  }

  // --- RENDER DEMAND PLAN (SAANIKA'S CODE UNCHANGED) ---
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
                                        // Convert displayed unit back to BBL for storage
                                        const enteredBbl = unitMode === "CE" ? enteredDisplay / ratio : enteredDisplay;
                                        const currentBbl = rawBbl == null || rawBbl === "" ? null : Number(rawBbl);
                                        // Compare in BBL space with a tiny tolerance to avoid float noise
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
            {(activeTab === "Packaging Plan - Coming Soon" || activeTab === "Allocation Plan - Coming Soon") && <div style={chartCardStyle}><h2>{activeTab}</h2><p>Coming Soon</p></div>}
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