# Editor de Vídeo com IA

Editor não linear desktop, local-first, construído com Tauri 2, React, Tailwind CSS 4 e Rust. O Gemini recebe apenas texto estruturado; mídia, áudio, caminhos locais, proxies e render permanecem na máquina.

## O que já funciona

- importação e probe real de vídeo/áudio com FFprobe;
- media bin com busca, waveform, relink e proxy 720p;
- timeline Canvas virtualizada com múltiplas faixas, snap por frame, move, trim de entrada/saída, split, duplicação, multi-seleção, ripple delete, lock, mute e visibilidade;
- monitor de programa com velocidade, transform, crop, opacity, efeitos e legendas;
- efeitos de exposição, contraste, saturação, temperatura, chroma key e blur;
- transições de entrada/saída, incluindo dissolve, dip, slide e crossfade de áudio;
- legendas geradas da transcrição ou editadas manualmente;
- transcrição totalmente local via `whisper.cpp`, com timestamps normalizados para uma timebase de 240.000 ticks/s;
- agente Gemini conversacional com function calling, validação de IDs, transações atômicas, limite de operações e rejeição de pedidos que exigem visão;
- undo/redo compartilhado entre React e Rust, autosave e projetos `.aivedit` versionados;
- exportação FFmpeg H.264/AAC com múltiplas faixas, gaps, transforms, efeitos, velocidade, mixagem, transições, legendas queimadas, progresso e cancelamento.

Não são usados kits de componentes, bibliotecas de timeline ou pacotes de ícones. Os controles, SVGs e a timeline foram implementados neste repositório.

## Requisitos

- Bun 1.3+;
- Rust 1.77.2+;
- dependências nativas exigidas pelo Tauri para o sistema operacional;
- `ffmpeg` e `ffprobe` no `PATH`, ou `FFMPEG_PATH` / `FFPROBE_PATH`;
- O aplicativo inclui o motor `whisper-cli` e oferece o download dos modelos GGML do whisper.cpp na seção **Modelos** do painel Media. Um arquivo `.bin` local também pode ser selecionado pela interface.

Os pesos dos modelos não são versionados nem redistribuídos aqui. O sidecar Linux de `whisper-cli` fica em `src-tauri/binaries`; builds de outras arquiteturas devem fornecer o binário correspondente.

## Desenvolvimento

```bash
bun install
bun run tauri dev
```

Para testar apenas a interface no navegador:

```bash
bun run dev
```

O modo web permite importar mídia para demonstração, mas persistência nativa, FFmpeg, whisper.cpp e Gemini são deliberadamente ativados apenas no aplicativo Tauri.

## Gemini

Abra a aba **Chat**, escolha **Chave da sessão** e informe a chave. Ela fica somente na memória do processo. Como alternativa para desenvolvimento, defina:

```bash
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash
```

O adaptador usa `gemini-3.5-flash` por padrão e permite sobrescrever o modelo sem alterar o código. O payload contém transcript, IDs, ticks, propriedades de timeline e as últimas mensagens; não contém bytes de áudio/vídeo, thumbnails, waveforms, proxies ou caminhos de arquivo.

## Atalhos

| Ação | Atalho |
| --- | --- |
| Reproduzir/pausar | `Espaço` |
| Split no playhead | `S` |
| Excluir seleção | `Delete` / `Backspace` |
| Duplicar seleção | `Ctrl/Cmd + D` |
| Undo | `Ctrl/Cmd + Z` |
| Redo | `Ctrl/Cmd + Shift + Z` ou `Ctrl/Cmd + Y` |

Assets podem ser arrastados do media bin para uma faixa compatível. As bordas dos clipes fazem trim; o corpo move o clipe.

## Verificação

```bash
bun run lint
bun run typecheck
bun run test
bun run test:rust
bun run build
bun run tauri build -- --no-bundle
```

Os testes Rust incluem uma renderização sintética real com FFmpeg, além de testes do grafo, transcrição, validação do agente, atomicidade e persistência temporal.

## Empacotamento

`bun run tauri build` gera os pacotes nativos. Para uma distribuição autocontida, forneça builds licenciados de FFmpeg/FFprobe e `whisper-cli` para cada plataforma; o usuário baixa o modelo escolhido pelo painel Media. Em desenvolvimento, FFmpeg/FFprobe podem permanecer no `PATH`.

Detalhes técnicos estão em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) e a fronteira de dados em [docs/PRIVACY.md](docs/PRIVACY.md). O contrato visual está em [DESIGN.md](DESIGN.md).
