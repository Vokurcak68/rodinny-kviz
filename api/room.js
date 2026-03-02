// Stateless quiz API — host sends full state, server caches it.
// Even if Vercel routes to different instances, host re-fills cache every 1.5s.
var fs = require('fs');
var TMP = '/tmp/qr_';

function readRoom(code) {
  try { return JSON.parse(fs.readFileSync(TMP + code, 'utf8')); } catch(e) { return null; }
}
function writeRoom(code, room) {
  try { fs.writeFileSync(TMP + code, JSON.stringify(room)); } catch(e) {}
}

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var q = req.query || {};
  var action = q.action || '';

  /* CREATE — stateless, just generate IDs */
  if (action === 'create') {
    var name = decodeURIComponent(q.name || 'Hostitel');
    var code = makeCode();
    var pid = makeId();
    var room = {
      created: Date.now(), code: code, state: 'lobby', hostPid: pid,
      players: [{pid:pid, name:name, color:'#e94560', score:0, streak:0, correct:0}],
      questions: prepQuestions(), curQ: 0, qStartTime: 0, answers: {}, lastUpdate: Date.now()
    };
    writeRoom(code, room);
    res.json({ok: true, code: code, pid: pid, room: room});
    return;
  }

  /* SYNC — host pushes full state every poll, returns any pending joins */
  if (action === 'sync') {
    var code = (q.code || '').toUpperCase();
    var pid = q.pid || '';
    // Host sends current room state as POST body
    if (req.method === 'POST') {
      collectBody(req, function(body) {
        var room;
        try { room = JSON.parse(body); } catch(e) { res.json({ok:false, error:'bad_json'}); return; }
        if (!room || room.hostPid !== pid) { res.json({ok:false, error:'not_host'}); return; }
        // Merge from cache: pending joins + guest answers
        var cached = readRoom(code);
        var newPlayers = [];
        var newAnswers = {};
        if (cached) {
          // Merge pending joins
          if (cached._pendingJoins) {
            for (var i = 0; i < cached._pendingJoins.length; i++) {
              var pj = cached._pendingJoins[i];
              var exists = false;
              for (var j = 0; j < room.players.length; j++) {
                if (room.players[j].pid === pj.pid) { exists = true; break; }
              }
              if (!exists && room.players.length < 4) {
                room.players.push(pj);
                newPlayers.push(pj);
              }
            }
          }
          // Merge guest answers (answers in cache that host doesn't have yet)
          if (cached.answers) {
            var ckeys = Object.keys(cached.answers);
            for (var k = 0; k < ckeys.length; k++) {
              if (!room.answers[ckeys[k]]) {
                room.answers[ckeys[k]] = cached.answers[ckeys[k]];
                newAnswers[ckeys[k]] = cached.answers[ckeys[k]];
              }
            }
          }
        }
        // Check if all answered after merge → resolve round
        if (room.state === 'playing' && Object.keys(room.answers).length >= room.players.length) {
          resolveRound(room);
        }
        room.lastUpdate = Date.now();
        room._pendingJoins = [];
        writeRoom(code, room);
        res.json({ok: true, newPlayers: newPlayers, newAnswers: newAnswers, answeredCount: Object.keys(room.answers).length});
      });
      return;
    }
    // GET — non-host reads cached state
    var cached = readRoom(code);
    if (!cached) { res.json({ok: false, error: 'not_found'}); return; }
    var myIdx = -1;
    for (var i = 0; i < cached.players.length; i++) {
      if (cached.players[i].pid === pid) myIdx = i;
    }
    var resp = {ok:true, state:cached.state, players:stripPids(cached.players), myIdx:myIdx, curQ:cached.curQ, lastUpdate:cached.lastUpdate};
    if (cached.state === 'playing') {
      var qd = cached.questions[cached.curQ];
      resp.question = {cat:qd.cat, q:qd.q, a:qd.a, idx:cached.curQ};
      resp.qStartTime = cached.qStartTime;
      resp.serverTime = Date.now();
      resp.myAnswered = !!cached.answers[pid];
      resp.answeredCount = Object.keys(cached.answers).length;
      resp.totalPlayers = cached.players.length;
    }
    if (cached.state === 'round-result') {
      resp.correctIdx = cached.lastCorrectIdx;
      resp.correctText = cached.lastCorrectText;
      resp.roundPlayers = stripPids(cached.players);
    }
    if (cached.state === 'final') { resp.finalPlayers = stripPids(cached.players); }
    res.json(resp);
    return;
  }

  /* JOIN — guest writes join request to cache, host picks it up */
  if (action === 'join') {
    var code = (q.code || '').toUpperCase();
    var name = decodeURIComponent(q.name || 'Hráč');
    var cached = readRoom(code);
    if (!cached) { res.json({ok: false, error: 'not_found'}); return; }
    if (cached.state !== 'lobby') { res.json({ok: false, error: 'already_started'}); return; }
    if (cached.players.length >= 4) { res.json({ok: false, error: 'full'}); return; }
    var colors = ['#e94560','#2979ff','#00c853','#ff6d00'];
    var jpid = makeId();
    var newPlayer = {pid:jpid, name:name, color:colors[cached.players.length], score:0, streak:0, correct:0};
    // Add to room directly AND to pending (for cross-instance)
    cached.players.push(newPlayer);
    if (!cached._pendingJoins) cached._pendingJoins = [];
    cached._pendingJoins.push(newPlayer);
    cached.lastUpdate = Date.now();
    writeRoom(code, cached);
    res.json({ok: true, pid: jpid, players: stripPids(cached.players)});
    return;
  }

  /* ANSWER — guest submits answer, stored in cache for host to pick up */
  if (action === 'answer') {
    var code = (q.code || '').toUpperCase();
    var pid = q.pid || '';
    var aidx = parseInt(q.idx);
    var atime = parseFloat(q.time) || 15;
    var cached = readRoom(code);
    if (!cached) { res.json({ok: false, error: 'not_found'}); return; }
    cached.answers[pid] = {idx: aidx, time: atime};
    if (Object.keys(cached.answers).length >= cached.players.length) resolveRound(cached);
    cached.lastUpdate = Date.now();
    writeRoom(code, cached);
    res.json({ok: true, answeredCount: Object.keys(cached.answers).length});
    return;
  }

  /* START */
  if (action === 'start') {
    var code = (q.code || '').toUpperCase();
    var pid = q.pid || '';
    var cached = readRoom(code);
    if (!cached) { res.json({ok: false, error: 'not_found'}); return; }
    if (cached.hostPid !== pid) { res.json({ok: false, error: 'not_host'}); return; }
    if (cached.players.length < 2) { res.json({ok: false, error: 'need_more'}); return; }
    cached.state = 'playing'; cached.curQ = 0; cached.qStartTime = Date.now(); cached.answers = {}; cached.lastUpdate = Date.now();
    writeRoom(code, cached);
    res.json({ok: true});
    return;
  }

  /* TIMEOUT */
  if (action === 'timeout') {
    var code = (q.code || '').toUpperCase();
    var pid = q.pid || '';
    var cached = readRoom(code);
    if (!cached) { res.json({ok: false, error: 'not_found'}); return; }
    if (cached.hostPid !== pid) { res.json({ok: false, error: 'not_host'}); return; }
    if (cached.state !== 'playing') { res.json({ok: false}); return; }
    for (var i = 0; i < cached.players.length; i++) {
      if (!cached.answers[cached.players[i].pid]) cached.answers[cached.players[i].pid] = {idx:-1, time:99};
    }
    resolveRound(cached);
    writeRoom(code, cached);
    res.json({ok: true});
    return;
  }

  /* NEXT */
  if (action === 'next') {
    var code = (q.code || '').toUpperCase();
    var pid = q.pid || '';
    var cached = readRoom(code);
    if (!cached) { res.json({ok: false, error: 'not_found'}); return; }
    if (cached.hostPid !== pid) { res.json({ok: false, error: 'not_host'}); return; }
    cached.curQ++;
    if (cached.curQ >= cached.questions.length) { cached.state = 'final'; }
    else { cached.state = 'playing'; cached.qStartTime = Date.now(); cached.answers = {}; }
    cached.lastUpdate = Date.now();
    writeRoom(code, cached);
    res.json({ok: true, state: cached.state});
    return;
  }

  res.json({error: 'unknown_action'});
};

