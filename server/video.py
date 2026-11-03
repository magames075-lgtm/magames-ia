"""Renderização de vídeo no servidor: roteiro → narração (edge-tts) → imagens → ffmpeg (Ken Burns, fades, legendas)."""
import asyncio, json, os, random, re, shutil, time, uuid

ROOT = os.environ.get("VIDEO_DIR", "/tmp/mgv")
os.makedirs(ROOT, exist_ok=True)
JOBS: dict[str, dict] = {}
QUEUE: list[str] = []
_cond = None
_worker = None
_client = _chat = _image = _tts = None
FONT = os.environ.get("SUB_FONT", "DejaVu Sans")
TTL = 3600  # arquivos ficam 1 h


def init(client, chat_complete, generate_image, tts_bytes):
    global _client, _chat, _image, _tts
    _client, _chat, _image, _tts = client, chat_complete, generate_image, tts_bytes


def queue_size():
    return len(QUEUE)


def position(jid):
    return QUEUE.index(jid) + 1 if jid in QUEUE else 0


def extract_json(text):
    t = re.sub(r"```(?:json)?", "", text).strip()
    starts = [i for i in (t.find("{"), t.find("[")) if i >= 0]
    if not starts:
        raise ValueError("sem JSON")
    s = min(starts)
    close = "}" if t[s] == "{" else "]"
    t = t[s:t.rfind(close) + 1]
    try:
        return json.loads(t)
    except Exception:
        return json.loads(re.sub(r",\s*([}\]])", r"\1", t).replace("\u201c", '"').replace("\u201d", '"'))


async def make_script(topic, minutes, tone="envolvente"):
    minutes = max(0.5, min(float(minutes), 10))
    n = max(3, round(minutes * 60 / 20))  # ~20 s por cena
    words = 50
    sysmsg = "Você é roteirista e narrador de vídeos virais do YouTube em português do Brasil. Responda SOMENTE com JSON válido, sem comentários."
    title, topics = topic, []
    if n > 10:
        try:
            plan = extract_json(await _chat([{"role": "user", "content": f'Tema: "{topic}". Tom: {tone}. Planeje um vídeo narrado de {minutes:g} minutos com exatamente {n} cenas em sequência lógica (cena 1 = gancho forte; última = conclusão com chamada para se inscrever). Formato: {{"titulo":"título chamativo","topicos":["resumo curto da cena 1","..."]}}'}], 0.8, sysmsg))
            title = plan.get("titulo") or title
            topics = [str(x) for x in plan.get("topicos", [])][:n]
        except Exception:
            topics = []
    scenes = []
    batch = n if n <= 10 else 8
    for s in range(0, n, batch):
        e = min(n, s + batch)
        plan_txt = ("Plano:\n" + "\n".join(f"{i+1}. {t}" for i, t in enumerate(topics)) + "\n") if topics else ""
        prev = f'Última frase narrada: "{scenes[-1]["narration"]}"\n' if scenes else ""
        ask = (f'Vídeo sobre: "{topic}". Tom: {tone}. Duração total ~{minutes:g} min, {n} cenas.\n{plan_txt}{prev}'
               f'Escreva as cenas {s+1} a {e}' + (" (cena 1 = gancho forte que prende nos 3 primeiros segundos; a última = conclusão com chamada para curtir e se inscrever)" if n <= 10 else "") + ". "
               f'Para cada cena: "narration" = texto falado em português do Brasil, natural, envolvente, com fatos corretos, de {words-8} a {words+8} palavras, sem emojis, sem dizer "cena"; '
               '"image" = prompt em INGLÊS descrevendo uma imagem cinematográfica que ilustra a narração (assunto, cenário, luz, estilo), sem texto escrito; '
               '"query" = 2 a 4 palavras-chave em INGLÊS para buscar uma foto real do assunto.\n'
               + ('Formato: {"title":"título chamativo","scenes":[{"narration":"...","image":"...","query":"..."}]}' if s == 0 else 'Formato: {"scenes":[{"narration":"...","image":"...","query":"..."}]}'))
        got = None
        for attempt in range(3):
            try:
                j = extract_json(await _chat([{"role": "user", "content": ask}], 0.8, sysmsg))
                arr = j if isinstance(j, list) else (j.get("scenes") or j.get("cenas") or [])
                arr = [x for x in arr if isinstance(x, dict) and (x.get("narration") or x.get("narracao"))]
                if arr:
                    if isinstance(j, dict) and s == 0 and j.get("title") and title == topic:
                        title = j["title"]
                    got = arr
                    break
            except Exception:
                await asyncio.sleep(2)
        if not got:
            raise RuntimeError("a IA não devolveu o roteiro")
        for x in got[: e - s]:
            scenes.append({"narration": str(x.get("narration") or x.get("narracao")).strip(),
                           "image": str(x.get("image") or x.get("imagem") or topic).strip(),
                           "query": str(x.get("query") or x.get("busca") or topic).strip()})
    return {"title": str(title).strip().strip('"'), "scenes": scenes}


