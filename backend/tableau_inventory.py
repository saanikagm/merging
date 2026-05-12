import csv
import io
import os

import requests

TABLEAU_SERVER = os.environ.get("TABLEAU_SERVER", "https://10az.online.tableau.com")
TABLEAU_SITE = os.environ.get("TABLEAU_SITE", "centralcoastanalytics")
TABLEAU_VIEW_NAME = os.environ.get("TABLEAU_VIEW_NAME", "CurrentBeerInventory")
TABLEAU_WIP_VIEW_NAME = os.environ.get("TABLEAU_WIP_VIEW_NAME", "Inventory Forecasting Detail")
TABLEAU_API_VERSION = os.environ.get("TABLEAU_API_VERSION", "3.21")


def _signin() -> tuple[str, str]:
    pat_name = os.environ.get("TABLEAU_PAT_NAME")
    pat_secret = os.environ.get("TABLEAU_PAT_SECRET")
    if not pat_name or not pat_secret:
        raise RuntimeError("TABLEAU_PAT_NAME and TABLEAU_PAT_SECRET must be set")

    url = f"{TABLEAU_SERVER}/api/{TABLEAU_API_VERSION}/auth/signin"
    body = {
        "credentials": {
            "personalAccessTokenName": pat_name,
            "personalAccessTokenSecret": pat_secret,
            "site": {"contentUrl": TABLEAU_SITE},
        }
    }
    resp = requests.post(url, json=body, headers={"Accept": "application/json"}, timeout=15)
    resp.raise_for_status()
    data = resp.json()["credentials"]
    return data["token"], data["site"]["id"]


def _find_view_id(token: str, site_id: str, view_name: str | None = None) -> str:
    name = view_name or TABLEAU_VIEW_NAME
    url = f"{TABLEAU_SERVER}/api/{TABLEAU_API_VERSION}/sites/{site_id}/views"
    params = {"filter": f"name:eq:{name}"}
    headers = {"X-Tableau-Auth": token, "Accept": "application/json"}
    resp = requests.get(url, params=params, headers=headers, timeout=15)
    resp.raise_for_status()
    views = resp.json().get("views", {}).get("view", [])
    if not views:
        raise RuntimeError(f"View '{name}' not found on site")
    return views[0]["id"]


def _download_view_csv(
    token: str,
    site_id: str,
    view_id: str,
    view_filters: dict[str, str] | None = None,
) -> str:
    url = f"{TABLEAU_SERVER}/api/{TABLEAU_API_VERSION}/sites/{site_id}/views/{view_id}/data"
    headers = {"X-Tableau-Auth": token}
    # maxAge=1 asks Tableau for data refreshed within the last minute (best-effort).
    params: dict[str, str | int] = {"maxAge": 1}
    if view_filters:
        for k, v in view_filters.items():
            params[k] = v
    resp = requests.get(url, headers=headers, params=params, timeout=30)
    resp.raise_for_status()
    # The endpoint usually returns UTF-8 CSV. Some Tableau crosstab downloads come
    # back as UTF-16 with a BOM; handle both.
    if resp.content[:2] == b"\xff\xfe" or resp.content[:2] == b"\xfe\xff":
        return resp.content.decode("utf-16")
    return resp.text


def _signout(token: str) -> None:
    try:
        requests.post(
            f"{TABLEAU_SERVER}/api/{TABLEAU_API_VERSION}/auth/signout",
            headers={"X-Tableau-Auth": token},
            timeout=10,
        )
    except Exception:
        pass


def fetch_inventory() -> list[dict]:
    token, site_id = _signin()
    try:
        view_id = _find_view_id(token, site_id)
        csv_text = _download_view_csv(token, site_id, view_id)
    finally:
        _signout(token)

    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    if not rows:
        return []

    header = [h.strip() for h in rows[0]]
    out: list[dict] = []
    for raw in rows[1:]:
        if not raw:
            continue
        record = {}
        for i, value in enumerate(raw):
            key = header[i] if i < len(header) and header[i] else f"col_{i}"
            record[key] = value.strip()
        out.append(record)
    return out


def _normalize_date(raw: str) -> str | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            from datetime import datetime
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def fetch_wip_schedule(week_dates: list[str] | None = None) -> list[dict]:
    """Returns a flat list of WIP arrivals from the 'Inventory Forecasting Detail'
    Tableau view. Each row: { product_name, week_start_date (YYYY-MM-DD), bbl (float) }.

    week_dates is the list of week-start ISO dates (YYYY-MM-DD) we want covered. They are
    passed as a comma-separated vf_Date filter so the view returns those exact weeks rather
    than the workbook's default range.
    """
    view_filters: dict[str, str] | None = None
    if week_dates:
        view_filters = {"vf_Date": ",".join(week_dates)}
    token, site_id = _signin()
    try:
        view_id = _find_view_id(token, site_id, TABLEAU_WIP_VIEW_NAME)
        csv_text = _download_view_csv(token, site_id, view_id, view_filters)
    finally:
        _signout(token)

    reader = csv.DictReader(io.StringIO(csv_text))
    out: list[dict] = []
    for row in reader:
        if (row.get("Measure Names") or "").strip() != "WIP":
            continue
        name = (row.get("ProductName") or "").strip()
        date_iso = _normalize_date(row.get("Date") or "")
        try:
            bbl = float((row.get("Measure Values") or "0").replace(",", ""))
        except ValueError:
            continue
        if not name or not date_iso:
            continue
        out.append({"product_name": name, "week_start_date": date_iso, "bbl": bbl})
    return out
