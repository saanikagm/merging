"use client";
import { generateCapacityPlan } from './capacityPlanning';

export default function CapacityPlanTable({ productData, onBrewUpdate }: any) {
    const calendarDates = Array.from({length: 6}).map((_, i) => {
        const d = new Date();
        d.setDate(d.getDate() + (i * 7));
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    const plan = generateCapacityPlan(
        productData.name,
        productData.forecasts,
        productData.startInv,
        productData.finalSS,
        productData.manualReleases
    );

    const fmtDec = (num: number) => Number(num).toFixed(2);
    const fmt = (num: number) => Number(num).toFixed(0);

    // Week 0 "Start Brewing" = whatever needs to start NOW to arrive in week 1.
    // Derived from plannedReceipt[0]; can be overridden via manualReleases[-1] slot
    // (we use index -1 key convention → stored as key "wk0" in manualReleases).
    const week0Receipt = plan.plannedReceipt[0] ?? 0;
    const isWk0Overridden = productData.manualReleases['wk0'] !== undefined;
    const week0StartValue = isWk0Overridden ? productData.manualReleases['wk0'] : week0Receipt;

    const totalStartBrewing =
        (week0StartValue > 0 ? Number(week0StartValue) : 0) +
        plan.plannedRelease.reduce((a: number, b: number) => a + b, 0);

    return (
        <div className="overflow-x-auto p-6 bg-white rounded-xl shadow-sm border border-slate-200 mb-8 text-slate-800">
            <div className="flex justify-between items-start mb-6">
                <div>
                    <h2 className="text-2xl font-extrabold text-slate-900 mb-2">{plan.productName} - Action Plan</h2>
                    <div className="flex space-x-4 text-sm">
                        <span className="bg-blue-50 text-blue-800 px-3 py-1 rounded-md border border-blue-100 font-semibold">
                            Avg Demand: {fmtDec(plan.avgWeeklyDemand)} bbl/wk
                        </span>
                    </div>
                </div>
                <div className="text-right">
                    <p className="text-xs font-bold text-slate-500 uppercase">Locked Safety Target</p>
                    <p className="text-xl font-black text-purple-700">{fmtDec(productData.finalSS)} bbl</p>
                </div>
            </div>

            <table className="min-w-full text-sm text-left border-collapse mb-6">
                <thead>
                    <tr className="bg-slate-50 border-y border-slate-200 text-slate-600 uppercase tracking-wider text-xs">
                        <th className="p-3 border-r border-slate-200 font-semibold">Weekly Flow</th>
                        <th className="p-3 text-center">Wk 0</th>
                        {calendarDates.map((date, i) => <th key={i} className="p-3 text-center text-blue-700">{date}</th>)}
                        <th className="p-3 border-l border-slate-200 text-center">Total</th>
                    </tr>
                </thead>
                <tbody>
                    <tr className="border-b border-slate-100">
                        <td className="p-3 border-r border-slate-200 font-medium text-red-600">➖ Forecasted Demand</td>
                        <td className="p-3 text-center text-slate-400">-</td>
                        {plan.forecasts.map((f: number, i: number) => <td key={i} className="p-3 text-center text-red-600">{fmt(f)}</td>)}
                        <td className="p-3 border-l border-slate-200 text-center font-bold text-red-600">{fmt(plan.totalForecast)}</td>
                    </tr>

                    <tr className="border-b border-slate-100">
                        <td className="p-3 border-r border-slate-200 font-medium text-emerald-600">➕ Brews Arriving</td>
                        <td className="p-3 text-center text-slate-400">-</td>
                        {plan.plannedReceipt.map((r: number, i: number) => (
                            <td key={i} className="p-3 text-center font-bold text-emerald-600">{r > 0 ? r : '-'}</td>
                        ))}
                        <td className="p-3 border-l border-slate-200 text-center text-slate-400">-</td>
                    </tr>

                    <tr className="border-b border-slate-200 bg-slate-50">
                        <td className="p-3 border-r border-slate-200 font-bold text-slate-800">📦 Ending Inventory</td>
                        <td className="p-3 text-center font-bold text-slate-900">{fmtDec(plan.startInv)}</td>
                        {plan.projAvailable.map((p: number, i: number) => (
                            <td key={i} className={`p-3 text-center font-bold ${p < plan.safetyStock ? 'text-red-600' : 'text-slate-800'}`}>{fmtDec(p)}</td>
                        ))}
                        <td className="p-3 border-l border-slate-200 text-center text-slate-400">-</td>
                    </tr>

                    <tr className="border-b-2 border-purple-200 bg-purple-50">
                        <td className="p-4 border-r border-purple-200 font-extrabold text-purple-800 text-base">⚙️ ACTION: Start Brewing</td>

                        {/* ── Week 0: brew that must start NOW to arrive in week 1 ── */}
                        <td className="p-2 text-center">
                            {week0Receipt > 0 ? (
                                <input
                                    type="number"
                                    value={week0StartValue}
                                    onChange={(e) => onBrewUpdate(productData.name, 'wk0', e.target.value)}
                                    className={`w-20 p-2 text-center font-black text-base rounded outline-none transition-colors ${
                                        isWk0Overridden
                                            ? 'border-2 border-amber-400 bg-amber-100 text-amber-800'
                                            : 'border-2 border-transparent bg-transparent text-purple-700 hover:bg-purple-100 hover:border-purple-300'
                                    }`}
                                />
                            ) : (
                                <span className="text-purple-300">-</span>
                            )}
                        </td>

                        {/* ── Weeks 1–6 ── */}
                        {plan.plannedRelease.map((r: number, i: number) => {
                            const isOverridden = productData.manualReleases[i] !== undefined;
                            return (
                                <td key={i} className="p-2 text-center">
                                    <input
                                        type="number"
                                        value={isOverridden ? productData.manualReleases[i] : r}
                                        onChange={(e) => onBrewUpdate(productData.name, i, e.target.value)}
                                        className={`w-20 p-2 text-center font-black text-base rounded outline-none transition-colors ${
                                            isOverridden
                                                ? 'border-2 border-amber-400 bg-amber-100 text-amber-800'
                                                : 'border-2 border-transparent bg-transparent text-purple-700 hover:bg-purple-100 hover:border-purple-300'
                                        }`}
                                    />
                                </td>
                            );
                        })}

                        <td className="p-4 border-l border-purple-200 text-center font-bold text-purple-800">
                            {totalStartBrewing} bbl
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}