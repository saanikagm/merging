"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";

type DemandPlanRow = {
  id: string;
  brand: string;
  channel: string;
  packaging_format: string;
  week_number: number;
  year: number;
  previous_value: number | null;
  effective_value: number | null;
  session_id: string;
};

type PivotRow = {
  key: string;
  brand: string;
  channel: string;
  packaging_format: string;
  Week1: number | null;
  Week2: number | null;
  Week3: number | null;
  Week4: number | null;
  Week5: number | null;
  Week6: number | null;
  Week7: number | null;
  Week8: number | null;
};

const TABS = [
  "Overview",
  "Demand Plan",
  "Inventory",
  "Brewing Plan",
  "Packaging Plan",
  "Allocation Plan",
] as const;

type TabName = (typeof TABS)[number];


function getEffectiveOrForecast(row: DemandPlanRow) {
  return row.effective_value ?? row.previous_value ?? 0;
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "";
  return Number(value).toFixed(2).replace(/\.00$/, "");
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabName>("Demand Plan");
  const [rows, setRows] = useState<DemandPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [latestForecastDate] = useState("April 8, 2026");

  const [showDemandContent, setShowDemandContent] = useState(false);

  const [sessionId, setSessionId] = useState("558f862e-1c64-49c2-968e-6d9274b71088");
  const [isGenerating, setIsGenerating] = useState(false);

  const [productFilter, setProductFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [packagingFilter, setPackagingFilter] = useState("");
  

  useEffect(() => {
    async function loadRows() {
      setLoading(true);
      setError("");
    
      const batchSize = 1000;
      let from = 0;
      let allRows: DemandPlanRow[] = [];
    
      while (true) {
        const { data, error } = await supabase
          .from("demand_plans")
          .select("*")
          .eq("session_id", sessionId)
          .order("brand", { ascending: true })
          .order("channel", { ascending: true })
          .order("packaging_format", { ascending: true })
          .order("week_number", { ascending: true })
          .range(from, from + batchSize - 1);
    
        if (error) {
          setError(error.message);
          setLoading(false);
          return;
        }
    
        const batch = (data || []) as DemandPlanRow[];
        allRows = [...allRows, ...batch];
    
        if (batch.length < batchSize) {
          break;
        }
    
        from += batchSize;
      }
    
      setRows(allRows);
      setLoading(false);
    }

    loadRows();
  }, [sessionId]);

  const products = useMemo(() => {
    return [...new Set(rows.map((r) => r.brand))].sort();
  }, [rows]);

  const channels = useMemo(() => {
    return [...new Set(rows.map((r) => r.channel))].sort();
  }, [rows]);

  const packagingFormats = useMemo(() => {
    return [...new Set(rows.map((r) => r.packaging_format))].sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const productMatch = !productFilter || row.brand === productFilter;
      const channelMatch = !channelFilter || row.channel === channelFilter;
      const packagingMatch = !packagingFilter || row.packaging_format === packagingFilter;
      return productMatch && channelMatch && packagingMatch;
    });
  }, [rows, productFilter, channelFilter, packagingFilter]);

  const chartData = useMemo(() => {
    const weekMap: Record<number, { week: string; forecast: number; effective: number }> = {};

    for (let week = 1; week <= 8; week++) {
      weekMap[week] = {
        week: `Week${week}`,
        forecast: 0,
        effective: 0,
      };
    }

    filteredRows.forEach((row) => {
      if (row.week_number >= 1 && row.week_number <= 8) {
        weekMap[row.week_number].forecast += row.previous_value ?? 0;
        weekMap[row.week_number].effective += getEffectiveOrForecast(row);
      }
    });

    return Object.values(weekMap);
  }, [filteredRows]);

  const pivotRows = useMemo(() => {
    const grouped: Record<string, PivotRow> = {};

    filteredRows.forEach((row) => {
      const key = `${row.brand}||${row.channel}||${row.packaging_format}`;

      if (!grouped[key]) {
        grouped[key] = {
          key,
          brand: row.brand,
          channel: row.channel,
          packaging_format: row.packaging_format,
          Week1: null,
          Week2: null,
          Week3: null,
          Week4: null,
          Week5: null,
          Week6: null,
          Week7: null,
          Week8: null,
        };
      }

      if (row.week_number >= 1 && row.week_number <= 8) {
        grouped[key][`Week${row.week_number}` as keyof PivotRow] =
          getEffectiveOrForecast(row) as never;
      }
    });

    return Object.values(grouped);
  }, [filteredRows]);

  const [pendingEdit, setPendingEdit] = useState<{
    pivotRow: PivotRow;
    weekNumber: number;
    newValue: string;
  } | null>(null);
  
  const [overrideReason, setOverrideReason] = useState("");

  function handleCellUpdate(pivotRow: PivotRow, weekNumber: number, newValue: string) {
    if (newValue.trim() === "") return;
  
    const parsed = Number(newValue);
    if (Number.isNaN(parsed)) return;
  
    setPendingEdit({
      pivotRow,
      weekNumber,
      newValue,
    });
    setOverrideReason("");
  }

  async function savePendingEdit() {
    if (!pendingEdit) return;
  
    const parsed = Number(pendingEdit.newValue);
    if (Number.isNaN(parsed)) return;
  
    if (!overrideReason.trim()) {
      alert("Please enter a reason for the change.");
      return;
    }
  
    const matchingRow = rows.find(
      (r) =>
        r.brand === pendingEdit.pivotRow.brand &&
        r.channel === pendingEdit.pivotRow.channel &&
        r.packaging_format === pendingEdit.pivotRow.packaging_format &&
        r.week_number === pendingEdit.weekNumber
    );
  
    if (!matchingRow) return;
  
    const { error } = await supabase
      .from("demand_plans")
      .update({
        effective_value: parsed,
        override_rationale: overrideReason.trim(),
      })
      .eq("id", matchingRow.id);
  
    if (error) {
      alert(`Update failed: ${error.message}`);
      return;
    }
  
    setRows((prev) =>
      prev.map((r) =>
        r.id === matchingRow.id
          ? {
              ...r,
              effective_value: parsed,
            }
          : r
      )
    );
  
    setPendingEdit(null);
    setOverrideReason("");
  }

  async function handleGenerateDemandPlan() {
    try {
      setIsGenerating(true);
      setError("");
  
      const response = await fetch("http://127.0.0.1:8000/run-forecast", {
        method: "POST",
      });
  
      if (!response.ok) {
        throw new Error("Failed to generate demand plan");
      }
  
      const result = await response.json();
  
      if (!result.session_id) {
        throw new Error("No session_id returned from backend");
      }
  
      setSessionId(result.session_id);
      setShowDemandContent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsGenerating(false);
    }
  }

  function renderPlaceholderTab(title: string) {
    return (
      <div style={placeholderCardStyle}>
        <h2 style={{ marginTop: 0, marginBottom: "8px" }}>{title}</h2>
        <p style={{ color: "#6b7280", margin: 0 }}>This section is not built yet.</p>
      </div>
    );
  }

  
  function renderDemandPlanTab() {
    return (
      <>
        <div style={chartCardStyle}>
          <div style={{ marginBottom: "8px" }}>
            <h2 style={{ margin: 0, fontSize: "28px", fontWeight: 700 }}>Demand Plan</h2>
            <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>
              Choose whether to use the latest generated forecast or run a brand new demand plan.
            </p>
            <p style={{ marginTop: "8px", marginBottom: 0, color: "#9ca3af", fontSize: "13px" }}>
              Current session: {sessionId}
            </p>
          </div>
  
          <div
            style={{
              display: "flex",
              gap: "12px",
              flexWrap: "wrap",
              marginTop: "20px",
            }}
          >
            <button
              onClick={() => setShowDemandContent(true)}
              style={{
                background: "#111827",
                color: "white",
                border: "none",
                borderRadius: "12px",
                padding: "12px 18px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {`Generate Demand Plan with Most Recent Forecast (${latestForecastDate})`}
            </button>
  
            <button
              onClick={handleGenerateDemandPlan}
              disabled={isGenerating}
              style={{
                background: isGenerating ? "#9ca3af" : "white",
                color: "#111827",
                border: "1px solid #d1d5db",
                borderRadius: "12px",
                padding: "12px 18px",
                fontWeight: 600,
                cursor: isGenerating ? "not-allowed" : "pointer",
              }}
            >
              {isGenerating ? "Generating New Demand Plan..." : "Generate New Demand Plan"}
            </button>
          </div>
        </div>
  
        {showDemandContent && (
          <>
            <div style={tableCardStyle}>
              <div style={{ padding: "24px 24px 0 24px" }}>
                <h3 style={{ marginTop: 0, marginBottom: "8px", fontSize: "20px" }}>
                  Editable Demand Table
                </h3>
                <p style={{ marginTop: 0, color: "#6b7280" }}>
                  Edit a value and click outside the box to save it to Supabase as the effective plan.
                </p>
              </div>
  
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    minWidth: "1200px",
                    borderCollapse: "collapse",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      {[
                        "Brand",
                        "Channel",
                        "Packaging",
                        "Week1",
                        "Week2",
                        "Week3",
                        "Week4",
                        "Week5",
                        "Week6",
                        "Week7",
                        "Week8",
                      ].map((header) => (
                        <th
                          key={header}
                          style={{
                            textAlign: "left",
                            padding: "14px 16px",
                            borderBottom: "1px solid #e5e7eb",
                            fontSize: "13px",
                            fontWeight: 700,
                            color: "#374151",
                          }}
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pivotRows.map((row, index) => (
                      <tr
                        key={row.key}
                        style={{
                          background: index % 2 === 0 ? "white" : "#fcfcfd",
                        }}
                      >
                        <td style={cellStyle}>{row.brand}</td>
                        <td style={cellStyle}>{row.channel}</td>
                        <td style={cellStyle}>{row.packaging_format}</td>
  
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((week) => {
                          const field = `Week${week}` as keyof PivotRow;
                          return (
                            <td key={week} style={cellStyle}>
                              <input
                                type="number"
                                step="0.01"
                                defaultValue={row[field] ?? ""}
                                onBlur={(e) => handleCellUpdate(row, week, e.target.value)}
                                style={inputStyle}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
  
            <div style={filterGridStyle}>
              <div style={filterCardStyle}>
                <label style={labelStyle}>Product</label>
                <select
                  value={productFilter}
                  onChange={(e) => setProductFilter(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">All Products</option>
                  {products.map((product) => (
                    <option key={product} value={product}>
                      {product}
                    </option>
                  ))}
                </select>
              </div>
  
              <div style={filterCardStyle}>
                <label style={labelStyle}>Channel</label>
                <select
                  value={channelFilter}
                  onChange={(e) => setChannelFilter(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">All Channels</option>
                  {channels.map((channel) => (
                    <option key={channel} value={channel}>
                      {channel}
                    </option>
                  ))}
                </select>
              </div>
  
              <div style={filterCardStyle}>
                <label style={labelStyle}>Packaging Type</label>
                <select
                  value={packagingFilter}
                  onChange={(e) => setPackagingFilter(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">All Packaging Types</option>
                  {packagingFormats.map((packaging) => (
                    <option key={packaging} value={packaging}>
                      {packaging}
                    </option>
                  ))}
                </select>
              </div>
            </div>
  
            <div style={chartCardStyle}>
              <div style={{ marginBottom: "12px" }}>
                <h3 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>Forecast Trend</h3>
                <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>
                  Filter by brand, channel, and packaging type to update the forecast view.
                </p>
              </div>
  
              <div style={{ width: "100%", height: 360 }}>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="week" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="forecast"
                      name="Forecast"
                      stroke="#94a3b8"
                      strokeWidth={3}
                      dot={{ r: 3 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="effective"
                      name="Effective Plan"
                      stroke="#2563eb"
                      strokeWidth={3}
                      dot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f7f7f5",
        padding: "32px 24px 48px 24px",
        fontFamily: 'Inter, Arial, sans-serif',
        color: "#111827",
      }}
    >
      <div style={{ maxWidth: "1320px", margin: "0 auto" }}>
        <div style={{ marginBottom: "24px" }}>
        <h1
          style={{
            margin: 0,
            fontSize: "34px",
            fontWeight: 700,
            fontFamily: 'Georgia, "Times New Roman", serif',
          }}
        >
          Brewery Planning App
        </h1>
          <p style={{ marginTop: "8px", marginBottom: 0, color: "#6b7280" }}>
            Central Coast Analytics
          </p>
        </div>

        <div
          style={{
            display: "flex",
            gap: "10px",
            flexWrap: "wrap",
            marginBottom: "24px",
            padding: "8px",
            background: "white",
            border: "1px solid #e5e7eb",
            borderRadius: "16px",
          }}
        >
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: "12px 18px",
                borderRadius: "12px",
                border: activeTab === tab ? "1px solid #111827" : "1px solid transparent",
                background: activeTab === tab ? "#111827" : "transparent",
                color: activeTab === tab ? "white" : "#4b5563",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: "14px",
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        {loading && <p>Loading...</p>}
        {error && <p style={{ color: "red" }}>Error: {error}</p>}

        {!loading && !error && (
          <>
            {activeTab === "Overview" && renderPlaceholderTab("Overview")}
            {activeTab === "Demand Plan" && renderDemandPlanTab()}
            {activeTab === "Inventory" && renderPlaceholderTab("Inventory")}
            {activeTab === "Brewing Plan" && renderPlaceholderTab("Brewing Plan")}
            {activeTab === "Packaging Plan" && renderPlaceholderTab("Packaging Plan")}
            {activeTab === "Allocation Plan" && renderPlaceholderTab("Allocation Plan")}
          </>
        )}
      </div>

      {pendingEdit && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "#fffaf0",
              border: "2px solid #f59e0b",
              borderRadius: "18px",
              padding: "24px",
              width: "420px",
              boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
            }}
          >
            <h3
              style={{
                marginTop: 0,
                marginBottom: "12px",
                fontSize: "20px",
                color: "#b45309",
                fontFamily: 'Georgia, "Times New Roman", serif',
              }}
            >
              Why? (logged to audit trail)
            </h3>

            <input
              type="text"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="e.g., expecting late shipment"
              style={{
                width: "100%",
                padding: "12px",
                borderRadius: "10px",
                border: "1px solid #d1d5db",
                fontSize: "16px",
                marginBottom: "16px",
              }}
            />

            <div style={{ display: "flex", gap: "12px" }}>
              <button
                onClick={savePendingEdit}
                style={{
                  background: "#f59e0b",
                  color: "white",
                  border: "none",
                  borderRadius: "10px",
                  padding: "10px 18px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Save
              </button>

              <button
                onClick={() => {
                  setPendingEdit(null);
                  setOverrideReason("");
                }}
                style={{
                  background: "white",
                  color: "#6b7280",
                  border: "1px solid #d1d5db",
                  borderRadius: "10px",
                  padding: "10px 18px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}


const filterGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: "16px",
  marginBottom: "20px",
};

const filterCardStyle: React.CSSProperties = {
  background: "white",
  border: "1px solid #e5e7eb",
  borderRadius: "16px",
  padding: "16px",
  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: "8px",
  fontWeight: 600,
  fontSize: "14px",
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: "10px",
  border: "1px solid #d1d5db",
  fontSize: "14px",
  background: "white",
};

const chartCardStyle: React.CSSProperties = {
  background: "white",
  border: "1px solid #e5e7eb",
  borderRadius: "20px",
  padding: "24px",
  marginBottom: "20px",
  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
};

const tableCardStyle: React.CSSProperties = {
  background: "white",
  border: "1px solid #e5e7eb",
  borderRadius: "20px",
  overflow: "hidden",
  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
};

const placeholderCardStyle: React.CSSProperties = {
  background: "white",
  border: "1px solid #e5e7eb",
  borderRadius: "20px",
  padding: "24px",
  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
};

const cellStyle: React.CSSProperties = {
  padding: "14px 16px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
  fontSize: "14px",
};

const inputStyle: React.CSSProperties = {
  width: "90px",
  padding: "8px 10px",
  borderRadius: "10px",
  border: "1px solid #d1d5db",
  fontSize: "13px",
  background: "white",
};

  