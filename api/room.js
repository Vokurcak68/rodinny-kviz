var https = require('https');

var GIST_ID = process.env.GIST_ID || 'eb389578a90ecde0773e247dca251a32';
var GH_TOKEN = process.env.GH_TOKEN;

function ghReq(method, path, body, cb) {
  var opts = {
    hostname: 'api.github.com',
    path: path,
    method: method,
    headers: {
      'Authorization': 'token ' + GH_TOKEN,
      'User-Agent': 'quiz-api',
      'Accept': 'application/vnd.github.v3+json'
    }
  };
  if (body) {
    var b = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['Content-Length'] = Buffer.byteLength(b);
  }
  var req = https.request(opts, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      try { cb(null, JSON.parse(data)); } catch(e) { cb(e); }
    });
  });
  req.on('error', function(e) { cb(e); });
  if (body) req.write(JSON.stringify(body));
  req.end();
}

function loadRooms(cb) {
  ghReq('GET', '/gists/' + GIST_ID, null, function(err, gist) {
    if (err || !gist || !gist.files) { cb(err, {}); return; }
    var f = gist.files['rooms.json'];
    if (!f || !f.content) { cb(null, {}); return; }
    try { cb(null, JSON.parse(f.content)); } catch(e) { cb(null, {}); }
  });
}

