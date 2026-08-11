const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let Pool = null;
try { ({ Pool } = require('pg')); } catch (_) {}
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
    // Base64 aumenta o tamanho dos arquivos. 16 MB cobre músicas de até 5 MB
    // e imagens de cenário/tokens sem derrubar a conexão.
    maxHttpBufferSize: 16 * 1024 * 1024,
    pingInterval: 10000,
    pingTimeout: 20000
});

const PUBLIC_DIR = path.resolve(__dirname);
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const TABLE_FILE = path.join(PUBLIC_DIR, 'mesa.html');
const DATA_FILE = process.env.ROOMS_DATA_FILE || path.join(PUBLIC_DIR, 'data', 'rooms.json');

app.get('/', (req, res) => res.sendFile(INDEX_FILE));
app.get('/index.html', (req, res) => res.sendFile(INDEX_FILE));
app.get('/mesa.html', (req, res) => res.sendFile(TABLE_FILE));
app.use(express.static(PUBLIC_DIR, { index: false, fallthrough: true }));

const rooms = Object.create(null);
let pgPool = null;
let storageMode = 'json';
let disablePostgres = false;
let jsonSaveTimer = null;
const roomPersistTimers = new Map();

function cleanCode(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '-').slice(0, 80);
}
function cleanName(value) {
    return String(value || 'Anônimo').trim().slice(0, 80) || 'Anônimo';
}
function ownerKeyFor(name) {
    return 'player:' + cleanName(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}
function passwordRecord(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return { passwordSalt: salt, passwordHash: hash };
}
function passwordMatches(room, password) {
    if (room.passwordHash && room.passwordSalt) {
        const actual = Buffer.from(room.passwordHash, 'hex');
        const candidate = crypto.scryptSync(String(password), room.passwordSalt, 64);
        return actual.length === candidate.length && crypto.timingSafeEqual(actual, candidate);
    }
    // Migração de salas antigas que ainda tinham senha em texto simples.
    return room.password !== undefined && String(room.password) === String(password);
}
function normalizeRoom(room, code) {
    if (!room) return null;
    room.code = code;
    room.roomName = room.roomName || code;
    room.system = ['vampiro', 'lobisomem', 'dnd'].includes(room.system) ? room.system : 'lobisomem';
    room.currentImage = room.currentImage || null;
    room.tokens = Array.isArray(room.tokens) ? room.tokens : [];
    room.sharedMusic = Array.isArray(room.sharedMusic) ? room.sharedMusic : [];
    room.musicState = room.musicState || { trackId: null, playing: false, position: 0, startedAt: null, loop: true };
    room.sheets = room.sheets && typeof room.sheets === 'object' ? room.sheets : {};
    room.rollHistory = Array.isArray(room.rollHistory) ? room.rollHistory.slice(-100) : [];
    room.profiles = room.profiles && typeof room.profiles === 'object' ? room.profiles : {};
    room.players = room.players && typeof room.players === 'object' ? room.players : {};
    room.createdAt = room.createdAt || Date.now();
    room.updatedAt = room.updatedAt || Date.now();
    return room;
}
function persistableRoom(room) {
    const copy = { ...room };
    delete copy.players;
    delete copy.code;
    return copy;
}

async function initStorage() {
    if (!disablePostgres && process.env.DATABASE_URL && Pool) {
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
        });
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS rpg_rooms (
                room_code TEXT PRIMARY KEY,
                room_data JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        storageMode = 'postgres';
        console.log('💾 Persistência: PostgreSQL');
        return;
    }
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}');
            for (const [code, data] of Object.entries(parsed)) rooms[code] = normalizeRoom({ ...data, players: {} }, code);
        } catch (err) {
            console.error('⚠️ Não foi possível ler rooms.json:', err.message);
        }
    }
    storageMode = 'json';
    console.log(`💾 Persistência: JSON (${DATA_FILE})`);
}
async function loadRoom(code) {
    if (rooms[code]) return rooms[code];
    if (storageMode === 'postgres' && pgPool) {
        const result = await pgPool.query('SELECT room_data FROM rpg_rooms WHERE room_code = $1', [code]);
        if (result.rows[0]) {
            rooms[code] = normalizeRoom({ ...result.rows[0].room_data, players: {} }, code);
            return rooms[code];
        }
    }
    return null;
}
function scheduleJsonSave() {
    if (storageMode !== 'json') return;
    clearTimeout(jsonSaveTimer);
    jsonSaveTimer = setTimeout(() => {
        try {
            const output = {};
            for (const [code, room] of Object.entries(rooms)) output[code] = persistableRoom(room);
            fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
            const temp = DATA_FILE + '.tmp';
            fs.writeFileSync(temp, JSON.stringify(output, null, 2));
            fs.renameSync(temp, DATA_FILE);
        } catch (err) { console.error('Erro ao persistir salas:', err); }
    }, 120);
}
async function persistRoom(code) {
    const room = rooms[code];
    if (!room) return;
    room.updatedAt = Date.now();
    if (storageMode === 'postgres' && pgPool) {
        try {
            await pgPool.query(
                `INSERT INTO rpg_rooms(room_code, room_data, updated_at)
                 VALUES($1, $2::jsonb, NOW())
                 ON CONFLICT(room_code) DO UPDATE SET room_data=EXCLUDED.room_data, updated_at=NOW()`,
                [code, JSON.stringify(persistableRoom(room))]
            );
        } catch (err) { console.error(`Erro ao persistir ${code} no Postgres:`, err); }
    } else scheduleJsonSave();
}
function schedulePersistRoom(code, delay=180) {
    clearTimeout(roomPersistTimers.get(code));
    roomPersistTimers.set(code, setTimeout(() => {
        roomPersistTimers.delete(code);
        persistRoom(code);
    }, delay));
}

