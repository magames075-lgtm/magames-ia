"""MaGames IA — backend grátis (Render free tier).

Endpoints:
  GET  /api/health            status + provedores configurados
  POST /api/chat              streaming SSE (Gemini → Groq → LLM7)
  POST /api/image             bytes da imagem (Gemini image → Pollinations c/ chave → Pollinations anônimo → foto livre)
  GET  /api/voices            vozes neurais
  POST /api/tts               MP3 (edge-tts; reserva Google TTS)
  POST /api/stt               transcrição (Groq Whisper)
  POST /api/script            roteiro de vídeo (JSON)
  POST /api/video             cria job de vídeo → {id}
  GET  /api/video/{id}        status/progresso
  GET  /api/video/{id}/file   MP4
Chaves só em variáveis de ambiente (GEMINI_API_KEY, GROQ_API_KEY, POLLINATIONS_KEY). Nunca no repositório.
"""
import asyncio, base64, json, os, random, re, shutil, time, uuid, urllib.parse
from collections import defaultdict, deque

import httpx
from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse, FileResponse

import video as videomod

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GROQ_KEY = os.environ.get("GROQ_API_KEY", "").strip()
POLL_KEY = os.environ.get("POLLINATIONS_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
GEMINI_ALT_MODELS = ["gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-flash-latest"]
MODEL_OVERRIDE: dict[str, str] = {}
GEMINI_IMAGE_MODEL = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
VERSION = "2.1.0"
STARTED = time.time()

app = FastAPI(title="MaGames IA API", version=VERSION)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["X-Provider", "X-Retry-After", "Content-Disposition"])

client: httpx.AsyncClient | None = None


@app.on_event("startup")
async def _startup():
    global client
    client = httpx.AsyncClient(timeout=httpx.Timeout(120, connect=15), follow_redirects=True,
                               headers={"User-Agent": "MaGamesIA/2.0 (+https://magames075-lgtm.github.io/magames-ia/)"})
    videomod.init(client, chat_complete, generate_image, tts_bytes)
    asyncio.create_task(videomod.cleanup_loop())


# ---------------- limites simples por IP ----------------
_hits: dict[str, deque] = defaultdict(deque)


def client_ip(req: Request) -> str:
    return (req.headers.get("x-forwarded-for", "").split(",")[0].strip() or (req.client.host if req.client else "?"))


def limited(req: Request, bucket: str, n: int, per: int) -> bool:
    k = bucket + ":" + client_ip(req)
    q = _hits[k]
    now = time.time()
    while q and now - q[0] > per:
        q.popleft()
    if len(q) >= n:
        return True
    q.append(now)
    return False


def err(status: int, msg: str, retry: int = 0):
    h = {"X-Retry-After": str(retry)} if retry else {}
    return JSONResponse({"error": msg, "retry_after": retry}, status_code=status, headers=h)


# circuit breaker por provedor
_down: dict[str, float] = {}
LAST_ERR: dict[str, str] = {}


def is_down(p: str) -> bool:
    return _down.get(p, 0) > time.time()


def mark_down(p: str, sec: float):
    _down[p] = time.time() + sec


@app.get("/")
async def root():
    return {"app": "MaGames IA API", "version": VERSION, "docs": "/docs"}


@app.get("/api/health")
async def health():
    return {"ok": True, "version": VERSION, "uptime": int(time.time() - STARTED),
            "chat": [p for p, k in (("gemini", GEMINI_KEY), ("groq", GROQ_KEY), ("llm7", "1")) if k],
            "image": [p for p, k in (("gemini", GEMINI_KEY), ("pollinations-key", POLL_KEY), ("pollinations", "1"), ("foto-livre", "1")) if k],
            "tts": "edge-tts", "stt": bool(GROQ_KEY), "video_queue": videomod.queue_size(),
            "down": {p: int(t - time.time()) for p, t in _down.items() if t > time.time()}, "last_errors": LAST_ERR}


# ---------------- CHAT ----------------
SYSTEM_DEFAULT = ("Você é a MaGames IA, uma assistente brilhante, útil e direta, criada pela MaGames. "
                  "Responda em português do Brasil (a menos que o usuário use outro idioma), com Markdown quando ajudar "
                  "(listas, tabelas, blocos de código). Seja precisa; se não souber, diga.")


