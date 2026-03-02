// Vercel Serverless: in-memory room store (per-instance, ephemeral)
// For a quiz game with short sessions, this is fine.
// Note: Vercel may route to different instances, so we use a global Map
// that persists for the life of the serverless function (warm start).

// We'll use Vercel KV or a simple global store
// Since Vercel serverless can cold-start on different instances,
// we need something shared. Let's use a simple JSON file approach
// via /tmp (shared within same execution environment)

var fs = require('fs');
var path = '/tmp/quiz-rooms.json';

function loadRooms() {
  try {
    var data = fs.readFileSync(path, 'utf8');
    var rooms = JSON.parse(data);
    // Clean old rooms (>1 hour)
    var now = Date.now();
    var keys = Object.keys(rooms);
    for (var i = 0; i < keys.length; i++) {
      if (now - rooms[keys[i]].created > 3600000) {
        delete rooms[keys[i]];
      }
    }
    return rooms;
  } catch(e) {
    return {};
  }
}

function saveRooms(rooms) {
  try {
    fs.writeFileSync(path, JSON.stringify(rooms));
  } catch(e) {}
}

module.exports = function(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var rooms = loadRooms();
  var url = req.url || '';
  var parts = url.split('?')[0].split('/').filter(Boolean);
  // /api/room?action=create&name=Tom
  // /api/room?action=join&code=ABCD&name=Jerry
  // /api/room?action=poll&code=ABCD&pid=xxx
  // /api/room?action=answer&code=ABCD&pid=xxx&idx=2&time=3.5
  // /api/room?action=start&code=ABCD&pid=xxx
  // /api/room?action=next&code=ABCD&pid=xxx

  var q = req.query || {};
  var action = q.action || '';

  if (action === 'create') {
    var name = q.name || 'Hostitel';
    var code = makeCode();
    while (rooms[code]) { code = makeCode(); }
    var pid = makeId();
    var questions = prepQuestions();
    rooms[code] = {
      created: Date.now(),
      code: code,
      state: 'lobby', // lobby, playing, round-result, final
      hostPid: pid,
      players: [{pid: pid, name: name, color: '#e94560', score: 0, streak: 0, correct: 0}],
      questions: questions,
      curQ: 0,
      qStartTime: 0,
      answers: {},
      lastUpdate: Date.now()
    };
    saveRooms(rooms);
    res.json({ok: true, code: code, pid: pid});
    return;
  }

  if (action === 'join') {
    var code = (q.code || '').toUpperCase();
    var name = q.name || 'Hráč';
    if (!rooms[code]) { res.json({ok: false, error: 'not_found'}); return; }
    var room = rooms[code];
    if (room.state !== 'lobby') { res.json({ok: false, error: 'already_started'}); return; }
    if (room.players.length >= 4) { res.json({ok: false, error: 'full'}); return; }
    // Check if name already exists
    var colors = ['#e94560','#2979ff','#00c853','#ff6d00'];
    var pid = makeId();
    room.players.push({pid: pid, name: name, color: colors[room.players.length], score: 0, streak: 0, correct: 0});
    room.lastUpdate = Date.now();
    saveRooms(rooms);
    res.json({ok: true, pid: pid, players: stripPids(room.players)});
    return;
  }

  if (action === 'poll') {
    var code = (q.code || '').toUpperCase();
    var pid = q.pid || '';
    if (!rooms[code]) { res.json({ok: false, error: 'not_found'}); return; }
    var room = rooms[code];
    // Return current state
    var myIdx = -1;
    for (var i = 0; i < room.players.length; i++) {
      if (room.players[i].pid === pid) myIdx = i;
    }
    var resp = {
      ok: true,
      state: room.state,
      players: stripPids(room.players),
      myIdx: myIdx,
      curQ: room.curQ,
      lastUpdate: room.lastUpdate
    };
    if (room.state === 'playing') {
      var qData = room.questions[room.curQ];
      resp.question = {cat: qData.cat, q: qData.q, a: qData.a, idx: room.curQ};
      resp.qStartTime = room.qStartTime;
      resp.serverTime = Date.now();
      // Check if this player already answered
      resp.myAnswered = !!room.answers[pid];
      resp.answeredCount = Object.keys(room.answers).length;
      resp.totalPlayers = room.players.length;
    }
    if (room.state === 'round-result') {
      resp.correctIdx = room.lastCorrectIdx;
      resp.correctText = room.lastCorrectText;
      resp.roundPlayers = stripPids(room.players);
    }
    if (room.state === 'final') {
      resp.finalPlayers = stripPids(room.players);
    }
    res.json(resp);
    return;
  }

  if (action === 'start') {
    var code = (q.code || '').toUpperCase();
    var pid = q.pid || '';
    if (!rooms[code]) { res.json({ok: false, error: 'not_found'}); return; }
    var room = rooms[code];
    if (room.hostPid !== pid) { res.json({ok: false, error: 'not_host'}); return; }
    if (room.players.length < 2) { res.json({ok: false, error: 'need_more'}); return; }
    room.state = 'playing';
    room.curQ = 0;
    room.qStartTime = Date.now();
    room.answers = {};
    room.lastUpdate = Date.now();
    saveRooms(rooms);
    res.json({ok: true});
    return;
  }

  if (action === 'answer') {
    var code = (q.code || '').toUpperCase();
    var pid = q.pid || '';
    var ansIdx = parseInt(q.idx);
    var ansTime = parseFloat(q.time) || 15;
    if (!rooms[code]) { res.json({ok: false, error: 'not_found'}); return; }
    var room = rooms[code];
    if (room.state !== 'playing') { res.json({ok: false, error: 'not_playing'}); return; }
    if (room.answers[pid]) { res.json({ok: false, error: 'already_answered'}); return; }
    room.answers[pid] = {idx: ansIdx, time: ansTime};
    room.lastUpdate = Date.now();

    // Check if all answered
    if (Object.keys(room.answers).length >= room.players.length) {
      resolveRound(room);
    }
    saveRooms(rooms);
    res.json({ok: true, answeredCount: Object.keys(room.answers).length});
    return;
  }

  if (action === 'timeout') {
    // Host reports time is up — force resolve
    var code = (q.code || '').toUpperCase();
    var pid = q.pid || '';
    if (!rooms[code]) { res.json({ok: false, error: 'not_found'}); return; }
    var room = rooms[code];
    if (room.hostPid !== pid) { res.json({ok: false, error: 'not_host'}); return; }
    if (room.state !== 'playing') { res.json({ok: false}); return; }
    // Fill in missing answers as timeout (-1)
    for (var i = 0; i < room.players.length; i++) {
      if (!room.answers[room.players[i].pid]) {
        room.answers[room.players[i].pid] = {idx: -1, time: 99};
      }
    }
    resolveRound(room);
    saveRooms(rooms);
    res.json({ok: true});
    return;
  }

  if (action === 'next') {
    var code = (q.code || '').toUpperCase();
    var pid = q.pid || '';
    if (!rooms[code]) { res.json({ok: false, error: 'not_found'}); return; }
    var room = rooms[code];
    if (room.hostPid !== pid) { res.json({ok: false, error: 'not_host'}); return; }
    room.curQ++;
    if (room.curQ >= room.questions.length) {
      room.state = 'final';
    } else {
      room.state = 'playing';
      room.qStartTime = Date.now();
      room.answers = {};
    }
    room.lastUpdate = Date.now();
    saveRooms(rooms);
    res.json({ok: true, state: room.state});
    return;
  }

  res.json({error: 'unknown_action'});
};

