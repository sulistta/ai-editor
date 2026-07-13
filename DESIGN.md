# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-07-12
- Primary product surfaces: editor desktop, timeline, media bin, monitor, inspector, transcript e chat do agente
- Evidence reviewed: requisitos aprovados nesta conversa; o repositório começou vazio

## Brand
- Personality: precisa, profissional, concentrada e franca
- Trust signals: estado real do projeto, progresso verificável, histórico reversível e nenhuma informação inventada
- Avoid: futurismo decorativo, gradientes, sombras, cantos arredondados, slogans de IA e dados fictícios

## Product goals
- Goals: permitir edição complexa manual e por linguagem natural sem enviar áudio ou vídeo ao modelo remoto
- Non-goals: colaboração, billing, nuvem, geração de mídia, composição 3D, plugins e node compositing
- Success signals: importação real, timeline responsiva, transcrição local, operações reversíveis e exportação reproduzível

## Personas and jobs
- Primary personas: criadores e editores profissionais trabalhando sozinhos
- User jobs: organizar mídia, transcrever, montar, revisar, refinar e exportar projetos longos
- Key contexts of use: sessões extensas em desktop, monitor grande, teclado e mouse, mídia armazenada localmente

## Information architecture
- Primary navigation: Media, Effects, Captions e Transitions à esquerda; Inspector e Chat à direita
- Core routes/screens: uma única superfície de edição com onboarding contextual
- Content hierarchy: monitor e timeline primeiro; ferramentas e agente permanecem subordinados ao projeto

## Design principles
- O estado do projeto deve ser legível antes de ser bonito
- Toda ação da IA deve deixar uma trilha concreta e reversível
- Controles profissionais usam nomes convencionais
- Tradeoffs: densidade e precisão têm prioridade sobre minimalismo espaçoso

## Visual language
- Color: warm-black `#0B0C0A`, neutros adjacentes e âmbar `#FFB800` como único sinal
- Typography: IBM Plex Mono para toda a interface, com numerais tabulares
- Spacing/layout rhythm: unidades de 4 px e painéis densos, redimensionáveis
- Shape/radius/elevation: cantos retos, bordas de 1 px, zero sombras
- Motion: 120–180 ms apenas para indicar mudanças de estado; respeitar reduced motion
- Imagery/iconography: conteúdo do usuário e SVGs próprios; nenhum glifo Unicode como ícone

## Components
- Existing components to reuse: nenhum
- New/changed components: toolbar, tabs, media bin, monitor, transport, inspector, chat, timeline canvas, tracks e ledger
- Variants and states: default, hover, focus, active, disabled, loading, error e offline
- Token/component ownership: tokens globais em CSS; componentes implementados no próprio repositório

## Accessibility
- Target standard: WCAG 2.2 AA
- Keyboard/focus behavior: foco sempre visível, atalhos documentados e ordem previsível
- Contrast/readability: texto claro em fundo warm-black e âmbar reservado a foco/progresso
- Screen-reader semantics: landmarks, labels e alternativas textuais para canvas
- Reduced motion and sensory considerations: desativar linha animada e transições não essenciais

## Responsive behavior
- Supported breakpoints/devices: desktop a partir de 1180×720
- Layout adaptations: painéis laterais recolhem antes da timeline; monitor preserva proporção
- Touch/hover differences: hover é melhoria; operações críticas continuam acessíveis por foco e clique

## Interaction states
- Loading: progresso determinado por job real
- Empty: instruções diretas para importar mídia ou instalar modelo local
- Error: causa, impacto e ação recuperável
- Success: confirmação curta no status bar, sem modal
- Disabled: motivo exposto em tooltip ou descrição adjacente
- Offline/slow network: edição e transcrição continuam; somente Gemini fica indisponível

## Content voice
- Tone: direto, técnico e calmo
- Terminology: termos convencionais de edição e português brasileiro
- Microcopy rules: verbos curtos, sem metáforas de IA e sem números simulados

## Implementation constraints
- Framework/styling system: Tauri v2, React, Tailwind CSS v4 e CSS próprio
- Design-token constraints: obedecer integralmente ao anchor Industrial
- Performance constraints: canvas virtualizado e nenhuma mídia binária no estado React
- Compatibility constraints: Windows, macOS e Linux desktop
- Test/screenshot expectations: estados vazio, carregado, transcrevendo, agente ativo e erro devem ser reproduzíveis

## Open questions
- Nenhuma decisão bloqueante; nome de marca permanece “Editor de Vídeo” até existir uma definição do produto
