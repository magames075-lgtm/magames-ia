# Diagnóstico — MaGames IA v1 (02/11/2026)

## Teste real (navegador desktop, sem login)
- No desktop, tudo "funcionou" de forma frágil: chat respondeu via LLM7, imagem via Pollinations (como `<img>`), voz Piper após baixar ~63 MB, vídeo começou a montar com ffmpeg.wasm (~31 MB).
- Do servidor de testes, a cota do LLM7 já estava esgotada ("Daily token quota exceeded. Retry after 69137 seconds") e a Pollinations anônima devolveu `402 FREE_LIMIT: 1 image every 45 seconds per IP`. Ou seja: os serviços grátis sem chave quebram assim que o IP é compartilhado/bastante usado.

## Por que NADA funcionou no Android do Maicon
1. **Chat (LLM7 sem chave)**: cota diária por IP. Em rede móvel o IP é compartilhado (CGNAT) por milhares de pessoas → 429 imediato. Sem chave Gemini/Groq não havia reserva real (WebLLM exige WebGPU com GPU compatível — a maioria dos Androids intermediários não tem).
2. **Imagens (Pollinations anônimo)**: 1 imagem/45 s por IP + Turnstile em `fetch()`; no IP compartilhado da operadora o limite estoura sempre e volta a imagem-aviso ou erro. Sem CORS a imagem nem podia ser baixada/usada em vídeo.
3. **Voz (Piper no aparelho)**: download de ~63 MB (modelo ONNX + runtime WASM) em dados móveis, depois inferência ONNX no celular — trava ou estoura memória em aparelho intermediário; o Chrome Android mata abas com pouca RAM.
4. **Vídeo (ffmpeg.wasm)**: ~31 MB de core + renderização 720p no navegador: lento demais, consome RAM (SharedArrayBuffer/threads limitados no GitHub Pages sem COOP/COEP), e o Android congela abas em segundo plano → falha.
5. **Service worker v1**: cache "cache-first" para todos os arquivos do mesmo domínio e sem aviso de atualização → o celular podia continuar com JS antigo/quebrado depois de um deploy.

## Conclusão
O problema era de arquitetura: depender de serviços grátis anônimos chamados direto do navegador do celular (limites por IP, CORS, Turnstile) e de modelos pesados rodando no aparelho. Solução: **backend próprio grátis** (Render free) que guarda as chaves grátis (Gemini, Groq, Pollinations) em variáveis de ambiente, faz o trabalho pesado (voz neural edge-tts, imagens, ffmpeg) e entrega ao app só o resultado (texto em streaming, JPG, MP3, MP4).
