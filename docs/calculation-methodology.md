# Brewery Planning App Calculation Methodology

## Purpose

The Brewery Planning App creates a weekly Sales, Inventory, and Operations Planning workflow for Societe Brewing. The app connects forecasted demand, current inventory, brewing decisions, and packaging decisions into one planning sequence.

The goal is not to replace planner judgment. The goal is to give the team a consistent, data-backed first draft that can be reviewed, adjusted, and explained.

The workflow is:

1. Forecast demand by product and packaging format.
2. Review and lock the demand plan.
3. Pull current inventory and calculate safety stock targets.
4. Create a brewing plan based on demand, inventory, safety stock, batch size, and fermentation lead time.
5. Create a packaging plan based on beer ready to package, package-level demand, and package-level inventory.

All core planning math is performed in barrels, abbreviated as BBL. Case equivalents, abbreviated as CE, and physical package units are display conversions.

## Planning Data Sources

The app uses three main data sources.

**Historical demand**

Historical sales volume is pulled from the historical demand table. Each row includes product, channel, packaging type, date, and sales volume in BBL.

Historical demand is used to generate the forecast and to estimate demand variability for safety stock.

**Current inventory**

Current inventory is pulled from Tableau when the app loads. The Inventory tab also has a refresh button to pull the latest Tableau inventory during a planning session.

Inventory is used in two ways:

- Product-level inventory supports the Brewing Plan.
- Package-level inventory supports the Packaging Plan when package-level inventory fields are available.

**User overrides**

The user can override demand values, inventory values, safety stock targets, and brew quantities. Overrides are intentional planning inputs. When a user changes a value, the app asks for a reason so the adjustment can be explained later.

## Units

The app uses BBL as the base planning unit because demand, inventory, brewing capacity, and beer availability are all represented most consistently in barrels.

For display and operator-facing packaging work orders, the app converts BBL into CE or whole package units.

The packaging conversion table is:

| Packaging Type Name | BBL Vol per Unit | CE per Unit |
| --- | ---: | ---: |
| Keg - 50L | 0.426 | 5.87 |
| Keg - 20L - Petainer | 0.168 | 2.32 |
| Keg - GCT - One Way | 0.167 | 2.30 |
| Keg - Sixtel | 0.167 | 2.30 |
| Keg - GCT Sixtel | 0.167 | 2.30 |
| Case - 6x4 - 16oz - Can | 0.097 | 1.34 |
| Case - 24x - 12oz - Can | 0.073 | 1.00 |
| Case - 6x4 - 12oz - Can | 0.073 | 1.00 |
| Case - 4x6 - 12oz - Can | 0.073 | 1.00 |
| Single - 12oz - Can | 0.073 | 1.00 |
| Case - 12x - 19.2oz - Can | 0.058 | 0.80 |
| Case - 12x - 16oz - Can | 0.048 | 0.66 |
| Keg - 1/2 bbl | 0.500 | 6.89 |
| Keg - 1/4 bbl | 0.250 | 3.45 |
| Keg - 1/6 bbl | 0.167 | 2.30 |
| Keg - 1/2 BBL KLPPF | 0.500 | 6.89 |
| Keg - 1/6 BBL KLPPF | 0.167 | 2.30 |
| Case - 2x12 - 12oz - Can | 0.073 | 1.00 |
| Case - 12x - 500ml - Bottle | 0.051 | 0.70 |
| Case - 24x - 16oz - Can | 0.097 | 1.34 |
| Single - Magnum 1.5 L | 0.013 | 0.18 |

The CE conversion is calculated as:

```text
CE per BBL = CE per unit / BBL per unit
```

The physical package-unit conversion is calculated as:

```text
Physical units = BBL to package / BBL per unit
```

Packaging work orders are rounded to whole units because the packaging team cannot produce partial cases, cans, bottles, or kegs.

## Demand Forecast Methodology

The demand forecast creates 52 weeks of projected demand. The app displays the first 8 weeks for planning.

Forecasts are generated at two levels:

**Product level**

Product-level forecasts aggregate demand across all channels and packaging formats for a product. These rows use packaging format `ALL`.

