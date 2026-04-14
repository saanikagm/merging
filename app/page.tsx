"use client";

import { useEffect, useMemo, useState } from "react";
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

const TABS = ["Overview", "Demand Plan", "Inventory", "Brewing Plan", "Packaging Plan", "Allocation Plan"] as const;
type TabName = (typeof TABS)[number];

// --- HELPER MATH ---
function getEffectiveOrForecast(row: DemandPlanRow) { return row.effective_value ?? row.previous_value ?? 0; }
function formatNumber(value: number | null | undefined) { return value == null ? "" : Number(value).toFixed(2).replace(/\.00$/, ""); }
function getZRatio(sl: number) { return sl === 99 ? 2.33 / 1.645 : sl === 90 ? 1.28 / 1.645 : sl === 85 ? 1.04 / 1.645 : 1.0; }

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
  const [activeTab, setActiveTab] = useState<TabName>("Demand Plan");
  const [rows, setRows] = useState<DemandPlanRow[]>([]);
  const [inventoryDB, setInventoryDB] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [sessionId, setSessionId] = useState("");
  const [latestForecastDate, setLatestForecastDate] = useState<string | null>(null);
  const [showDemandContent, setShowDemandContent] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const [productFilter, setProductFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [packagingFilter, setPackagingFilter] = useState("");
  const [demandViewLevel, setDemandViewLevel] = useState<"packaging" | "product">("packaging");

  // Operations States
  const [globalServiceLevel, setGlobalServiceLevel] = useState(95);
  const [selectedOpsProduct, setSelectedOpsProduct] = useState("");
  const [manualBrewPlan, setManualBrewPlan] = useState<Record<string, Record<number, number>>>({});

  // Universal Audit State
  const [pendingEdit, setPendingEdit] = useState<PendingAudit | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [cancelTick, setCancelTick] = useState(0);

  // --- DATA FETCHING ---
  useEffect(() => {
    async function fetchLatestSession() {
      const { data } = await supabase.from("planning_sessions").select("id, created_at").order("created_at", { ascending: false }).limit(1).single();
      if (data) {
        setSessionId(data.id);
        setLatestForecastDate(new Date(data.created_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }));
      }
    }
    fetchLatestSession();
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    async function loadData() {
      setLoading(true);

      const { data: demandData, error: demandErr } = await supabase.from("demand_plans").select("*").eq("session_id", sessionId);
      if (demandErr) { setError(demandErr.message); setLoading(false); return; }
      const fetchedDemand = (demandData || []) as DemandPlanRow[];
      setRows(fetchedDemand);

      const { data: invData, error: invErr } = await supabase.from("inventory").select("*");
      if (invErr) { console.error("Inventory fetch error:", invErr.message); }

      const rawInv = invData || [];
      const initialInv = rawInv.map((item: any) => {
          const start = Number(item.startInv ?? item.starting_inventory ?? item.inventory_bbl ?? item.inventory ?? 0);
          const ss = Number(item.safetyStock ?? item.safety_stock ?? item.baseSafetyStock ?? 10);
          return {
              name: item.name || item.ProductName || item.brand || "Unknown",
              startInv: start,
              originalStartInv: start, // Baseline for visual highlight comparison
              baseSafetyStock: ss,
              finalSS: ss
          };
      });

      const uniqueDemandBrands = [...new Set(fetchedDemand.map(r => r.brand))];
      uniqueDemandBrands.forEach(brand => {
          if (!initialInv.find(i => i.name === brand)) {
              initialInv.push({ name: brand, startInv: 0, originalStartInv: 0, baseSafetyStock: 10, finalSS: 10 });
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
    const map: any = {};
    for (let w = 1; w <= 8; w++) map[w] = { week: weekLabels[w - 1], forecast: 0, effective: 0 };
    filteredRows.forEach((r) => {
      if (r.week_number >= 1 && r.week_number <= 8) {
        map[r.week_number].forecast += r.previous_value ?? 0;
        map[r.week_number].effective += getEffectiveOrForecast(r);
      }
    });
    return Object.values(map);
  }, [filteredRows, weekLabels]);

  const pivotRows = useMemo(() => {
    const grouped: Record<string, PivotRow> = {};
    filteredRows.forEach((r) => {
      const key = `${r.brand}||${r.channel}||${r.packaging_format}`;
      if (!grouped[key]) grouped[key] = { key, brand: r.brand, channel: r.channel, packaging_format: r.packaging_format, Week1: null, Week2: null, Week3: null, Week4: null, Week5: null, Week6: null, Week7: null, Week8: null };
      if (r.week_number >= 1 && r.week_number <= 8) grouped[key][`Week${r.week_number}` as keyof PivotRow] = getEffectiveOrForecast(r) as never;
    });
    return Object.values(grouped);
  }, [filteredRows]);

  const productLevelRows = useMemo(() => {
    const grouped: Record<string, ProductLevelRow> = {};
    filteredRows.forEach((r) => {
      if (!grouped[r.brand]) grouped[r.brand] = { brand: r.brand, Week1: 0, Week2: 0, Week3: 0, Week4: 0, Week5: 0, Week6: 0, Week7: 0, Week8: 0 };
      if (r.week_number >= 1 && r.week_number <= 8) (grouped[r.brand][`Week${r.week_number}` as keyof ProductLevelRow] as number) += getEffectiveOrForecast(r);
    });
    return Object.values(grouped).sort((a, b) => a.brand.localeCompare(b.brand));
  }, [filteredRows]);

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
          setPendingEdit({ context: 'brewing', brand, weekIndex, newValue: value });
      }
  };

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
        </div>
        <div style={overviewGridStyle}>
          <div style={overviewLeftColumnStyle}>
            {renderMetricCard("Demand Plan", [`${formatNumber(chartData.reduce((s, r) => s + r.effective, 0))} Total BBL`, `Avg BBL Weekly`], [2, 3])}
            {renderMetricCard("Inventory Plan", ["4.4 WOH Avg", "-0.2 - 10.0 WOH Range", "6% Weeks Above Target"])}
          </div>
          <div style={overviewMainGridStyle}>
            <div style={overviewPanelStyle}>
              <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Weekly Forecast Demand</h3>
              <div style={{ width: "100%", height: 300, marginTop: "12px" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="week" /><YAxis /><Tooltip /><Legend /><Line type="monotone" dataKey="forecast" stroke="#94a3b8" strokeWidth={3} dot={{ r: 3 }} /><Line type="monotone" dataKey="effective" stroke="#2563eb" strokeWidth={3} dot={{ r: 4 }} /></LineChart>
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
            <h2 style={{ margin: 0, fontSize: "28px", fontWeight: 700 }}>Inventory Parameters</h2>
            <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>Adjust global service levels or override specific safety stock buffers.</p>
        </div>

        <div style={{...filterCardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
            <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>Global Target Service Level</h3>
                <p style={{ margin: 0, color: "#6b7280", fontSize: "13px" }}>Recalculates safety stock targets for ALL products.</p>
            </div>
            <select value={globalServiceLevel} onChange={(e) => handleGlobalSLChange(Number(e.target.value))} style={{...selectStyle, width: '200px', fontWeight: 'bold'}}>
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
                                        onBlur={(e) => {
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
                                        onBlur={(e) => {
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
            <h2 style={{ margin: 0, fontSize: "28px", fontWeight: 700 }}>Demand Plan</h2>
            <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>Current session: {sessionId}</p>
          </div>
          <div style={{ display: "flex", gap: "12px", marginTop: "20px" }}>
            <button onClick={() => setShowDemandContent(true)} style={{ background: "#111827", color: "white", border: "none", borderRadius: "12px", padding: "12px 18px", fontWeight: 600, cursor: "pointer" }}>Load Latest Forecast</button>
          </div>
        </div>

        {showDemandContent && (
          <div style={tableCardStyle}>
            <div style={{ padding: "24px" }}><h3 style={{ margin: 0 }}>Editable Demand Table</h3></div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: "1200px", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    {["Brand", "Channel", "Packaging", ...weekLabels].map((h) => <th key={h} style={{ textAlign: "left", padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", color: "#374151" }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {pivotRows.map((row, index) => (
                    <tr key={row.key} style={{ background: index % 2 === 0 ? "white" : "#fcfcfd" }}>
                      <td style={cellStyle}>{row.brand}</td><td style={cellStyle}>{row.channel}</td><td style={cellStyle}>{row.packaging_format}</td>
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((w) => {
                          const currentVal = row[`Week${w}` as keyof PivotRow] ?? "";
                          return (
                            <td key={w} style={cellStyle}>
                                <input
                                    key={`demand-${row.key}-${w}-${currentVal}-${cancelTick}`}
                                    type="number"
                                    defaultValue={currentVal}
                                    onBlur={(e) => {
                                        if(e.target.value !== "" && String(e.target.value) !== String(currentVal)) {
                                            setPendingEdit({ context: 'demand', demandPivotRow: row, weekNumber: w, newValue: e.target.value, brand: row.brand })
                                        }
                                    }}
                                    style={inputStyle}
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
        <div style={{ marginBottom: "24px" }}><h1 style={{ margin: 0, fontSize: "34px", fontFamily: 'Georgia, "Times New Roman", serif' }}>Brewery Planning App</h1><p style={{ margin: 0, color: "#6b7280" }}>Central Coast Analytics</p></div>

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
            {activeTab === "Demand Plan" && renderDemandPlanTab()}
            {activeTab === "Inventory" && renderInventoryTab()}
            {activeTab === "Brewing Plan" && renderBrewingTab()}
            {(activeTab === "Packaging Plan" || activeTab === "Allocation Plan") && <div style={chartCardStyle}><h2>{activeTab}</h2><p>Coming Soon</p></div>}
          </>
        )}
      </div>

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