def providers_chain(prefer: str | None = None):
    chain = []
    if GEMINI_KEY:
        chain.append(("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", GEMINI_KEY, MODEL_OVERRIDE.get("gemini", GEMINI_MODEL)))
    if GROQ_KEY:
        chain.append(("groq", "https://api.groq.com/openai/v1/chat/completions", GROQ_KEY, GROQ_MODEL))
    chain.append(("llm7", "https://api.llm7.io/v1/chat/completions", "", "default"))
    if prefer:
        chain.sort(key=lambda c: 0 if c[0] == prefer else 1)
    return chain


def clean_messages(msgs, system=None):
    out = []
    for m in msgs[-40:]:
        role = m.get("role")
        if role not in ("user", "assistant", "system"):
            continue
        c = m.get("content")
        if isinstance(c, str):
            c = c[:30000]
        elif isinstance(c, list):  # partes multimodais (texto + imagem data URL)
            c = [p for p in c if isinstance(p, dict) and p.get("type") in ("text", "image_url")][:6]
        else:
            continue
        out.append({"role": role, "content": c})
    if not out or out[0]["role"] != "system":
        out.insert(0, {"role": "system", "content": system or SYSTEM_DEFAULT})
    return out


def _has_images(msgs):
    return any(isinstance(m["content"], list) and any(p.get("type") == "image_url" for p in m["content"]) for m in msgs)


def _text_only(msgs):
    o = []
    for m in msgs:
        c = m["content"]
        if isinstance(c, list):
            c = " ".join(p.get("text", "") for p in c if p.get("type") == "text") + " [imagem anexada não suportada por este motor]"
        o.append({"role": m["role"], "content": c})
    return o


async def stream_provider(name, url, key, model, messages, temperature):
    """Gera pedaços de texto. Lança exceção se falhar antes de produzir algo."""
    body = {"model": model, "messages": messages, "stream": True, "temperature": temperature}
    if name == "gemini":
        body["reasoning_effort"] = "low"
    if name == "groq" and "gpt-oss" in model:
        body["reasoning_effort"] = "low"
        body["include_reasoning"] = False
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    async with client.stream("POST", url, json=body, headers=headers, timeout=httpx.Timeout(90, connect=10)) as r:
        if r.status_code != 200:
            t = (await r.aread()).decode("utf-8", "ignore")[:300]
            e = RuntimeError(f"{name} {r.status_code}: {t}")
            e.status = r.status_code
            raise e
        buf = ""
        async for chunk in r.aiter_text():
            buf += chunk
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    j = json.loads(data)
                except Exception:
                    continue
                if j.get("error"):
                    raise RuntimeError(f"{name}: {j['error'].get('message', 'erro')}")
                ch = (j.get("choices") or [{}])[0]
                d = ch.get("delta") or ch.get("message") or {}
                if d.get("content"):
                    yield d["content"]


async def chat_stream(messages, temperature=0.7, prefer=None):
    """Yields ('provider', name) | ('t', text) | ('error', msg)."""
    errors = []
    multimodal = _has_images(messages)
    for name, url, key, model in providers_chain(prefer):
        if is_down(name):
            errors.append(f"{name}: em pausa (limite)")
            continue
        msgs = messages if (name == "gemini" or not multimodal) else _text_only(messages)
        got = False
        for attempt in range(2):
            try:
                yield ("provider", name)
                agen = stream_provider(name, url, key, MODEL_OVERRIDE.get(name, model), msgs, temperature)
                try:
                    while True:
                        try:
                            t = await asyncio.wait_for(agen.__anext__(), (12 if name == "gemini" else 25) if not got else 40)
                        except StopAsyncIteration:
                            break
                        except asyncio.TimeoutError:
                            te = RuntimeError(f"{name}: sem resposta a tempo")
                            te.status = 504
                            raise te
                        got = True
                        yield ("t", t)
                finally:
                    try:
                        await agen.aclose()
                    except Exception:
                        pass
                if got:
                    return
                raise RuntimeError(f"{name}: resposta vazia")
            except Exception as e:  # noqa
                st = getattr(e, "status", 0)
                if got:
                    yield ("error", "a resposta foi interrompida; toque em regenerar")
                    return
                errors.append(str(e)[:200])
                LAST_ERR[name] = time.strftime("%H:%M ") + str(e)[:200]
                if st == 404 and name == "gemini" and attempt == 0:
                    m = re.search(r"use models/([\w.\-]+)", str(e))
                    MODEL_OVERRIDE["gemini"] = m.group(1) if m else "gemini-flash-latest"
                    model = MODEL_OVERRIDE["gemini"]
                    continue
                if st == 429:
                    mark_down(name, 60 if attempt else 20)
                    break
                if st in (401, 403):
                    mark_down(name, 600)
                    break
                if st == 503 and name == "gemini" and attempt == 0:
                    # modelo sobrecarregado: tenta outro modelo Gemini grátis antes de trocar de motor
                    cur = MODEL_OVERRIDE.get("gemini", GEMINI_MODEL)
                    alt = [m for m in GEMINI_ALT_MODELS if m != cur]
                    if alt:
                        MODEL_OVERRIDE["gemini"] = alt[0]
                        GEMINI_ALT_MODELS.remove(alt[0]); GEMINI_ALT_MODELS.append(alt[0])
                        continue
                if st in (503, 504):
                    mark_down(name, 300 if name == "gemini" else 90)  # sobrecarregado/lento: usa o próximo motor por 90 s
                    break
                if st in (500, 502) and attempt == 0:
                    await asyncio.sleep(1.5)
                    continue
                break
    yield ("error", "Todos os motores de IA falharam agora. " + " | ".join(errors[-3:]))


