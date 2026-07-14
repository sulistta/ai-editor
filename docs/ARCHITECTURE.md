# Arquitetura

## Fronteiras

- **React** mantém interação, seleção, playhead, viewport e uma réplica tipada do projeto.
- **Rust/Tauri** é a autoridade para persistência, histórico, validação, processos locais e chamadas ao Gemini.
- **FFmpeg/FFprobe** fazem probe, waveform, proxy, extração de áudio e render final.
- **whisper.cpp** recebe apenas WAV PCM mono temporário e produz JSON local.
- **Gemini** recebe somente o contexto textual compacto e devolve operações declarativas ou uma pergunta estruturada sem efeitos colaterais.

## Modelo temporal

Todo tempo persistido usa inteiros em uma timebase fixa de 240.000 ticks por segundo. Essa base representa de forma exata as taxas de frame usuais e evita acumular erro de ponto flutuante em cortes longos. Conversões para segundos existem apenas nas bordas com HTML Media e FFmpeg.

`durationTicks` representa duração na timeline. A janela lida da origem é `durationTicks × speed`; portanto split, captions, preview e render usam a mesma semântica.

Clipes são ativos no intervalo semiaberto `[startTick, startTick + durationTicks)`. O monitor não pula espaços vazios: um relógio da timeline avança por gaps em tempo real e mantém o programa preto, igual à base usada pelo render.

Na posição exata do fim da sequência, o estado persistido do playhead continua no tick final, mas a consulta visual usa o início do último frame. No evento `ended`, o monitor preserva esse frame em um bitmap imutável, limitado a 1920 px, e oculta a superfície nativa do vídeo até o próximo play/seek.

## Timeline

O canvas tem sempre as dimensões do viewport, independentemente da duração do projeto. Seu backing store só é realocado quando tamanho ou densidade de pixels mudam, não a cada playhead/scroll. Scroll horizontal e vertical são valores virtuais controlados por inputs acessíveis; o desenho subtrai esses offsets e ignora clipes fora da área visível. Não existe um filho DOM com a largura total da sequência, evitando superfícies compostas gigantes, relayout por pixel e o desaparecimento do restante da interface ao chegar ao extremo direito.

## Monitor de programa

O preview escolhe uma única camada visual — o vídeo visível mais alto — e reproduz em paralelo todas as camadas de áudio elegíveis. Mute e visibilidade de faixa são aplicados antes da seleção; o playhead é convertido de e para o tempo da origem com limites na janela do clipe.

Arquivos locais são entregues primeiro diretamente ao elemento de mídia pelo asset protocol do Tauri, mantendo início de reprodução e uso de memória previsíveis em projetos longos. Se o backend multimídia do WebKit rejeitar esse protocolo apesar de o codec ser válido, o monitor tenta proxy atual, leitura local sob demanda por `Blob` e arquivo original; URLs temporárias anteriores são revogadas. Áudios auxiliares seguem a mesma cadeia de recuperação. A seleção do media bin nunca substitui o programa: fora de um clipe ativo, o monitor exibe preto.

## Transcrição automática

Cada importação ou relink avalia se o asset possui áudio, caminho local, modelo e transcript existente. Jobs elegíveis entram em uma fila serial para impedir múltiplas instâncias pesadas do `whisper.cpp`; sem modelo, o asset permanece importado e o job fica em `queued` até a ativação de um modelo.

Os estados `queued`, `running`, `completed` e `failed` são expostos no media bin e no ledger global de jobs. Não há botão de transcrição por asset: a recuperação acontece pelo estado do modelo e pela fila automática, sem bloquear proxy, inserção ou organização da mídia.

## Command bus

Toda alteração persistente é um `EditTransaction` contendo:

- ID e revisão-base;
- origem manual ou agente;
- rótulo humano;
- lista ordenada de `EditCommand`.

O backend aplica comandos em uma cópia do projeto. A cópia só substitui o estado atual se todos os comandos forem válidos, garantindo atomicidade. O frontend serializa commits para impedir corridas de revisão durante ajustes rápidos do Inspector.

Undo e redo trabalham com snapshots limitados. Projetos abertos são validados antes de substituir o estado; assets ausentes são marcados offline e podem ser relinkados.

## Agente

O adaptador Gemini declara `apply_edit_operations` e `ask_user_question` em modo de function calling obrigatório. O modelo deve escolher exatamente uma delas por turno: editar quando possui contexto suficiente ou fazer uma única pergunta quando faltar uma decisão que mudaria materialmente a edição. Além das operações de baixo nível, o contrato inclui `removeSilences`, `setCanvas`, `createCaptions` e `setCaptionStyle`; o backend as expande contra uma cópia projetada do estado para que intenções compostas continuem atômicas. O backend:

1. confirma que a revisão ainda é atual;
2. omite caminhos, proxies e waveforms do contexto;
3. resolve o alvo por ID explícito, seleção atual ou único clipe compatível e só acusa ambiguidade quando ela é real;
4. valida operação, IDs, ranges e enums;
5. rejeita respostas com zero ou múltiplas chamadas de função;
6. valida e limita perguntas a 500 caracteres e cinco opções, sem gerar comandos;
7. limita a resposta a 64 operações e a expansão a 256 comandos;
8. confirma novamente a revisão antes de devolver o plano;
9. aplica tudo pelo mesmo command bus usado pela interface.

Cor, tipografia, posição, proporção, crop e efeitos são propriedades editáveis e não exigem pixels. Somente pedidos que dependem de reconhecer o conteúdo visual bruto permanecem fora do contexto textual. Falhas transitórias do Gemini (408, 429 e 5xx, timeout ou conexão) usam até três retries com backoff exponencial e jitter; cancelar no chat invalida o plano antes de qualquer commit.

## Render

O exportador cria um `filter_complex` com uma entrada por instância de clipe. O grafo inclui trim de origem, retiming, crop, filtros, scale/rotate/opacity, offsets de timeline, overlays por ordem de faixa, `amix`, fades e subtitles. Uma base preta de duração exata preserva gaps.

O FFmpeg grava em arquivo temporário no diretório de destino. O arquivo final só é substituído após sucesso. O processo publica progresso pelo event bus do Tauri e observa uma flag atômica de cancelamento.

## Persistência

- `.aivedit`: JSON legível, `schemaVersion: 1`;
- autosave: diretório de dados da aplicação, gravação atômica e debounce de 1,2 s;
- proxies: diretório de cache da aplicação, identificados pelo fingerprint da mídia;
- áudio WAV, JSON do whisper e SRT de render: temporários removidos após uso.