def create_job(body):
    scenes = body.get("scenes")
    topic = (body.get("topic") or "").strip()
    if not scenes and not topic:
        raise ValueError("Envie um tema ou as cenas do roteiro")
    if scenes:
        if not isinstance(scenes, list) or not scenes:
            raise ValueError("Roteiro inválido")
        scenes = [{"narration": str(s.get("narration", "")).strip()[:1500], "image": str(s.get("image", "")).strip()[:600],
                   "query": str(s.get("query", "")).strip()[:100]} for s in scenes[:40] if str(s.get("narration", "")).strip()]
        if not scenes:
            raise ValueError("Roteiro sem narração")
        words = sum(len(s["narration"].split()) for s in scenes)
        if words > 2200:
            raise ValueError("Roteiro longo demais (máx. ~12 min de narração)")
    aspect = "9:16" if body.get("aspect") == "9:16" else "16:9"
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "queued", "progress": 0.0, "stage": "Na fila", "error": None, "duration": 0, "size": 0,
           "title": (body.get("title") or topic or "Vídeo MaGames IA")[:120], "created": int(time.time()), "log": [],
           "topic": topic, "minutes": float(body.get("minutes", 1) or 1), "tone": body.get("tone", "envolvente"),
           "scenes": scenes, "aspect": aspect, "res": 480 if str(body.get("res")) == "480" else 720, "voice": body.get("voice") or "pt-BR-AntonioNeural",
           "rate": body.get("rate", 0), "subtitles": body.get("subtitles", True) is not False, "music": bool(body.get("music")),
           "images": body.get("images") if body.get("images") in ("ia", "foto") else "ia", "cancel": False,
           "file": os.path.join(ROOT, jid, "final.mp4"), "proc": None}
    JOBS[jid] = job
    QUEUE.append(jid)
    _ensure_worker()
    return job


def cancel(jid):
    j = JOBS.get(jid)
    if not j:
        return False
    j["cancel"] = True
    if jid in QUEUE:
        QUEUE.remove(jid)
        j["status"], j["stage"] = "canceled", "Cancelado"
    p = j.get("proc")
    if p and p.returncode is None:
        try:
            p.kill()
        except Exception:
            pass
    return True


def _ensure_worker():
    global _worker, _cond
    if _cond is None:
        _cond = asyncio.Event()
    _cond.set()
    if _worker is None or _worker.done():
        _worker = asyncio.create_task(_work_loop())


async def _work_loop():
    while True:
        if not QUEUE:
            _cond.clear()
            await _cond.wait()
            continue
        jid = QUEUE[0]
        job = JOBS.get(jid)
        try:
            if job and not job["cancel"]:
                job["status"] = "running"
                await _render(job)
                job["status"], job["stage"], job["progress"] = "done", "Pronto", 1.0
        except Exception as e:  # noqa
            if job:
                if job["cancel"]:
                    job["status"], job["stage"] = "canceled", "Cancelado"
                else:
                    job["status"], job["error"] = "error", str(e)[:400]
                    job["stage"] = "Erro"
                _log(job, "ERRO " + str(e)[:300])
        finally:
            if QUEUE and QUEUE[0] == jid:
                QUEUE.pop(0)
            if job:
                job["proc"] = None
                if job["status"] != "done":
                    shutil.rmtree(os.path.join(ROOT, jid), ignore_errors=True)


