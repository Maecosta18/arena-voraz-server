/**
 * Arena Voraz — servidor de multijugador.
 *
 * Cero dependencias externas a propósito: implementa el protocolo WebSocket
 * (RFC 6455) a mano sobre el módulo http/net de Node, así el deploy en
 * Render/Railway/lo que sea es un simple "node server.js" sin depender de
 * que el registro de npm esté disponible o de versiones de paquetes.
 *
 * También sirve los archivos estáticos de ./public (el juego en sí).
 *
 * El servidor es la autoridad de la partida: guarda posición/vida/kills de
 * cada jugador y decide los impactos (raycast contra la posición que el
 * servidor ya conoce de cada jugador), así nadie puede hackear su cliente
 * para inflar kills.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ============================================================ */
/* ---------------------- static file server ------------------- */
/* ============================================================ */
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json' };

function serveStatic(req, res){
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!filePath.startsWith(PUBLIC_DIR)){ res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err){ res.writeHead(404, {'Content-Type':'text/plain'}); res.end('404 not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

/* ============================================================ */
/* -------------------- minimal websocket frames ----------------- */
/* ============================================================ */
function encodeFrame(str){
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126){
    header = Buffer.alloc(2);
    header[0] = 0x81; header[1] = len;
  } else if (len < 65536){
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
function encodeClose(){ const h = Buffer.alloc(2); h[0]=0x88; h[1]=0; return h; }
function encodePong(payload){
  payload = payload || Buffer.alloc(0);
  const h = Buffer.alloc(2); h[0]=0x8A; h[1]=payload.length;
  return Buffer.concat([h, payload]);
}

// Try to pull ONE frame out of the front of `buf`. Returns null if there
// isn't a complete frame yet (wait for more data). Assumes each message
// fits in a single (unfragmented) frame, which is how every browser and
// Node's own WebSocket client sends small JSON text messages.
function tryParseFrame(buf){
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126){
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127){
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); offset = 10;
  }
  let maskKey = null;
  if (masked){
    if (buf.length < offset+4) return null;
    maskKey = buf.slice(offset, offset+4); offset += 4;
  }
  if (buf.length < offset+len) return null;
  let payload = buf.slice(offset, offset+len);
  if (masked){
    const out = Buffer.alloc(len);
    for (let i=0;i<len;i++) out[i] = payload[i] ^ maskKey[i%4];
    payload = out;
  }
  return { opcode, payload, bytesConsumed: offset+len };
}

/* ============================================================ */
/* ----------------------- game config ------------------------ */
/* ============================================================ */
const ARENA_R = 34;
const GRAVITY = -15.5;
const SPAWN_COUNT = 8;
const SPAWN_POINTS = [];
for (let s=0; s<SPAWN_COUNT; s++){
  const a = (s/SPAWN_COUNT)*Math.PI*2;
  SPAWN_POINTS.push({ x: Math.cos(a)*(ARENA_R*0.55), z: Math.sin(a)*(ARENA_R*0.55) });
}
const WEAPONS = {
  blaster: { kind:'hitscan', range:46, dmg:22, cooldown:250 },
  honda:   { kind:'projectile', range:40, dmg:34, splash:16, splashR:3.2, speed:22, cooldown:650 }
};
const MAX_NAME_LEN = 14;
const MAX_PLAYERS = 24;
const MAX_BOTS = 8;
const BOT_NAMES = ['Rocko','Bicho','Fierro','Tormenta','Cactus','Nube','Chispa','Torbellino','Garra','Piedra','Rayo','Sombra','Zorro','Puma'];
const BOT_SKINS = ['#f2c9a1','#d9a066','#a9673f','#7a4a2b','#3a2a1d','#f0dcc4'];
const BOT_SHIRTS = ['#37e6c4','#ff5c5c','#ffb454','#7ea8ff','#c98bf0','#6bd68a'];
const BOT_PANTS = ['#22314f','#1c1c1c','#6b5b3e','#2f4a33','#4a4a4a','#5a3825'];
const BOT_HATS = ['none','cap','band','party'];

function pickSpawn(){ return SPAWN_POINTS[(Math.random()*SPAWN_POINTS.length)|0]; }
function pick(arr){ return arr[(Math.random()*arr.length)|0]; }
function clampNum(n, fallback){ n = Number(n); return Number.isFinite(n) ? n : (fallback||0); }
function safeStr(s, max){ return String(s==null?'':s).slice(0, max||64); }
function normalize3(v){
  const len = Math.hypot(v.x||0, v.y||0, v.z||0) || 1;
  return { x:(v.x||0)/len, y:(v.y||0)/len, z:(v.z||0)/len };
}
function dist3(a,b){ return Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z); }
function genId(){ return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g,''); }