Product-level demand is used by the Inventory and Brewing Plan tabs because brewing is planned by beer, not by finished package.

**Packaging level**

Packaging-level forecasts are created separately for each product, channel, and packaging format combination.

Packaging-level demand is used by the Forecasted Demand tab when the user switches to Packaging Level, and by the Packaging Plan to determine which finished packages should be produced.

### Forecast Model Selection

The forecasting pipeline tests multiple time-series and machine-learning models, including:

- Moving average
- Seasonal naive
- Exponential smoothing
- ARIMA
- Seasonal ARIMA
- Holt trend
- Holt seasonal
- LightGBM
- XGBoost
- Random Forest

The app selects models using backtesting.

For the near-term forecast, weeks 1 through 8, the app uses rolling backtests. Each model is tested on historical windows, and the model with the lowest average root mean squared error is selected.

For the longer-term forecast, weeks 9 through 52, the app uses a holdout period. Each model forecasts a recent holdout window, and the model with the lowest error is selected.

If the data is too sparse for a model, the app skips that model. If no advanced model is suitable, the app falls back to either seasonal naive or moving average, depending on how much history exists.

### Forecast Guardrails

The forecast includes guardrails to prevent unreasonable outputs.

The app prevents negative forecasts by flooring the final forecast at zero.

The app also checks for model blow-ups or degenerate collapses. If a selected model produces a forecast that is extremely large compared with history, or collapses toward zero despite meaningful recent demand, the app falls back to moving average for that horizon.

### Demand Overrides

The Forecasted Demand tab allows the user to edit forecasted values. Edited demand values become the effective demand plan.

The app uses:

```text
Effective demand = user override, if present
Effective demand = original forecast, if no override is present
```

Demand overrides are highlighted and require an audit reason.

Once the user locks the demand plan, demand values become read-only for the current planning session.

## Inventory and Safety Stock Methodology

The Inventory tab starts with current inventory pulled from Tableau. Inventory is shown by product in BBL.

The user can refresh inventory from Tableau at any time before locking the Inventory Plan.

### Starting Inventory

Starting inventory is the current product-level inventory available at the time inventory is loaded or refreshed.

The app treats this as the opening inventory balance for the planning horizon.

### Average Demand

Average demand is calculated from the next 8 weeks of product-level forecasted demand:

```text
Average weekly demand = next 8 weeks forecasted demand / 8
```

This value is shown for context and is used to help interpret whether a product is fast-moving or slow-moving.

### Safety Stock

Safety stock is the inventory buffer used to reduce the risk of stockouts.

The app first checks whether a safety stock value already exists in the inventory data. If it does, that value is used.

If no saved safety stock exists, the app estimates safety stock from historical demand variability.

The app calculates weekly historical demand by product and computes the standard deviation of recent weekly demand.

The current implementation uses:

- 13 weeks of history for low-volume products
- 52 weeks of history for other products

Low-volume products are identified by recent average demand. If the recent 13-week average is below 2 BBL per week, the product is treated as low-volume.

The default service level is 95 percent. The user can adjust the global target service level to 85 percent, 90 percent, 95 percent, or 99 percent.

The service-level adjustment scales the base safety stock using a z-score ratio:

```text
Adjusted safety stock = base safety stock * service level ratio
```

The 95 percent service level is the baseline. Lower service levels reduce the target safety stock. Higher service levels increase it.

### Inventory Overrides

The user can override starting inventory or desired safety stock for an individual product.

Examples:

- A recent cycle count found different on-hand inventory.
- The team knows a seasonal product should not carry safety stock right now.
- The team wants a higher buffer for a strategic product.

Inventory overrides require an audit reason.

Once the user locks the Inventory Plan, inventory and safety stock values become read-only for the current planning session.

## Brewing Plan Methodology

The Brewing Plan converts product-level demand, starting inventory, and safety stock into a weekly brew schedule.

The Brewing Plan operates at the product level, not the packaging level. This is because brewing creates liquid beer. Packaging decisions happen later.

### Inputs

For each product, the Brewing Plan uses:

