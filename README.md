# MaGames IA

Super app de IA **grátis e sem login** (PWA, instalável no Android), feito pela **MaGames Tecnologia**.

**Abrir:** https://magames075-lgtm.github.io/magames-ia/

## O que faz
- **Chat** com streaming, histórico local, markdown e destaque de código, entrada por voz (pt-BR).
  Motores com troca automática: suas chaves grátis opcionais (Gemini, Groq, OpenRouter `:free`, LLM7) → LLM7 sem chave → **modo offline** (WebLLM/WebGPU, Qwen 2.5 / Llama 3.2 rodando no aparelho, sem limite).
- **Imagens** por IA (Pollinations) com galeria.
- **Voz** neural Piper (pt_BR Faber) rodando no navegador, sem limite, download em WAV; vozes do sistema como reserva.
- **Vídeos longos** (1–10 min): roteiro por IA → imagem por cena (fotos reais Wikimedia Commons, ou IA com chave Pollinations) → narração Piper → MP4 montado no aparelho com ffmpeg.wasm (Ken Burns, fades, legendas embutidas, 16:9 ou 9:16, 480p/720p) + `.srt` e roteiro.

## Limites (honestos)
- Serviços de nuvem gratuitos têm cotas: LLM7 sem chave tem cota diária por IP; Pollinations libera ~1 imagem a cada 45 s por IP e bloqueia `fetch` de navegador sem chave (por isso as imagens IA sem chave só são exibidas, não entram nos vídeos).
- O que é ilimitado roda no seu aparelho: modo offline (precisa WebGPU) e vozes Piper.
- Chaves ficam só no `localStorage` do navegador.

## Desenvolvimento
```bash
npm ci
npm run dev     # http://localhost:5173/magames-ia/
npm run build   # gera dist/
```
Deploy automático no GitHub Pages via `.github/workflows/pages.yml` a cada push na `main`.