// closest intersection of a ray (origin,dir) with a sphere (center,radius),
// within `maxDist`. Returns {dist, point} or null.
function raySphereHit(origin, dir, center, radius, maxDist){
  const ocx = origin.x-center.x, ocy = origin.y-center.y, ocz = origin.z-center.z;
  const b = ocx*dir.x + ocy*dir.y + ocz*dir.z;
  const c = ocx*ocx+ocy*ocy+ocz*ocz - radius*radius;
  const disc = b*b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  const tHit = t >= 0 ? t : (-b + Math.sqrt(disc));
  if (tHit < 0 || tHit > maxDist) return null;
  return { dist: tHit, point: { x: origin.x+dir.x*tHit, y: origin.y+dir.y*tHit, z: origin.z+dir.z*tHit } };
}

/* ============================================================ */
/* ---------------------------- state ---------------------------- */
/* ============================================================ */
const players = new Map(); // id -> { socket, buf, name, skin, shirt, pants, hat, glasses, weapon, x,y,z, yaw, hp, kills, alive, lastFireAt }
const projectiles = [];    // { ownerId, x,y,z, vx,vy,vz, dmg, splash, splashR, life }
const scoreboard = new Map(); // id -> { name, kills } — lifetime totals for this server run

function send(id, obj){
  const p = players.get(id);
  if (!p || p.socket.destroyed) return;
  try{ p.socket.write(encodeFrame(JSON.stringify(obj))); }catch(e){}
}
function broadcast(obj, exceptId){
  const msg = encodeFrame(JSON.stringify(obj));
  for (const [id, p] of players){
    if (id === exceptId) continue;
    if (p.socket.destroyed) continue;
    try{ p.socket.write(msg); }catch(e){}
  }
}
function publicView(id){
  const p = players.get(id);
  if (!p || !p.joined) return null;
  return { id, name:p.name, skin:p.skin, shirt:p.shirt, pants:p.pants, hat:p.hat, glasses:p.glasses,
    weapon:p.weapon, x:p.x, z:p.z, yaw:p.yaw, hp:p.hp, kills:p.kills, alive:p.alive, isBot: !!p.isBot };
}
function snapshot(){
  const out = [];
  for (const id of players.keys()){ const v = publicView(id); if (v) out.push(v); }
  return out;
}
function leaderboardTop(n){
  return Array.from(scoreboard.entries())
    .map(([id, s]) => ({ id, name:s.name, kills:s.kills }))
    .sort((a,b) => b.kills - a.kills)
    .slice(0, n||10);
}

function applyDamage(targetId, dmg, byId, byName){
  const t = players.get(targetId);
  if (!t || !t.alive) return;
  if (t.invulnerableUntil && Date.now() < t.invulnerableUntil) return;
  t.hp = Math.max(0, t.hp - dmg);
  send(targetId, { t:'hit', dmg, by:byId, byName: byName||'???' });
  broadcast({ t:'hp', id:targetId, hp:t.hp }, null);
  if (t.hp <= 0){
    t.alive = false;
    broadcast({ t:'kill', by:byId, byName: byName||'???', victim:targetId, victimName:t.name }, null);
    if (byId && players.has(byId)){
      const shooter = players.get(byId);
      shooter.kills++;
      let sc = scoreboard.get(byId);
      if (!sc) sc = { name: shooter.name, kills:0 };
      sc.name = shooter.name; sc.kills = shooter.kills;
      scoreboard.set(byId, sc);
      broadcast({ t:'kills', id:byId, kills: shooter.kills }, null);
    }
    setTimeout(() => respawn(targetId), 1100);
  }
}
function respawn(id){
  const p = players.get(id);
  if (!p) return;
  const sp = pickSpawn();
  p.x = sp.x; p.z = sp.z; p.hp = 100; p.alive = true;
  p.invulnerableUntil = Date.now() + 1300;
  broadcast({ t:'respawn', id, x:sp.x, z:sp.z }, null);
}