- Forecasted demand for the next 8 weeks
- Starting inventory in BBL
- Desired safety stock in BBL
- Manual brew overrides, if any

### Brewing Assumptions

The current Brewing Plan uses these assumptions:

| Assumption | Current Value |
| --- | ---: |
| Brew batch size | 50 BBL |
| Fermentation lead time | 2 weeks |
| Display horizon | 6 weeks |
| Forecast lookahead | 8 weeks |

The 2-week fermentation lead time means beer started on one Monday is not available until two Mondays later.

Example:

```text
Start brewing: Monday, May 4
Ready to use: Monday, May 18
```

### Projected Inventory

For each week, the app calculates projected inventory before any new receipt:

```text
Projected inventory before receipt = current inventory - forecasted demand
```

If projected inventory falls below desired safety stock, the app recommends a brew receipt large enough to bring inventory back above the safety stock target.

The receipt is rounded up to the nearest 50 BBL batch:

```text
Required gap = safety stock - projected inventory before receipt
Recommended receipt = round up required gap to nearest 50 BBL
```

After the receipt is added:

```text
Ending inventory = projected inventory before receipt + brew receipt
```

### Start Brewing vs Brews Arriving

The Brewing Plan distinguishes between two dates:

**Start Brewing**

This is when production needs to begin.

**Brews Arriving**

This is when the beer is expected to be ready after fermentation.

Because the lead time is 2 weeks:

```text
Start brewing in week 1 -> beer arrives in week 3
Start brewing in week 2 -> beer arrives in week 4
Start brewing in week 3 -> beer arrives in week 5
```

The Packaging Plan uses Brews Arriving, not Start Brewing. This prevents the app from packaging beer before it is ready.

### Past-Due Brews

If the math says beer is needed in the first two weeks of the plan, the brew would have needed to start before the current planning window.

The app treats this as a past-due brew and adds it to the immediate action schedule. Operationally, this means the planner should confirm whether the beer is already in tank or whether action is needed immediately.

### Facility Capacity

The Brewing Plan totals the planned starts across products by week.

The current capacity reference is:

```text
Maximum weekly brewing capacity = 500 BBL
Warning threshold = 400 BBL
```

When a week approaches the threshold, the app highlights the week so the team can review timing and priorities.

### Brew Overrides

The user can override planned brews. Common reasons include:

- The suggested batch is too small or operationally impractical.
- The brewery wants to level-load production across weeks.
- The beer is seasonal and should not be brewed even if historical data creates a small safety stock.
- A batch is already in progress outside the app.

Brew overrides require an audit reason.

## Packaging Plan Methodology

The Packaging Plan converts beer that is ready to package into package-level work orders.

The Packaging Plan answers:

```text
Given the beer ready this week, which package formats should we produce, and how many whole units of each?
```

### Key Principle

All allocation logic is calculated in BBL. The final display converts BBL into whole physical units.

This is intentional. Forecasts, inventory, brewing capacity, and beer availability are all most consistent in BBL. Operators, however, need package counts.

### Inputs

For the selected brand, the Packaging Plan uses:

- Beer ready to package from the Brewing Plan
- Package-level forecasted demand
- Package-level starting inventory
- BBL per unit conversion table
- CE per unit conversion table for display where relevant

### Beer Ready to Package

The Packaging Plan uses the Brewing Plan's Brews Arriving row.

It does not use the Start Brewing row.

This accounts for the 2-week fermentation lead time.

Example:

```text
If 100 BBL starts brewing on Monday, May 4:
It appears as beer ready to package on Monday, May 18.
Packaging Plan can allocate that beer starting the week of May 18.
```

### Package-Level Inventory Roll Forward

For each package format, the app starts with package-level inventory on hand.

Each week, before adding newly packaged units, the app subtracts that week's package-level forecasted demand:

```text
Inventory before packaging = beginning package inventory - forecasted package demand
```

This matters because package inventory on hand today is not the same as package inventory expected several weeks from now. The app estimates what will be left by the time the beer is ready to package.

### Package-Level Target

For each package format, the app calculates a planning target.