function saveRooms(rooms, cb) {
  // Clean old rooms (>2 hours)
  var now = Date.now();
  var keys = Object.keys(rooms);
  for (var i = 0; i < keys.length; i++) {
    if (now - rooms[keys[i]].created > 7200000) delete rooms[keys[i]];
  }
  var body = {
    files: { 'rooms.json': { content: JSON.stringify(rooms) } }
  };
  ghReq('PATCH', '/gists/' + GIST_ID, body, function(err) {
    if (cb) cb(err);
  });
}

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var q = req.query || {};
  var action = q.action || '';

  loadRooms(function(err, rooms) {
    if (err) rooms = {};

    /* CREATE */
    if (action === 'create') {
      var name = decodeURIComponent(q.name || 'Hostitel');
      var code = makeCode();
      while (rooms[code]) code = makeCode();
      var pid = makeId();
      rooms[code] = {
        created: Date.now(), code: code, state: 'lobby', hostPid: pid,
        players: [{pid:pid, name:name, color:'#e94560', score:0, streak:0, correct:0}],
        questions: prepQuestions(), curQ: 0, qStartTime: 0, answers: {}, lastUpdate: Date.now()
      };
      saveRooms(rooms, function() { res.json({ok:true, code:code, pid:pid}); });
      return;
    }

    /* JOIN */
    if (action === 'join') {
      var jcode = (q.code || '').toUpperCase();
      var jname = decodeURIComponent(q.name || 'Hráč');
      var room = rooms[jcode];
      if (!room) { res.json({ok:false, error:'not_found'}); return; }
      if (room.state !== 'lobby') { res.json({ok:false, error:'already_started'}); return; }
      if (room.players.length >= 4) { res.json({ok:false, error:'full'}); return; }
      var colors = ['#e94560','#2979ff','#00c853','#ff6d00'];
      var jpid = makeId();
      room.players.push({pid:jpid, name:jname, color:colors[room.players.length], score:0, streak:0, correct:0});
      room.lastUpdate = Date.now();
      saveRooms(rooms, function() { res.json({ok:true, pid:jpid, players:stripPids(room.players)}); });
      return;
    }

    /* POLL — read only, no save needed */
    if (action === 'poll') {
      var pcode = (q.code || '').toUpperCase();
      var ppid = q.pid || '';
      var pr = rooms[pcode];
      if (!pr) { res.json({ok:false, error:'not_found'}); return; }
      var myIdx = -1;
      for (var i = 0; i < pr.players.length; i++) {
        if (pr.players[i].pid === ppid) myIdx = i;
      }
      var resp = {ok:true, state:pr.state, players:stripPids(pr.players), myIdx:myIdx, curQ:pr.curQ, lastUpdate:pr.lastUpdate};
      if (pr.state === 'playing') {
        var qd = pr.questions[pr.curQ];
        resp.question = {cat:qd.cat, q:qd.q, a:qd.a, idx:pr.curQ};
        resp.qStartTime = pr.qStartTime;
        resp.serverTime = Date.now();
        resp.myAnswered = !!pr.answers[ppid];
        resp.answeredCount = Object.keys(pr.answers).length;
        resp.totalPlayers = pr.players.length;
      }
      if (pr.state === 'round-result') {
        resp.correctIdx = pr.lastCorrectIdx;
        resp.correctText = pr.lastCorrectText;
        resp.roundPlayers = stripPids(pr.players);
      }
      if (pr.state === 'final') { resp.finalPlayers = stripPids(pr.players); }
      res.json(resp);
      return;
    }

    /* START */
    if (action === 'start') {
      var sc = (q.code || '').toUpperCase();
      var sp = q.pid || '';
      var sr = rooms[sc];
      if (!sr) { res.json({ok:false, error:'not_found'}); return; }
      if (sr.hostPid !== sp) { res.json({ok:false, error:'not_host'}); return; }
      if (sr.players.length < 2) { res.json({ok:false, error:'need_more'}); return; }
      sr.state = 'playing'; sr.curQ = 0; sr.qStartTime = Date.now(); sr.answers = {}; sr.lastUpdate = Date.now();
      saveRooms(rooms, function() { res.json({ok:true}); });
      return;
    }

    /* ANSWER */
    if (action === 'answer') {
      var ac = (q.code || '').toUpperCase();
      var ap = q.pid || '';
      var ai = parseInt(q.idx);
      var at = parseFloat(q.time) || 15;
      var ar = rooms[ac];
      if (!ar) { res.json({ok:false, error:'not_found'}); return; }
      if (ar.state !== 'playing') { res.json({ok:false, error:'not_playing'}); return; }
      if (ar.answers[ap]) { res.json({ok:false, error:'already_answered'}); return; }
      ar.answers[ap] = {idx:ai, time:at};
      ar.lastUpdate = Date.now();
      if (Object.keys(ar.answers).length >= ar.players.length) resolveRound(ar);
      saveRooms(rooms, function() { res.json({ok:true, answeredCount:Object.keys(ar.answers).length}); });
      return;
    }

    /* TIMEOUT */
    if (action === 'timeout') {
      var tc = (q.code || '').toUpperCase();
      var tp = q.pid || '';
      var tr = rooms[tc];
      if (!tr) { res.json({ok:false, error:'not_found'}); return; }
      if (tr.hostPid !== tp) { res.json({ok:false, error:'not_host'}); return; }
      if (tr.state !== 'playing') { res.json({ok:false}); return; }
      for (var ti = 0; ti < tr.players.length; ti++) {
        if (!tr.answers[tr.players[ti].pid]) tr.answers[tr.players[ti].pid] = {idx:-1, time:99};
      }
      resolveRound(tr);
      saveRooms(rooms, function() { res.json({ok:true}); });
      return;
    }

    /* NEXT */
    if (action === 'next') {
      var nc = (q.code || '').toUpperCase();
      var np = q.pid || '';
      var nr = rooms[nc];
      if (!nr) { res.json({ok:false, error:'not_found'}); return; }
      if (nr.hostPid !== np) { res.json({ok:false, error:'not_host'}); return; }
      nr.curQ++;
      if (nr.curQ >= nr.questions.length) { nr.state = 'final'; }
      else { nr.state = 'playing'; nr.qStartTime = Date.now(); nr.answers = {}; }
      nr.lastUpdate = Date.now();
      saveRooms(rooms, function() { res.json({ok:true, state:nr.state}); });
      return;
    }

    res.json({error:'unknown_action'});
  });
};

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
