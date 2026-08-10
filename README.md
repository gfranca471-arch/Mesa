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
- **Música**: Upload local — não é transmitida entre jogadores, apenas o comando de play/pause

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
