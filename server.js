const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

const PUBLIC_DIR = path.resolve(__dirname);
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const TABLE_FILE = path.join(PUBLIC_DIR, 'mesa.html');

// Rotas explícitas: não dependem do comportamento automático do express.static.
// Isso evita o "Cannot GET /" no Render quando a rota raiz é requisitada.
app.get('/', (req, res) => res.sendFile(INDEX_FILE));
app.get('/index.html', (req, res) => res.sendFile(INDEX_FILE));
app.get('/mesa.html', (req, res) => res.sendFile(TABLE_FILE));

// Assets/arquivos restantes do projeto.
app.use(express.static(PUBLIC_DIR, { index: false, fallthrough: true }));

// Diagnóstico simples para confirmar que o serviço correto está no ar.
app.get('/health', (req, res) => {
    res.status(200).json({
        ok: true,
        index: require('fs').existsSync(INDEX_FILE),
        mesa: require('fs').existsSync(TABLE_FILE)
    });
});

const rooms = {};

io.on('connection', (socket) => {
    console.log('🔌 Cliente:', socket.id);

    socket.on('join-room', (data) => {
        const { room, password, name, role, system, color, charImage } = data;
        if (!rooms[room]) {
            if (role !== 'narrador') {
                socket.emit('error', 'Sala não existe. Peça ao Narrador para criar.');
                return;
            }
            rooms[room] = {
                password, system: system || 'lobisomem',
                players: {}, currentImage: null,
                sharedMusic: [], createdAt: Date.now()
            };
        }
        const roomData = rooms[room];
        if (roomData.password !== password) {
            socket.emit('error', 'Senha incorreta!');
            return;
        }
        const playerSystem = role === 'narrador' ? (system || roomData.system) : roomData.system;
        socket.join(room);
        roomData.players[socket.id] = {
            id: socket.id, name, role, system: playerSystem,
            color: color || '#e94560', charImage: charImage || '',
            joinedAt: Date.now()
        };
        socket.emit('room-joined', {
            room, system: roomData.system,
            players: roomData.players,
            currentImage: roomData.currentImage,
            tokens: roomData.tokens || [],
            sharedMusic: roomData.sharedMusic
        });
        socket.to(room).emit('user-joined', roomData.players[socket.id]);
        console.log(`👤 ${name} (${role}) entrou em ${room}`);
    });

    socket.on('roll-dice', (data) => {
        if (rooms[data.room]) socket.to(data.room).emit('dice-rolled', data);
    });

    socket.on('change-image', (data) => {
        if (rooms[data.room]) {
            rooms[data.room].currentImage = data.url;
            socket.to(data.room).emit('image-changed', data.url);
        }
    });

    socket.on('token-added', (data) => {
        if (rooms[data.room]) {
            rooms[data.room].tokens = rooms[data.room].tokens || [];
            rooms[data.room].tokens.push(data.token);
            io.to(data.room).emit('token-added', data.token);
        }
    });
    socket.on('token-moved', (data) => {
        const room = rooms[data.room];
        if (!room) return;
        const i = (room.tokens || []).findIndex(t => t.id === data.token.id);
        if (i >= 0) room.tokens[i] = data.token;
        io.to(data.room).emit('token-moved', data.token);
    });
    socket.on('token-removed', (data) => {
        const room = rooms[data.room];
        if (!room) return;
        room.tokens = (room.tokens || []).filter(t => t.id !== data.id);
        io.to(data.room).emit('token-removed', data.id);
    });

    socket.on('music-control', (data) => {
        if (rooms[data.room]) socket.to(data.room).emit('music-played', data);
    });

    socket.on('share-music', (data) => {
        if (rooms[data.room]) {
            rooms[data.room].sharedMusic.push(data.track);
            socket.to(data.room).emit('shared-music', data);
        }
    });

    socket.on('chat-message', (data) => {
        if (rooms[data.room]) socket.to(data.room).emit('chat-message', data);
    });

    socket.on('update-sheet', (data) => {
        if (rooms[data.room]) socket.to(data.room).emit('sheet-updated', { ...data, id: socket.id });
    });

    socket.on('change-border', (data) => {
        if (rooms[data.room]) {
            if (rooms[data.room].players[socket.id]) rooms[data.room].players[socket.id].color = data.color;
            socket.to(data.room).emit('border-changed', { id: socket.id, color: data.color });
        }
    });

    socket.on('change-char-image', (data) => {
        if (rooms[data.room]) {
            if (rooms[data.room].players[socket.id]) rooms[data.room].players[socket.id].charImage = data.url;
            socket.to(data.room).emit('char-image-changed', { id: socket.id, url: data.url });
        }
    });

    socket.on('webrtc-offer', (data) => { io.to(data.target).emit('webrtc-offer', { from: socket.id, offer: data.offer }); });
    socket.on('webrtc-answer', (data) => { io.to(data.target).emit('webrtc-answer', { from: socket.id, answer: data.answer }); });
    socket.on('webrtc-ice', (data) => { io.to(data.target).emit('webrtc-ice', { from: socket.id, candidate: data.candidate }); });

    socket.on('disconnect', () => {
        console.log('❌ Saiu:', socket.id);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.players[socket.id]) {
                const name = room.players[socket.id].name;
                delete room.players[socket.id];
                io.to(roomCode).emit('user-left', socket.id);
                if (Object.keys(room.players).length === 0) {
                    setTimeout(() => {
                        if (Object.keys(room.players).length === 0) {
                            delete rooms[roomCode];
                            console.log(`🗑️ Sala ${roomCode} removida`);
                        }
                    }, 3600000);
                }
            }
        }
    });
});

const fs = require('fs');
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor RPG Mesa na porta ${PORT}`);
    console.log(`📁 Diretório público: ${PUBLIC_DIR}`);
    console.log(`🏠 index.html: ${fs.existsSync(INDEX_FILE) ? 'OK' : 'AUSENTE'}`);
    console.log(`🎲 mesa.html: ${fs.existsSync(TABLE_FILE) ? 'OK' : 'AUSENTE'}`);
});