async def chat_complete(messages, temperature=0.7, system=None, prefer=None) -> str:
    msgs = clean_messages(messages, system)
    out, last_err = [], ""
    async for kind, val in chat_stream(msgs, temperature, prefer):
        if kind == "t":
            out.append(val)
        elif kind == "error":
            last_err = val
    if not out:
        raise RuntimeError(last_err or "sem resposta")
    return "".join(out)


@app.post("/api/chat")
async def api_chat(req: Request):
    if limited(req, "chat", 30, 60):
        return err(429, "Muitas mensagens em pouco tempo. Aguarde alguns segundos.", 20)
    try:
        body = await req.json()
    except Exception:
        return err(400, "JSON inválido")
    msgs = clean_messages(body.get("messages") or [], body.get("system"))
    temp = float(body.get("temperature", 0.7))
    prefer = body.get("provider") if body.get("provider") in ("gemini", "groq", "llm7") else None

    async def gen():
        yield ": ok\n\n"
        async for kind, val in chat_stream(msgs, temp, prefer):
            if kind == "t":
                yield "data: " + json.dumps({"t": val}, ensure_ascii=False) + "\n\n"
            elif kind == "provider":
                yield "data: " + json.dumps({"provider": val}) + "\n\n"
            else:
                yield "data: " + json.dumps({"error": val}, ensure_ascii=False) + "\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


# ---------------- IMAGEM ----------------
_poll_lock = asyncio.Lock()
_poll_next = 0.0


async def img_gemini(prompt, w, h):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_IMAGE_MODEL}:generateContent"
    ar = "16:9" if w > h * 1.3 else ("9:16" if h > w * 1.3 else "1:1")
    body = {"contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": ar}}}
    r = await client.post(url, json=body, headers={"x-goog-api-key": GEMINI_KEY}, timeout=90)
    if r.status_code != 200:
        e = RuntimeError(f"gemini-image {r.status_code}: {r.text[:200]}")
        e.status = r.status_code
        raise e
    for c in r.json().get("candidates", []):
        for p in c.get("content", {}).get("parts", []):
            d = p.get("inlineData") or p.get("inline_data")
            if d and d.get("data"):
                return base64.b64decode(d["data"]), d.get("mimeType", "image/png")
    raise RuntimeError("gemini-image: sem imagem na resposta")


async def img_pollinations_key(prompt, w, h, seed):
    q = urllib.parse.quote(prompt[:900], safe="")
    url = f"https://gen.pollinations.ai/image/{q}?width={w}&height={h}&seed={seed}&model=flux&nologo=true"
    r = await client.get(url, headers={"Authorization": "Bearer " + POLL_KEY}, timeout=120)
    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/"):
        e = RuntimeError(f"pollinations-key {r.status_code}: {r.text[:150] if r.status_code != 200 else 'não-imagem'}")
        e.status = r.status_code
        raise e
    return r.content, r.headers["content-type"]