function resolveRound(room) {
  var q = room.questions[room.curQ];
  var sp = specType(room.curQ);
  var maxT = getMaxTime(sp);
  var mult = 1;
  if (sp === 'blitz') mult = 2;
  if (sp === 'finale') mult = 3;

  for (var i = 0; i < room.players.length; i++) {
    var p = room.players[i];
    var ans = room.answers[p.pid] || {idx: -1, time: 99};
    var ok = ans.idx === q.c;
    var pts = 0;
    if (ok) {
      p.streak = (p.streak || 0) + 1;
      p.correct = (p.correct || 0) + 1;
      var base = 100;
      var speed = Math.round((1 - Math.min(ans.time / maxT, 1)) * 50);
      var sm = p.streak >= 3 ? 1.5 : 1;
      pts = Math.round((base + speed) * mult * sm);
      p.score += pts;
    } else {
      p.streak = 0;
    }
    p.lastPts = pts;
    p.lastOk = ok;
  }
  room.lastCorrectIdx = q.c;
  room.lastCorrectText = q.a[q.c];
  room.state = 'round-result';
  room.lastUpdate = Date.now();
}

function specType(idx) {
  if (idx === 4) return 'blitz';
  if (idx === 9) return 'bet';
  if (idx === 14) return 'finale';
  return '';
}