async def cleanup_loop():
    while True:
        await asyncio.sleep(300)
        now = time.time()
        for jid, j in list(JOBS.items()):
            if now - j["created"] > TTL and j["status"] in ("done", "error", "canceled"):
                shutil.rmtree(os.path.join(ROOT, jid), ignore_errors=True)
                JOBS.pop(jid, None)


def _log(job, msg):
    job["log"] = (job["log"] + [time.strftime("%H:%M:%S ") + msg])[-25:]


def _stage(job, p, msg):
    job["progress"], job["stage"] = round(max(job["progress"], min(p, 0.999)), 3), msg
    _log(job, msg)


async def _run(job, args, timeout=1800, on_progress=None):
    if job["cancel"]:
        raise RuntimeError("cancelado")
    if on_progress:
        args = args[:1] + ["-progress", "pipe:1", "-nostats"] + args[1:]
    p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    job["proc"] = p
    out_parts = []

    async def read_out():
        while True:
            line = await p.stdout.readline()
            if not line:
                break
            t = line.decode("utf-8", "ignore")
            if on_progress and t.startswith("out_time_us="):
                try:
                    on_progress(max(0, int(t.split("=", 1)[1].strip())) / 1e6)
                except Exception:
                    pass
            elif not on_progress:
                out_parts.append(t)

    try:
        rd = asyncio.create_task(read_out())
        errt = asyncio.create_task(p.stderr.read())
        await asyncio.wait_for(asyncio.gather(rd, p.wait()), timeout)
        errb = await errt
    except asyncio.TimeoutError:
        p.kill()
        raise RuntimeError("ffmpeg demorou demais")
    finally:
        job["proc"] = None
    if job["cancel"]:
        raise RuntimeError("cancelado")
    if p.returncode != 0:
        raise RuntimeError(f"{os.path.basename(args[0])} falhou: " + errb.decode("utf-8", "ignore")[-400:])
    return "".join(out_parts)


async def _duration(job, path):
    out = await _run(job, ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], 60)
    return float(out.strip() or 0)


