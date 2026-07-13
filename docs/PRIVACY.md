# Fronteira de privacidade

## Permanece local

- bytes de áudio e vídeo;
- thumbnails, waveforms e proxies;
- caminhos absolutos e estrutura de diretórios;
- projetos e autosaves;
- WAV temporário usado pelo whisper.cpp;
- modelo e saída completa da transcrição local;
- render final.

## É enviado ao Gemini

- pedido atual e até 12 mensagens recentes do chat;
- nomes e IDs lógicos de assets, clipes e faixas;
- duração, ticks, volume, velocidade, efeitos e transições;
- texto e timestamps dos segmentos de transcript;
- captions e markers da sequência.

Esse envio acontece somente quando o usuário envia uma mensagem na aba Chat. Editar manualmente, transcrever, criar proxy e exportar não exigem rede.

## Chave de API

A chave informada pela interface fica em memória e é descartada ao fechar o processo. Ela não entra no projeto, autosave, localStorage ou logs do aplicativo. Para desenvolvimento, o processo também aceita `GEMINI_API_KEY` no ambiente.

## Limites intencionais

O agente não pode decidir com base em rostos, objetos, enquadramento, cor da imagem ou eventos visuais. Ele também não recebe o áudio bruto. Pedidos desse tipo são recusados em vez de produzir uma edição inventada.
