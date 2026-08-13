# 🎲 Mesa RPG Online

Mesa virtual completa para jogar RPG com seus amigos, com **dados 3D realistas**, **videochamada**, **sincronização em tempo real** e **fichas visuais interativas**.

---

## ✨ Funcionalidades

| Funcionalidade | Descrição |
|----------------|-----------|
| 🎲 **Dados 3D** | D4, D6, D8, D10, D12, D20 e D100 com física realista (Three.js + Cannon.js) |
| 📹 **Videochamada** | WebRTC nativo — câmera, microfone e compartilhamento de tela |
| 🔄 **Sincronização** | Socket.io — todos veem os dados, imagem e música em tempo real |
| 📋 **Fichas Visuais** | Fichas interativas com marcadores (dots) para Lobisomem, Vampiro e D&D 5E |
| 🎵 **Música** | Upload de MP3, controle de volume, loop e sincronização |
| 🖼️ **Cenário** | Imagem central alterável pelo Narrador, sincronizada para todos |
| 💬 **Chat** | Chat de texto em tempo real com notificações |
| 🏠 **Salas** | Código único, senha de acesso, até 8 jogadores |

---

## 🚀 Como rodar localmente

```bash
# 1. Clone ou baixe os arquivos
# 2. Instale as dependências
npm install

# 3. Inicie o servidor
npm start

# 4. Abra no navegador
# http://localhost:3000
```

---

## 🌐 Como hospedar online (Railway / Render / Fly.io)

