from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from generate_demand_plan import generate_demand_plan

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/run-forecast")
def run_forecast():
    session_id = generate_demand_plan()
    return {"success": True, "session_id": session_id}
