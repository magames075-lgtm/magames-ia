"""Pluviômetro da vizinhança (ClimaA v1.3) — relatos de chuva da comunidade.

POST /chuva/relato   {lat, lon, mm, agora?: "fraca"|"forte"|"granizo"}
GET  /chuva/relatos?lat&lon&raio_km=30&horas=24

Privacidade: coordenadas arredondadas para 0,01° (~1 km) antes de gravar; IP não é gravado.
Armazenamento: SQLite em CHUVA_DB (padrão /tmp/chuva.sqlite). No Render grátis o disco é
efêmero: os relatos somem quando o serviço reinicia/redeploya.
"""
import math, os, sqlite3, threading, time
from collections import defaultdict, deque

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()
DB = os.environ.get("CHUVA_DB", "/tmp/chuva.sqlite")
LIM_HORA = 6
_lock = threading.Lock()
_hits: dict[str, deque] = defaultdict(deque)
AGORA_OK = {"", "fraca", "forte", "granizo"}


def _db():
    c = sqlite3.connect(DB, check_same_thread=False)
    c.execute("CREATE TABLE IF NOT EXISTS relatos (id INTEGER PRIMARY KEY, ts REAL, lat REAL, lon REAL, mm REAL, agora TEXT)")
    c.execute("CREATE INDEX IF NOT EXISTS ix_ts ON relatos(ts)")
    return c


_conn = _db()


def _ip(req: Request) -> str:
    return req.headers.get("x-forwarded-for", "").split(",")[0].strip() or (req.client.host if req.client else "?")


def _km(a1, o1, a2, o2):
    r = math.radians
    d = math.sin(r(a2 - a1) / 2) ** 2 + math.cos(r(a1)) * math.cos(r(a2)) * math.sin(r(o2 - o1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(d))


def _num(v, lo, hi):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and lo <= f <= hi else None


@router.post("/chuva/relato")
async def relato(req: Request):
    try:
        b = await req.json()
        assert isinstance(b, dict)
    except Exception:
        return JSONResponse({"erro": "JSON inválido"}, 400)
    lat, lon, mm = _num(b.get("lat"), -90, 90), _num(b.get("lon"), -180, 180), _num(b.get("mm"), 0, 500)
    agora = str(b.get("agora") or "").strip().lower()
    if lat is None or lon is None:
        return JSONResponse({"erro": "lat/lon fora do intervalo"}, 400)
    if mm is None:
        return JSONResponse({"erro": "mm deve ser de 0 a 500"}, 400)
    if agora not in AGORA_OK:
        return JSONResponse({"erro": "agora deve ser fraca, forte ou granizo"}, 400)
    ip, now = _ip(req), time.time()
    with _lock:
        q = _hits[ip]
        while q and now - q[0] > 3600:
            q.popleft()
        if len(q) >= LIM_HORA:
            return JSONResponse({"erro": "Muitos relatos. Tente de novo mais tarde."}, 429,
                                headers={"Retry-After": str(int(3600 - (now - q[0])) + 1)})
        q.append(now)
        lat, lon = round(lat, 2), round(lon, 2)
        cur = _conn.execute("INSERT INTO relatos (ts, lat, lon, mm, agora) VALUES (?,?,?,?,?)",
                            (now, lat, lon, round(mm, 1), agora))
        _conn.execute("DELETE FROM relatos WHERE ts < ?", (now - 8 * 86400,))
        _conn.commit()
    return {"ok": True, "id": cur.lastrowid, "lat": lat, "lon": lon, "mm": round(mm, 1), "agora": agora, "ts": int(now)}


@router.get("/chuva/relatos")
def relatos(lat: float, lon: float, raio_km: float = 30, horas: float = 24):
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return JSONResponse({"erro": "lat/lon fora do intervalo"}, 400)
    raio_km, horas = max(1.0, min(raio_km, 200.0)), max(1.0, min(horas, 168.0))
    now = time.time()
    dlat = raio_km / 111.0
    dlon = raio_km / (111.0 * max(0.05, math.cos(math.radians(lat))))
    with _lock:
        rows = _conn.execute(
            "SELECT id, ts, lat, lon, mm, agora FROM relatos WHERE ts >= ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY ts DESC LIMIT 500",
            (now - horas * 3600, lat - dlat, lat + dlat, lon - dlon, lon + dlon)).fetchall()
    out = []
    for i, ts, a, o, mm, ag in rows:
        d = _km(lat, lon, a, o)
        if d <= raio_km:
            out.append({"id": i, "lat": a, "lon": o, "mm": mm, "agora": ag, "ts": int(ts), "min_atras": int((now - ts) // 60), "km": round(d, 1)})
    return {"relatos": out, "raio_km": raio_km, "horas": horas, "aviso": "Servidor grátis: relatos podem sumir quando o servidor reinicia."}
