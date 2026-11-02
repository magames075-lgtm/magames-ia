# STATUS — MaGames IA v2 (02/11/2026, ~20:25 BRT)

- App: https://magames075-lgtm.github.io/magames-ia/ (GitHub Pages, deploy automático a cada push no `main`)
- Backend: https://magames-ia-api.onrender.com (Render free, serviço `magames-ia-api`, srv-dbkh6k942hec73cjolj0, Docker de `server/`, região Oregon)
- Chaves (Gemini, Groq, Pollinations) só no cofre do Hark e nas variáveis de ambiente do Render. Nunca no repositório.

## Verificado ponta a ponta no app ao vivo (navegador, 02/11)
| Recurso | Status | Observação |
|---|---|---|
| Chat (streaming, conversas, copiar, refazer, continuação) | ✅ funciona | Gemini primeiro; se der erro/lentidão (>25 s) cai para Groq `openai/gpt-oss-120b` em segundos; LLM7 por último. Hoje o Gemini (`gemini-flash-latest`) devolve 503 "high demand" e o Groq responde. |
| Imagens (gerar, galeria, baixar) | ✅ funciona | Servidor: Pollinations com chave → Pollinations grátis (1/45 s) → foto livre (Openverse/Wikimedia). Gemini imagem: 429 (sem cota grátis), desligado automaticamente. Download JPG ok (292 KB). |
| Voz (prévia, gerar, baixar MP3) | ✅ funciona | edge-tts (Francisca, Antônio, Thalita, multilíngues…). MP3 baixado (35 KB). Reserva: Google TTS. |
| Vídeo (roteiro IA → render no servidor → tocar → baixar) | ✅ funciona | Vídeo de 54 s 720p com narração, legendas queimadas, Ken Burns, fades e título: render 220 s, MP4 2,6 MB baixado. |
| Microfone no chat | ⚠️ não testado no aparelho | Web Speech do Chrome; se faltar, grava e transcreve no servidor (Whisper via Groq). |

## Limites honestos (grátis)
- Render free: dorme após 15 min sem uso → primeira abertura leva ~50 s (o app mostra "Acordando o servidor grátis…" e um ping a cada 4 min mantém acordado enquanto aberto).
- Render free tem 0,1 CPU: vídeo leva ~3,5–4 min por minuto em 720p (480p é mais rápido). 10 min de vídeo ≈ 35–40 min. Um vídeo por vez (fila). Se o servidor reiniciar, o vídeo em andamento se perde (arquivos ficam ~1 h).
- Pollinations com chave: só ~0,25 pollen grátis (~125 imagens); depois cai no grátis anônimo (1 imagem a cada ~45 s, compartilhado por todos) e, nos vídeos, em fotos reais.
- Cotas grátis Gemini/Groq por dia: se as duas acabarem, sobra LLM7 (cota por IP do servidor).

## O que falta / próximos passos
1. Testar no Android do Maicon (abrir o link, recarregar uma vez; se aparecer "Nova versão disponível", tocar em Atualizar).
2. Deploy do backend não é automático (repo público sem integração GitHub no Render): após mudar `server/`, disparar deploy pela API do Render (chave no cofre, serviço `render`) ou "Manual Deploy" no painel. Opcional: conectar o GitHub no Render para auto-deploy.
3. Gemini: se o 503 persistir, testar outro modelo (variável `GEMINI_MODEL` no Render; hoje `gemini-flash-latest`).
4. Mais imagens grátis no servidor: Cloudflare Workers AI (flux-1-schnell, cota diária grátis) precisa criar conta Cloudflare.
5. Piper offline e WebLLM foram removidos do app (pesados e quebravam no celular); a voz e o chat agora vêm do servidor, com voz do sistema como reserva.
6. Melhorias de vídeo: ETA na barra, música de verdade (biblioteca livre), escolher imagem por cena.
