"""Quick single-product forecast test. Run: python test_forecast.py [ProductName]

Loads historical data from Supabase, runs the product-level pipeline on ONE
product (default "The Pupil" — the high-volume one that triggered the blow-up),
and prints the 52-week forecast + which model was selected. No writes to Supabase.
"""
import sys
import numpy as np
from generate_demand_plan import (
    load_historical_demand,
    make_product_weekly_series,
    hybrid_forecast_52,
)

product = sys.argv[1] if len(sys.argv) > 1 else "The Pupil"

print(f"Loading historical demand...")
df = load_historical_demand()

print(f"Building series for '{product}'...")
series = make_product_weekly_series(df, product)
print(f"  Series length: {len(series)} weeks")
print(f"  Historical max: {float(np.nanmax(np.abs(series.values))):.2f}")

print(f"Running hybrid_forecast_52...")
fc52, near_model, long_model = hybrid_forecast_52(
    series, near_horizon=8, long_horizon=52, folds=5, test_weeks=13,
)

print(f"\nNear model (weeks 1-8): {near_model}")
print(f"Long model (weeks 9-52): {long_model}")
print(f"\nForecast stats:")
print(f"  Weeks 1-8  min/max/mean: {fc52[:8].min():.2f} / {fc52[:8].max():.2f} / {fc52[:8].mean():.2f}")
print(f"  Weeks 9-52 min/max/mean: {fc52[8:].min():.2f} / {fc52[8:].max():.2f} / {fc52[8:].mean():.2f}")
print(f"\nFirst 8 weeks: {[round(float(x), 2) for x in fc52[:8]]}")
print(f"Last 8 weeks:  {[round(float(x), 2) for x in fc52[-8:]]}")