The current target is:

```text
Target inventory = greater of:
1. demand over the next 2 weeks
2. average weekly demand across the 6-week packaging horizon
```

This gives priority to packages that have near-term demand while still recognizing consistently faster-moving package formats.

### Gap Calculation

For each package format:

```text
Gap = target inventory - inventory before packaging
```

If the gap is positive, that package format is under target and should be considered for packaging.

If the gap is zero or negative, that package format is already adequately stocked relative to the current target.

### Allocation of Ready Beer

The app sorts package formats by largest gap first.

It then allocates beer ready to package into the largest gaps, while converting to whole physical units:

```text
Units to package = floor(allocated BBL / BBL per unit)
Packaged BBL = units to package * BBL per unit
```

The app uses floor rounding during target-fill allocation so it does not over-assign a package format while trying to fill a specific gap.

### Draining the Remainder

In brewing operations, a tank that is ready to package typically needs to be packaged out. If some beer remains after target gaps are filled, the app assigns the remainder to the fastest-moving package format.

Fastest-moving is based on total forecasted demand for that package format across the packaging horizon.

This reflects the planning discussion that overstock should usually go to the package format most likely to sell through quickly.

For the drain-remainder step, the app rounds to the closest whole unit:

```text
Remainder units = round(remaining BBL / BBL per unit)
```

This can create a small overage or underage because package units are discrete.

### Packaging Reconciliation

For each week, the Packaging Plan shows:

- BBL ready to package
- BBL assigned to package work orders
- Remaining unassigned BBL, or overage caused by unit rounding

The reconciliation is shown because exact equality is not always possible when converting liquid BBL into whole physical units.

Small differences may represent:

- Packaging loss
- Rounding to whole units
- Small unassigned volumes
- Operational judgment needed by the planner

### Packaging Work Orders

For each package format and week, the app shows:

- Packaging format
- BBL per unit
- Starting package inventory
- Forecasted package demand
- Target inventory
- Recommended whole units to package
- BBL equivalent of the recommended units
- Projected ending package inventory
- Rationale for the recommendation

The most common rationales are:

- Restock to target
- Drain remainder to fastest mover
- No SKU gap
- No liquid ready

## Locking and Auditability

The app uses locks to maintain a clear planning sequence.

The intended order is:

1. Lock Demand Plan.
2. Lock Inventory Plan.
3. Review and adjust Brewing Plan.
4. Review Packaging Plan.

Locks make the upstream data stable before the next planning stage is created.

Overrides require reasons so that the final plan can be explained. The reason is part of the planning record, not just a UI note.

## Current Assumptions

The current implementation includes these assumptions:

| Area | Current Assumption |
| --- | --- |
| Base planning unit | BBL |
| Display conversions | CE and whole physical units |
| Brew batch size | 50 BBL |
| Fermentation lead time | 2 weeks |
| Brewing capacity reference | 500 BBL per week |
| Brewing warning threshold | 400 BBL per week |
| Brewing planning level | Product level |
| Packaging planning level | Brand plus packaging format |
| Package work orders | Whole units only |
| Packaging remainder | Assigned to fastest-moving package format |

## Known Limitations and Future Enhancements

The app currently creates a strong first draft, but it does not yet model every real-world constraint.

Potential future enhancements include:

- Product-specific brew batch sizes
- Product-specific fermentation times
- Packaging-line capacity by week
- Minimum packaging run sizes
- Explicit packaging loss or yield assumptions
- Manual package-level overrides
- Package-level safety stock targets set by the client
- Seasonal safety stock rules for products with zero near-term forecast
- Level-loading logic for brewing
- Allocation planning by distributor when supply is constrained

## Summary

The app creates the plan in stages.

Forecasting estimates demand from historical sales. Inventory establishes what is currently available and what buffer should be carried. Brewing determines when liquid beer needs to be started so it is ready after fermentation. Packaging then decides how to convert ready beer into finished package units based on package-level demand and inventory.

The methodology is designed to be explainable, adjustable, and auditable. The output should be treated as a recommended planning baseline that the brewery team can review and refine using operational knowledge.