function rtcConfig() {
    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];
    const urls = String(process.env.TURN_URL || '').split(',').map(v => v.trim()).filter(Boolean);
    if (urls.length) {
        iceServers.push({
            urls: urls.length === 1 ? urls[0] : urls,
            username: process.env.TURN_USERNAME || '',
            credential: process.env.TURN_CREDENTIAL || ''
        });
    }
    return { iceServers, iceCandidatePoolSize: 10, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
}

app.get('/health', (req, res) => {
    res.status(200).json({
        ok: true,
        index: fs.existsSync(INDEX_FILE),
        mesa: fs.existsSync(TABLE_FILE),
        storage: storageMode,
        turnConfigured: Boolean(process.env.TURN_URL)
    });
});

function isRoomMember(socket, roomCode) {
    return socket.data.roomCode === roomCode && rooms[roomCode] && rooms[roomCode].players[socket.id];
}
function currentMusicPosition(room, now = Date.now()) {
    const m = room.musicState || {};
    if (!m.playing || !m.startedAt) return Number(m.position) || 0;
    return Math.max(0, (now - m.startedAt) / 1000);
}
function musicPayload(room) {
    const now = Date.now();
    return { ...room.musicState, position: currentMusicPosition(room, now), serverTime: now };
}

io.on('connection', (socket) => {
    console.log('🔌 Cliente:', socket.id);

    socket.on('join-room', async (data) => {
        try {
            const code = cleanCode(data.room);
            const role = data.role === 'narrador' ? 'narrador' : 'jogador';
            const name = cleanName(data.name);
            if (!code) return socket.emit('room-error', 'Código da sala inválido.');

            let room = await loadRoom(code);
            if (!room) {
                if (role !== 'narrador') return socket.emit('room-error', 'Sala não existe. Peça ao Narrador para criar.');
                const passwordFields = passwordRecord(data.password || '');
                room = normalizeRoom({
                    ...passwordFields,
                    roomName: String(data.roomName || code).trim().slice(0, 100) || code,
                    system: ['vampiro', 'lobisomem', 'dnd'].includes(data.system) ? data.system : 'lobisomem',
                    currentImage: null,
                    tokens: [], sharedMusic: [], sheets: {}, rollHistory: [], profiles: {},
                    musicState: { trackId: null, playing: false, position: 0, startedAt: null, loop: true },
                    players: {}, createdAt: Date.now(), updatedAt: Date.now()
                }, code);
                rooms[code] = room;
                await persistRoom(code);
            }
            if (!passwordMatches(room, data.password || '')) return socket.emit('room-error', 'Senha incorreta!');
            if (room.password !== undefined) {
                Object.assign(room, passwordRecord(data.password || ''));
                delete room.password;
                await persistRoom(code);
            }

            // O sistema pertence à sala. Quem entra recebe sempre o sistema salvo nela.
            const ownerKey = ownerKeyFor(name);
            socket.join(code);
            socket.data.roomCode = code;
            socket.data.ownerKey = ownerKey;
            socket.data.playerName = name;
            const savedProfile = room.profiles[ownerKey] || {};
            const profile = {
                name,
                color: savedProfile.color || data.color || '#e94560',
                charImage: savedProfile.charImage || data.charImage || '',
                updatedAt: Date.now()
            };
            room.profiles[ownerKey] = profile;
            room.players[socket.id] = {
                id: socket.id, ownerKey, name, role, system: room.system,
                color: profile.color, charImage: profile.charImage,
                cameraOn: Boolean(data.cameraOn), micOn: Boolean(data.micOn), screenSharing: false, joinedAt: Date.now()
            };
            schedulePersistRoom(code, 300);

            socket.emit('room-joined', {
                room: code,
                roomName: room.roomName,
                system: room.system,
                players: room.players,
                currentImage: room.currentImage,
                tokens: room.tokens,
                sharedMusic: room.sharedMusic,
                musicState: musicPayload(room),
                sheetKey: ownerKey,
                mySheet: room.sheets[ownerKey] || null,
                rollHistory: room.rollHistory || [],
                rtcConfig: rtcConfig(),
                storageMode
            });
            socket.to(code).emit('user-joined', room.players[socket.id]);
            console.log(`👤 ${name} (${role}) entrou em ${code}`);
        } catch (err) {
            console.error('join-room:', err);
            socket.emit('room-error', 'Não foi possível abrir a sala.');
        }
    });

    function randomDie(sides) {
        return crypto.randomInt(1, Math.max(2, Number(sides) || 2) + 1);
    }

    // Todos na sala recebem o MESMO lançamento. O resultado é definido uma vez
    // no servidor; cada navegador anima seus próprios dados 3D e termina na
    // mesma face/resultado. Isso evita o narrador ver um valor e outro jogador outro.
    socket.on('dice-roll-request', (data) => {
        const code = cleanCode(data.room);
        if (!isRoomMember(socket, code)) return;
        const room = rooms[code];
        const rawMode = String(data.diceMode || data.diceType || '20');
        const isV5 = rawMode === 'v5' && room.system === 'vampiro';
        const diceType = isV5 ? 10 : Math.max(2, Math.min(100, parseInt(rawMode, 10) || 20));
        const totalPool = Math.max(1, Math.min(10, parseInt(data.totalPool, 10) || 1));
        const hungerCount = isV5 ? Math.max(0, Math.min(totalPool, 5, parseInt(data.hungerCount, 10) || 0)) : 0;
        const mode = isV5 ? 'v5' : (diceType === 20 ? 'd20' : (diceType === 100 ? 'd100' : 'normal'));
        const difficulty = mode === 'd20' ? null : Math.max(1, Math.min(diceType, parseInt(data.difficulty, 10) || (isV5 ? 6 : 1)));
        const minSuccess = mode === 'd20' ? null : Math.max(0, parseInt(data.minSuccess, 10) || 0);
        const criticalCount = Math.max(1, parseInt(data.criticalCount, 10) || 2);
        const resultsDetailed = [];
        for (let i = 0; i < totalPool; i++) {
            resultsDetailed.push({ value: randomDie(diceType), hunger: isV5 && i >= totalPool - hungerCount });
        }
        const roll = {
            rollId: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
            room: code, who: socket.data.playerName || 'Jogador', rollerId: socket.id,
            diceMode: isV5 ? 'v5' : String(diceType), diceType, mode, totalPool, hungerCount,
            difficulty, minSuccess, criticalCount, resultsDetailed, createdAt: Date.now()
        };
        room.rollHistory.push(roll);
        if (room.rollHistory.length > 100) room.rollHistory = room.rollHistory.slice(-100);
        schedulePersistRoom(code, 250);
        io.to(code).emit('dice-roll-start', roll);
    });

    // Compatibilidade com clientes antigos: só replica o resultado textual.
    socket.on('roll-dice', (data) => {
        const code = cleanCode(data.room);
        if (isRoomMember(socket, code)) socket.to(code).emit('dice-rolled', data);
    });

    // CENÁRIO: qualquer participante pode alterar; o servidor guarda e replica.
    socket.on('change-image', async (data) => {
        const code = cleanCode(data.room);
        if (!isRoomMember(socket, code)) return;
        const room = rooms[code];
        room.currentImage = String(data.url || '').slice(0, 15 * 1024 * 1024) || null;
        io.to(code).emit('image-changed', { url: room.currentImage, by: socket.data.playerName });
        persistRoom(code);
    });

    // TOKENS: posição, tamanho, cor da borda e estado morto ficam no objeto inteiro.
    socket.on('token-added', async (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code) || !data.token?.id) return;
        const room = rooms[code];
        const token = { ...data.token, updatedAt: Date.now() };
        const existing = room.tokens.findIndex(t => t.id === token.id);
        if (existing >= 0) room.tokens[existing] = token; else room.tokens.push(token);
        io.to(code).emit('token-added', token);
        persistRoom(code);
    });
    socket.on('token-moved', async (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code) || !data.token?.id) return;
        const room = rooms[code];
        const i = room.tokens.findIndex(t => t.id === data.token.id);
        if (i < 0) return;
        room.tokens[i] = { ...room.tokens[i], ...data.token, updatedAt: Date.now() };
        schedulePersistRoom(code, 220);
        socket.to(code).emit('token-moved', room.tokens[i]);
    });
    socket.on('token-removed', async (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code)) return;
        const room = rooms[code];
        room.tokens = room.tokens.filter(t => t.id !== data.id);
        io.to(code).emit('token-removed', data.id);
        persistRoom(code);
    });

    // MÚSICA: biblioteca + estado de reprodução são próprios da sala.
    socket.on('share-music', async (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code) || !data.track?.id) return;
        const room = rooms[code];
        if (!room.sharedMusic.some(t => t.id === data.track.id)) {
            room.sharedMusic.push(data.track);
            // Evita crescimento ilimitado do arquivo da sala.
            if (room.sharedMusic.length > 30) room.sharedMusic.shift();
            persistRoom(code);
        }
        io.to(code).emit('shared-music', { track: data.track });
    });
    socket.on('remove-music', async (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code)) return;
        const room = rooms[code];
        room.sharedMusic = room.sharedMusic.filter(t => t.id !== data.trackId);
        if (room.musicState.trackId === data.trackId) room.musicState = { trackId:null, playing:false, position:0, startedAt:null, loop:true };
        io.to(code).emit('music-removed', { trackId: data.trackId, musicState: musicPayload(room) });
        persistRoom(code);
    });
    socket.on('music-sync-request', (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code)) return;
        socket.emit('music-state', musicPayload(rooms[code]));
    });

    socket.on('music-control', async (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code)) return;
        const room = rooms[code];
        const now = Date.now();
        const action = data.action || 'play';
        if (action === 'play') {
            const trackId = data.trackId || room.sharedMusic[data.trackIndex]?.id;
            if (!room.sharedMusic.some(t => t.id === trackId)) return;
            const position = Math.max(0, Number(data.position) || 0);
            room.musicState = { trackId, playing:true, position, startedAt:now - position*1000, loop:data.loop !== false };
        } else if (action === 'pause') {
            room.musicState.position = currentMusicPosition(room, now);
            room.musicState.playing = false;
            room.musicState.startedAt = null;
        } else if (action === 'seek') {
            const position = Math.max(0, Number(data.position) || 0);
            room.musicState.position = position;
            if (room.musicState.playing) room.musicState.startedAt = now - position*1000;
        } else if (action === 'loop') {
            room.musicState.loop = Boolean(data.loop);
        }
        io.to(code).emit('music-state', musicPayload(room));
        persistRoom(code);
    });

    socket.on('chat-message', (data) => {
        const code = cleanCode(data.room); if (isRoomMember(socket, code)) socket.to(code).emit('chat-message', data);
    });

    // FICHA PRIVADA: chave estável por nome dentro da sala. O conteúdo não é broadcast
    // para os demais jogadores; cada participante recebe sua própria ficha no join.
    socket.on('update-sheet', async (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code)) return;
        const room = rooms[code];
        const key = socket.data.ownerKey;
        if (!key) return;
        room.sheets[key] = { system: room.system, data: data.sheet?.data || {}, ownerName: socket.data.playerName, updatedAt: Date.now() };
        await persistRoom(code);
        socket.emit('sheet-updated', { key, sheet: room.sheets[key], name: socket.data.playerName });
    });

    socket.on('change-border', (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code)) return;
        rooms[code].players[socket.id].color = data.color;
        const key=socket.data.ownerKey;
        if(key){ rooms[code].profiles[key] = { ...(rooms[code].profiles[key]||{}), name:socket.data.playerName, color:data.color, updatedAt:Date.now() }; schedulePersistRoom(code); }
        io.to(code).emit('border-changed', { id:socket.id, color:data.color });
    });
    socket.on('change-char-image', (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code)) return;
        rooms[code].players[socket.id].charImage = data.url;
        const key=socket.data.ownerKey;
        if(key){ rooms[code].profiles[key] = { ...(rooms[code].profiles[key]||{}), name:socket.data.playerName, charImage:data.url, updatedAt:Date.now() }; schedulePersistRoom(code); }
        io.to(code).emit('char-image-changed', { id:socket.id, url:data.url });
    });
    socket.on('media-state', (data) => {
        const code = socket.data.roomCode; if (!code || !rooms[code]?.players[socket.id]) return;
        const player = rooms[code].players[socket.id];
        if (typeof data.cameraOn === 'boolean') player.cameraOn = data.cameraOn;
        if (typeof data.micOn === 'boolean') player.micOn = data.micOn;
        if (typeof data.screenSharing === 'boolean') player.screenSharing = data.screenSharing;
        socket.to(code).emit('media-state', { id:socket.id, cameraOn:player.cameraOn, micOn:player.micOn, screenSharing:player.screenSharing });
    });

    // WebRTC signaling fica somente entre membros da mesma sala.
    function relayRtc(event, data) {
        const code = socket.data.roomCode;
        const target = io.sockets.sockets.get(data.target);
        if (!code || !target || target.data.roomCode !== code) return;
        target.emit(event, { from: socket.id, ...data.payload });
    }
    socket.on('webrtc-offer', data => relayRtc('webrtc-offer', { target:data.target, payload:{ offer:data.offer } }));
    socket.on('webrtc-answer', data => relayRtc('webrtc-answer', { target:data.target, payload:{ answer:data.answer } }));
    socket.on('webrtc-ice', data => relayRtc('webrtc-ice', { target:data.target, payload:{ candidate:data.candidate } }));

    socket.on('disconnect', () => {
        const code = socket.data.roomCode;
        if (code && rooms[code]?.players[socket.id]) {
            delete rooms[code].players[socket.id];
            io.to(code).emit('user-left', socket.id);
        }
        console.log('❌ Saiu:', socket.id);
        // A sala NÃO é apagada quando fica vazia: configuração, fichas, tokens,
        // cenário e música devem existir quando os jogadores voltarem.
    });
});

