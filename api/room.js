// Quiz API v4 — Pure server-side state, /tmp + global cache with fallback header
var fs = require('fs');
var TMP = '/tmp/qr_';
if (!global._qr) global._qr = {};

function readRoom(code) {
  if (global._qr[code]) return global._qr[code];
  try {
    var d = JSON.parse(fs.readFileSync(TMP + code, 'utf8'));
    global._qr[code] = d;
    return d;
  } catch(e) { return null; }
}
function writeRoom(code, room) {
  global._qr[code] = room;
  try { fs.writeFileSync(TMP + code, JSON.stringify(room)); } catch(e) {}
}

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Room-Backup');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var q = req.query || {};
  var action = q.action || '';

  // If host sends room backup in header (base64), restore it if missing
  var backup = req.headers['x-room-backup'];
  if (backup && q.code) {
    var bcode = q.code.toUpperCase();
    if (!readRoom(bcode)) {
      try {
        var restored = JSON.parse(Buffer.from(backup, 'base64').toString());
        if (restored && restored.code === bcode) writeRoom(bcode, restored);
      } catch(e) {}
    }
  }

  /* CREATE */
  if (action === 'create') {
    var name = decodeURIComponent(q.name || 'Hostitel');
    var code = makeCode();
    var pid = makeId();
    var room = {
      v: 0, created: Date.now(), code: code, state: 'lobby', hostPid: pid,
      players: [{pid:pid,name:name,color:'#e94560',score:0,streak:0,correct:0}],
      questions: prepQuestions(), curQ: 0, qStartTime: 0, answers: {},
      lastUpdate: Date.now()
    };
    writeRoom(code, room);
    res.json({ok:true, code:code, pid:pid});
    return;
  }

  /* JOIN */
  if (action === 'join') {
    var code = (q.code||'').toUpperCase();
    var name = decodeURIComponent(q.name||'Hráč');
    var room = readRoom(code);
    if (!room) { res.json({ok:false,error:'not_found'}); return; }
    if (room.state !== 'lobby') { res.json({ok:false,error:'already_started'}); return; }
    if (room.players.length >= 4) { res.json({ok:false,error:'full'}); return; }
    // Check duplicate name
    var pid = makeId();
    var colors = ['#e94560','#2979ff','#00c853','#ff6d00'];
    room.players.push({pid:pid,name:name,color:colors[room.players.length],score:0,streak:0,correct:0});
    room.v++; room.lastUpdate = Date.now();
    writeRoom(code, room);
    res.json({ok:true, pid:pid, players:stripPids(room.players)});
    return;
  }

  /* POLL */
  if (action === 'poll') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    var room = readRoom(code);
    if (!room) { res.json({ok:false,error:'not_found'}); return; }
    var myIdx = -1;
    for (var i=0;i<room.players.length;i++) if (room.players[i].pid===pid) myIdx=i;
    var r = {ok:true, v:room.v, state:room.state, players:stripPids(room.players),
             myIdx:myIdx, curQ:room.curQ};
    if (room.state === 'playing') {
      var qd = room.questions[room.curQ];
      r.question = {cat:qd.cat, q:qd.q, a:qd.a, idx:room.curQ};
      r.qStartTime = room.qStartTime;
      r.serverTime = Date.now();
      r.myAnswered = !!room.answers[pid];
      r.answeredCount = Object.keys(room.answers).length;
      r.totalPlayers = room.players.length;
    }
    if (room.state === 'round-result') {
      r.correctIdx = room.lastCorrectIdx;
      r.correctText = room.lastCorrectText;
      r.roundPlayers = stripPids(room.players);
      r.curQ = room.curQ;
    }
    if (room.state === 'final') r.finalPlayers = stripPids(room.players);
    res.json(r);
    return;
  }

  /* START */
  if (action === 'start') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    var room = readRoom(code);
    if (!room) { res.json({ok:false,error:'not_found'}); return; }
    if (room.hostPid !== pid) { res.json({ok:false,error:'not_host'}); return; }
    if (room.players.length < 2) { res.json({ok:false,error:'need_more'}); return; }
    room.state = 'playing'; room.curQ = 0; room.qStartTime = Date.now();
    room.answers = {}; room.v++; room.lastUpdate = Date.now();
    writeRoom(code, room);
    res.json({ok:true});
    return;
  }

  /* ANSWER */
  if (action === 'answer') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    var aidx = parseInt(q.idx);
    var atime = parseFloat(q.time)||15;
    var room = readRoom(code);
    if (!room) { res.json({ok:false,error:'not_found'}); return; }
    if (room.state !== 'playing') { res.json({ok:false,error:'not_playing'}); return; }
    if (room.answers[pid]) { res.json({ok:true,answeredCount:Object.keys(room.answers).length}); return; }
    room.answers[pid] = {idx:aidx, time:atime};
    // Auto-resolve if all answered
    if (Object.keys(room.answers).length >= room.players.length) {
      resolveRound(room);
    }
    room.v++; room.lastUpdate = Date.now();
    writeRoom(code, room);
    res.json({ok:true, answeredCount:Object.keys(room.answers).length});
    return;
  }

  /* TIMEOUT — host says time is up */
  if (action === 'timeout') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    var room = readRoom(code);
    if (!room) { res.json({ok:false,error:'not_found'}); return; }
    if (room.hostPid !== pid) { res.json({ok:false,error:'not_host'}); return; }
    if (room.state !== 'playing') { res.json({ok:true}); return; }
    for (var i=0;i<room.players.length;i++) {
      if (!room.answers[room.players[i].pid]) room.answers[room.players[i].pid]={idx:-1,time:99};
    }
    resolveRound(room);
    room.v++; room.lastUpdate = Date.now();
    writeRoom(code, room);
    res.json({ok:true});
    return;
  }

  /* NEXT */
  if (action === 'next') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    var room = readRoom(code);
    if (!room) { res.json({ok:false,error:'not_found'}); return; }
    if (room.hostPid !== pid) { res.json({ok:false,error:'not_host'}); return; }
    if (room.state !== 'round-result') { res.json({ok:true,state:room.state}); return; }
    room.curQ++;
    if (room.curQ >= room.questions.length) { room.state = 'final'; }
    else { room.state = 'playing'; room.qStartTime = Date.now(); room.answers = {}; }
    room.v++; room.lastUpdate = Date.now();
    writeRoom(code, room);
    res.json({ok:true, state:room.state});
    return;
  }

  /* BACKUP — host periodically saves full room */
  if (action === 'backup') {
    if (req.method !== 'POST') { res.json({ok:false}); return; }
    collectBody(req, function(body) {
      try {
        var room = JSON.parse(body);
        if (room && room.code) writeRoom(room.code, room);
        res.json({ok:true});
      } catch(e) { res.json({ok:false}); }
    });
    return;
  }

  res.json({error:'unknown_action'});
};

function collectBody(req,cb){var d='';req.on('data',function(c){d+=c;if(d.length>5e5)req.destroy()});req.on('end',function(){cb(d)});}

function resolveRound(room) {
  var q = room.questions[room.curQ];
  var sp = specType(room.curQ), maxT = getMaxTime(sp);
  var mult = sp==='blitz'?2:sp==='finale'?3:1;
  for (var i=0;i<room.players.length;i++) {
    var p = room.players[i];
    var ans = room.answers[p.pid]||{idx:-1,time:99};
    var ok = ans.idx === q.c, pts = 0;
    if (ok) {
      p.streak=(p.streak||0)+1; p.correct=(p.correct||0)+1;
      var speed=Math.round((1-Math.min(ans.time/maxT,1))*50);
      pts=Math.round((100+speed)*mult*(p.streak>=3?1.5:1));
      p.score+=pts;
    } else { p.streak=0; }
    p.lastPts=pts; p.lastOk=ok;
  }
  room.lastCorrectIdx=q.c; room.lastCorrectText=q.a[q.c];
  room.state='round-result'; room.lastUpdate=Date.now();
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