async def img_pollinations_anon(prompt, w, h, seed, max_wait=60):
    global _poll_next
    async with _poll_lock:
        wait = _poll_next - time.time()
        if wait > max_wait:
            e = RuntimeError(f"fila grátis: {int(wait)}s")
            e.status = 429
            e.retry = int(wait)
            raise e
        if wait > 0:
            await asyncio.sleep(wait)
        q = urllib.parse.quote(prompt[:900], safe="")
        url = f"https://image.pollinations.ai/prompt/{q}?width={min(w,1024)}&height={min(h,1024)}&seed={seed}&model=flux&nologo=true&safe=true"
        try:
            r = await client.get(url, timeout=120)
        finally:
            _poll_next = time.time() + 46
        if r.status_code in (402, 429):
            m = re.search(r"after (\d+)s", r.text)
            _poll_next = time.time() + (int(m.group(1)) + 2 if m else 46)
            e = RuntimeError("pollinations: limite grátis")
            e.status = 429
            e.retry = int(_poll_next - time.time())
            raise e
        if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/") or len(r.content) < 3000:
            raise RuntimeError(f"pollinations {r.status_code}")
        return r.content, r.headers["content-type"]


async def stock_photo(query, w):
    """Foto real com licença livre (Openverse → Wikimedia)."""
    q = " ".join(re.sub(r"[^\w ]", " ", query).split()[:5])
    try:
        r = await client.get("https://api.openverse.org/v1/images/", params={"q": q, "page_size": 12, "mature": "false", "aspect_ratio": "wide" if w >= 1000 else ""}, timeout=20)
        if r.status_code == 200:
            for it in r.json().get("results", [])[:6]:
                u = it.get("url")
                if not u:
                    continue
                try:
                    ir = await client.get(u, timeout=25)
                    if ir.status_code == 200 and ir.headers.get("content-type", "").startswith("image/") and len(ir.content) > 20000:
                        return ir.content, ir.headers["content-type"]
                except Exception:
                    pass
    except Exception:
        pass
    r = await client.get("https://commons.wikimedia.org/w/api.php", params={
        "action": "query", "generator": "search", "gsrsearch": q + " filetype:bitmap", "gsrnamespace": 6, "gsrlimit": 10,
        "prop": "imageinfo", "iiprop": "url|size|mime", "iiurlwidth": 1280, "format": "json"}, timeout=20)
    pages = sorted((r.json().get("query", {}).get("pages", {}) or {}).values(), key=lambda p: p.get("index", 0))
    for p in pages:
        ii = (p.get("imageinfo") or [{}])[0]
        if "jpeg" in ii.get("mime", "") or "png" in ii.get("mime", ""):
            if ii.get("width", 0) >= 640 and ii.get("thumburl"):
                ir = await client.get(ii["thumburl"], timeout=25)
                if ir.status_code == 200:
                    return ir.content, ir.headers.get("content-type", "image/jpeg")
    raise RuntimeError("nenhuma foto livre encontrada")


async def generate_image(prompt, w=1024, h=1024, seed=None, allow_stock=False, stock_query=None, max_wait=60, prefer_free=False):
    """Retorna (bytes, mime, provider). Lança RuntimeError com .retry quando só falta esperar."""
    seed = seed if seed is not None else random.randint(1, 10**9)
    errors, retry = [], 0
    steps = []
    if GEMINI_KEY and not is_down("gemini-image"):
        steps.append(("gemini", lambda: img_gemini(prompt, w, h)))
    if POLL_KEY and not is_down("pollinations-key"):
        steps.append(("pollinations-key", lambda: img_pollinations_key(prompt, w, h, seed)))
    anon = ("pollinations", lambda: img_pollinations_anon(prompt, w, h, seed, max_wait))
    if prefer_free:
        steps.insert(0, anon)
    else:
        steps.append(anon)
    for name, fn in steps:
        try:
            b, mime = await fn()
            return b, mime, name
        except Exception as e:  # noqa
            st = getattr(e, "status", 0)
            errors.append(str(e)[:160])
            LAST_ERR[name + "-img"] = time.strftime("%H:%M ") + str(e)[:200]
            retry = max(retry, getattr(e, "retry", 0))
            if name == "gemini":
                mark_down("gemini-image", 3600 if st in (400, 403, 404, 429) else 120)
            elif name == "pollinations-key" and st in (401, 402, 403):
                mark_down("pollinations-key", 3600)
    if allow_stock:
        try:
            b, mime = await stock_photo(stock_query or prompt, w)
            return b, mime, "foto-livre"
        except Exception as e:
            errors.append(str(e)[:120])
    ex = RuntimeError(" | ".join(errors))
    ex.retry = retry
    raise ex