def _ass_time(t):
    t = max(0, t)
    h, m = int(t // 3600), int(t % 3600 // 60)
    return f"{h}:{m:02d}:{t % 60:05.2f}"


def _ass_text(s):
    return s.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")


def _write_ass(path, W, H, bounds, text, dur, offset, title=None):
    fs = int(H * (0.055 if W > H else 0.042))
    mv = int(H * (0.08 if W > H else 0.2))
    events = []
    toks = text.split() if text else []
    if bounds and len(toks) == len(bounds):  # usa as palavras do roteiro (com pontuação)
        bounds = [(b[0], b[1], toks[k]) for k, b in enumerate(bounds)]
    if bounds:
        chunks, cur = [], []
        for b in bounds:
            cur.append(b)
            txt = " ".join(x[2] for x in cur)
            if len(cur) >= 6 or len(txt) > (34 if W > H else 24) or re.search(r"[.!?;:]$", b[2]):
                chunks.append(cur)
                cur = []
        if cur:
            chunks.append(cur)
        for i, c in enumerate(chunks):
            st = c[0][0] + offset
            en = (chunks[i + 1][0][0] + offset) if i + 1 < len(chunks) else (c[-1][0] + c[-1][1] + offset + 0.3)
            events.append((st, min(en, dur), " ".join(x[2] for x in c)))
    elif text:
        ws = text.split()
        n = max(1, (len(ws) + 5) // 6)
        step = (dur - offset) / n
        for i in range(n):
            events.append((offset + i * step, offset + (i + 1) * step, " ".join(ws[i * 6:(i + 1) * 6])))
    lines = ["[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}", "WrapStyle: 0", "",
             "[V4+ Styles]",
             "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
             f"Style: Sub,{FONT},{fs},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,{max(2, fs // 14)},1,2,60,60,{mv},1",
             f"Style: Title,{FONT},{int(fs * 1.25)},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,3,{max(3, fs // 10)},0,8,60,60,{int(H * 0.08)},1",
             "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    if title:
        lines.append(f"Dialogue: 1,{_ass_time(0.2)},{_ass_time(min(4.0, dur))},Title,,0,0,0,,{{\\fad(300,400)}}{_ass_text(title)}")
    for st, en, tx in events:
        if en > st:
            lines.append(f"Dialogue: 0,{_ass_time(st)},{_ass_time(en)},Sub,,0,0,0,,{_ass_text(tx)}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


async def _fetch_img(job, sc, W, H):
    try:
        if job["images"] == "foto":
            from app import stock_photo  # noqa
            b, _m = await stock_photo(sc["query"] or sc["image"], W)
            return ("foto-livre", b)
        b, _m, prov = await _image((sc["image"] or sc["narration"])[:800] + ", cinematic, highly detailed, no text",
                                   W if W > H else 768, H if W > H else 1344, None, True, sc["query"] or sc["image"], 55, True)
        return (prov, b)
    except Exception as e:  # noqa
        _log(job, f"imagem falhou: {str(e)[:150]}")
        return None


async def _render(job):
    W, H = ((1280, 720) if job["aspect"] == "16:9" else (720, 1280)) if job["res"] == 720 else ((854, 480) if job["aspect"] == "16:9" else (480, 854))
    d = os.path.join(ROOT, job["id"])
    os.makedirs(d, exist_ok=True)
    t0 = time.time()

    if not job["scenes"]:
        _stage(job, 0.02, "Escrevendo o roteiro com IA…")
        s = await make_script(job["topic"], job["minutes"], job["tone"])
        job["scenes"] = s["scenes"]
        if job["title"] in ("", job["topic"], "Vídeo MaGames IA"):
            job["title"] = s["title"] or job["title"]
    scenes = job["scenes"]
    n = len(scenes)
    _log(job, f"{n} cenas, {W}x{H}, voz {job['voice']}")
    clips, total = [], 0.0
    fps = 24
    img_tasks = {}
    for i, sc in enumerate(scenes):
        base = 0.05 + 0.88 * i / n
        span = 0.88 / n
        # 1) narração
        _stage(job, base, f"Cena {i+1}/{n}: narrando…")
        audio, bounds = await _tts(sc["narration"], job["voice"], job["rate"])
        ap = os.path.join(d, f"a{i}.mp3")
        with open(ap, "wb") as f:
            f.write(audio)
        adur = await _duration(job, ap)
        lead = 0.25
        dur = round(adur + lead + 0.45, 2)
        # 2) imagem (pré-busca a próxima enquanto esta cena renderiza)
        _stage(job, base + span * 0.25, f"Cena {i+1}/{n}: criando imagem…")
        ip = os.path.join(d, f"i{i}.img")
        for k in (i, i + 1):
            if k < n and k not in img_tasks:
                img_tasks[k] = asyncio.create_task(_fetch_img(job, scenes[k], W, H))
        got = await img_tasks.pop(i)
        if job["cancel"]:
            raise RuntimeError("cancelado")
        pre = os.path.join(d, f"p{i}.jpg")
        BW, BH = int(W * 1.2) // 2 * 2, int(H * 1.2) // 2 * 2
        if got:
            with open(ip, "wb") as f:
                f.write(got[1])
            _log(job, f"cena {i+1}: imagem via {got[0]}")
            try:
                await _run(job, ["ffmpeg", "-y", "-loglevel", "error", "-i", ip, "-frames:v", "1", "-vf",
                                 f"scale={BW}:{BH}:force_original_aspect_ratio=increase,crop={BW}:{BH},setsar=1", "-q:v", "3", pre], 120)
            except Exception as e:  # noqa
                got = None
                _log(job, f"imagem inválida: {str(e)[:100]}")
        if not got:
            hue = random.randint(0, 360)
            await _run(job, ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                             f"gradients=s={BW}x{BH}:c0=0x1b1035:c1=0x0b3a4a:speed=0.01:d=1,hue=h={hue}", "-frames:v", "1", pre], 60)
        # 3) legendas + render da cena
        _stage(job, base + span * 0.5, f"Cena {i+1}/{n}: montando ({int(dur)} s)…")
        vf = []
        N = max(1, int(dur * fps))
        mode = i % 4
        if mode == 0:
            z, x, y = f"1+0.13*on/{N}", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
        elif mode == 1:
            z, x, y = f"1.13-0.13*on/{N}", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
        elif mode == 2:
            z, x, y = "1.12", f"(iw-iw/zoom)*on/{N}", "ih/2-(ih/zoom/2)"
        else:
            z, x, y = "1.12", f"(iw-iw/zoom)*(1-on/{N})", "ih/2-(ih/zoom/2)"
        vf.append(f"zoompan=z='{z}':x='{x}':y='{y}':d=1:s={W}x{H}:fps={fps}")
        vf.append(f"fade=t=in:st=0:d=0.35,fade=t=out:st={max(0, dur - 0.4):.2f}:d=0.4")
        if job["subtitles"] or i == 0:
            assp = os.path.join(d, f"s{i}.ass")
            _write_ass(assp, W, H, bounds if job["subtitles"] else [], sc["narration"] if job["subtitles"] else "", dur, lead,
                       title=job["title"] if i == 0 else None)
            vf.append(f"subtitles={assp}")
        vf.append("format=yuv420p")
        cp = os.path.join(d, f"c{i}.mp4")

        def prog(sec, base=base, span=span, i=i, dur=dur):
            f = min(1.0, sec / max(dur, 0.1))
            job["progress"] = round(max(job["progress"], min(base + span * (0.5 + 0.5 * f), 0.999)), 3)
            job["stage"] = f"Cena {i+1}/{n}: montando {int(min(sec, dur))}/{int(dur)} s…"
        await _run(job, ["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-framerate", str(fps), "-i", pre, "-i", ap,
                         "-filter_complex", f"[0:v]{','.join(vf)}[v];[1:a]adelay={int(lead*1000)}:all=1,apad,aresample=44100,afade=t=out:st={max(0, dur-0.35):.2f}:d=0.35[a]",
                         "-map", "[v]", "-map", "[a]", "-t", f"{dur:.2f}", "-r", str(fps),
                         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "27", "-maxrate", "2500k", "-bufsize", "5000k", "-g", str(fps * 4),
                         "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "44100", "-threads", "2", cp], 1800, on_progress=prog)
        clips.append(cp)
        total += dur
        for pth in (ip,):
            try:
                os.remove(pth)
            except Exception:
                pass
        _stage(job, base + span, f"Cena {i+1}/{n} pronta")
    # 4) juntar
    _stage(job, 0.94, "Juntando as cenas…")
    lst = os.path.join(d, "list.txt")
    with open(lst, "w") as f:
        f.write("".join(f"file '{c}'\n" for c in clips))
    joined = os.path.join(d, "joined.mp4")
    await _run(job, ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], 600)
    if job["music"]:
        _stage(job, 0.97, "Adicionando trilha de fundo…")
        pad = ("aevalsrc='0.5*(sin(2*PI*110*t)+0.7*sin(2*PI*164.81*t)+0.6*sin(2*PI*220*t)+0.4*sin(2*PI*277.18*t))"
               "*(0.55+0.45*sin(2*PI*0.07*t))':s=44100:d=" + f"{total + 1:.1f}")
        await _run(job, ["ffmpeg", "-y", "-loglevel", "error", "-i", joined, "-f", "lavfi", "-i", pad, "-filter_complex",
                         "[1:a]lowpass=f=900,volume=0.05,afade=t=in:d=2,aformat=channel_layouts=stereo[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]",
                         "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", job["file"]], 900)
    else:
        await _run(job, ["ffmpeg", "-y", "-loglevel", "error", "-i", joined, "-c", "copy", "-movflags", "+faststart", job["file"]], 300)
    for c in clips + [joined]:
        try:
            os.remove(c)
        except Exception:
            pass
    job["duration"] = round(total, 1)
    job["size"] = os.path.getsize(job["file"])
    _log(job, f"pronto em {int(time.time() - t0)} s, {job['size'] // 1024} KB")