function handleJoin(id, p, msg){
  if (p.joined) return; // already joined, ignore a duplicate join
  const sp = pickSpawn();
  p.x = sp.x; p.z = sp.z; p.hp = 100; p.kills = 0; p.alive = true; p.lastFireAt = 0;
  p.invulnerableUntil = Date.now() + 1000;
  p.name = safeStr(msg.name, MAX_NAME_LEN) || ('Guerrero'+((Math.random()*90)|0));
  p.skin = safeStr(msg.skin, 16) || '#d9a066';
  p.shirt = safeStr(msg.shirt, 16) || '#37e6c4';
  p.pants = safeStr(msg.pants, 16) || '#2a2a2a';
  p.hat = safeStr(msg.hat, 16) || 'none';
  p.glasses = !!msg.glasses;
  p.weapon = msg.weapon === 'honda' ? 'honda' : 'blaster';
  p.joined = true;
  let sc = scoreboard.get(id);
  if (!sc){ sc = { name:p.name, kills:0 }; scoreboard.set(id, sc); } else { sc.name = p.name; }
  send(id, { t:'welcome', id, x:p.x, z:p.z, arenaR: ARENA_R, players: snapshot(), leaderboard: leaderboardTop(8) });
  broadcast({ t:'join', player: publicView(id) }, id);
}
function handleMove(id, p, msg){
  if (!p.joined || !p.alive) return;
  p.x = clampNum(msg.x, p.x); p.z = clampNum(msg.z, p.z); p.yaw = clampNum(msg.yaw, p.yaw);
}
function handleWeapon(id, p, msg){
  if (!p.joined) return;
  p.weapon = msg.weapon === 'honda' ? 'honda' : 'blaster';
}
function fireWeapon(id, p, origin, dir){
  const w = WEAPONS[p.weapon] || WEAPONS.blaster;
  if (w.kind === 'hitscan'){
    let best = null;
    for (const [tid, t] of players){
      if (tid === id || !t.joined || !t.alive) continue;
      const hit = raySphereHit(origin, dir, { x:t.x, y:1.0, z:t.z }, 0.7, w.range);
      if (hit && (!best || hit.dist < best.dist)) best = { tid, dist:hit.dist, point:hit.point };
    }
    broadcast({ t:'shot', by:id, weapon:'blaster', from:origin, dir, hitPoint: best?best.point:null }, null);
    if (best) applyDamage(best.tid, w.dmg, id, p.name);
  } else {
    projectiles.push({ ownerId:id, x:origin.x, y:origin.y, z:origin.z,
      vx:dir.x*w.speed, vy:dir.y*w.speed, vz:dir.z*w.speed,
      dmg:w.dmg, splash:w.splash, splashR:w.splashR, life:3.2 });
    broadcast({ t:'shot', by:id, weapon:'honda', from:origin, dir }, null);
  }
}
function handleFire(id, p, msg){
  if (!p.joined || !p.alive) return;
  const w = WEAPONS[p.weapon] || WEAPONS.blaster;
  const now = Date.now();
  if (now - p.lastFireAt < w.cooldown - 40) return; // small slack for jitter, but rate-limited server-side
  p.lastFireAt = now;
  const origin = { x: clampNum(msg.ox,p.x), y: clampNum(msg.oy,1), z: clampNum(msg.oz,p.z) };
  const dir = normalize3({ x: clampNum(msg.dx,0), y: clampNum(msg.dy,0), z: clampNum(msg.dz,1) });
  fireWeapon(id, p, origin, dir);
}