function getMaxTime(sp) {
  if (sp === 'blitz') return 7;
  if (sp === 'finale') return 20;
  return 15;
}

function makeCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  var c = '';
  for (var i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function makeId() {
  var c = '';
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (var i = 0; i < 12; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function stripPids(players) {
  var r = [];
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    r.push({name: p.name, color: p.color, score: p.score, streak: p.streak, correct: p.correct, lastPts: p.lastPts, lastOk: p.lastOk});
  }
  return r;
}

function prepQuestions() {
  var allQ = [
    {cat:"🌍 Zeměpis",q:"Jaké je hlavní město Austrálie?",a:["Canberra","Sydney","Melbourne","Brisbane"],c:0},
    {cat:"🇨🇿 Česko",q:"Která řeka je nejdelší v Česku?",a:["Vltava","Labe","Morava","Dyje"],c:0},
    {cat:"🔬 Věda",q:"Kolik kostí má dospělý člověk?",a:["206","186","256","300"],c:0},
    {cat:"🎬 Popkultura",q:"Jak se jmenuje sněhulák z Ledového království?",a:["Olaf","Sven","Kristoff","Hans"],c:0},
    {cat:"⚽ Sport",q:"Ve kterém roce se konaly první novodobé olympijské hry?",a:["1896","1900","1888","1912"],c:0},
    {cat:"🍕 Jídlo",q:"Z které země pochází sushi?",a:["Japonsko","Čína","Thajsko","Korea"],c:0},
    {cat:"🏛️ Historie",q:"Kdo objevil Ameriku v roce 1492?",a:["Kryštof Kolumbus","Amerigo Vespucci","Marco Polo","Fernão de Magalhães"],c:0},
    {cat:"🇨🇿 Česko",q:"Kolik krajů má Česká republika?",a:["14","12","13","16"],c:0},
    {cat:"🔬 Věda",q:"Která planeta je Slunci nejblíže?",a:["Merkur","Venuše","Mars","Země"],c:0},
    {cat:"🎬 Popkultura",q:"Kdo namaloval Monu Lisu?",a:["Leonardo da Vinci","Michelangelo","Raphael","Botticelli"],c:0},
    {cat:"🌍 Zeměpis",q:"Která hora je nejvyšší na světě?",a:["Mount Everest","K2","Kilimandžáro","Mont Blanc"],c:0},
    {cat:"🍕 Jídlo",q:"Co je hlavní ingredience guacamole?",a:["Avokádo","Rajče","Paprika","Cibule"],c:0},
    {cat:"⚽ Sport",q:"Kolik hráčů má fotbalový tým na hřišti?",a:["11","10","12","9"],c:0},
    {cat:"🏛️ Historie",q:"Ve kterém roce padla Berlínská zeď?",a:["1989","1991","1987","1990"],c:0},
    {cat:"🇨🇿 Česko",q:"Který český král byl zároveň římským císařem a sídlil v Praze?",a:["Karel IV.","Václav IV.","Rudolf II.","Přemysl Otakar II."],c:0},
    {cat:"🔬 Věda",q:"Jaký plyn tvoří většinu zemské atmosféry?",a:["Dusík","Kyslík","CO₂","Argon"],c:0},
    {cat:"🌍 Zeměpis",q:"Která země má nejvíce obyvatel?",a:["Indie","Čína","USA","Indonésie"],c:0},
    {cat:"🎬 Popkultura",q:"Jak se jmenuje kouzelnická škola v Harrym Potterovi?",a:["Bradavice","Krásnohůlky","Mahoutokoro","Ilvermorny"],c:0},
    {cat:"🍕 Jídlo",q:"Která koření je nejdražší na světě?",a:["Šafrán","Vanilka","Kardamom","Skořice"],c:0},
    {cat:"⚽ Sport",q:"Kolik setů se hraje maximálně v tenisovém grandslamu mužů?",a:["5","3","4","6"],c:0},
    {cat:"🏛️ Historie",q:"Kdo byl první prezident Československa?",a:["T. G. Masaryk","Edvard Beneš","Klement Gottwald","Antonín Zápotocký"],c:0}
  ];
  var sh = allQ.slice().sort(function() { return Math.random() - 0.5; });
  var qs = [];
  for (var i = 0; i < 15 && i < sh.length; i++) {
    var q = sh[i];
    var cor = q.a[q.c];
    var sa = q.a.slice().sort(function() { return Math.random() - 0.5; });
    qs.push({cat: q.cat, q: q.q, a: sa, c: sa.indexOf(cor)});
  }
  return qs;
}