@app.post("/api/image")
async def api_image(req: Request):
    if limited(req, "img", 12, 300):
        return err(429, "Limite de imagens por minuto atingido. Aguarde um pouco.", 60)
    body = await req.json()
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return err(400, "Descreva a imagem")
    w = max(256, min(int(body.get("width", 1024)), 1536))
    h = max(256, min(int(body.get("height", 1024)), 1536))
    try:
        b, mime, prov = await generate_image(prompt, w, h, body.get("seed"), allow_stock=bool(body.get("allow_stock")), max_wait=int(body.get("max_wait", 55)))
    except Exception as e:  # noqa
        r = getattr(e, "retry", 0)
        if r:
            return err(429, f"Os geradores grátis estão ocupados. Tente em {r}s.", r)
        return err(502, "Não consegui gerar a imagem agora: " + str(e)[:300])
    return Response(b, media_type=mime, headers={"X-Provider": prov, "Cache-Control": "no-store"})


# ---------------- VOZ (TTS / STT) ----------------
VOICES = [
    {"id": "pt-BR-FranciscaNeural", "name": "Francisca", "gender": "F", "lang": "pt-BR", "desc": "feminina, calorosa"},
    {"id": "pt-BR-AntonioNeural", "name": "Antônio", "gender": "M", "lang": "pt-BR", "desc": "masculina, clara"},
    {"id": "pt-BR-ThalitaMultilingualNeural", "name": "Thalita", "gender": "F", "lang": "pt-BR", "desc": "feminina, jovem, multilíngue"},
    {"id": "pt-PT-RaquelNeural", "name": "Raquel (Portugal)", "gender": "F", "lang": "pt-PT", "desc": "feminina, sotaque de Portugal"},
    {"id": "pt-PT-DuarteNeural", "name": "Duarte (Portugal)", "gender": "M", "lang": "pt-PT", "desc": "masculina, sotaque de Portugal"},
    {"id": "en-US-AndrewMultilingualNeural", "name": "Andrew", "gender": "M", "lang": "multi", "desc": "masculina, multilíngue (fala português)"},
    {"id": "en-US-AvaMultilingualNeural", "name": "Ava", "gender": "F", "lang": "multi", "desc": "feminina, multilíngue (fala português)"},
    {"id": "en-US-BrianMultilingualNeural", "name": "Brian", "gender": "M", "lang": "multi", "desc": "masculina grave, multilíngue"},
    {"id": "en-US-EmmaMultilingualNeural", "name": "Emma", "gender": "F", "lang": "multi", "desc": "feminina, multilíngue"},
    {"id": "es-MX-DaliaNeural", "name": "Dalia (Espanhol)", "gender": "F", "lang": "es", "desc": "espanhol"},
    {"id": "en-US-GuyNeural", "name": "Guy (Inglês)", "gender": "M", "lang": "en", "desc": "inglês, locutor"},
]
VOICE_IDS = {v["id"] for v in VOICES}


@app.get("/api/voices")
async def api_voices():
    return {"voices": VOICES}


def _pct(v, unit):
    try:
        n = int(round(float(v)))
    except Exception:
        n = 0
    n = max(-50, min(n, 100))
    return f"{'+' if n >= 0 else ''}{n}{unit}"


async def tts_bytes(text, voice="pt-BR-FranciscaNeural", rate=0, pitch=0, words=False):
    """Retorna (mp3_bytes, boundaries[]) — boundaries: [(start_s, dur_s, word)]."""
    import edge_tts
    voice = voice if voice in VOICE_IDS else "pt-BR-FranciscaNeural"
    last = None
    for attempt in range(3):
        try:
            comm = edge_tts.Communicate(text, voice, rate=_pct(rate, "%"), pitch=_pct(pitch, "Hz"), boundary="WordBoundary")
            audio, bounds = bytearray(), []
            async for ch in comm.stream():
                if ch["type"] == "audio":
                    audio.extend(ch["data"])
                elif ch["type"] == "WordBoundary":
                    bounds.append((ch["offset"] / 1e7, ch["duration"] / 1e7, ch["text"]))
            if len(audio) < 500:
                raise RuntimeError("áudio vazio")
            return bytes(audio), bounds
        except Exception as e:  # noqa
            last = e
            await asyncio.sleep(1 + attempt * 2)
    # reserva: Google Translate TTS (sem marcação de palavras)
    try:
        audio = bytearray()
        for part in _chunks(text, 190):
            r = await client.get("https://translate.google.com/translate_tts", params={"ie": "UTF-8", "client": "tw-ob", "tl": "pt-BR", "q": part}, timeout=30)
            if r.status_code != 200:
                raise RuntimeError(f"gtts {r.status_code}")
            audio.extend(r.content)
        return bytes(audio), []
    except Exception as e2:
        raise RuntimeError(f"voz indisponível: {last} / {e2}")


