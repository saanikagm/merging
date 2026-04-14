"use client";

export const getZRatio = (sl: number) => {
    if (sl === 99) return 2.33 / 1.645;
    if (sl === 95) return 1.0;
    if (sl === 90) return 1.28 / 1.645;
    if (sl === 85) return 1.04 / 1.645;
    return 1.0;
};

export default function InventoryTab({ inventoryDB, globalServiceLevel, onGlobalSLChange, onUpdate }: any) {
    const fmtDec = (num: number) => Number(num).toFixed(2);

    return (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 animate-fadeIn">
            <div className="mb-8 p-5 bg-slate-900 rounded-xl flex items-center justify-between shadow-md">
                <div>
                    <h2 className="text-xl font-extrabold text-white mb-1">Global Target Service Level</h2>
                    <p className="text-slate-400 text-sm">Recalculates safety stock targets for ALL products.</p>
                </div>
                <select
                    value={globalServiceLevel}
                    onChange={(e) => onGlobalSLChange(Number(e.target.value))}
                    className="p-3 text-lg border-2 border-emerald-500 rounded-lg bg-emerald-50 text-emerald-900 font-black cursor-pointer outline-none shadow-inner"
                >
                    <option value={85}>85% - Aggressive (Lean)</option>
                    <option value={90}>90% - Moderate</option>
                    <option value={95}>95% - Standard Policy</option>
                    <option value={99}>99% - Highly Conservative</option>
                </select>
            </div>

            <div className="overflow-x-auto">
                <table className="min-w-full text-sm text-left border-collapse">
                    <thead>
                        <tr className="bg-slate-50 border-y border-slate-200 text-slate-600 uppercase tracking-wider text-xs">
                            <th className="p-4 font-semibold">Product Name</th>
                            <th className="p-4 font-semibold text-center bg-slate-100/50">Starting Inv</th>
                            <th className="p-4 font-semibold text-center text-slate-400 border-r border-slate-200">Avg Demand</th>
                            <th className="p-4 font-semibold text-center text-blue-600">Calculated SS</th>
                            <th className="p-4 font-semibold text-center bg-purple-50 text-purple-800">Audited Final SS</th>
                            <th className="p-4 font-semibold text-center text-slate-400">Audit Reason / Notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        {inventoryDB.map((item: any) => {
                            const calculatedSS = item.baseSafetyStock * getZRatio(globalServiceLevel);
                            const isAudited = item.finalSS !== Number(calculatedSS.toFixed(2));

                            return (
                                <tr key={item.name} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                                    <td className="p-4 font-bold text-slate-800">{item.name}</td>

                                    <td className="p-4 text-center bg-slate-50/50">
                                        <input
                                            type="number"
                                            value={item.startInv}
                                            onChange={(e) => onUpdate(item.name, 'startInv', Number(e.target.value))}
                                            className="w-20 p-2 border border-slate-300 rounded focus:border-blue-500 outline-none font-bold text-center"
                                        />
                                    </td>

                                    <td className="p-4 text-center text-slate-500 font-medium border-r border-slate-200">
                                        {fmtDec(item.avgDemand)}
                                    </td>

                                    <td className="p-4 text-center text-blue-600 font-bold bg-blue-50/30">
                                        {fmtDec(calculatedSS)}
                                    </td>

                                    <td className="p-4 text-center bg-purple-50/30">
                                        <input
                                            type="number"
                                            value={item.finalSS}
                                            onChange={(e) => onUpdate(item.name, 'finalSS', Number(e.target.value))}
                                            className={`w-20 p-2 border-2 rounded outline-none font-black text-center ${isAudited ? 'border-amber-400 text-amber-700 bg-amber-50' : 'border-purple-200 text-purple-700 focus:border-purple-600'}`}
                                        />
                                    </td>

                                    <td className="p-4">
                                        <input
                                            type="text"
                                            placeholder={isAudited ? "Required: Why was this changed?" : "Optional notes..."}
                                            value={item.auditReason}
                                            onChange={(e) => onUpdate(item.name, 'auditReason', e.target.value)}
                                            className={`w-full p-2 border rounded outline-none text-sm ${isAudited && !item.auditReason ? 'border-red-400 bg-red-50' : 'border-slate-200'}`}
                                        />
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}