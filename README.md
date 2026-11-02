# MaGames IA

Super app de IA grátis em português (PWA): chat, imagens, voz neural e estúdio de vídeos.

- App: https://magames075-lgtm.github.io/magames-ia/ (Vite + JS puro, GitHub Pages)
- API: https://magames-ia-api.onrender.com (FastAPI em `server/`, Docker no Render free)

## Arquitetura
- `src/` — frontend. `src/api.js` acorda o servidor (Render dorme), repete pedidos e mantém vivo.
- `server/app.py` — `/api/chat` (SSE: Gemini → Groq → LLM7), `/api/image`, `/api/tts` (edge-tts), `/api/stt` (Whisper/Groq), `/api/script`, `/api/video` (fila + ffmpeg).
- `server/video.py` — roteiro IA → narração → imagens → ffmpeg (Ken Burns, fades, legendas ASS, trilha opcional).

## Variáveis de ambiente (só no Render, nunca no repo)
`GEMINI_API_KEY`, `GROQ_API_KEY`, `POLLINATIONS_KEY`, `GEMINI_MODEL`, `GROQ_MODEL`.

## Desenvolvimento
```
npm install && npm run dev            # frontend (VITE_API_URL opcional)
cd server && pip install -r requirements.txt && uvicorn app:app --reload
```
MaGames Tecnologia.