def _chunks(text, n):
    out, cur = [], ""
    for w in text.split():
        if len(cur) + len(w) + 1 > n:
            out.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        out.append(cur)
    return out


@app.post("/api/tts")
async def api_tts(req: Request):
    if limited(req, "tts", 40, 300):
        return err(429, "Limite de narrações atingido. Aguarde um pouco.", 60)
    body = await req.json()
    text = re.sub(r"\s+", " ", (body.get("text") or "")).strip()
    if not text:
        return err(400, "Escreva o texto")
    if len(text) > 12000:
        return err(400, "Texto muito longo (máx. 12.000 caracteres por vez)")
    try:
        audio, _ = await tts_bytes(text, body.get("voice"), body.get("rate", 0), body.get("pitch", 0))
    except Exception as e:  # noqa
        return err(502, "Não consegui gerar a voz agora: " + str(e)[:200])
    return Response(audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store", "Content-Disposition": 'inline; filename="magames-voz.mp3"'})


@app.post("/api/stt")
async def api_stt(req: Request, file: UploadFile = File(...), language: str = Form("pt")):
    if not GROQ_KEY:
        return err(503, "Transcrição indisponível")
    if limited(req, "stt", 20, 300):
        return err(429, "Muitas transcrições. Aguarde.", 60)
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        return err(400, "Áudio muito grande (máx. 20 MB)")
    r = await client.post("https://api.groq.com/openai/v1/audio/transcriptions",
                          headers={"Authorization": "Bearer " + GROQ_KEY},
                          files={"file": (file.filename or "audio.webm", data, file.content_type or "audio/webm")},
                          data={"model": "whisper-large-v3-turbo", "language": language, "response_format": "json"}, timeout=90)
    if r.status_code != 200:
        return err(502, "Falha na transcrição: " + r.text[:200])
    return {"text": r.json().get("text", "").strip()}


# ---------------- VÍDEO ----------------
@app.post("/api/script")
async def api_script(req: Request):
    if limited(req, "script", 10, 300):
        return err(429, "Muitos roteiros seguidos. Aguarde um pouco.", 60)
    body = await req.json()
    topic = (body.get("topic") or "").strip()
    if not topic:
        return err(400, "Escreva o tema do vídeo")
    try:
        s = await videomod.make_script(topic, float(body.get("minutes", 1)), body.get("tone", "envolvente"))
    except Exception as e:  # noqa
        return err(502, "Não consegui escrever o roteiro: " + str(e)[:200])
    return s


@app.post("/api/video")
async def api_video(req: Request):
    if limited(req, "video", 4, 1800):
        return err(429, "Limite de vídeos por meia hora atingido. Aguarde.", 300)
    body = await req.json()
    try:
        job = videomod.create_job(body)
    except ValueError as e:
        return err(400, str(e))
    return {"id": job["id"], "status": job["status"], "position": videomod.position(job["id"])}


@app.get("/api/video/{jid}")
async def api_video_status(jid: str):
    j = videomod.JOBS.get(jid)
    if not j:
        return err(404, "Vídeo não encontrado (o servidor pode ter reiniciado). Crie de novo.")
    return {k: j[k] for k in ("id", "status", "progress", "stage", "error", "duration", "title", "size", "created", "log")} | {"position": videomod.position(jid)}


@app.get("/api/video/{jid}/file")
async def api_video_file(jid: str, dl: int = 0):
    j = videomod.JOBS.get(jid)
    if not j or j["status"] != "done" or not os.path.exists(j["file"]):
        return err(404, "Arquivo não disponível")
    name = re.sub(r"[^\w\-]+", "-", j.get("title") or "video").strip("-")[:60] or "video"
    return FileResponse(j["file"], media_type="video/mp4", filename=f"{name}.mp4",
                        content_disposition_type="attachment" if dl else "inline")


@app.delete("/api/video/{jid}")
async def api_video_cancel(jid: str):
    ok = videomod.cancel(jid)
    return {"ok": ok}