### Railway (recomendado)
1. Crie conta em [railway.app](https://railway.app)
2. New Project → Deploy from GitHub (ou upload)
3. Railway detecta o `package.json` automaticamente
4. O deploy é automático! A URL será gerada.

### Render
1. Crie conta em [render.com](https://render.com)
2. New Web Service → Connect repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Deploy!

---

## 📱 Como usar no celular

1. Abra o site no navegador do celular (Chrome/Safari)
2. Menu → **"Adicionar à tela inicial"**
3. Vira um app nativo sem barra de endereço!

---

## 🗂️ Estrutura de arquivos

```
rpg-mesa/
├── index.html      # Página de login
├── mesa.html       # Mesa principal (frontend completo)
├── server.js       # Backend Node.js + Socket.io
├── package.json    # Dependências
└── README.md       # Este arquivo
```

---

## 🎮 Fluxo de uso

1. **Narrador** acessa o site, escolhe "Narrador", define nome, senha e sistema (Lobisomem/Vampiro/D&D)
2. O código da sala é definido pelo narrador
3. **Jogadores** acessam, escolhem "Jogador", digitam o código e a senha
4. Todos entram na mesa com videochamada, dados 3D, fichas visuais e chat sincronizados!

---

## 📝 Sistema de Fichas

As fichas agora usam **marcadores visuais clicáveis** (dots):

- **Lobisomem**: Atributos, Habilidades, Dons, Antecedentes, Fúria, Gnose, Força de Vontade, Vitalidade, Renome
- **Vampiro**: Atributos, Habilidades, Disciplinas, Antecedentes, Humanidade, Força de Vontade, Reserva de Sangue, Vitalidade
- **D&D 5E**: Atributos numéricos com modificadores automáticos, Perícias com indicadores de proficiência/expertise, Magias, Equipamento

---

## ⚠️ Notas importantes

- **Dados 3D**: Usam Three.js + Cannon.js para física realista (gravidade, quicar, girar)
- **Videochamada**: WebRTC com STUN servers do Google. Para produção, adicione TURN servers.
- **Sincronização**: Se o servidor estiver offline, o modo local ativa (cada um vê só a própria tela)
- **Música**: Biblioteca e estado de reprodução são sincronizados pela sala. Arquivos em Base64 podem aumentar bastante o tamanho persistido da sala.

---

Feito com ❤️ para a comunidade RPGista brasileira.


## Render — importante
Os arquivos `server.js`, `index.html`, `mesa.html` e `package.json` devem ficar no MESMO diretório raiz do serviço.
A rota `/` é servida explicitamente por `server.js`. Para verificar o deploy, abra `/health`: deve retornar `ok: true`, `index: true` e `mesa: true`.

## V12 — dados físicos / Vampiro V5
- D10 reconstruído como trapezoedro pentagonal com 10 faces-kite planas.
- D4/D6/D8/D12/D20 preservam os poliedros físicos correspondentes.
- D100 é exibido fisicamente como par de D10 (dezenas + unidades), mantendo resultado lógico de 1 a 100.
- Em mesas de Vampiro, a opção D10 Vampiro V5 aparece abaixo do D10 normal.
- Dados de Fome substituem dados normais dentro do pool total; não aumentam a quantidade rolada.
- Ao finalizar a física, a face que define o resultado é orientada para cima e os dados permanecem visíveis por 7 segundos.


## V14 — dados 3D padronizados
- As malhas-base de D4/D6/D8/D10/D12/D20 e o algoritmo de chanfro foram adaptados do projeto open-source `3d-dice/dice-box-threejs` (MIT), que por sua vez é baseado no Major's 3D Dice.
- A renderização usa malha visual chanfrada e colisão Cannon com o poliedro-base não chanfrado.
- O D10 usa a proporção e o UV próprio do trapezoedro pentagonal da referência, em vez da malha customizada das versões anteriores.
- Em mesas Vampiro V5, dados normais são pretos e dados de Fome são vermelhos. Fome substitui dados do pool total. As faces V5 usam uma interpretação vetorial original de símbolos funcionais (falha, sucesso, crítico e falha bestial), sem copiar artes proprietárias.


## V16 — sincronização de dados, mídia e zoom

- Rolagens 3D são disparadas pelo servidor para todos os participantes da sala; todos veem a animação e o mesmo resultado.
- Histórico de até 100 testes por sala, com nome do jogador e horário, com barra de rolagem na aba Dados.
- O histórico de testes também é persistido junto da sala.
- Tokens agora pertencem à mesma camada transformada do cenário: zoom/pan do mapa altera proporcionalmente posição e tamanho visual dos tokens.
- Movimento de token é transmitido durante o arraste, além de tamanho, borda e marca de morto.
- O login solicita câmera e microfone no clique em “Entrar na Mesa”; a mesa tenta abri-los automaticamente e oferece um botão de fallback se o navegador bloquear autoplay/permissão.
- WebRTC usa uma negociação por par e troca de tracks (`replaceTrack`) para câmera/microfone/tela, reduzindo renegociações. TURN continua configurável por variáveis de ambiente.
- Música usa o estado persistente da sala (`trackId`, play/pause, posição e loop), com correção periódica de sincronismo, e toca em paralelo ao áudio da chamada.
- D20 exibe apenas resultados; D100 conta sucesso quando o valor é igual ou inferior ao alvo.


## V17 — jogador único em vários aparelhos + móvel + seleção de áudio

- O Nome de Jogador é a identidade lógica dentro da sala: ficha, cor e imagem do personagem são recuperadas pela mesma identidade quando ele volta.
- Dois ou mais aparelhos com o mesmo Nome de Jogador e a mesma sala/senha contam como **um único jogador** no limite da mesa, mas mantêm conexões WebRTC independentes. Isso permite, por exemplo, usar o computador para a mesa e o celular para câmera/microfone.
- O layout de vídeo agrupa os aparelhos do mesmo jogador em um único card e escolhe uma câmera/microfone ativos, evitando duplicar o jogador e reduzindo eco entre seus próprios aparelhos.
- A aba Sala ganhou seleção de microfone e, quando o navegador suporta a Audio Output Devices API, seleção explícita de saída de áudio/fone. Em navegadores sem essa API, a rota do fone/viva-voz continua sob controle do Android/iOS.
- WebRTC ganhou tentativa de reconexão/ICE restart para conexões `disconnected` ou `failed`, fallback de oferta para o recém-chegado e bitrate de vídeo mais conservador para redes móveis.
- O histórico de dados mantém os resultados **mais recentes no topo**, com nome e horário, e a aba Dados continua rolável.
- O layout móvel usa rolagem vertical e horizontal onde necessário, reduz cards de vídeo e limita a altura das abas para que conteúdo não fique preso fora da tela.
- O login não inventa mais um nome aleatório: o nome é a chave persistente do personagem dentro da sala. O navegador lembra o último nome usado para cada código de sala.


## Vampiro V6 — autorização de campanha

A sala `Vampiro V6 — Alpha` exige autorização do proprietário do site para ser criada. Configure no Render:

```bash
V6_CAMPAIGN_AUTH_KEY=uma-chave-secreta-definida-pela-administradora
```

O narrador precisa informar essa autorização ao criar uma nova campanha/sala V6. A chave nunca é salva dentro da sala. O servidor também impede duas salas com o mesmo **Nome da Sala** dentro da mesma **Campanha**, mesmo que os códigos sejam diferentes.

A ficha V6 segue somente elementos confirmados publicamente para o Alpha Playtest (Lifepaths, Natures, Clan Traits, Merits, Vitae, Humanity Scale, Beast/Nature e Quickening). Campos cujas listas/regras completas ainda não foram publicadas ficam livres para evitar inventar regras.

## WebRTC

A V18 usa um iniciador determinístico por par de aparelhos para evitar ofertas WebRTC concorrentes. Para redes móveis/NAT restritivo, configure também `TURN_URL`, `TURN_USERNAME` e `TURN_CREDENTIAL`; STUN sozinho não consegue garantir conexão entre todas as redes. A saída de áudio é escolhida automaticamente pelo sistema operacional; seletores de câmera/microfone só aparecem quando há mais de um dispositivo de entrada.