async function flushAllRooms() {
    for (const code of Object.keys(rooms)) {
        try { await persistRoom(code); } catch (_) {}
    }
    if (storageMode === 'json') {
        // Dá tempo para o debounce gravar a última versão antes do encerramento.
        await new Promise(resolve => setTimeout(resolve, 180));
    }
}

let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`🛑 ${signal}: salvando salas...`);
    try { await flushAllRooms(); } catch (err) { console.error('Falha ao salvar no encerramento:', err); }
    try { if (pgPool) await pgPool.end(); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3500).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = process.env.PORT || 3000;
(async () => {
    try { await initStorage(); }
    catch (err) {
        console.error('Falha ao iniciar persistência; usando JSON local:', err);
        pgPool = null; storageMode = 'json'; disablePostgres = true;
        await initStorage();
    }
    server.listen(PORT, () => {
        console.log(`🚀 Servidor RPG Mesa na porta ${PORT}`);
        console.log(`📁 Diretório público: ${PUBLIC_DIR}`);
        console.log(`🏠 index.html: ${fs.existsSync(INDEX_FILE) ? 'OK' : 'AUSENTE'}`);
        console.log(`🎲 mesa.html: ${fs.existsSync(TABLE_FILE) ? 'OK' : 'AUSENTE'}`);
    });
})();