function collectBody(req, cb) {
  var d = '';
  req.on('data', function(c) { d += c; if (d.length > 1e6) req.destroy(); });
  req.on('end', function() { cb(d); });
}

/* ===== HELPERS ===== */
function resolveRound(room) {
  var q = room.questions[room.curQ];
  var sp = specType(room.curQ);
  var maxT = getMaxTime(sp);
  var mult = sp==='blitz'?2:sp==='finale'?3:1;
  for (var i = 0; i < room.players.length; i++) {
    var p = room.players[i];
    var ans = room.answers[p.pid] || {idx:-1, time:99};
    var ok = ans.idx === q.c;
    var pts = 0;
    if (ok) {
      p.streak=(p.streak||0)+1; p.correct=(p.correct||0)+1;
      var speed=Math.round((1-Math.min(ans.time/maxT,1))*50);
      pts=Math.round((100+speed)*mult*(p.streak>=3?1.5:1));
      p.score+=pts;
    } else { p.streak=0; }
    p.lastPts=pts; p.lastOk=ok;
  }
  room.lastCorrectIdx=q.c; room.lastCorrectText=q.a[q.c]; room.state='round-result'; room.lastUpdate=Date.now();
}
function specType(i){if(i===4)return'blitz';if(i===9)return'bet';if(i===14)return'finale';return'';}
function getMaxTime(s){if(s==='blitz')return 7;if(s==='finale')return 20;return 15;}
function makeCode(){var c='',ch='ABCDEFGHJKLMNPQRSTUVWXYZ';for(var i=0;i<4;i++)c+=ch[Math.floor(Math.random()*ch.length)];return c;}
function makeId(){var c='',ch='abcdefghijklmnopqrstuvwxyz0123456789';for(var i=0;i<12;i++)c+=ch[Math.floor(Math.random()*ch.length)];return c;}
function stripPids(p){var r=[];for(var i=0;i<p.length;i++){var x=p[i];r.push({name:x.name,color:x.color,score:x.score,streak:x.streak,correct:x.correct,lastPts:x.lastPts,lastOk:x.lastOk});}return r;}
function prepQuestions(){
  var allQ=[
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
    {cat:"⚽ Sport",q:"Kolik setů se hraje max. v tenisovém grandslamu mužů?",a:["5","3","4","6"],c:0},
    {cat:"🏛️ Historie",q:"Kdo byl první prezident Československa?",a:["T. G. Masaryk","Edvard Beneš","Klement Gottwald","Antonín Zápotocký"],c:0}
  ];
  var sh=allQ.slice().sort(function(){return Math.random()-0.5});
  var qs=[];
  for(var i=0;i<15&&i<sh.length;i++){
    var it=sh[i],cor=it.a[it.c],sa=it.a.slice().sort(function(){return Math.random()-0.5});
    qs.push({cat:it.cat,q:it.q,a:sa,c:sa.indexOf(cor)});
  }
  return qs;
}