/* ============================================================ */
/* ----------------------------- bots ----------------------------- */
/* ============================================================ */
function botCountNow(){
  let n = 0; for (const p of players.values()) if (p.isBot) n++;
  return n;
}
function spawnBot(){
  if (players.size >= MAX_PLAYERS || botCountNow() >= MAX_BOTS) return null;
  const id = 'bot_' + genId();
  const sp = pickSpawn();
  const p = {
    socket: { destroyed:true }, buf: Buffer.alloc(0), joined:true, isBot:true,
    name: pick(BOT_NAMES), skin: pick(BOT_SKINS), shirt: pick(BOT_SHIRTS), pants: pick(BOT_PANTS),
    hat: pick(BOT_HATS), glasses: Math.random()<0.3, weapon: Math.random()<0.5 ? 'honda' : 'blaster',
    x: sp.x, y:0, z: sp.z, yaw:0, hp:100, kills:0, alive:true, lastFireAt:0,
    invulnerableUntil: Date.now()+1000,
    aiSpeed: 3.5 + Math.random()*1.1, aiStrafeDir: Math.random()<0.5?1:-1,
    aiWanderX: sp.x, aiWanderZ: sp.z, aiNextWanderAt: 0
  };
  players.set(id, p);
  let sc = scoreboard.get(id);
  if (!sc){ sc = { name:p.name, kills:0 }; scoreboard.set(id, sc); }
  broadcast({ t:'join', player: publicView(id) }, null);
  return id;
}
function removeBot(){
  let targetId = null;
  for (const [id, p] of players){ if (p.isBot) targetId = id; } // last one added wins (Map preserves insertion order)
  if (!targetId) return false;
  players.delete(targetId);
  broadcast({ t:'leave', id: targetId }, null);
  return true;
}
function updateBots(dt){
  const now = Date.now();
  const alivePlayers = [];
  for (const [id, p] of players) if (p.joined && p.alive) alivePlayers.push({ id, p });

  for (const [id, p] of players){
    if (!p.isBot || !p.alive) continue;
    let target = null, bestD = Infinity;
    for (const o of alivePlayers){
      if (o.id === id) continue;
      const d = Math.hypot(o.p.x-p.x, o.p.z-p.z);
      if (d < bestD){ bestD = d; target = o; }
    }
    const w = WEAPONS[p.weapon] || WEAPONS.blaster;
    let moveX = 0, moveZ = 0;

    if (target && bestD < 28){
      const dx = target.p.x-p.x, dz = target.p.z-p.z;
      const d = Math.hypot(dx,dz) || 1;
      const dirX = dx/d, dirZ = dz/d;
      if (d > w.range*0.72){ moveX = dirX; moveZ = dirZ; }
      else if (d < w.range*0.4){ moveX = -dirX; moveZ = -dirZ; }
      else { moveX = -dirZ*p.aiStrafeDir; moveZ = dirX*p.aiStrafeDir; }

      if (d <= w.range && now - p.lastFireAt >= w.cooldown){
        p.lastFireAt = now;
        const aim = normalize3({ x: dirX, y: (Math.random()-0.5)*0.08, z: dirZ });
        fireWeapon(id, p, { x:p.x, y:1.5, z:p.z }, aim);
      }
    } else {
      if (now > p.aiNextWanderAt){
        const ang = Math.random()*Math.PI*2, rad = Math.random()*ARENA_R*0.7;
        p.aiWanderX = Math.cos(ang)*rad; p.aiWanderZ = Math.sin(ang)*rad;
        p.aiNextWanderAt = now + 3000 + Math.random()*3000;
      }
      const dx = p.aiWanderX-p.x, dz = p.aiWanderZ-p.z;
      const d = Math.hypot(dx,dz) || 1;
      moveX = dx/d; moveZ = dz/d;
    }

    if (moveX || moveZ){
      const mlen = Math.hypot(moveX,moveZ) || 1;
      p.x += (moveX/mlen)*p.aiSpeed*dt;
      p.z += (moveZ/mlen)*p.aiSpeed*dt;
      const distC = Math.hypot(p.x,p.z);
      if (distC > ARENA_R-1){ const k=(ARENA_R-1)/distC; p.x*=k; p.z*=k; }
      p.yaw = Math.atan2(moveX, moveZ);
    }
  }
}

