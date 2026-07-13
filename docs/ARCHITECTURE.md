# Arquitetura

## Fronteiras

- **React** mantém interação, seleção, playhead, viewport e uma réplica tipada do projeto.
- **Rust/Tauri** é a autoridade para persistência, histórico, validação, processos locais e chamadas ao Gemini.
- **FFmpeg/FFprobe** fazem probe, waveform, proxy, extração de áudio e render final.
- **whisper.cpp** recebe apenas WAV PCM mono temporário e produz JSON local.
- **Gemini** recebe somente o contexto textual compacto e devolve operações declarativas.

## Modelo temporal

Todo tempo persistido usa inteiros em uma timebase fixa de 240.000 ticks por segundo. Essa base representa de forma exata as taxas de frame usuais e evita acumular erro de ponto flutuante em cortes longos. Conversões para segundos existem apenas nas bordas com HTML Media e FFmpeg.

`durationTicks` representa duração na timeline. A janela lida da origem é `durationTicks × speed`; portanto split, captions, preview e render usam a mesma semântica.

## Command bus

Toda alteração persistente é um `EditTransaction` contendo:

- ID e revisão-base;
- origem manual ou agente;
- rótulo humano;
- lista ordenada de `EditCommand`.

O backend aplica comandos em uma cópia do projeto. A cópia só substitui o estado atual se todos os comandos forem válidos, garantindo atomicidade. O frontend serializa commits para impedir corridas de revisão durante ajustes rápidos do Inspector.

Undo e redo trabalham com snapshots limitados. Projetos abertos são validados antes de substituir o estado; assets ausentes são marcados offline e podem ser relinkados.

## Agente

O adaptador Gemini declara uma única função `apply_edit_operations`. O modelo pode cortar, mover, aparar, dividir, alterar volume/velocidade/transform, aplicar efeitos/transições e criar legendas. O backend:

1. confirma que a revisão ainda é atual;
2. omite caminhos, proxies e waveforms do contexto;
3. valida operação, IDs, ranges e enums;
4. limita o plano a 64 operações;
5. confirma novamente a revisão antes de devolver o plano;
6. aplica tudo pelo mesmo command bus usado pela interface.

Pedidos explicitamente visuais são interrompidos antes da chamada remota. Cancelar no chat invalida o plano antes de qualquer commit.

## Render

O exportador cria um `filter_complex` com uma entrada por instância de clipe. O grafo inclui trim de origem, retiming, crop, filtros, scale/rotate/opacity, offsets de timeline, overlays por ordem de faixa, `amix`, fades e subtitles. Uma base preta de duração exata preserva gaps.

O FFmpeg grava em arquivo temporário no diretório de destino. O arquivo final só é substituído após sucesso. O processo publica progresso pelo event bus do Tauri e observa uma flag atômica de cancelamento.

## Persistência

- `.aivedit`: JSON legível, `schemaVersion: 1`;
- autosave: diretório de dados da aplicação, gravação atômica e debounce de 1,2 s;
- proxies: diretório de cache da aplicação, identificados pelo fingerprint da mídia;
- áudio WAV, JSON do whisper e SRT de render: temporários removidos após uso.
