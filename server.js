const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let Pool = null;
try { ({ Pool } = require('pg')); } catch (_) {}
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) {}
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

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
    next();
});

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
const v6ApprovalRequests = new Map();
const V6_APPROVAL_EMAIL = process.env.V6_APPROVAL_EMAIL || 'v.f.lune@gmail.com';
const V6_APPROVAL_TTL_MS = 30 * 60 * 1000;


function cleanCode(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '-').slice(0, 80);
}
function cleanName(value) {
    return String(value || 'Anônimo').trim().slice(0, 80) || 'Anônimo';
}
function cleanLabel(value, max=100) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}
function keyForLabel(value) {
    return cleanLabel(value, 120).toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function secretMatches(given, expected) {
    if (!expected) return false;
    const a = crypto.createHash('sha256').update(String(given || '')).digest();
    const b = crypto.createHash('sha256').update(String(expected)).digest();
    return a.length === b.length && crypto.timingSafeEqual(a, b);
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
    room.system = ['vampiro', 'vampirov6', 'lobisomem', 'dnd', 'changeling'].includes(room.system) ? room.system : 'lobisomem';
    room.campaignName = room.campaignName || 'Campanha ' + code;
    room.campaignKey = room.campaignKey || keyForLabel(room.campaignName);
    room.roomName = room.roomName || code;
    room.roomNameKey = room.roomNameKey || keyForLabel(room.roomName);
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

async function roomNameConflict(campaignKey, roomNameKey, exceptCode='') {
    for (const [code, room] of Object.entries(rooms)) {
        if (code !== exceptCode && room.campaignKey === campaignKey && room.roomNameKey === roomNameKey) return code;
    }
    if (storageMode === 'postgres' && pgPool) {
        const q = await pgPool.query(
            `SELECT room_code FROM rpg_rooms
             WHERE room_code <> $1
               AND COALESCE(room_data->>'campaignKey','') = $2
               AND COALESCE(room_data->>'roomNameKey','') = $3
             LIMIT 1`,
            [exceptCode, campaignKey, roomNameKey]
        );
        return q.rows[0]?.room_code || null;
    }
    return null;
}


async function loadRoomByCampaignKey(campaignKey) {
    if (!campaignKey) return null;
    for (const room of Object.values(rooms)) if (room?.campaignKey === campaignKey) return room;
    if (storageMode === 'postgres' && pgPool) {
        const result = await pgPool.query(
            `SELECT room_code, room_data FROM rpg_rooms
             WHERE COALESCE(room_data->>'campaignKey','') = $1
             ORDER BY updated_at DESC LIMIT 1`, [campaignKey]
        );
        if (result.rows[0]) {
            const code = result.rows[0].room_code;
            rooms[code] = normalizeRoom({ ...result.rows[0].room_data, players:{} }, code);
            return rooms[code];
        }
    }
    return null;
}
async function loadRoomByV6ApprovalId(approvalId) {
    if (!approvalId) return null;
    for (const room of Object.values(rooms)) if (room?.v6ApprovalId === approvalId) return room;
    if (storageMode === 'postgres' && pgPool) {
        const result = await pgPool.query(
            `SELECT room_code, room_data FROM rpg_rooms
             WHERE COALESCE(room_data->>'v6ApprovalId','') = $1
             ORDER BY updated_at DESC LIMIT 1`, [approvalId]
        );
        if (result.rows[0]) {
            const code = result.rows[0].room_code;
            rooms[code] = normalizeRoom({ ...result.rows[0].room_data, players:{} }, code);
            return rooms[code];
        }
    }
    return null;
}
function approvalRequestFromRoom(room) {
    if (!room?.v6ApprovalId || !room?.v6ApprovalToken) return null;
    return {
        id:room.v6ApprovalId, token:room.v6ApprovalToken, campaignName:room.campaignName,
        campaignKey:room.campaignKey, requestedBy:room.v6RequestedBy || 'Narrador',
        baseUrl:room.v6ApprovalBaseUrl || '', status:room.v6ApprovalStatus || 'pending',
        createdAt:room.v6ApprovalCreatedAt || room.createdAt || Date.now(),
        expiresAt:room.v6ApprovalExpiresAt || (Date.now()+V6_APPROVAL_TTL_MS),
        emailed:Boolean(room.v6ApprovalEmailed), emailMethod:room.v6ApprovalEmailMethod || '',
        emailError:room.v6ApprovalEmailError || ''
    };
}
function internalCodeForCampaign(campaignKey) {
    const digest = crypto.createHash('sha256').update(String(campaignKey)).digest('hex').slice(0, 16).toUpperCase();
    return 'CAMP-' + digest;
}
function baseUrlFromSocket(socket) {
    if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
    const headers = socket.handshake?.headers || {};
    const proto = String(headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : '';
}
function cleanupV6Approvals() {
    const now = Date.now();
    for (const [id, req] of v6ApprovalRequests.entries()) if (!req || req.expiresAt <= now || req.status === 'used') v6ApprovalRequests.delete(id);
}
function findPendingV6Approval(campaignKey) {
    cleanupV6Approvals();
    for (const req of v6ApprovalRequests.values()) if (req.campaignKey === campaignKey && ['pending','approved'].includes(req.status)) return req;
    return null;
}
function buildV6ApprovalLinks(req, socket) {
    const base = req.baseUrl || baseUrlFromSocket(socket || {});
    if (!base) throw new Error('PUBLIC_BASE_URL não configurada e host indisponível');
    return {
        base,
        approveUrl: `${base}/v6/approve?id=${encodeURIComponent(req.id)}&token=${encodeURIComponent(req.token)}`,
        rejectUrl: `${base}/v6/reject?id=${encodeURIComponent(req.id)}&token=${encodeURIComponent(req.token)}`
    };
}
function postJsonHttps(urlString, data, extraHeaders={}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlString);
        const body = Buffer.from(JSON.stringify(data));
        const request = https.request({
            protocol:u.protocol, hostname:u.hostname, port:u.port || 443,
            path:u.pathname + u.search, method:'POST',
            headers:{
                'Content-Type':'application/json', 'Accept':'application/json',
                'Content-Length':body.length,
                'User-Agent':'Mesa-RPG-Online/1.9.2',
                ...extraHeaders
            },
            timeout:12000
        }, res => {
            let raw='';
            res.setEncoding('utf8');
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                let parsed=null; try{ parsed=JSON.parse(raw); }catch(_){}
                if(res.statusCode>=200 && res.statusCode<300 && (!parsed || parsed.success !== 'false')) resolve(parsed || {success:true});
                else reject(new Error((parsed && parsed.message) || `serviço de e-mail respondeu HTTP ${res.statusCode}`));
            });
        });
        request.on('timeout',()=>request.destroy(new Error('tempo limite ao enviar e-mail')));
        request.on('error',reject);
        request.end(body);
    });
}
async function sendV6ApprovalViaFormSubmit(req, socket) {
    const {base, approveUrl, rejectUrl} = buildV6ApprovalLinks(req, socket);
    const endpoint = `https://formsubmit.co/ajax/${encodeURIComponent(V6_APPROVAL_EMAIL)}`;
    const payload = {
        _subject:`Autorizar campanha Vampiro V6: ${req.campaignName}`,
        Campanha:req.campaignName,
        Narrador:req.requestedBy,
        Autorizar:approveUrl,
        Recusar:rejectUrl,
        Mensagem:'Pedido de criação de campanha Vampiro V6. O pedido expira em 30 minutos.'
    };
    try {
        await postJsonHttps(endpoint, payload, { Origin:base, Referer:base+'/' });
        return 'formsubmit';
    } catch (err) {
        const msg=String(err?.message||err||'');
        if (/needs Activation|Activate Form|form.*activation/i.test(msg)) return 'formsubmit-activation';
        throw err;
    }
}
async function sendV6ApprovalEmail(req, socket) {
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';
    const {approveUrl, rejectUrl} = buildV6ApprovalLinks(req, socket);

    // Se SMTP estiver configurado, ele continua sendo a primeira opção.
    if (nodemailer && user && pass) {
        const host = process.env.SMTP_HOST || 'smtp.gmail.com';
        const port = Number(process.env.SMTP_PORT || 465);
        const secure = String(process.env.SMTP_SECURE || (port === 465 ? 'true' : 'false')).toLowerCase() !== 'false';
        const transport = nodemailer.createTransport({ host, port, secure, auth:{ user, pass } });
        await transport.sendMail({
            from: process.env.V6_APPROVAL_FROM || user,
            to: V6_APPROVAL_EMAIL,
            subject: `Autorizar campanha Vampiro V6: ${req.campaignName}`,
            text: `Pedido de criação da campanha Vampiro V6\n\nCampanha: ${req.campaignName}\nNarrador: ${req.requestedBy}\n\nAUTORIZAR: ${approveUrl}\nRECUSAR: ${rejectUrl}\n\nO pedido expira em 30 minutos.`,
            html: `<div style="font-family:Arial,sans-serif;max-width:620px"><h2>Autorizar campanha Vampiro V6</h2><p><b>Campanha:</b> ${escapeHtmlServer(req.campaignName)}</p><p><b>Narrador:</b> ${escapeHtmlServer(req.requestedBy)}</p><p><a href="${approveUrl}" style="display:inline-block;padding:12px 18px;background:#8b1734;color:white;text-decoration:none;border-radius:8px">Autorizar campanha</a> &nbsp; <a href="${rejectUrl}" style="display:inline-block;padding:12px 18px;background:#444;color:white;text-decoration:none;border-radius:8px">Recusar</a></p><p>O pedido expira em 30 minutos.</p></div>`
        });
        return 'smtp';
    }

    // Fallback sem SMTP: FormSubmit encaminha o pedido ao e-mail da administradora.
    // No primeiro uso desse endereço o próprio FormSubmit pode enviar uma confirmação
    // de ativação; depois de confirmada, os pedidos seguintes chegam normalmente.
    return await sendV6ApprovalViaFormSubmit(req, socket);
}
function escapeHtmlServer(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
async function createOrReuseV6Approval({ campaignName, campaignKey, requestedBy, socket }) {
    let req = findPendingV6Approval(campaignKey);
    if (req) return req;
    req = {
        id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(18).toString('hex'),
        token: crypto.randomBytes(32).toString('hex'),
        campaignName, campaignKey, requestedBy, baseUrl:baseUrlFromSocket(socket),
        status:'pending', createdAt:Date.now(), expiresAt:Date.now()+V6_APPROVAL_TTL_MS,
        emailed:false, emailMethod:'', emailError:''
    };
    v6ApprovalRequests.set(req.id, req);
    try { req.emailMethod = await sendV6ApprovalEmail(req, socket); req.emailed = true; }
    catch (err) { req.emailError = err.message || String(err); console.error('V6 approval email:', err); }
    return req;
}
function approvalResponsePage(title, body, ok=true) {
    return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtmlServer(title)}</title><body style="margin:0;background:#0a0a12;color:#eee;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh"><main style="max-width:560px;padding:28px;background:#151521;border-radius:16px;border:1px solid #333"><h1 style="color:${ok?'#00d9a5':'#ff5577'}">${escapeHtmlServer(title)}</h1><p style="line-height:1.6">${escapeHtmlServer(body)}</p></main></body></html>`;
}
app.get('/v6/approve', async (req, res) => {
    cleanupV6Approvals();
    const id=String(req.query.id||''), token=String(req.query.token||'');
    const item=v6ApprovalRequests.get(id) || null;
    const room=await loadRoomByV6ApprovalId(id);
    const expectedToken=item?.token || room?.v6ApprovalToken || '';
    if((!item && !room) || !secretMatches(token,expectedToken)) return res.status(404).send(approvalResponsePage('Pedido inválido','Este pedido não existe ou já expirou.',false));
    if(item){ item.status='approved'; item.approvedAt=Date.now(); }
    if(room){
        room.v6ApprovalStatus='approved';
        room.v6ApprovedAt=Date.now();
        room.v6ApprovalEmailError='';
        await persistRoom(room.code);
    }
    const campaignName=room?.campaignName || item?.campaignName || 'Vampiro V6';
    res.send(approvalResponsePage('Campanha autorizada',`A campanha “${campaignName}” foi autorizada e já está pronta. Se o narrador estiver aguardando, entrará automaticamente; se tiver saído, basta entrar novamente com o mesmo nome da campanha e senha.`));
});
app.get('/v6/reject', async (req, res) => {
    cleanupV6Approvals();
    const id=String(req.query.id||''), token=String(req.query.token||'');
    const item=v6ApprovalRequests.get(id) || null;
    const room=await loadRoomByV6ApprovalId(id);
    const expectedToken=item?.token || room?.v6ApprovalToken || '';
    if((!item && !room) || !secretMatches(token,expectedToken)) return res.status(404).send(approvalResponsePage('Pedido inválido','Este pedido não existe ou já expirou.',false));
    if(item){ item.status='rejected'; item.rejectedAt=Date.now(); }
    if(room){ room.v6ApprovalStatus='rejected'; room.v6RejectedAt=Date.now(); await persistRoom(room.code); }
    const campaignName=room?.campaignName || item?.campaignName || 'Vampiro V6';
    res.send(approvalResponsePage('Campanha recusada',`A criação da campanha “${campaignName}” foi recusada.`,false));
});
app.get('/api/v6-approval-status', async (req,res) => {
    cleanupV6Approvals();
    const id=String(req.query.id||'');
    const item=v6ApprovalRequests.get(id) || null;
    const room=await loadRoomByV6ApprovalId(id);
    if(!item && !room) return res.status(404).json({status:'expired'});
    res.json({
        status:room?.v6ApprovalStatus || item?.status || 'pending',
        emailed:room ? Boolean(room.v6ApprovalEmailed) : Boolean(item?.emailed),
        emailMethod:room?.v6ApprovalEmailMethod || item?.emailMethod || '',
        emailError:room?.v6ApprovalEmailError || item?.emailError || '',
        expiresAt:room?.v6ApprovalExpiresAt || item?.expiresAt || null
    });
});
app.post('/api/v6-resend-approval', async (req,res) => {
    cleanupV6Approvals();
    const id=String(req.body?.id||'');
    let item=v6ApprovalRequests.get(id) || null;
    const room=await loadRoomByV6ApprovalId(id);
    if(!item && room){ item=approvalRequestFromRoom(room); if(item) v6ApprovalRequests.set(item.id,item); }
    const status=room?.v6ApprovalStatus || item?.status;
    if(!item || status!=='pending') return res.status(404).json({ok:false,message:'Pedido não encontrado ou não está pendente.'});
    try {
        item.emailMethod=await sendV6ApprovalEmail(item,null); item.emailed=true; item.emailError='';
        if(room){ room.v6ApprovalEmailed=true; room.v6ApprovalEmailMethod=item.emailMethod; room.v6ApprovalEmailError=''; await persistRoom(room.code); }
        return res.json({ok:true,emailMethod:item.emailMethod,email:V6_APPROVAL_EMAIL});
    } catch(err) {
        const msg=err.message||String(err); item.emailed=false; item.emailError=msg;
        if(room){ room.v6ApprovalEmailed=false; room.v6ApprovalEmailError=msg; await persistRoom(room.code); }
        return res.status(502).json({ok:false,message:msg});
    }
});

app.get('/health', (req, res) => {
    res.status(200).json({
        ok: true,
        index: fs.existsSync(INDEX_FILE),
        mesa: fs.existsSync(TABLE_FILE),
        storage: storageMode,
        turnConfigured: Boolean(process.env.TURN_URL),
        v6ApprovalEmail: V6_APPROVAL_EMAIL,
        v6EmailConfigured: Boolean(process.env.SMTP_USER && process.env.SMTP_PASS),
        v6EmailFallback: 'formsubmit'
    });
});

function isRoomMember(socket, roomCode) {
    return socket.data.roomCode === roomCode && rooms[roomCode] && rooms[roomCode].players[socket.id];
}
function roomOwnerEndpoints(room, ownerKey) {
    return Object.values(room?.players || {}).filter(p => p.ownerKey === ownerKey);
}
function logicalPlayerCount(room) {
    return new Set(Object.values(room?.players || {}).map(p => p.ownerKey || p.id)).size;
}
function updateOwnerEndpoints(room, ownerKey, patch) {
    for (const player of Object.values(room?.players || {})) {
        if (player.ownerKey === ownerKey) Object.assign(player, patch);
    }
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
            const role = data.role === 'narrador' ? 'narrador' : 'jogador';
            const name = cleanName(data.name);
            const suppliedPassword = String(data.password || '').trim();
            const campaignName = cleanLabel(data.campaignName || data.roomName || data.room, 100);
            const campaignKey = keyForLabel(campaignName);
            if (!campaignName || !campaignKey) return socket.emit('room-error', 'Informe o nome da campanha.');
            if (!suppliedPassword) return socket.emit('room-error', 'A senha da campanha é obrigatória.');

            // O usuário não precisa conhecer código. O servidor localiza a sala pelo
            // nome normalizado da campanha e mantém um código interno apenas para Socket.IO/DB.
            let room = await loadRoomByCampaignKey(campaignKey);
            let code = room?.code || internalCodeForCampaign(campaignKey);
            if (!room) {
                if (role !== 'narrador') return socket.emit('room-error', 'Campanha não existe. Confirme o nome exato com o Narrador.');
                const requestedSystem = ['vampiro', 'vampirov6', 'lobisomem', 'dnd', 'changeling'].includes(data.system) ? data.system : 'lobisomem';

                if (requestedSystem === 'vampirov6') {
                    const approval=await createOrReuseV6Approval({campaignName,campaignKey,requestedBy:name,socket});
                    const passwordFields=passwordRecord(suppliedPassword);
                    room=normalizeRoom({
                        ...passwordFields, campaignName,campaignKey,roomName:campaignName,roomNameKey:campaignKey,
                        system:'vampirov6',v6Alpha:true,
                        v6ApprovalStatus:'pending',v6ApprovalId:approval.id,v6ApprovalToken:approval.token,
                        v6ApprovalCreatedAt:approval.createdAt,v6ApprovalExpiresAt:approval.expiresAt,
                        v6ApprovalBaseUrl:approval.baseUrl,v6RequestedBy:name,
                        v6ApprovalEmailed:Boolean(approval.emailed),v6ApprovalEmailMethod:approval.emailMethod||'',
                        v6ApprovalEmailError:approval.emailError||'',
                        currentImage:null,tokens:[],sharedMusic:[],sheets:{},rollHistory:[],profiles:{},
                        musicState:{trackId:null,playing:false,position:0,startedAt:null,loop:true},
                        players:{},createdAt:Date.now(),updatedAt:Date.now()
                    },code);
                    rooms[code]=room; await persistRoom(code);
                    socket.emit('v6-authorization-pending',{
                        approvalId:approval.id,email:V6_APPROVAL_EMAIL,expiresAt:approval.expiresAt,
                        emailMethod:approval.emailMethod||(approval.emailError?'pending-with-warning':'email'),
                        emailWarning:approval.emailError||''
                    });
                    return;
                }
                const passwordFields = passwordRecord(suppliedPassword);
                room = normalizeRoom({
                    ...passwordFields,
                    campaignName, campaignKey, roomName:campaignName, roomNameKey:campaignKey,
                    system: requestedSystem, v6Alpha:false, currentImage: null,
                    tokens: [], sharedMusic: [], sheets: {}, rollHistory: [], profiles: {},
                    musicState: { trackId: null, playing: false, position: 0, startedAt: null, loop: true },
                    players: {}, createdAt: Date.now(), updatedAt: Date.now()
                }, code);
                rooms[code] = room;
                await persistRoom(code);
            }
            if (!passwordMatches(room, suppliedPassword)) return socket.emit('room-error', 'Senha incorreta!');
            if (room.password !== undefined) {
                Object.assign(room, passwordRecord(data.password || ''));
                delete room.password;
                await persistRoom(code);
            }

            if (room.system === 'vampirov6') {
                // Salas V6 antigas, criadas antes do fluxo de aprovação persistente,
                // são consideradas válidas para não pedir autorização novamente.
                const approvalStatus=room.v6ApprovalStatus || 'approved';
                if(approvalStatus==='pending'){
                    if(role!=='narrador') return socket.emit('room-error','Esta campanha Vampiro V6 ainda aguarda autorização.');
                    let approval=v6ApprovalRequests.get(room.v6ApprovalId)||approvalRequestFromRoom(room);
                    if(approval&&!v6ApprovalRequests.has(approval.id)) v6ApprovalRequests.set(approval.id,approval);
                    socket.emit('v6-authorization-pending',{
                        approvalId:room.v6ApprovalId,email:V6_APPROVAL_EMAIL,expiresAt:room.v6ApprovalExpiresAt,
                        emailMethod:room.v6ApprovalEmailMethod||(room.v6ApprovalEmailError?'pending-with-warning':'email'),
                        emailWarning:room.v6ApprovalEmailError||''
                    });
                    return;
                }
                if(approvalStatus==='rejected') return socket.emit('room-error','A criação desta campanha Vampiro V6 foi recusada.');
            }

            // A identidade lógica do jogador é o Nome de Jogador dentro da sala.
            // Dois aparelhos com o mesmo nome/senha usam a mesma ficha/perfil e contam
            // como UM jogador, embora cada aparelho mantenha seu socket WebRTC próprio.
            const ownerKey = ownerKeyFor(name);
            const alreadyOnline = roomOwnerEndpoints(room, ownerKey);
            if (!alreadyOnline.length && logicalPlayerCount(room) >= 8) {
                return socket.emit('room-error', 'Sala cheia (8 jogadores). Um segundo aparelho do mesmo jogador pode entrar normalmente.');
            }
            const savedProfile = room.profiles[ownerKey] || {};
            const effectiveRole = alreadyOnline[0]?.role || savedProfile.role || role;
            const profile = {
                name,
                role: effectiveRole,
                color: savedProfile.color || data.color || '#e94560',
                charImage: savedProfile.charImage || data.charImage || '',
                updatedAt: Date.now()
            };
            room.profiles[ownerKey] = profile;

            socket.join(code);
            socket.data.roomCode = code;
            socket.data.ownerKey = ownerKey;
            socket.data.playerName = name;
            socket.data.playerRole = effectiveRole;
            room.players[socket.id] = {
                id: socket.id, ownerKey, name, role: effectiveRole, system: room.system,
                color: profile.color, charImage: profile.charImage,
                cameraOn: Boolean(data.cameraOn), micOn: Boolean(data.micOn), screenSharing: false,
                deviceIndex: alreadyOnline.length + 1, joinedAt: Date.now()
            };
            schedulePersistRoom(code, 300);

            socket.emit('room-joined', {
                room: code,
                roomName: room.roomName,
                campaignName: room.campaignName,
                system: room.system,
                ownerKey,
                players: room.players,
                logicalPlayerCount: logicalPlayerCount(room),
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
            socket.to(code).emit('user-joined', { ...room.players[socket.id], samePlayer: alreadyOnline.length > 0 });
            console.log(`👤 ${name} (${effectiveRole}) entrou em ${code}${alreadyOnline.length ? ' em outro aparelho' : ''}`);
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
        const isV6 = room.system === 'vampirov6';
        const diceType = (isV5 || isV6) ? 10 : Math.max(2, Math.min(100, parseInt(rawMode, 10) || 20));
        const totalPool = Math.max(1, Math.min(10, parseInt(data.totalPool, 10) || 1));
        const hungerCount = isV5 ? Math.max(0, Math.min(totalPool, 5, parseInt(data.hungerCount, 10) || 0)) : 0;
        const mode = isV6 ? 'v6' : (isV5 ? 'v5' : (diceType === 20 ? 'd20' : (diceType === 100 ? 'd100' : 'normal')));
        const difficulty = (mode === 'd20' || mode === 'v6') ? null : Math.max(1, Math.min(diceType, parseInt(data.difficulty, 10) || (isV5 ? 6 : 1)));
        const minSuccess = (mode === 'd20' || mode === 'v6') ? null : Math.max(0, parseInt(data.minSuccess, 10) || 0);
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
        const key=socket.data.ownerKey;
        if(!key) return;
        updateOwnerEndpoints(rooms[code], key, { color:data.color });
        rooms[code].profiles[key] = { ...(rooms[code].profiles[key]||{}), name:socket.data.playerName, role:socket.data.playerRole, color:data.color, updatedAt:Date.now() };
        schedulePersistRoom(code);
        io.to(code).emit('border-changed', { ownerKey:key, color:data.color });
    });
    socket.on('change-char-image', (data) => {
        const code = cleanCode(data.room); if (!isRoomMember(socket, code)) return;
        const key=socket.data.ownerKey;
        if(!key) return;
        updateOwnerEndpoints(rooms[code], key, { charImage:data.url });
        rooms[code].profiles[key] = { ...(rooms[code].profiles[key]||{}), name:socket.data.playerName, role:socket.data.playerRole, charImage:data.url, updatedAt:Date.now() };
        schedulePersistRoom(code);
        io.to(code).emit('char-image-changed', { ownerKey:key, url:data.url });
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
    socket.on('webrtc-reconnect-request', data => relayRtc('webrtc-reconnect-request', { target:data.target, payload:{} }));

    socket.on('disconnect', () => {
        const code = socket.data.roomCode;
        if (code && rooms[code]?.players[socket.id]) {
            const leaving = rooms[code].players[socket.id];
            delete rooms[code].players[socket.id];
            const ownerStillOnline = roomOwnerEndpoints(rooms[code], leaving.ownerKey).length > 0;
            io.to(code).emit('user-left', { id:socket.id, ownerKey:leaving.ownerKey, name:leaving.name, ownerStillOnline });
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