function handleMessage(id, raw){
  const p = players.get(id);
  if (!p) return;
  let msg;
  try{ msg = JSON.parse(raw); }catch(e){ return; }
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t === 'join') handleJoin(id, p, msg);
  else if (msg.t === 'move') handleMove(id, p, msg);
  else if (msg.t === 'weapon') handleWeapon(id, p, msg);
  else if (msg.t === 'fire') handleFire(id, p, msg);
  else if (msg.t === 'addBot' && p.joined) spawnBot();
  else if (msg.t === 'removeBot' && p.joined) removeBot();
}

function dropPlayer(id){
  const p = players.get(id);
  if (!p) return;
  players.delete(id);
  if (p.joined) broadcast({ t:'leave', id }, null);
}

/* ============================================================ */
/* ------------------------- ws upgrade --------------------------- */
/* ============================================================ */
server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || players.size >= MAX_PLAYERS){ socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
    '\r\n'
  ].join('\r\n'));

  const id = genId();
  const p = { socket, buf: Buffer.alloc(0), joined:false, name:'???', skin:'#d9a066', shirt:'#37e6c4', pants:'#2a2a2a',
    hat:'none', glasses:false, weapon:'blaster', x:0, y:0, z:0, yaw:0, hp:100, kills:0, alive:false, lastFireAt:0 };
  players.set(id, p);

  if (head && head.length) p.buf = Buffer.concat([p.buf, head]);

  socket.on('data', (chunk) => {
    p.buf = Buffer.concat([p.buf, chunk]);
    while (true){
      let frame;
      try{ frame = tryParseFrame(p.buf); }catch(e){ socket.destroy(); return; }
      if (!frame) break;
      p.buf = p.buf.slice(frame.bytesConsumed);
      if (frame.opcode === 0x1){ // text
        handleMessage(id, frame.payload.toString('utf8'));
      } else if (frame.opcode === 0x8){ // close
        try{ socket.write(encodeClose()); }catch(e){}
        socket.end();
      } else if (frame.opcode === 0x9){ // ping
        try{ socket.write(encodePong(frame.payload)); }catch(e){}
      }
    }
  });
  socket.on('error', () => { dropPlayer(id); });
  socket.on('close', () => { dropPlayer(id); });
});

/* ============================================================ */
/* ---------------------------- tick loop -------------------------- */
/* ============================================================ */
setInterval(() => {
  const dt = 0.05;
  for (let i=projectiles.length-1; i>=0; i--){
    const pr = projectiles[i];
    pr.vy += GRAVITY*dt;
    pr.x += pr.vx*dt; pr.y += pr.vy*dt; pr.z += pr.vz*dt;
    pr.life -= dt;
    let spent = false;
    for (const [tid, t] of players){
      if (tid === pr.ownerId || !t.joined || !t.alive) continue;
      if (dist3({x:pr.x,y:pr.y,z:pr.z}, {x:t.x,y:1,z:t.z}) < 0.7){
        const shooterName = players.get(pr.ownerId) ? players.get(pr.ownerId).name : '???';
        applyDamage(tid, pr.dmg, pr.ownerId, shooterName);
        for (const [tid2, t2] of players){
          if (tid2 === tid || tid2 === pr.ownerId || !t2.joined || !t2.alive) continue;
          if (dist3({x:pr.x,y:pr.y,z:pr.z}, {x:t2.x,y:1,z:t2.z}) < pr.splashR) applyDamage(tid2, pr.splash, pr.ownerId, shooterName);
        }
        spent = true;
        break;
      }
    }
    if (spent || pr.y <= 0.1 || pr.life <= 0) projectiles.splice(i, 1);
  }
}, 50);

setInterval(() => {
  if (players.size === 0) return;
  let hasHuman = false;
  for (const p of players.values()) if (p.joined && !p.isBot){ hasHuman = true; break; }
  if (hasHuman) updateBots(0.1);
  broadcast({ t:'state', players: snapshot(), leaderboard: leaderboardTop(8) }, null);
}, 100);

server.listen(PORT, () => {
  console.log('Arena Voraz escuchando en el puerto ' + PORT);
});
