import csv
import io
import os

import requests

TABLEAU_SERVER = os.environ.get("TABLEAU_SERVER", "https://10az.online.tableau.com")
TABLEAU_SITE = os.environ.get("TABLEAU_SITE", "centralcoastanalytics")
TABLEAU_VIEW_NAME = os.environ.get("TABLEAU_VIEW_NAME", "CurrentBeerInventory")
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


def _find_view_id(token: str, site_id: str) -> str:
    url = f"{TABLEAU_SERVER}/api/{TABLEAU_API_VERSION}/sites/{site_id}/views"
    params = {"filter": f"name:eq:{TABLEAU_VIEW_NAME}"}
    headers = {"X-Tableau-Auth": token, "Accept": "application/json"}
    resp = requests.get(url, params=params, headers=headers, timeout=15)
    resp.raise_for_status()
    views = resp.json().get("views", {}).get("view", [])
    if not views:
        raise RuntimeError(f"View '{TABLEAU_VIEW_NAME}' not found on site")
    return views[0]["id"]


def _download_view_csv(token: str, site_id: str, view_id: str) -> str:
    url = f"{TABLEAU_SERVER}/api/{TABLEAU_API_VERSION}/sites/{site_id}/views/{view_id}/data"
    headers = {"X-Tableau-Auth": token}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
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
