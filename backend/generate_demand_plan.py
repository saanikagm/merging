import os
import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client, Client

from statsmodels.tsa.holtwinters import ExponentialSmoothing, Holt
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.tsa.statespace.sarimax import SARIMAX
import lightgbm as lgb
import xgboost as xgb
from sklearn.ensemble import RandomForestRegressor


load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
CLIENT_ID = os.getenv("CLIENT_ID")
FORECAST_YEAR = int(os.getenv("FORECAST_YEAR", "2026"))
HISTORICAL_TABLE = os.getenv("HISTORICAL_TABLE", "societehistoricaldemand")

if not SUPABASE_URL or not SUPABASE_KEY or not CLIENT_ID:
    raise ValueError("Missing one or more required environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

SEASON = 52

# If your societehistoricaldemand columns are named differently, map them here.
# Left = column in Supabase, Right = column name the pipeline expects.
COLUMN_RENAMES = {
    # "product_name": "ProductName",
    # "channel": "Channel",
    # "packaging_type_name": "PackagingTypeName",
    # "date": "Date",
    # "sales_vol": "Sales Vol",
}


def load_historical_demand() -> pd.DataFrame:
    """Page through the societehistoricaldemand table (Supabase caps at 1000/req)."""
    rows = []
    start = 0
    page = 1000
    while True:
        resp = (
            supabase.table(HISTORICAL_TABLE)
            .select("*")
            .range(start, start + page - 1)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < page:
            break
        start += page

    if not rows:
        raise ValueError(f"No rows returned from {HISTORICAL_TABLE}.")

    df = pd.DataFrame(rows)
    if COLUMN_RENAMES:
        df = df.rename(columns=COLUMN_RENAMES)

    required = {"ProductName", "Channel", "PackagingTypeName", "Date", "Sales Vol"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(
            f"{HISTORICAL_TABLE} is missing required columns: {missing}. "
            f"Populate COLUMN_RENAMES in generate_demand_plan.py to map them."
        )

    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df["Sales Vol"] = pd.to_numeric(df["Sales Vol"], errors="coerce").fillna(0)
    df = df.drop_duplicates()
    df.loc[df["Sales Vol"] < 0, "Sales Vol"] = 0
    df = df[df["Date"].dt.year >= 2023].copy()

    latest_date = df["Date"].max()
    print("Latest date in dataset (dropped):", latest_date)
    df = df[df["Date"] < latest_date].copy()

    print("df min/max after cleaning:", df["Date"].min(), df["Date"].max())
    return df


def make_weekly_series(df, product, channel, packaging):
    s = (
        df[
            (df["ProductName"] == product)
            & (df["Channel"] == channel)
            & (df["PackagingTypeName"] == packaging)
        ]
        .groupby("Date")["Sales Vol"]
        .sum()
        .sort_index()
    )
    s = s.asfreq("W-MON").fillna(0)
    return s


def rmse(y_true, y_pred):
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def fc_moving_avg(train, h, window=8):
    x = pd.to_numeric(train, errors="coerce").astype(float).fillna(0.0)
    w = min(window, len(x))
    m = float(x.iloc[-w:].mean()) if w > 0 else 0.0
    return np.full(h, m, dtype=float)


def fc_seasonal_naive(tr, h, season=SEASON):
    x = pd.to_numeric(tr, errors="coerce").astype(float).fillna(0.0)
    if len(x) < season:
        return None
    last_season = x.iloc[-season:].values
    reps = (h + season - 1) // season
    return np.tile(last_season, reps)[:h]


def fc_ets(train, h):
    x = pd.to_numeric(train, errors="coerce").astype(float).fillna(0.0)
    model = ExponentialSmoothing(
        x, trend="add", seasonal="add", seasonal_periods=SEASON,
        initialization_method="estimated"
    ).fit(optimized=True)
    return model.forecast(h).values


def fc_arima(train, h, order=(1, 1, 1)):
    x = pd.to_numeric(train, errors="coerce").astype(float).fillna(0.0)
    model = ARIMA(x, order=order).fit()
    return model.forecast(steps=h).values


def fc_sarima(train, h, order=(1, 1, 1), seasonal_order=(1, 0, 1, SEASON)):
    x = pd.to_numeric(train, errors="coerce").astype(float).fillna(0.0)
    model = SARIMAX(
        x,
        order=order,
        seasonal_order=seasonal_order,
        enforce_stationarity=False,
        enforce_invertibility=False,
    ).fit(disp=False)
    return model.forecast(h).values


def fc_holt_trend(train, h):
    x = pd.to_numeric(train, errors="coerce").astype(float).fillna(0.0)
    model = Holt(x, initialization_method="estimated").fit(optimized=True)
    return model.forecast(h).values


def fc_holt_seasonal(train, h):
    x = pd.to_numeric(train, errors="coerce").astype(float).fillna(0.0)
    model = ExponentialSmoothing(
        x, trend="add", seasonal="add", seasonal_periods=SEASON,
        initialization_method="estimated"
    ).fit(optimized=True)
    return model.forecast(h).values


def _ml_features(s: pd.Series):
    df_ml = pd.DataFrame({"y": s.values})
    df_ml["lag_1"] = df_ml["y"].shift(1)
    df_ml["lag_2"] = df_ml["y"].shift(2)
    df_ml["lag_4"] = df_ml["y"].shift(4)
    df_ml["lag_8"] = df_ml["y"].shift(8)
    df_ml["roll_mean_4"] = df_ml["y"].shift(1).rolling(4).mean()
    return df_ml.dropna().copy()


def _ml_predict(model, history, horizon):
    preds = []
    for _ in range(horizon):
        X_future = pd.DataFrame([{
            "lag_1": history[-1],
            "lag_2": history[-2] if len(history) >= 2 else history[-1],
            "lag_4": history[-4] if len(history) >= 4 else history[-1],
            "lag_8": history[-8] if len(history) >= 8 else history[-1],
            "roll_mean_4": np.mean(history[-4:]) if len(history) >= 4 else np.mean(history),
        }])
        pred = max(0.0, float(model.predict(X_future)[0]))
        preds.append(pred)
        history.append(pred)
    return np.array(preds, dtype=float)


def lightgbm_forecast(series, horizon=8):
    s = pd.Series(series).dropna().astype(float).copy()
    if len(s) < 9:
        fallback = s.tail(min(4, len(s))).mean() if len(s) > 0 else 0.0
        return np.array([max(0, fallback)] * horizon, dtype=float)
    df_ml = _ml_features(s)
    if len(df_ml) < 2:
        return np.array([max(0, s.tail(4).mean())] * horizon, dtype=float)
    feats = ["lag_1", "lag_2", "lag_4", "lag_8", "roll_mean_4"]
    model = lgb.LGBMRegressor(
        n_estimators=300, learning_rate=0.05, num_leaves=15,
        min_child_samples=5, random_state=42, verbosity=-1,
    ).fit(df_ml[feats], df_ml["y"])
    return _ml_predict(model, list(s.values), horizon)


def xgboost_forecast(series, horizon=8):
    s = pd.Series(series).dropna().astype(float).copy()
    if len(s) < 9:
        fallback = s.tail(min(4, len(s))).mean() if len(s) > 0 else 0.0
        return np.array([max(0, fallback)] * horizon, dtype=float)
    df_ml = _ml_features(s)
    if len(df_ml) < 2:
        return np.array([max(0, s.tail(4).mean())] * horizon, dtype=float)
    feats = ["lag_1", "lag_2", "lag_4", "lag_8", "roll_mean_4"]
    model = xgb.XGBRegressor(
        n_estimators=200, learning_rate=0.05, max_depth=3, min_child_weight=5,
        subsample=0.8, colsample_bytree=0.8, objective="reg:squarederror",
        random_state=42, n_jobs=-1,
    ).fit(df_ml[feats], df_ml["y"])
    return _ml_predict(model, list(s.values), horizon)


def randomforest_forecast(series, horizon=8):
    s = pd.Series(series).dropna().astype(float).copy()
    if len(s) < 9:
        fallback = s.tail(min(4, len(s))).mean() if len(s) > 0 else 0.0
        return np.array([max(0, fallback)] * horizon, dtype=float)
    df_ml = _ml_features(s)
    if len(df_ml) < 2:
        return np.array([max(0, s.tail(4).mean())] * horizon, dtype=float)
    feats = ["lag_1", "lag_2", "lag_4", "lag_8", "roll_mean_4"]
    model = RandomForestRegressor(
        n_estimators=200, max_depth=6, min_samples_leaf=3, random_state=42, n_jobs=-1,
    ).fit(df_ml[feats], df_ml["y"])
    return _ml_predict(model, list(s.values), horizon)


MODELS = {
    "MovingAvg": fc_moving_avg,
    "ETS": fc_ets,
    "ARIMA": fc_arima,
    "SeasonalARIMA": fc_sarima,
    "HoltTrend": fc_holt_trend,
    "HoltSeasonal": fc_holt_seasonal,
    "SeasonalNaive": fc_seasonal_naive,
    "LightGBM": lightgbm_forecast,
    "XGBoost": xgboost_forecast,
    "RandomForest": randomforest_forecast,
}


def rolling_backtest_select(series, horizon=8, folds=5, min_train=10, season=52):
    if len(series) < (min_train + horizon * (folds + 1)):
        return None

    end = len(series)
    fold_ends = [end - i * horizon for i in range(folds, 0, -1)]
    results = []

    for name, fn in MODELS.items():
        rmses = []
        ok = True

        for fe in fold_ends:
            train = series.iloc[: fe - horizon]
            val = series.iloc[fe - horizon: fe]

            if len(train) < min_train:
                ok = False
                break

            if name in {"ETS", "HoltSeasonal", "SeasonalARIMA"} and len(train) < 2 * season:
                ok = False
                break
            if name == "SeasonalNaive" and len(train) < season:
                ok = False
                break

            try:
                pred = fn(train, horizon)
                if pred is None:
                    ok = False
                    break

                pred = np.asarray(pred, dtype=float)
                if len(pred) != horizon or np.any(np.isnan(pred)) or np.any(np.isinf(pred)):
                    ok = False
                    break

                scale = max(1.0, np.nanmax(np.abs(train.values)))
                if np.nanmax(np.abs(pred)) > 100 * scale:
                    ok = False
                    break

                rmses.append(rmse(val.values, pred))
            except Exception:
                ok = False
                break

        if ok and rmses:
            results.append({"Model": name, "RMSE": float(np.mean(rmses))})

    if not results:
        return None

    res_df = pd.DataFrame(results).sort_values("RMSE").reset_index(drop=True)
    return res_df.loc[0, "Model"]


def holdout_select(series, test_weeks=13, min_points=10):
    if len(series) < (min_points + test_weeks):
        return None

    train = series.iloc[:-test_weeks]
    results = []

    for name, fn in MODELS.items():
        if name in {"SeasonalARIMA", "ETS", "HoltSeasonal"} and len(train) < 104:
            continue
        if name == "SeasonalNaive" and len(train) < 52:
            continue

        try:
            pred = fn(train, test_weeks)
            if pred is None:
                continue

            pred = np.asarray(pred, dtype=float)
            if len(pred) != test_weeks or np.any(np.isnan(pred)) or np.any(np.isinf(pred)):
                continue

            scale = max(1.0, np.nanmax(np.abs(train.values)))
            if np.nanmax(np.abs(pred)) > 100 * scale:
                continue

            results.append({"Model": name, "RMSE": rmse(series.iloc[-test_weeks:].values, pred)})
        except Exception:
            continue

    if not results:
        return None

    res_df = pd.DataFrame(results).sort_values("RMSE").reset_index(drop=True)
    return res_df.loc[0, "Model"]


def hybrid_forecast_52(series, near_horizon=8, long_horizon=52, folds=5, test_weeks=13):
    near_model = rolling_backtest_select(series, horizon=near_horizon, folds=folds)
    long_model = holdout_select(series, test_weeks=test_weeks)

    def choose_fallback(s, horizon):
        if len(s) >= SEASON:
            return "SeasonalNaive"
        return "MovingAvg"

    if near_model is None:
        near_model = choose_fallback(series, near_horizon)

    if long_model is None:
        long_model = choose_fallback(series, long_horizon)

    near_pred = MODELS[near_model](series, near_horizon)
    long_pred = MODELS[long_model](series, long_horizon)

    final = np.array(long_pred, dtype=float)
    final[:near_horizon] = np.array(near_pred, dtype=float)
    final = np.maximum(final, 0)

    # Guardrail: if the chosen models produce a blow-up (> 100x history) OR a
    # degenerate collapse (< 1% of a meaningful history) on the full series,
    # fall back to MovingAvg for the offending horizon. These can slip past
    # backtest validation when the model fits fine on folds but fails on
    # the full series.
    hist_scale = max(1.0, float(np.nanmax(np.abs(series.values)))) if len(series) else 1.0
    recent_mean = float(np.mean(np.abs(series.iloc[-8:].values))) if len(series) >= 8 else hist_scale
    cap = 100 * hist_scale
    floor = 0.01 * recent_mean  # anything below this is "degenerate" if history wasn't flat zero

    def _is_bad(slice_, label):
        if np.any(np.isnan(slice_)) or np.any(np.isinf(slice_)):
            return f"NaN/Inf in {label}"
        if len(slice_) and np.nanmax(slice_) > cap:
            return f"blow-up in {label} (max={np.nanmax(slice_):.2e} vs cap={cap:.2e})"
        if recent_mean > 0.1 and len(slice_) and np.nanmax(slice_) < floor:
            return f"degenerate zero in {label} (max={np.nanmax(slice_):.4f} vs recent_mean={recent_mean:.2f})"
        return None

    near_slice = final[:near_horizon]
    problem = _is_bad(near_slice, "near horizon")
    if problem:
        print(f"  {problem} (model={near_model}), falling back to MovingAvg")
        final[:near_horizon] = np.maximum(fc_moving_avg(series, near_horizon), 0)
        near_model = f"{near_model}->MovingAvg(fallback)"

    long_slice = final[near_horizon:]
    problem = _is_bad(long_slice, "long horizon")
    if problem:
        print(f"  {problem} (model={long_model}), falling back to MovingAvg")
        final[near_horizon:] = np.maximum(fc_moving_avg(series, long_horizon - near_horizon), 0)
        long_model = f"{long_model}->MovingAvg(fallback)"

    return final, near_model, long_model


def make_product_weekly_series(df, product):
    """Weekly series for a product, summing across ALL channels and packaging."""
    s = (
        df[df["ProductName"] == product]
        .groupby("Date")["Sales Vol"]
        .sum()
        .sort_index()
    )
    s = s.asfreq("W-MON").fillna(0)
    return s


def build_product_level_forecast_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Run the full ensemble on product-level aggregated series (one per ProductName)."""
    products = sorted(df["ProductName"].dropna().unique())
    rows = []

    for product in products:
        try:
            series = make_product_weekly_series(df, product)
            fc52, best_near, best_long = hybrid_forecast_52(
                series, near_horizon=8, long_horizon=52, folds=5, test_weeks=13,
            )

            row = {
                "ProductName": product,
                "Channel": "all",
                "PackagingTypeName": "ALL",
                "BestModel_Weeks1to8": best_near,
                "BestModel_Weeks9to52": best_long,
            }
            row.update({f"Week{i}": float(fc52[i - 1]) for i in range(1, 53)})
            rows.append(row)

        except Exception as e:
            print(f"Skipping product-level {product}: {e}")

    product_df = pd.DataFrame(rows)
    print("Product-level forecast rows:", product_df.shape)
    return product_df


def build_forecast_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    segments = (
        df.dropna(subset=["ProductName", "Channel", "PackagingTypeName"])[
            ["ProductName", "Channel", "PackagingTypeName"]
        ]
        .drop_duplicates()
        .sort_values(["ProductName", "Channel", "PackagingTypeName"])
        .reset_index(drop=True)
    )

    rows = []

    for _, seg in segments.iterrows():
        product = seg["ProductName"]
        channel = seg["Channel"]
        packaging = seg["PackagingTypeName"]

        try:
            series = make_weekly_series(df, product, channel, packaging)
            fc52, best_near, best_long = hybrid_forecast_52(
                series,
                near_horizon=8,
                long_horizon=52,
                folds=5,
                test_weeks=13,
            )

            row = {
                "ProductName": product,
                "Channel": channel,
                "PackagingTypeName": packaging,
                "BestModel_Weeks1to8": best_near,
                "BestModel_Weeks9to52": best_long,
            }
            row.update({f"Week{i}": float(fc52[i - 1]) for i in range(1, 53)})
            rows.append(row)

        except Exception as e:
            print(f"Skipping {product} | {channel} | {packaging}: {e}")

    forecast_df = pd.DataFrame(rows)
    print("Forecast rows:", forecast_df.shape)
    return forecast_df


def create_planning_session(client_id: str) -> str:
    session_payload = {
        "client_id": client_id,
        "status": "active",
        "current_phase": "demand",
    }
    session_resp = supabase.table("planning_sessions").insert(session_payload).execute()
    session_id = session_resp.data[0]["id"]
    print("Created session:", session_id)
    return session_id


def reshape_forecast_to_demand_plans(df: pd.DataFrame, session_id: str, year: int) -> pd.DataFrame:
    week_cols = [f"Week{i}" for i in range(1, 53) if f"Week{i}" in df.columns]
    long_rows = []

    for _, row in df.iterrows():
        brand = row["ProductName"]
        channel = row["Channel"]
        packaging = row["PackagingTypeName"]

        if pd.isna(channel) or str(channel).strip() == "":
            channel = "all"

        for week_col in week_cols:
            value = row[week_col]
            if pd.isna(value):
                continue

            week_number = int(week_col.replace("Week", ""))

            long_rows.append({
                "session_id": session_id,
                "brand": str(brand),
                "channel": str(channel),
                "packaging_format": str(packaging),
                "week_number": week_number,
                "year": year,
                "previous_value": float(value),
                "recommended_value": None,
                "effective_value": None,
                "override_rationale": None,
            })

    return pd.DataFrame(long_rows)


def insert_in_batches(table_name: str, df: pd.DataFrame, batch_size: int = 500):
    records = df.to_dict(orient="records")

    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        supabase.table(table_name).insert(batch).execute()
        print(f"Inserted rows {i} to {i + len(batch) - 1}")


def generate_demand_plan() -> str:
    print("Loading historical demand from Supabase...")
    df = load_historical_demand()

    print("Building packaging-level forecast dataframe...")
    packaging_df = build_forecast_dataframe(df)

    print("Building product-level forecast dataframe...")
    product_df = build_product_level_forecast_dataframe(df)

    print("Creating planning session...")
    session_id = create_planning_session(CLIENT_ID)

    print("Reshaping packaging-level rows...")
    packaging_rows = reshape_forecast_to_demand_plans(
        packaging_df, session_id=session_id, year=FORECAST_YEAR,
    )

    print("Reshaping product-level rows...")
    product_rows = reshape_forecast_to_demand_plans(
        product_df, session_id=session_id, year=FORECAST_YEAR,
    )

    combined = pd.concat([packaging_rows, product_rows], ignore_index=True)
    print(f"Inserting {len(combined)} demand plan rows ({len(packaging_rows)} packaging + {len(product_rows)} product)...")
    insert_in_batches("demand_plans", combined, batch_size=500)

    print("Done.")
    print("SESSION_ID:", session_id)
    return session_id


def main():
    generate_demand_plan()


if __name__ == "__main__":
    main()
