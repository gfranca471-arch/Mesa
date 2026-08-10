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

app.use(express.static(path.join(__dirname)));

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
                players: {}, currentImage: null, tokens: [],
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

    socket.on('tokens-update', (data) => {
        if (!rooms[data.room]) return;
        rooms[data.room].tokens = Array.isArray(data.tokens) ? data.tokens.slice(0, 200) : [];
        io.to(data.room).emit('tokens-updated', rooms[data.room].tokens);
    });

    socket.on('change-image', (data) => {
        if (rooms[data.room]) {
            rooms[data.room].currentImage = data.url;
            socket.to(data.room).emit('image-changed', data.url);
        }
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor RPG Mesa na porta ${PORT}`);
});