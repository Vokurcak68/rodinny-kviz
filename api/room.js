var fs = require('fs');
var TMP = '/tmp/qr_';

// Room stored per-key in /tmp + global fallback
if (!global._qr) global._qr = {};

function loadRoom(code, cb) {
  // Try global first (fastest, same instance)
  if (global._qr[code]) { cb(null, JSON.parse(JSON.stringify(global._qr[code]))); return; }
  // Try /tmp (shared in same sandbox)
  try {
    var data = fs.readFileSync(TMP + code + '.json', 'utf8');
    var room = JSON.parse(data);
    global._qr[code] = room;
    cb(null, JSON.parse(JSON.stringify(room)));
  } catch(e) {
    cb(null, null);
  }
}

function saveRoom(code, room, cb) {
  global._qr[code] = room;
  try { fs.writeFileSync(TMP + code + '.json', JSON.stringify(room)); } catch(e) {}
  if (cb) cb(null);
}

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var q = req.query || {};
  var action = q.action || '';

  /* CREATE */
  if (action === 'create') {
    var name = decodeURIComponent(q.name || 'Hostitel');
    var code = makeCode();
    var pid = makeId();
    var questions = prepQuestions();
    var room = {
      created: Date.now(), code: code, state: 'lobby', hostPid: pid,
      players: [{pid:pid, name:name, color:'#e94560', score:0, streak:0, correct:0}],
      questions: questions, curQ: 0, qStartTime: 0, answers: {}, lastUpdate: Date.now()
    };
    saveRoom(code, room, function() {
      res.json({ok: true, code: code, pid: pid});
    });
    return;
  }

  /* JOIN */
  if (action === 'join') {
    var jcode = (q.code || '').toUpperCase();
    var jname = decodeURIComponent(q.name || 'Hráč');
    loadRoom(jcode, function(err, room) {
      if (!room) { res.json({ok: false, error: 'not_found'}); return; }
      if (room.state !== 'lobby') { res.json({ok: false, error: 'already_started'}); return; }
      if (room.players.length >= 4) { res.json({ok: false, error: 'full'}); return; }
      var colors = ['#e94560','#2979ff','#00c853','#ff6d00'];
      var jpid = makeId();
      room.players.push({pid:jpid, name:jname, color:colors[room.players.length], score:0, streak:0, correct:0});
      room.lastUpdate = Date.now();
      saveRoom(jcode, room, function() {
        res.json({ok: true, pid: jpid, players: stripPids(room.players)});
      });
    });
    return;
  }

  /* POLL */
  if (action === 'poll') {
    var pcode = (q.code || '').toUpperCase();
    var ppid = q.pid || '';
    loadRoom(pcode, function(err, room) {
      if (!room) { res.json({ok: false, error: 'not_found'}); return; }
      var myIdx = -1;
      for (var i = 0; i < room.players.length; i++) {
        if (room.players[i].pid === ppid) myIdx = i;
      }
      var resp = {
        ok: true, state: room.state, players: stripPids(room.players),
        myIdx: myIdx, curQ: room.curQ, lastUpdate: room.lastUpdate
      };
      if (room.state === 'playing') {
        var qData = room.questions[room.curQ];
        resp.question = {cat:qData.cat, q:qData.q, a:qData.a, idx:room.curQ};
        resp.qStartTime = room.qStartTime;
        resp.serverTime = Date.now();
        resp.myAnswered = !!room.answers[ppid];
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
    });
    return;
  }

  /* START */
  if (action === 'start') {
    var scode = (q.code || '').toUpperCase();
    var spid = q.pid || '';
    loadRoom(scode, function(err, room) {
      if (!room) { res.json({ok: false, error: 'not_found'}); return; }
      if (room.hostPid !== spid) { res.json({ok: false, error: 'not_host'}); return; }
      if (room.players.length < 2) { res.json({ok: false, error: 'need_more'}); return; }
      room.state = 'playing';
      room.curQ = 0;
      room.qStartTime = Date.now();
      room.answers = {};
      room.lastUpdate = Date.now();
      saveRoom(scode, room, function() { res.json({ok: true}); });
    });
    return;
  }

  /* ANSWER */
  if (action === 'answer') {
    var acode = (q.code || '').toUpperCase();
    var apid = q.pid || '';
    var aidx = parseInt(q.idx);
    var atime = parseFloat(q.time) || 15;
    loadRoom(acode, function(err, room) {
      if (!room) { res.json({ok: false, error: 'not_found'}); return; }
      if (room.state !== 'playing') { res.json({ok: false, error: 'not_playing'}); return; }
      if (room.answers[apid]) { res.json({ok: false, error: 'already_answered'}); return; }
      room.answers[apid] = {idx: aidx, time: atime};
      room.lastUpdate = Date.now();
      if (Object.keys(room.answers).length >= room.players.length) {
        resolveRound(room);
      }
      saveRoom(acode, room, function() {
        res.json({ok: true, answeredCount: Object.keys(room.answers).length});
      });
    });
    return;
  }

  /* TIMEOUT */
  if (action === 'timeout') {
    var tcode = (q.code || '').toUpperCase();
    var tpid = q.pid || '';
    loadRoom(tcode, function(err, room) {
      if (!room) { res.json({ok: false, error: 'not_found'}); return; }
      if (room.hostPid !== tpid) { res.json({ok: false, error: 'not_host'}); return; }
      if (room.state !== 'playing') { res.json({ok: false}); return; }
      for (var i = 0; i < room.players.length; i++) {
        if (!room.answers[room.players[i].pid]) {
          room.answers[room.players[i].pid] = {idx: -1, time: 99};
        }
      }
      resolveRound(room);
      saveRoom(tcode, room, function() { res.json({ok: true}); });
    });
    return;
  }

  /* NEXT */
  if (action === 'next') {
    var ncode = (q.code || '').toUpperCase();
    var npid = q.pid || '';
    loadRoom(ncode, function(err, room) {
      if (!room) { res.json({ok: false, error: 'not_found'}); return; }
      if (room.hostPid !== npid) { res.json({ok: false, error: 'not_host'}); return; }
      room.curQ++;
      if (room.curQ >= room.questions.length) { room.state = 'final'; }
      else { room.state = 'playing'; room.qStartTime = Date.now(); room.answers = {}; }
      room.lastUpdate = Date.now();
      saveRoom(ncode, room, function() { res.json({ok: true, state: room.state}); });
    });
    return;
  }

  res.json({error: 'unknown_action'});
};

/* ===== HELPERS ===== */
function resolveRound(room) {
  var q = room.questions[room.curQ];
  var sp = specType(room.curQ);
  var maxT = getMaxTime(sp);
  var mult = 1;
  if (sp === 'blitz') mult = 2;
  if (sp === 'finale') mult = 3;
  for (var i = 0; i < room.players.length; i++) {
    var p = room.players[i];
    var ans = room.answers[p.pid] || {idx:-1, time:99};
    var ok = ans.idx === q.c;
    var pts = 0;
    if (ok) {
      p.streak = (p.streak||0)+1; p.correct = (p.correct||0)+1;
      var speed = Math.round((1-Math.min(ans.time/maxT,1))*50);
      var sm = p.streak >= 3 ? 1.5 : 1;
      pts = Math.round((100+speed)*mult*sm);
      p.score += pts;
    } else { p.streak = 0; }
    p.lastPts = pts; p.lastOk = ok;
  }
  room.lastCorrectIdx = q.c;
  room.lastCorrectText = q.a[q.c];
  room.state = 'round-result';
  room.lastUpdate = Date.now();
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
