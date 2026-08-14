# 🎲 Mesa RPG Online — V19

Mesa virtual de RPG com dados 3D, cenário e tokens compartilhados, fichas persistentes, música sincronizada e chamada WebRTC.

## Entrada na campanha

Não existe código de sala para o usuário. Narrador e jogadores informam apenas:

- Nome de Jogador
- Nome da Campanha / Sala
- Senha

O Narrador também escolhe o sistema ao criar uma campanha nova. O Nome da Campanha é normalizado no servidor, portanto não é possível criar outra campanha com o mesmo nome apenas mudando maiúsculas, espaços ou acentos. Quem entra precisa informar a senha correta.

A identidade persistente do personagem é **Campanha + Nome de Jogador**. Dois aparelhos conectados com o mesmo Nome de Jogador pertencem ao mesmo jogador, usam a mesma ficha/perfil e ocupam uma única vaga; cada aparelho mantém seu próprio socket WebRTC.

## Sistemas

- 🐺 Lobisomem: O Apocalipse
- 🧛 Vampiro: A Máscara V5
- 🩸 Vampiro: A Máscara V6 — Alpha Playtest
- ⚔️ Dungeons & Dragons 5E (2024 Core + opções legado)
- 🦋 Changeling: O Sonhar — C20 (estrutura-base; será refinada com a ficha de referência)

### Conteúdo ampliado das fichas

- **Lobisomem:** seleção atualizada com as 11 tribos de W5, mantendo opções antigas para personagens já salvos; campos de Espírito Patrono, Favor e Ban/Restrição.
- **Vampiro V5:** seleção dos 14 clãs modernos, preservando nomes legados para compatibilidade.
- **Vampiro V6 Alpha:** criador/ficha separado da V5, usando apenas categorias publicamente confirmadas do playtest atual.
- **D&D 5E:** 12 classes do PHB 2024, 10 espécies, 16 antecedentes e sugestões das 48 subclasses do PHB 2024, além de campos livres para legado/suplementos.
- **Changeling C20:** atributos, habilidades, Artes, Reinos, Antecedentes, Glamour, Força de Vontade, Banalidade, Birthrights/Frailties e opções-base de Kith/Gallain. A ficha final será alinhada à referência que ainda será enviada.

## Autorização para criar campanha Vampiro V6

O Narrador **não digita código de autorização**.

Ao tentar criar uma campanha nova com o sistema Vampiro V6, o servidor envia um pedido de aprovação para:

`v.f.lune@gmail.com`

O e-mail contém botões/link para **Autorizar** ou **Recusar**. O Narrador pode permanecer na tela; após a aprovação, a campanha é criada automaticamente. O pedido expira em 30 minutos.

### Variáveis necessárias no Render para o e-mail

```text
V6_APPROVAL_EMAIL=v.f.lune@gmail.com
SMTP_USER=<conta que enviará o e-mail>
SMTP_PASS=<senha de aplicativo / credencial SMTP>
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
PUBLIC_BASE_URL=https://SEU-SERVICO.onrender.com
```

Para Gmail, `SMTP_PASS` deve ser uma senha de aplicativo/credencial SMTP válida da conta usada em `SMTP_USER`.

## Câmera, microfone e vários aparelhos

A chamada é uma malha WebRTC: cada aparelho possui conexão direta com os demais endpoints da sala. Para cada par existe somente um iniciador de negociação, reduzindo colisões de ofertas.

Quando o mesmo jogador usa computador + celular:

- continua sendo exibido como um único jogador;
- o aparelho mais recente com câmera ativa passa a ser a câmera preferida daquele jogador;
- o aparelho mais recente com microfone ativo passa a ser o microfone preferido ouvido pelos **outros jogadores**;
- o próprio jogador não reproduz o próprio microfone para evitar eco/feedback;
- o computador pode permanecer como controle da mesa enquanto o celular fornece câmera/microfone.

A saída de áudio (fone/Bluetooth/alto-falante) é escolhida automaticamente pelo navegador/sistema operacional. A interface só mostra seleção de **câmera** ou **microfone** quando mais de uma entrada daquele tipo estiver disponível.

Para redes móveis, CGNAT, redes corporativas ou NAT restritivo, configure TURN:

```text
TURN_URL=<url do servidor TURN>
TURN_USERNAME=<usuário>
TURN_CREDENTIAL=<senha>
```

Sem TURN, STUN/WebRTC não consegue garantir conectividade entre todas as combinações de redes.

## Sincronização da mesa

São sincronizados para todos na mesma campanha:

- cenário;
- tokens, posição, tamanho, borda e marca ✕ de morto;
- rolagens 3D e resultados;
- histórico de testes (mais recente no topo);
- música, play/pause, posição e loop;
- presença e estado de mídia dos jogadores.

Zoom/pan do cenário transforma a mesma camada dos tokens, por isso eles acompanham proporcionalmente o mapa.

## Persistência

Sala, sistema, senha, fichas, perfis, cenário, tokens, músicas e histórico podem ser persistidos em PostgreSQL quando `DATABASE_URL` está configurada. Sem PostgreSQL, há fallback para `data/rooms.json`, que não é garantia de permanência em filesystem efêmero de hospedagens como Render sem disco persistente.

## Regras especiais dos dados

- D20: mostra os resultados sem classificar sucesso/falha.
- D100: sucesso quando o resultado é **igual ou inferior** ao alvo.
- Vampiro V5: Fome substitui dados normais; não aumenta o pool.
- Vampiro V6 Alpha: usa D10 comum e evita inventar resolução ainda não publicada integralmente.

## Instalação

```bash
npm install
npm start
```

No Render:

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check: `/health`

Os arquivos `index.html`, `mesa.html`, `server.js` e `package.json` precisam estar no mesmo diretório raiz do serviço.


## V19.1 — autorização V6 e Lobisomem 3ª Edição

- A autorização de campanha Vampiro V6 não depende mais obrigatoriamente de `SMTP_USER`/`SMTP_PASS`.
- Quando SMTP não existe, o servidor usa FormSubmit como relay para `V6_APPROVAL_EMAIL`. No primeiro uso, confirme a ativação recebida nesse e-mail e use o botão **Reenviar pedido** na tela de espera.
- SMTP continua suportado opcionalmente se as variáveis forem definidas manualmente.
- A ficha de Lobisomem foi revertida para a linha clássica da 3ª Edição/Revisada: as 12 tribos ativas da 3ª Edição/Revisada em português, incluindo Fianna, e campos Natureza, Comportamento e Seita no lugar dos campos de Patrono/Favor/Ban de W5.


## V19.2 — autorização V6 persistente
- Pedidos V6 ficam em tela de espera, com Voltar/Reenviar.
- Resposta de ativação inicial do FormSubmit não é tratada como erro.
- A autorização passa a ser persistida na própria campanha.
- Depois de aprovada uma vez, a campanha V6 não pede autorização novamente.
- Lobisomem 3ª edição inclui Fianna e Portadores da Luz Interior em português.
