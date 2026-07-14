# Contexto — autonomia de edição por IA

- Timestamp UTC: 2026-07-14T02:38:00Z
- Tipo: brownfield
- Perfil de entrevista: standard
- Estado do resumo inicial: `not_needed`

## Declaração da tarefa

Tornar o editor profissional e eficiente, adicionar recursos relevantes para o funcionamento real e permitir que a IA determine ritmo, foco e estilo da edição.

## Resultado desejado

Um editor desktop utilizável em produção no qual a IA consiga propor ou executar uma montagem editorial coerente, mantendo controle humano, reversibilidade e evidência clara das decisões.

## Solução declarada pelo usuário

Evoluir o projeto atual com novas funcionalidades, melhorias de eficiência e maior autonomia editorial do agente.

## Hipótese de intenção

O protótipo já cobre operações básicas, mas o agente atual funciona principalmente como tradutor de prompt para comandos isolados. A provável intenção é transformá-lo em um sistema editorial capaz de analisar o material disponível, formar uma estratégia e produzir uma primeira montagem com ritmo, foco narrativo e estilo consistentes.

## Fatos e evidências do repositório

- O produto é um editor local-first em Tauri 2, React 19, TypeScript e Rust.
- FFmpeg/FFprobe fazem importação, proxy, waveform e render; whisper.cpp faz transcrição local.
- O modelo remoto recebe texto estruturado, transcript e estado da timeline, nunca bytes de mídia, waveforms, thumbnails, proxies ou caminhos locais.
- O agente atual faz uma única chamada `apply_edit_operations`, limitada a 64 operações, e aplica o resultado imediatamente como uma transação atômica.
- As operações atuais cobrem excluir, mover, aparar, dividir, volume, velocidade, opacidade, transform, alguns efeitos/transições e criação de legendas.
- O agente não cria uma estratégia editorial persistida, não apresenta alternativas, não explica decisões por trecho, não pontua confiança e não executa um ciclo de análise–montagem–avaliação.
- Pedidos dependentes de rosto, objeto, enquadramento, imagem ou outros sinais visuais são recusados. Não existe análise local de imagem ou de áudio semântico/prosódico além da transcrição.
- Há undo/redo, autosave, formato `.aivedit`, exportação FFmpeg e testes unitários/integrados descritos no README.
- A árvore estava limpa antes do início desta entrevista; HEAD `ddb691d`.

## Restrições conhecidas

- Contrato atual: mídia permanece local; somente contexto textual compacto pode ir ao Gemini.
- Sem novas dependências sem solicitação explícita.
- Windows, macOS e Linux desktop; alvo mínimo de interface 1180×720.
- Ações da IA devem ser reversíveis e deixar trilha concreta.
- O modo de entrevista não implementa; ele produz uma especificação para o próximo workflow.

## Desconhecidos e perguntas abertas

- Qual é o público e o primeiro tipo de vídeo que deve orientar o produto.
- O que “profissional” significa em termos de fluxo, confiabilidade e qualidade editorial.
- Quais sinais a IA pode analisar localmente e se análise visual local entra no escopo.
- Se a IA deve gerar um rascunho para aprovação, aplicar automaticamente ou operar por níveis de autonomia.
- Quais estilos editoriais devem ser suportados primeiro e como serão definidos/reutilizados.
- Métricas de sucesso: tempo até o primeiro corte, qualidade percebida, retenção, taxa de aceitação das sugestões, render ou estabilidade.
- Limites de escopo e não objetivos da primeira entrega.

## Limites de decisão ainda desconhecidos

- O que o agente pode decidir sem confirmação humana.
- Se mudanças arquiteturais de modelo, processamento local e schema de projeto estão autorizadas.
- Se a privacidade textual atual é uma regra permanente ou uma preferência negociável sob processamento estritamente local.
- Qual compromisso aceitar entre qualidade da análise, latência e requisitos de hardware.

## Pontos prováveis de alteração

- `src-tauri/src/agent.rs`: planejamento do agente, contexto, validação e execução.
- `src-tauri/src/domain.rs` e `src/types.ts`: estratégia editorial, decisões, estilos, análise e histórico.
- `src/components/Workspace.tsx`: briefing, revisão de plano, níveis de autonomia e ledger editorial.
- `src/context/EditorContext.tsx`: fluxo assíncrono e aplicação/aceitação de propostas.
- `src-tauri/src/transcription.rs`, `media.rs` e novos módulos locais: sinais de fala, silêncio, cenas e qualidade técnica, conforme escopo.
- `src-tauri/src/render.rs`: novos recursos que precisem de paridade de preview/render.
- Testes TypeScript/Rust e documentação de arquitetura/privacidade.

## Documentos e regras inspecionados

- Instruções `AGENTS.md` fornecidas na conversa; não há `AGENTS.md` versionado na árvore.
- `README.md`
- `DESIGN.md`
- `docs/ARCHITECTURE.md`
- `docs/PRIVACY.md`
- `models/README.md`
- `package.json`
- `src-tauri/Cargo.toml`
- Implementação relevante em `agent.rs`, `domain.rs`, `types.ts`, `Workspace.tsx` e `EditorContext.tsx`.
- Não havia snapshots, specs ou planos relevantes em `.omx`; apenas estados visuais anteriores de Ralph.

## Termos e conflitos

- “Agente” hoje significa um planejador de uma única transação declarativa; “autonomia” ainda não possui definição canônica no projeto.
- “Foco” pode significar foco narrativo/temático ou reenquadramento visual automático; essas interpretações exigem capacidades diferentes.
- “Estilo” pode significar regras editoriais reutilizáveis (ritmo, cortes, legendas, transições, áudio) ou look visual/color grading; o escopo precisa distinguir os dois.
- O contrato atual recusa contexto visual, enquanto a visão de autonomia pode exigir sinais visuais. Essa decisão precisa ser humana.

## Resumo seguro para prompts

O editor já é um protótipo local-first funcional com timeline, transcrição local, agente Gemini textual, undo/redo e exportação. O maior salto não é adicionar mais comandos isolados, mas definir uma arquitetura editorial: briefing, análise de sinais permitidos, estratégia, proposta revisável, execução atômica, avaliação e memória de estilo. Permanecem em aberto o segmento inicial, o nível de autonomia, os sinais permitidos, os não objetivos e as métricas de sucesso.
