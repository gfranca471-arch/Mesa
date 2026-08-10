# 🎲 Mesa RPG Online — V15

Mesa virtual para Lobisomem, Vampiro V5 e D&D 5E, com dados 3D, fichas individuais, cenário/tokens sincronizados, música da sala e chamada WebRTC.

## Principais mudanças da V15

### Estado próprio de cada sala
- O sistema escolhido quando a sala é criada passa a pertencer à sala. Ao retornar, a sala continua como **Vampiro**, **Lobisomem** ou **D&D** e a ficha correspondente é carregada automaticamente.
- São persistidos: nome da sala, senha (hash no servidor), sistema, cenário, tokens (posição, tamanho, borda e X de morto), biblioteca/estado da música, perfis e fichas individuais.
- Cada jogador recebe apenas a própria ficha ao entrar. A chave atual é baseada no nome do jogador dentro daquela sala; por isso use sempre o mesmo nome ao retornar.

### Cenário e tokens sincronizados
- Qualquer participante pode alterar a imagem do cenário.
- A mudança do cenário aparece imediatamente para narrador e jogadores.
- Tokens são compartilhados pela sala. Movimento, tamanho, cor da borda, X de morto, criação e remoção são replicados em tempo real.
- O zoom/pan do cenário continua local para cada participante, para uma pessoa não alterar a visão da mesa de todos os demais.

### Música sincronizada
- Arquivos de até 5 MB podem ser enviados para a biblioteca da sala.
- O servidor aceita mensagens maiores do Socket.IO para comportar os arquivos Base64.
- Play, pause, posição e loop ficam associados à sala e são enviados a todos.
- Quem entra depois recebe a faixa atual e a posição aproximada em que ela está tocando.
- Navegadores podem bloquear reprodução automática. O botão **Ativar áudio sincronizado** resolve isso após uma interação do usuário.
- Música e áudio da chamada usam elementos/fluxos separados e podem tocar simultaneamente.

### WebRTC
- Áudio e vídeo são pré-negociados com transceivers quando suportados.
- Ligar/desligar câmera, microfone e compartilhamento usa `replaceTrack()` quando possível, evitando renegociações desnecessárias.
- Parâmetros de envio são ajustados para privilegiar fluidez/latência.
- ICE usa STUN por padrão e aceita TURN por variáveis de ambiente.

### Regras dos dados
- **D20:** mostra somente os resultados. Não exibe dificuldade, mínimo de sucessos ou avaliação êxito/falha.
- **D100:** é roll-under: um resultado **igual ou inferior ao alvo** é sucesso.
- **Vampiro V5:** Fome substitui dados normais dentro do pool; não aumenta a quantidade total.
- O painel do último resultado foi reduzido e continua fixo na aba Dados.

## Instalação local

```bash
npm install
npm start
```

Abra `http://localhost:3000`.

## Persistência no Render

O servidor possui dois modos:

### 1. PostgreSQL — recomendado no Render
Defina a variável de ambiente:

```text
DATABASE_URL=<string de conexão PostgreSQL>
```

A tabela `rpg_rooms` é criada automaticamente. Esse modo é o recomendado para manter salas entre reinicializações e novos deploys.

### 2. JSON local
Sem `DATABASE_URL`, o estado é salvo em:

```text
data/rooms.json
```

Para esse arquivo sobreviver a reinicializações/deploys no Render é necessário montar armazenamento persistente e, se quiser, definir:

```text
ROOMS_DATA_FILE=/var/data/rooms.json
```

Sem banco ou disco persistente, o JSON funciona durante a execução, mas pode desaparecer quando o serviço for recriado.

## TURN para chamadas mais confiáveis

STUN já vem configurado. Para redes em que conexão direta WebRTC não é possível, configure um TURN:

```text
TURN_URL=turn:seu-servidor:3478
TURN_USERNAME=usuario
TURN_CREDENTIAL=senha
```

Também é aceito mais de um `TURN_URL`, separado por vírgulas.

## Diagnóstico

Abra:

```text
/health
```

Exemplo:

```json
{
  "ok": true,
  "index": true,
  "mesa": true,
  "storage": "postgres",
  "turnConfigured": true
}
```

## Estrutura

```text
index.html
mesa.html
server.js
package.json
render.yaml
THIRD_PARTY_NOTICES.txt
data/
  rooms.json
```

## Dependências

- Express
- Socket.IO
- PostgreSQL (`pg`, opcional em execução; usado quando `DATABASE_URL` está configurado)
- Three.js / Cannon.js no frontend
