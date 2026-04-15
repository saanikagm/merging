import os
import threading
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from generate_demand_plan import generate_demand_plan
from tableau_inventory import fetch_inventory

app = FastAPI()

allowed_origins = [
    o.strip()
    for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_KEY = os.environ.get("FORECAST_API_KEY")

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


def _run_job(job_id: str):
    try:
        session_id = generate_demand_plan()
        with jobs_lock:
            jobs[job_id] = {"status": "done", "session_id": session_id}
    except Exception as e:
        with jobs_lock:
            jobs[job_id] = {"status": "error", "error": str(e)}


def _check_auth(x_api_key: str | None):
    if not API_KEY or x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/run-forecast")
def run_forecast(x_api_key: str | None = Header(default=None)):
    _check_auth(x_api_key)
    job_id = str(uuid.uuid4())
    with jobs_lock:
        jobs[job_id] = {"status": "running"}
    threading.Thread(target=_run_job, args=(job_id,), daemon=True).start()
    return {"success": True, "job_id": job_id, "status": "running"}


@app.get("/inventory")
def inventory(x_api_key: str | None = Header(default=None)):
    _check_auth(x_api_key)
    try:
        rows = fetch_inventory()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Tableau fetch failed: {e}")
    return {"rows": rows}


@app.get("/forecast-status/{job_id}")
def forecast_status(job_id: str, x_api_key: str | None = Header(default=None)):
    _check_auth(x_api_key)
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job
