# Brewery Planning App — Quick Start Guide

## What it does

Builds a weekly Sales, Inventory, and Operations (SIOP) plan for Societe from a demand forecast, live inventory, and a brewing schedule. Each stage locks before the next one starts, so you're always building on a committed baseline.

## Access

Go to https://merging-six.vercel.app in any modern browser. No login required.

## The workflow

The app has six tabs but you only touch four to build a plan, in order:

**1. Overview** (start here)
Snapshot of current demand trends and metrics. Read-only. Use it to orient yourself before editing anything.

**2. Forecasted Demand**
- Click **Load Latest Forecast** to pull the most recent forecast from the database (fast — takes a few seconds).
- Or click **Generate New Forecast** to run a fresh forecast. This takes 20–30 minutes on the server. You can close the browser and come back; the job keeps running.
- Review weekly demand numbers by brand. Edit any cell to override the forecast — you'll be prompted for a reason so the change is auditable.
- The **Visualize Forecast ↓** button scrolls to a line chart showing prior 8 weeks of actuals vs next 8 weeks of forecast.
- Toggle between **Product Level** and **Packaging Level** to see the demand rolled up or broken out by packaging type.
- Toggle between **BBL** and **CE** (case equivalents) for units.
- **Download CSV** exports the current view.
- When demand is final, click **Lock Demand Plan** → confirm. The tab auto-advances to Inventory.

**3. Inventory**
- Opens with the Starting Inventory column auto-populated from Tableau (live — pulled when the page loaded).
- Click **Refresh Inventory from Tableau** any time to re-pull the latest numbers.
- Adjust the **Global Target Service Level** dropdown to recalculate every product's safety stock target.
- Override specific starting inventory or final safety stock values in the table — highlighted amber when edited.
- Click **Lock Inventory Plan** → confirm. Auto-advances to Brewing Plan.

**4. Brewing Plan**
- **Facility Load vs Capacity** shows weekly totals (500 BBL max — red when near capacity).
- **Brew Schedule by Product** below shows the planned brews by brand.
- Use the dropdown to open a specific product's detailed Action Plan showing forecasted demand, brews arriving, ending inventory, and a row you can edit to override any planned brew (e.g. zero out a brew that's too small to bother with, or delay one to a different week).

**5 & 6. Packaging Plan / Allocation Plan**
Coming soon. Currently placeholders.

## Starting a new plan

Any time you want to start over, go back to the **Forecasted Demand** tab and click **Load Latest Forecast** or **Generate New Forecast**. If you have a locked stage in progress, a confirmation appears asking if you want to start over. Confirming wipes all locks and edits and starts fresh.

## Locking rules

- Each lock is one-way for that session — you can't unlock, only start a new plan.
- Locked stages are greyed out and read-only.
- If you close the browser, your locks persist in that browser. To start clean, click Load Latest Forecast and confirm the reset.

## Automatic weekly forecast

A fresh forecast runs automatically every Sunday night at 8pm PST so Monday morning is ready to go. You don't need to hit Generate manually unless you want a mid-week refresh.

## Troubleshooting

- **"Failed to fetch" on Generate New Forecast** — the backend may be starting up after inactivity. Wait 30 seconds and try again.
- **Table is empty after Load Latest Forecast** — a forecast may not have been generated yet. Run Generate New Forecast once to seed it.
- **Locked badge shows when you didn't lock anything** — you're on the same browser as a previous session. Click Load Latest or Generate New and confirm "Start New Plan" to clear.

## Support

For bugs or questions, contact Saanika.
