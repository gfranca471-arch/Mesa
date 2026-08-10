const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] }, transports: ['websocket', 'polling'] });
app.use(express.static(path.join(__dirname)));

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
let persistedRooms = {};
try { persistedRooms = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}'); } catch { persistedRooms = {}; }
const rooms = {};
for (const [code, saved] of Object.entries(persistedRooms)) {
    rooms[code] = { ...saved, players: {}, sharedMusic: saved.sharedMusic || [], sheets: saved.sheets || {}, tokens: saved.tokens || [], currentImage: saved.currentImage || null };
}
let saveTimer = null;
function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        const snapshot = {};
        for (const [code, room] of Object.entries(rooms)) {
            snapshot[code] = { password: room.password, system: room.system, currentImage: room.currentImage || null, sharedMusic: room.sharedMusic || [], sheets: room.sheets || {}, tokens: room.tokens || [], createdAt: room.createdAt || Date.now() };
        }
        const tmp = DATA_FILE + '.tmp';
        try { fs.writeFileSync(tmp, JSON.stringify(snapshot)); fs.renameSync(tmp, DATA_FILE); } catch (e) { console.error('Falha ao salvar salas:', e.message); }
    }, 150);
}
function ensureRoom(room, password, system) {
    if (!rooms[room]) rooms[room] = { password, system: system || 'lobisomem', players: {}, currentImage: null, sharedMusic: [], sheets: {}, tokens: [], createdAt: Date.now() };
    return rooms[room];
}

io.on('connection', (socket) => {
    console.log('🔌 Cliente:', socket.id);

    socket.on('join-room', (data) => {
        const { room, password, name, role, system, color, charImage } = data || {};
        if (!room || !name) return socket.emit('error', 'Nome e sala são obrigatórios.');
        if (!rooms[room] && role !== 'narrador') return socket.emit('error', 'Sala não existe. Peça ao Narrador para criar.');
        const roomData = ensureRoom(room, password, system);
        if (roomData.password !== password) return socket.emit('error', 'Senha incorreta!');
        if (role === 'narrador' && system) roomData.system = system;
        const playerSystem = role === 'narrador' ? (system || roomData.system) : roomData.system;
        socket.join(room);
        const ownerKey = 'player:' + String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        roomData.players[socket.id] = { id: socket.id, name, role, system: playerSystem, color: color || '#e94560', charImage: charImage || '', ownerKey, joinedAt: Date.now() };
        socket.data.room = room; socket.data.ownerKey = ownerKey;
        socket.emit('room-joined', { room, system: roomData.system, players: roomData.players, currentImage: roomData.currentImage, sharedMusic: roomData.sharedMusic, sheets: roomData.sheets, tokens: roomData.tokens });
        socket.to(room).emit('user-joined', roomData.players[socket.id]);
        scheduleSave();
        console.log(`👤 ${name} (${role}) entrou em ${room}`);
    });

    socket.on('roll-dice', (data) => { if (rooms[data.room]) socket.to(data.room).emit('dice-rolled', data); });

    socket.on('change-image', (data) => {
        const room = rooms[data.room]; if (!room) return;
        room.currentImage = data.url; scheduleSave(); socket.to(data.room).emit('image-changed', data.url);
    });

    socket.on('music-control', (data) => { if (rooms[data.room]) socket.to(data.room).emit('music-played', data); });
    socket.on('share-music', (data) => { if (rooms[data.room]) { rooms[data.room].sharedMusic.push(data.track); scheduleSave(); socket.to(data.room).emit('shared-music', data); } });
    socket.on('chat-message', (data) => { if (rooms[data.room]) socket.to(data.room).emit('chat-message', data); });

    socket.on('update-sheet', (data) => {
        const room = rooms[data.room]; if (!room || !data.sheet) return;
        const key = data.ownerKey || socket.data.ownerKey || ('socket:' + socket.id);
        room.sheets[key] = { ...data.sheet, name: data.name || room.players[socket.id]?.name || key, updatedAt: Date.now() };
        scheduleSave();
        io.to(data.room).emit('sheet-updated', { ...data, ownerKey: key, id: socket.id });
    });

    socket.on('change-border', (data) => {
        const room = rooms[data.room]; if (!room) return;
        if (room.players[socket.id]) room.players[socket.id].color = data.color;
        socket.to(data.room).emit('border-changed', { id: socket.id, color: data.color });
    });
    socket.on('change-char-image', (data) => {
        const room = rooms[data.room]; if (!room) return;
        if (room.players[socket.id]) room.players[socket.id].charImage = data.url;
        scheduleSave(); socket.to(data.room).emit('char-image-changed', { id: socket.id, url: data.url });
    });

    socket.on('token-add', (data) => {
        const room = rooms[data.room]; if (!room || !data.token?.url) return;
        const token = { ...data.token, owner: data.token.owner || socket.data.ownerKey };
        room.tokens.push(token); scheduleSave(); io.to(data.room).emit('token-added', token);
    });
    socket.on('token-move', (data) => {
        const room = rooms[data.room]; if (!room || !data.token?.id) return;
        const idx = room.tokens.findIndex(t => t.id === data.token.id); if (idx < 0) return;
        room.tokens[idx] = { ...room.tokens[idx], x: Number(data.token.x), y: Number(data.token.y) };
        scheduleSave(); io.to(data.room).emit('token-moved', room.tokens[idx]);
    });
    socket.on('token-remove', (data) => {
        const room = rooms[data.room]; if (!room) return;
        room.tokens = room.tokens.filter(t => t.id !== data.id); scheduleSave(); io.to(data.room).emit('token-removed', data.id);
    });

    socket.on('webrtc-offer', (data) => io.to(data.target).emit('webrtc-offer', { from: socket.id, offer: data.offer }));
    socket.on('webrtc-answer', (data) => io.to(data.target).emit('webrtc-answer', { from: socket.id, answer: data.answer }));
    socket.on('webrtc-ice', (data) => io.to(data.target).emit('webrtc-ice', { from: socket.id, candidate: data.candidate }));

    socket.on('disconnect', () => {
        const roomCode = socket.data.room;
        if (roomCode && rooms[roomCode]?.players[socket.id]) {
            const room = rooms[roomCode];
            delete room.players[socket.id];
            io.to(roomCode).emit('user-left', socket.id);
            scheduleSave();
        }
        console.log('❌ Saiu:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor RPG Mesa na porta ${PORT}`));
