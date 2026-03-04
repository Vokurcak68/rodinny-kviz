// Quiz API v6.1 — Gist with /tmp+global fallback
var https = require('https');
var fs = require('fs');
var GIST_ID = process.env.GIST_ID || 'eb389578a90ecde0773e247dca251a32';
var GH_TOKEN = process.env.GH_TOKEN || '';
var USE_GIST = !!GH_TOKEN;
var TMP = '/tmp/qr_';
if (!global._qr) global._qr = {};

// In-memory cache with short TTL to reduce Gist reads
var cache = {};
var CACHE_TTL = 800; // ms

function gistReq(method, body, cb) {
  var opts = {
    hostname: 'api.github.com',
    path: '/gists/' + GIST_ID,
    method: method,
    headers: {
      'User-Agent': 'quiz-app',
      'Authorization': 'token ' + GH_TOKEN,
      'Accept': 'application/vnd.github.v3+json'
    }
  };
  if (body) opts.headers['Content-Type'] = 'application/json';
  var req = https.request(opts, function(res) {
    var d = '';
    res.on('data', function(c) { d += c; });
    res.on('end', function() {
      try { cb(null, JSON.parse(d)); } catch(e) { cb(e); }
    });
  });
  req.on('error', function(e) { cb(e); });
  req.setTimeout(6000, function() { req.destroy(); cb(new Error('timeout')); });
  if (body) req.write(JSON.stringify(body));
  req.end();
}

function readRoom(code, cb) {
  if (!USE_GIST) {
    // Fallback: /tmp + global
    var room = global._qr[code] || null;
    if (!room) { try { room = JSON.parse(fs.readFileSync(TMP + code, 'utf8')); global._qr[code] = room; } catch(e) {} }
    cb(null, room);
    return;
  }
  var c = cache[code];
  if (c && (Date.now() - c.t) < CACHE_TTL) { cb(null, c.room); return; }
  gistReq('GET', null, function(err, gist) {
    if (err || !gist || !gist.files) { cb(err || new Error('no gist')); return; }
    var fname = 'room_' + code + '.json';
    if (!gist.files[fname]) { cb(null, null); return; }
    try {
      var room = JSON.parse(gist.files[fname].content);
      cache[code] = {room: room, t: Date.now()};
      cb(null, room);
    } catch(e) { cb(e); }
  });
}

function writeRoom(code, room, cb) {
  if (!USE_GIST) {
    // Fallback: /tmp + global
    global._qr[code] = room;
    try { fs.writeFileSync(TMP + code, JSON.stringify(room)); } catch(e) {}
    if (cb) cb(null);
    return;
  }
  cache[code] = {room: room, t: Date.now()};
  var fname = 'room_' + code + '.json';
  var files = {};
  files[fname] = {content: JSON.stringify(room)};
  gistReq('PATCH', {files: files}, function(err) {
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

  /* CREATE */
  if (action === 'create') {
    var name = decodeURIComponent(q.name || 'Hostitel');
    var jr = q.junior === '1';
    var code = makeCode();
    var pid = makeId();
    var room = {
      v: 0, created: Date.now(), code: code, state: 'lobby', hostPid: pid,
      players: [{pid:pid,name:name,color:'#e94560',score:0,streak:0,correct:0,junior:jr}],
      questions: prepQuestions(), curQ: 0, qStartTime: 0, answers: {},
      lastUpdate: Date.now()
    };
    writeRoom(code, room, function(err) {
      if (err) { res.json({ok:false,error:'write_fail'}); return; }
      res.json({ok: true, code: code, pid: pid});
    });
    return;
  }

  /* JOIN */
  if (action === 'join') {
    var code = (q.code||'').toUpperCase();
    var name = decodeURIComponent(q.name||'Hráč');
    var jr = q.junior === '1';
    readRoom(code, function(err, room) {
      if (err || !room) { res.json({ok:false,error:'not_found'}); return; }
      if (room.state !== 'lobby') { res.json({ok:false,error:'already_started'}); return; }
      if (room.players.length >= 4) { res.json({ok:false,error:'full'}); return; }
      var pid = makeId();
      var colors = ['#e94560','#2979ff','#00c853','#ff6d00'];
      room.players.push({pid:pid,name:name,color:colors[room.players.length],score:0,streak:0,correct:0,junior:jr});
      room.v++; room.lastUpdate = Date.now();
      writeRoom(code, room, function(err2) {
        if (err2) { res.json({ok:false,error:'write_fail'}); return; }
        res.json({ok:true, pid:pid, players:stripPids(room.players)});
      });
    });
    return;
  }

  /* POLL */
  if (action === 'poll') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    readRoom(code, function(err, room) {
      if (err || !room) { res.json({ok:false,error:'not_found'}); return; }

      var changed = false;
      // Merge answer from poll param (format: "qNum:idx:time")
      if (room.state === 'playing' && q.myAns && !room.answers[pid]) {
        var parts = q.myAns.split(':');
        if (parts.length === 3 && parseInt(parts[0]) === room.curQ) {
          room.answers[pid] = {idx:parseInt(parts[1]), time:parseFloat(parts[2])};
          changed = true;
          if (Object.keys(room.answers).length >= room.players.length) {
            resolveRound(room);
          }
          room.v++; room.lastUpdate = Date.now();
        }
      }

      if (changed) {
        writeRoom(code, room, function() { sendPoll(res, room, pid); });
      } else {
        sendPoll(res, room, pid);
      }
    });
    return;
  }

  /* ANSWER */
  if (action === 'answer') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    var aidx = parseInt(q.idx);
    var atime = parseFloat(q.time)||15;
    readRoom(code, function(err, room) {
      if (err || !room) { res.json({ok:false,error:'not_found'}); return; }
      if (room.state !== 'playing') { res.json({ok:false,error:'not_playing'}); return; }
      if (room.answers[pid]) { res.json({ok:true,answeredCount:Object.keys(room.answers).length}); return; }
      room.answers[pid] = {idx:aidx, time:atime};
      if (Object.keys(room.answers).length >= room.players.length) {
        resolveRound(room);
      }
      room.v++; room.lastUpdate = Date.now();
      writeRoom(code, room, function() {
        res.json({ok:true, answeredCount:Object.keys(room.answers).length});
      });
    });
    return;
  }

  /* START */
  if (action === 'start') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    readRoom(code, function(err, room) {
      if (err || !room) { res.json({ok:false,error:'not_found'}); return; }
      if (room.hostPid !== pid) { res.json({ok:false,error:'not_host'}); return; }
      if (room.players.length < 2) { res.json({ok:false,error:'need_more'}); return; }
      room.state = 'playing'; room.curQ = 0; room.qStartTime = Date.now();
      room.answers = {}; room.v++; room.lastUpdate = Date.now();
      writeRoom(code, room, function() {
        res.json({ok:true});
      });
    });
    return;
  }

  /* TIMEOUT */
  if (action === 'timeout') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    readRoom(code, function(err, room) {
      if (err || !room) { res.json({ok:false,error:'not_found'}); return; }
      if (room.hostPid !== pid) { res.json({ok:false,error:'not_host'}); return; }
      if (room.state !== 'playing') { res.json({ok:true}); return; }
      for (var i=0;i<room.players.length;i++) {
        if (!room.answers[room.players[i].pid]) room.answers[room.players[i].pid]={idx:-1,time:99};
      }
      resolveRound(room);
      room.v++; room.lastUpdate = Date.now();
      writeRoom(code, room, function() {
        res.json({ok:true});
      });
    });
    return;
  }

  /* NEXT */
  if (action === 'next') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    readRoom(code, function(err, room) {
      if (err || !room) { res.json({ok:false,error:'not_found'}); return; }
      if (room.hostPid !== pid) { res.json({ok:false,error:'not_host'}); return; }
      if (room.state !== 'round-result') { res.json({ok:true,state:room.state}); return; }
      room.curQ++;
      if (room.curQ >= room.questions.length) { room.state = 'final'; }
      else { room.state = 'playing'; room.qStartTime = Date.now(); room.answers = {}; }
      room.v++; room.lastUpdate = Date.now();
      writeRoom(code, room, function() {
        res.json({ok:true, state:room.state});
      });
    });
    return;
  }

  /* HINT 50:50 */
  if (action === 'hint5050') {
    var code = (q.code||'').toUpperCase();
    var pid = q.pid||'';
    readRoom(code, function(err, room) {
      if (err || !room) { res.json({ok:false,error:'not_found'}); return; }
      if (room.state !== 'playing') { res.json({ok:false,error:'not_playing'}); return; }
      var pl = null;
      for (var i=0;i<room.players.length;i++) if (room.players[i].pid===pid) pl=room.players[i];
      if (!pl || !pl.junior) { res.json({ok:false,error:'not_junior'}); return; }
      if ((pl.hints5050used||0) >= 3) { res.json({ok:false,error:'no_hints'}); return; }
      pl.hints5050used = (pl.hints5050used||0)+1;
      var qd = room.questions[room.curQ];
      var wrong = [];
      for (var j=0;j<qd.a.length;j++) if (j!==qd.c) wrong.push(j);
      wrong.sort(function(){return Math.random()-0.5});
      var hide = wrong.slice(0,2);
      writeRoom(code, room, function() {
        res.json({ok:true, hide:hide, remaining:3-pl.hints5050used});
      });
    });
    return;
  }

  res.json({error:'unknown_action'});
};

function sendPoll(res, room, pid) {
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
}

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
      var jrMult = p.junior ? 1.3 : 1;
      pts=Math.round((100+speed)*mult*(p.streak>=3?1.5:1)*jrMult);
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
function stripPids(p){var r=[];for(var i=0;i<p.length;i++){var x=p[i];r.push({name:x.name,color:x.color,score:x.score,streak:x.streak,correct:x.correct,lastPts:x.lastPts,lastOk:x.lastOk,junior:!!x.junior});}return r;}
function prepQuestions(){
  var allQ=[
{cat:"🌍 Zeměpis",q:"Jaké je hlavní město Austrálie?",a:["Canberra","Sydney","Melbourne","Brisbane"],c:0},
{cat:"🌍 Zeměpis",q:"Která řeka je nejdelší na světě?",a:["Nil","Amazonka","Jang-c'-ťiang","Mississippi"],c:0},
{cat:"🌍 Zeměpis",q:"Ve které zemi se nachází Machu Picchu?",a:["Peru","Bolívie","Kolumbie","Ekvádor"],c:0},
{cat:"🌍 Zeměpis",q:"Kolik kontinentů má Země?",a:["7","5","6","8"],c:0},
{cat:"🌍 Zeměpis",q:"Která poušť je největší na světě?",a:["Sahara","Gobi","Kalahari","Atacama"],c:0},
{cat:"🌍 Zeměpis",q:"Jaké je hlavní město Kanady?",a:["Ottawa","Toronto","Montreal","Vancouver"],c:0},
{cat:"🌍 Zeměpis",q:"Který oceán je největší?",a:["Tichý","Atlantský","Indický","Severní ledový"],c:0},
{cat:"🌍 Zeměpis",q:"Ve které zemi leží hora Kilimandžáro?",a:["Tanzanie","Keňa","Uganda","Etiopie"],c:0},
{cat:"🌍 Zeměpis",q:"Jaké je hlavní město Japonska?",a:["Tokio","Ósaka","Kjóto","Jokohama"],c:0},
{cat:"🌍 Zeměpis",q:"Která země má nejvíce obyvatel na světě?",a:["Indie","Čína","USA","Indonésie"],c:0},
{cat:"🌍 Zeměpis",q:"Jak se jmenuje nejmenší stát na světě?",a:["Vatikán","Monako","San Marino","Lichtenštejnsko"],c:0},
{cat:"🌍 Zeměpis",q:"Na kterém kontinentu leží Egypt?",a:["Afrika","Asie","Evropa","Jižní Amerika"],c:0},
{cat:"🌍 Zeměpis",q:"Které moře odděluje Evropu od Afriky?",a:["Středozemní moře","Rudé moře","Černé moře","Kaspické moře"],c:0},
{cat:"🌍 Zeměpis",q:"Jaké je hlavní město Brazílie?",a:["Brasília","Rio de Janeiro","São Paulo","Salvador"],c:0},
{cat:"🌍 Zeměpis",q:"Který vodopád leží na hranici Zambie a Zimbabwe?",a:["Viktoriiny vodopády","Niagarské vodopády","Iguazú","Angelův vodopád"],c:0},
{cat:"🌍 Zeměpis",q:"Kolik států tvoří USA?",a:["50","48","52","46"],c:0},
{cat:"🌍 Zeměpis",q:"Která země má tvar boty?",a:["Itálie","Řecko","Chorvatsko","Portugalsko"],c:0},
{cat:"🇨🇿 Česko",q:"Kolik krajů má Česká republika?",a:["14","12","16","13"],c:0},
{cat:"🇨🇿 Česko",q:"Která řeka je nejdelší v České republice?",a:["Vltava","Labe","Morava","Dyje"],c:0},
{cat:"🇨🇿 Česko",q:"Ve kterém roce vznikla samostatná Česká republika?",a:["1993","1989","1990","1992"],c:0},
{cat:"🇨🇿 Česko",q:"Jak se jmenuje nejvyšší hora České republiky?",a:["Sněžka","Praděd","Lysá hora","Králický Sněžník"],c:0},
{cat:"🇨🇿 Česko",q:"Ve kterém městě se vyrábí plzeňské pivo?",a:["Plzeň","České Budějovice","Praha","Brno"],c:0},
{cat:"🇨🇿 Česko",q:"Kdo je autorem hudby k české národní hymně?",a:["František Škroup","Bedřich Smetana","Antonín Dvořák","Leoš Janáček"],c:0},
{cat:"🇨🇿 Česko",q:"Které české město je známé jako Hanácká metropole?",a:["Olomouc","Prostějov","Přerov","Kroměříž"],c:0},
{cat:"🇨🇿 Česko",q:"Kolik obyvatel má přibližně Česká republika?",a:["10,9 milionu","8,5 milionu","12 milionů","9 milionů"],c:0},
{cat:"🇨🇿 Česko",q:"Který hrad je největší na světě podle rozlohy?",a:["Pražský hrad","Hrad Špilberk","Karlštejn","Hrad Křivoklát"],c:0},
{cat:"🇨🇿 Česko",q:"Ve kterém roce proběhla sametová revoluce?",a:["1989","1988","1990","1991"],c:0},
{cat:"🇨🇿 Česko",q:"Jak se jmenuje nejhlubší propast v Česku?",a:["Hranická propast","Macocha","Sloupsko-šošůvské jeskyně","Javoříčské jeskyně"],c:0},
{cat:"🇨🇿 Česko",q:"Které město je krajským městem Jihočeského kraje?",a:["České Budějovice","Tábor","Písek","Strakonice"],c:0},
{cat:"🇨🇿 Česko",q:"Kdo byl prvním prezidentem Československa?",a:["Tomáš Garrigue Masaryk","Edvard Beneš","Klement Gottwald","Václav Havel"],c:0},
{cat:"🇨🇿 Česko",q:"Ve kterém kraji leží Karlovy Vary?",a:["Karlovarský","Plzeňský","Ústecký","Liberecký"],c:0},
{cat:"🇨🇿 Česko",q:"Jak se jmenuje nejstarší české univerzita?",a:["Univerzita Karlova","Masarykova univerzita","Palackého univerzita","ČVUT"],c:0},
{cat:"🇨🇿 Česko",q:"Která česká řeka se vlévá do Labe v Mělníku?",a:["Vltava","Berounka","Sázava","Ohře"],c:0},
{cat:"🇨🇿 Česko",q:"Kolik památek UNESCO se nachází v České republice (přibližně)?",a:["17","10","22","8"],c:0},
{cat:"🔬 Věda",q:"Jaký je chemický vzorec vody?",a:["H₂O","CO₂","NaCl","O₂"],c:0},
{cat:"🔬 Věda",q:"Kolik planet má naše sluneční soustava?",a:["8","9","7","10"],c:0},
{cat:"🔬 Věda",q:"Která planeta je nejbližší ke Slunci?",a:["Merkur","Venuše","Mars","Země"],c:0},
{cat:"🔬 Věda",q:"Jak se jmenuje nejmenší částice chemického prvku?",a:["Atom","Molekula","Elektron","Proton"],c:0},
{cat:"🔬 Věda",q:"Jakou rychlostí se šíří světlo ve vakuu (přibližně)?",a:["300 000 km/s","150 000 km/s","500 000 km/s","1 000 000 km/s"],c:0},
{cat:"🔬 Věda",q:"Který plyn tvoří většinu zemské atmosféry?",a:["Dusík","Kyslík","Oxid uhličitý","Argon"],c:0},
{cat:"🔬 Věda",q:"Kolik kostí má dospělý člověk?",a:["206","186","215","196"],c:0},
{cat:"🔬 Věda",q:"Která planeta je největší ve sluneční soustavě?",a:["Jupiter","Saturn","Neptun","Uran"],c:0},
{cat:"🔬 Věda",q:"Co měří stupnice pH?",a:["Kyselost a zásaditost","Teplotu","Tlak","Tvrdost"],c:0},
{cat:"🔬 Věda",q:"Jak se jmenuje proces, kterým rostliny vyrábějí kyslík?",a:["Fotosyntéza","Respirace","Fermentace","Transpirace"],c:0},
{cat:"🔬 Věda",q:"Která krevní skupina je univerzální dárce?",a:["0−","AB+","A+","B−"],c:0},
{cat:"🔬 Věda",q:"Jaký je chemický symbol pro zlato?",a:["Au","Ag","Fe","Cu"],c:0},
{cat:"🔬 Věda",q:"Kolik chromozomů má člověk?",a:["46","44","48","42"],c:0},
{cat:"🔬 Věda",q:"Který vědec formuloval teorii relativity?",a:["Albert Einstein","Isaac Newton","Niels Bohr","Max Planck"],c:0},
{cat:"🔬 Věda",q:"Jak se nazývá jednotka elektrického odporu?",a:["Ohm","Volt","Ampér","Watt"],c:0},
{cat:"🔬 Věda",q:"Která část buňky obsahuje genetickou informaci?",a:["Jádro","Mitochondrie","Ribozom","Cytoplazma"],c:0},
{cat:"🔬 Věda",q:"Jak se jmenuje nejtvrdší přírodní minerál?",a:["Diamant","Korund","Topaz","Křemen"],c:0},
{cat:"🎬 Popkultura",q:"Jak se jmenuje kouzelník v sérii Pán prstenů?",a:["Gandalf","Saruman","Radagast","Dumbledore"],c:0},
{cat:"🎬 Popkultura",q:"Která animovaná ryba hledá svého syna?",a:["Marlin","Nemo","Dory","Gill"],c:0},
{cat:"🎬 Popkultura",q:"Jak se jmenuje škola čar a kouzel v Harry Potterovi?",a:["Bradavice","Krásnohůlky","Durmstrang","Mahoutokoro"],c:0},
{cat:"🎬 Popkultura",q:"Který superhrdina je známý jako Temný rytíř?",a:["Batman","Superman","Spider-Man","Iron Man"],c:0},
{cat:"🎬 Popkultura",q:"Ve kterém filmu zazní věta 'Já jsem tvůj otec'?",a:["Star Wars: Impérium vrací úder","Star Wars: Nová naděje","Star Wars: Návrat Jediho","Star Wars: Síla se probouzí"],c:0},
{cat:"🎬 Popkultura",q:"Jak se jmenuje sněhulák z filmu Ledové království?",a:["Olaf","Sven","Kristoff","Hans"],c:0},
{cat:"🎬 Popkultura",q:"Která herečka hraje Herminu Grangerovou ve filmech Harry Potter?",a:["Emma Watson","Emma Stone","Emma Thompson","Emma Roberts"],c:0},
{cat:"🎬 Popkultura",q:"Ve kterém animovaném filmu lev zpívá Hakuna Matata?",a:["Lví král","Madagaskar","Kniha džunglí","Zootropolis"],c:0},
{cat:"🎬 Popkultura",q:"Jak se jmenuje hlavní postava série Minecraft?",a:["Steve","Alex","Creeper","Enderman"],c:0},
{cat:"🎬 Popkultura",q:"Který seriál se odehrává v městečku Hawkins?",a:["Stranger Things","Riverdale","Dark","Lost"],c:0},
{cat:"🎬 Popkultura",q:"Jak se jmenuje robot z filmu WALL-E?",a:["WALL-E","EVA","AUTO","M-O"],c:0},
{cat:"🎬 Popkultura",q:"Kdo namluvil Shreka v originále?",a:["Mike Myers","Eddie Murphy","Cameron Diaz","Antonio Banderas"],c:0},
{cat:"🎬 Popkultura",q:"V jakém městě žijí Simpsonovi?",a:["Springfield","Shelbyville","Capital City","Ogdenville"],c:0},
{cat:"🎬 Popkultura",q:"Která česká pohádková postava létá na koštěti a vaří lektvary?",a:["Babička z perníkové chaloupky","Křemílek","Rumcajs","Rákosníček"],c:0},
{cat:"🎬 Popkultura",q:"Jak se jmenuje hlavní hrdina filmu Shrek?",a:["Shrek","Fiona","Lord Farquaad","Kocour v botách"],c:0},
{cat:"🎬 Popkultura",q:"Který Marvel hrdina má štít z vibránia?",a:["Captain America","Thor","Iron Man","Black Panther"],c:0},
{cat:"🎬 Popkultura",q:"Ve kterém roce vyšel první film Jurský park?",a:["1993","1990","1995","1997"],c:0},
{cat:"⚽ Sport",q:"Kolik hráčů má fotbalový tým na hřišti?",a:["11","10","12","9"],c:0},
{cat:"⚽ Sport",q:"Ve které zemi se konaly letní olympijské hry 2024?",a:["Francie","Japonsko","USA","Brazílie"],c:0},
{cat:"⚽ Sport",q:"Kolik setů je potřeba vyhrát v tenisovém Grand Slamu mužů?",a:["3 ze 5","2 ze 3","4 ze 7","3 ze 3"],c:0},
{cat:"⚽ Sport",q:"Jak dlouhý je olympijský bazén?",a:["50 metrů","25 metrů","100 metrů","75 metrů"],c:0},
{cat:"⚽ Sport",q:"Který sport se hraje na kurtu s raketou a míčkem přes síť?",a:["Tenis","Badminton","Squash","Stolní tenis"],c:0},
{cat:"⚽ Sport",q:"Ve kterém sportu se používá termín 'homerun'?",a:["Baseball","Kriket","Softball","Rugby"],c:0},
{cat:"⚽ Sport",q:"Kolik kol má závod Formule 1 v jedné sezóně (přibližně)?",a:["20–24","10–15","30–35","15–18"],c:0},
{cat:"⚽ Sport",q:"Který český hokejista vyhrál Art Ross Trophy v NHL?",a:["Jaromír Jágr","Dominik Hašek","Patrik Eliáš","David Pastrňák"],c:0},
{cat:"⚽ Sport",q:"Ve kterém roce se konalo mistrovství světa ve fotbale v Kataru?",a:["2022","2020","2024","2018"],c:0},
{cat:"⚽ Sport",q:"Jak se nazývá nejvyšší fotbalová soutěž v Anglii?",a:["Premier League","La Liga","Serie A","Bundesliga"],c:0},
{cat:"⚽ Sport",q:"Kolik bodů má touchdown v americkém fotbale?",a:["6","7","3","4"],c:0},
{cat:"⚽ Sport",q:"Která česká tenistka vyhrála Wimbledon v roce 2011?",a:["Petra Kvitová","Karolína Plíšková","Barbora Krejčíková","Markéta Vondroušová"],c:0},
{cat:"⚽ Sport",q:"Ve kterém sportu soutěží Ester Ledecká?",a:["Lyžování a snowboarding","Biatlon","Běžecké lyžování","Krasobruslení"],c:0},
{cat:"⚽ Sport",q:"Jak se jmenuje nejslavnější cyklistický závod?",a:["Tour de France","Giro d'Italia","Vuelta a España","Paříž–Roubaix"],c:0},
{cat:"⚽ Sport",q:"Kolik minut trvá jedna třetina v ledním hokeji?",a:["20","15","25","30"],c:0},
{cat:"⚽ Sport",q:"Ve kterém městě sídlí fotbalový klub FC Barcelona?",a:["Barcelona","Madrid","Valencie","Sevilla"],c:0},
{cat:"⚽ Sport",q:"Kdo drží rekord v počtu titulů na Roland Garros (muži)?",a:["Rafael Nadal","Roger Federer","Novak Djokovič","Björn Borg"],c:0},
{cat:"🍕 Jídlo",q:"Z které země pochází pizza?",a:["Itálie","Řecko","Turecko","Španělsko"],c:0},
{cat:"🍕 Jídlo",q:"Který vitamín obsahují citrusové plody nejvíce?",a:["Vitamín C","Vitamín A","Vitamín D","Vitamín B12"],c:0},
{cat:"🍕 Jídlo",q:"Z čeho se vyrábí tofu?",a:["Sójové boby","Rýže","Pšenice","Kukuřice"],c:0},
{cat:"🍕 Jídlo",q:"Jak se jmenuje tradiční české jídlo z knedlíků, zelí a masa?",a:["Vepřo-knedlo-zelo","Svíčková","Guláš","Řízek"],c:0},
{cat:"🍕 Jídlo",q:"Z které země pochází sushi?",a:["Japonsko","Čína","Korea","Thajsko"],c:0},
{cat:"🍕 Jídlo",q:"Co je hlavní surovinou guacamole?",a:["Avokádo","Rajče","Paprika","Okurka"],c:0},
{cat:"🍕 Jídlo",q:"Které koření dává kari jeho žlutou barvu?",a:["Kurkuma","Šafrán","Paprika","Zázvor"],c:0},
{cat:"🍕 Jídlo",q:"Z které země pochází croissant?",a:["Rakousko","Francie","Belgie","Švýcarsko"],c:0},
{cat:"🍕 Jídlo",q:"Jak se nazývá japonská polévka z fermentované sójové pasty?",a:["Miso","Ramen","Pho","Tom Yum"],c:0},
{cat:"🍕 Jídlo",q:"Která zelenina se používá k výrobě hranolek?",a:["Brambory","Celer","Batáty","Tuřín"],c:0},
{cat:"🍕 Jídlo",q:"Co je hlavní ingrediencí hummusu?",a:["Cizrna","Čočka","Fazole","Hrášek"],c:0},
{cat:"🍕 Jídlo",q:"Jak se jmenuje tradiční vánoční cukroví ve tvaru půlměsíce?",a:["Vanilkové rohlíčky","Linecké","Pracny","Šuhajdy"],c:0},
{cat:"🍕 Jídlo",q:"Z které země pochází paella?",a:["Španělsko","Itálie","Portugalsko","Mexiko"],c:0},
{cat:"🍕 Jídlo",q:"Který typ těstovin má tvar mušle?",a:["Conchiglie","Penne","Fusilli","Farfalle"],c:0},
{cat:"🍕 Jídlo",q:"Co je základem české svíčkové omáčky?",a:["Smetana a zelenina","Rajčata","Houby","Cibule a pivo"],c:0},
{cat:"🍕 Jídlo",q:"Z které země pochází čaj jako kulturní nápoj?",a:["Čína","Indie","Japonsko","Srí Lanka"],c:0},
{cat:"🍕 Jídlo",q:"Jak se nazývá italský dezert z mascarpone a piškotů?",a:["Tiramisu","Panna cotta","Cannoli","Zabaglione"],c:0},
{cat:"🏛️ Historie",q:"Ve kterém roce skončila druhá světová válka?",a:["1945","1944","1946","1943"],c:0},
{cat:"🏛️ Historie",q:"Kdo objevil Ameriku v roce 1492?",a:["Kryštof Kolumbus","Amerigo Vespucci","Fernando Magalhães","Vasco da Gama"],c:0},
{cat:"🏛️ Historie",q:"Ve kterém městě stojí Koloseum?",a:["Řím","Atény","Istanbul","Alexandrie"],c:0},
{cat:"🏛️ Historie",q:"Která civilizace postavila pyramidy v Gíze?",a:["Starověký Egypt","Mayové","Římané","Babyloňané"],c:0},
{cat:"🏛️ Historie",q:"Ve kterém roce padla Berlínská zeď?",a:["1989","1987","1990","1991"],c:0},
{cat:"🏛️ Historie",q:"Kdo byl prvním člověkem na Měsíci?",a:["Neil Armstrong","Buzz Aldrin","Jurij Gagarin","Alan Shepard"],c:0},
{cat:"🏛️ Historie",q:"Ve kterém století žil Leonardo da Vinci?",a:["15. století","16. století","14. století","17. století"],c:0},
{cat:"🏛️ Historie",q:"Která země postavila Velkou čínskou zeď?",a:["Čína","Mongolsko","Korea","Japonsko"],c:0},
{cat:"🏛️ Historie",q:"Ve kterém roce začala první světová válka?",a:["1914","1912","1916","1918"],c:0},
{cat:"🏛️ Historie",q:"Kdo napsal 95 tezí a zahájil reformaci?",a:["Martin Luther","Jan Hus","Jan Kalvín","Erasmus Rotterdamský"],c:0},
{cat:"🏛️ Historie",q:"Ve které zemi probíhala Velká francouzská revoluce?",a:["Francie","Anglie","Německo","Španělsko"],c:0},
{cat:"🏛️ Historie",q:"Který český král byl zvolen římským císařem jako Karel IV.?",a:["Václav (Karel)","Přemysl Otakar II.","Jan Lucemburský","Jiří z Poděbrad"],c:0},
{cat:"🏛️ Historie",q:"Ve kterém roce byl založen Karlův most?",a:["1357","1348","1380","1333"],c:0},
{cat:"🏛️ Historie",q:"Kdo byl Tutanchamon?",a:["Egyptský faraon","Řecký filozof","Římský císař","Perský král"],c:0},
{cat:"🏛️ Historie",q:"Ve kterém roce přistálo Apollo 11 na Měsíci?",a:["1969","1967","1971","1965"],c:0},
{cat:"🏛️ Historie",q:"Která bitva se odehrála roku 1805 u Slavkova?",a:["Bitva tří císařů","Bitva u Lipska","Bitva u Waterloo","Bitva u Trafalgaru"],c:0},
{cat:"🏛️ Historie",q:"Kdo byl prvním prezidentem USA?",a:["George Washington","Thomas Jefferson","Abraham Lincoln","John Adams"],c:0},
{cat:"🎵 Hudba",q:"Kolik strun má klasická kytara?",a:["6","4","8","12"],c:0},
{cat:"🎵 Hudba",q:"Který český skladatel napsal symfonii Z Nového světa?",a:["Antonín Dvořák","Bedřich Smetana","Leoš Janáček","Bohuslav Martinů"],c:0},
{cat:"🎵 Hudba",q:"Jak se jmenuje nejnižší mužský hlasový obor?",a:["Bas","Baryton","Tenor","Alt"],c:0},
{cat:"🎵 Hudba",q:"Který hudební nástroj má 88 kláves?",a:["Klavír","Varhany","Cembalo","Akordeon"],c:0},
{cat:"🎵 Hudba",q:"Ze které země pochází skupina ABBA?",a:["Švédsko","Norsko","Finsko","Dánsko"],c:0},
{cat:"🎵 Hudba",q:"Jak se jmenuje cyklus symfonických básní Bedřicha Smetany?",a:["Má vlast","Prodaná nevěsta","Libuše","Dalibor"],c:0},
{cat:"🎵 Hudba",q:"Kolik not má základní hudební stupnice?",a:["7","8","5","12"],c:0},
{cat:"🎵 Hudba",q:"Který zpěvák je znám přezdívkou 'Král popu'?",a:["Michael Jackson","Elvis Presley","Prince","Freddie Mercury"],c:0},
{cat:"🎵 Hudba",q:"Jak se nazývá hudební značka pro ticho?",a:["Pomlka","Pauza","Fermata","Koruna"],c:0},
{cat:"🎵 Hudba",q:"Ze které země pochází tango jako hudební a taneční žánr?",a:["Argentina","Španělsko","Brazílie","Kuba"],c:0},
{cat:"🎵 Hudba",q:"Který nástroj patří do skupiny žesťových?",a:["Trubka","Klarinet","Flétna","Hoboj"],c:0},
{cat:"🎵 Hudba",q:"Kdo složil operu Carmen?",a:["Georges Bizet","Giuseppe Verdi","Giacomo Puccini","Richard Wagner"],c:0},
{cat:"🎵 Hudba",q:"Jak se jmenuje česká zpěvačka, která reprezentovala ČR na Eurovision 2024?",a:["Aiko","Marta Jandová","Lucie Bílá","Ewa Farna"],c:0},
{cat:"🎵 Hudba",q:"Jaký hudební klíč se používá pro vyšší tóny?",a:["Houslový","Basový","Altový","Tenorový"],c:0},
{cat:"🎵 Hudba",q:"Která skupina nazpívala hit Bohemian Rhapsody?",a:["Queen","The Beatles","Led Zeppelin","Pink Floyd"],c:0},
{cat:"🎵 Hudba",q:"Kolik strun má housle?",a:["4","3","5","6"],c:0},
{cat:"🎵 Hudba",q:"Který hudební festival se každoročně koná v Trutnově?",a:["Trutnov Open Air","Rock for People","Colours of Ostrava","Sázavafest"],c:0},
{cat:"🐾 Příroda",q:"Které zvíře je nejrychlejší na souši?",a:["Gepard","Lev","Antilopa","Pštros"],c:0},
{cat:"🐾 Příroda",q:"Kolik nohou má pavouk?",a:["8","6","10","12"],c:0},
{cat:"🐾 Příroda",q:"Jak se nazývá samice koně?",a:["Klisna","Kobyla","Hříbě","Kůň"],c:0},
{cat:"🐾 Příroda",q:"Který pták je největší na světě?",a:["Pštros","Emu","Albatros","Kondor"],c:0},
{cat:"🐾 Příroda",q:"Kolik srdcí má chobotnice?",a:["3","2","1","4"],c:0},
{cat:"🐾 Příroda",q:"Ze kterého stromu padají žaludy?",a:["Dub","Buk","Lípa","Jasan"],c:0},
{cat:"🐾 Příroda",q:"Jak se nazývá proces přeměny housenky v motýla?",a:["Metamorfóza","Fotosyntéza","Hibernace","Migrace"],c:0},
{cat:"🐾 Příroda",q:"Které zvíře je symbolem WWF (Světového fondu na ochranu přírody)?",a:["Panda velká","Tygr","Slon","Nosorožec"],c:0},
{cat:"🐾 Příroda",q:"Kolik let může žít želva obrovská?",a:["Více než 100 let","50 let","70 let","30 let"],c:0},
{cat:"🐾 Příroda",q:"Který savec umí létat?",a:["Netopýr","Veverka létavá","Letucha","Kolibřík"],c:0},
{cat:"🐾 Příroda",q:"Jak se nazývá skupina vlků?",a:["Smečka","Stádo","Hejno","Kolonie"],c:0},
{cat:"🐾 Příroda",q:"Který hmyz vyrábí med?",a:["Včela","Čmelák","Vosa","Motýl"],c:0},
{cat:"🐾 Příroda",q:"Kolik krčních obratlů má žirafa?",a:["7","14","12","9"],c:0},
{cat:"🐾 Příroda",q:"Která rostlina chytá hmyz pomocí lepkavých listů?",a:["Rosnatka","Kopřiva","Bodlák","Šalvěj"],c:0},
{cat:"🐾 Příroda",q:"Ve kterém ročním období se ježci ukládají k zimnímu spánku?",a:["Podzim","Zima","Léto","Jaro"],c:0},
{cat:"🐾 Příroda",q:"Jak se jmenuje největší žijící plaz?",a:["Krokodýl mořský","Krajta síťovaná","Anakonda velká","Komodský varan"],c:0},
{cat:"🐾 Příroda",q:"Kolik párů křídel mají motýli?",a:["2","1","3","4"],c:0},
{cat:"💻 Technologie",q:"Co znamená zkratka HTML?",a:["HyperText Markup Language","High Tech Modern Language","Home Tool Markup Language","HyperText Machine Learning"],c:0},
{cat:"💻 Technologie",q:"Kdo založil společnost Microsoft?",a:["Bill Gates a Paul Allen","Steve Jobs a Steve Wozniak","Mark Zuckerberg","Larry Page a Sergey Brin"],c:0},
{cat:"💻 Technologie",q:"Ve kterém roce byl představen první iPhone?",a:["2007","2005","2009","2010"],c:0},
{cat:"💻 Technologie",q:"Co znamená zkratka Wi-Fi?",a:["Wireless Fidelity","Wired Finder","Wide Fiber","Wireless Fiber"],c:0},
{cat:"💻 Technologie",q:"Jaký programovací jazyk vytvořil Guido van Rossum?",a:["Python","Java","Ruby","JavaScript"],c:0},
{cat:"💻 Technologie",q:"Kolik bitů má jeden bajt?",a:["8","4","16","2"],c:0},
{cat:"💻 Technologie",q:"Která společnost vyrobila herní konzoli PlayStation?",a:["Sony","Nintendo","Microsoft","Sega"],c:0},
{cat:"💻 Technologie",q:"Co je to GPS?",a:["Globální polohový systém","Grafický procesní software","Generální programový server","Globální přenosový signál"],c:0},
{cat:"💻 Technologie",q:"Jak se jmenuje umělá inteligence od společnosti OpenAI?",a:["ChatGPT","Siri","Alexa","Cortana"],c:0},
{cat:"💻 Technologie",q:"Ve kterém roce vznikl Facebook?",a:["2004","2006","2002","2008"],c:0},
{cat:"💻 Technologie",q:"Co je blockchain?",a:["Decentralizovaná databáze","Antivirový program","Typ procesoru","Operační systém"],c:0},
{cat:"💻 Technologie",q:"Která společnost vyrábí procesory Ryzen?",a:["AMD","Intel","Nvidia","Qualcomm"],c:0},
{cat:"💻 Technologie",q:"Co znamená zkratka USB?",a:["Universal Serial Bus","Ultra Speed Bridge","Unified System Board","Universal System Byte"],c:0},
{cat:"💻 Technologie",q:"Kdo je zakladatelem Tesly?",a:["Elon Musk","Jeff Bezos","Tim Cook","Satya Nadella"],c:0},
{cat:"💻 Technologie",q:"Jak se nazývá nejpoužívanější mobilní operační systém na světě?",a:["Android","iOS","Windows","HarmonyOS"],c:0},
{cat:"💻 Technologie",q:"Kolik barev má jeden pixel na RGB displeji?",a:["3","4","2","1"],c:0},
{cat:"💻 Technologie",q:"Co znamená zkratka AI?",a:["Artificial Intelligence","Advanced Internet","Automated Input","Analog Interface"],c:0},
{cat:"📚 Literatura",q:"Kdo napsal Malého prince?",a:["Antoine de Saint-Exupéry","Jules Verne","Victor Hugo","Alexandre Dumas"],c:0},
{cat:"📚 Literatura",q:"Jak se jmenuje hlavní postava románu Robinson Crusoe?",a:["Robinson Crusoe","Lemuel Gulliver","Tom Sawyer","Oliver Twist"],c:0},
{cat:"📚 Literatura",q:"Kdo napsal Babičku?",a:["Božena Němcová","Karolína Světlá","Eliška Krásnohorská","Tereza Nováková"],c:0},
{cat:"📚 Literatura",q:"Ve které knize vystupuje Bilbo Pytlík?",a:["Hobit","Pán prstenů","Silmarillion","Nekonečný příběh"],c:0},
{cat:"📚 Literatura",q:"Kdo je autorem Sherlocka Holmese?",a:["Arthur Conan Doyle","Agatha Christie","Edgar Allan Poe","Raymond Chandler"],c:0},
{cat:"📚 Literatura",q:"Jak se jmenuje série knih o chlapci jménem Greg?",a:["Deník malého poseroutky","Deník Wimpy Kida","Gregor a předpověď","Percy Jackson"],c:0},
{cat:"📚 Literatura",q:"Kdo napsal Osudy dobrého vojáka Švejka?",a:["Jaroslav Hašek","Karel Čapek","Bohumil Hrabal","Milan Kundera"],c:0},
{cat:"📚 Literatura",q:"Která česká autorka napsala sérii Čarodějky z Eastwicku... ne, knihu Divá Bára?",a:["Božena Němcová","Karolína Světlá","Gabriela Preissová","Eliška Krásnohorská"],c:0},
{cat:"📚 Literatura",q:"Kdo napsal Válku s mloky?",a:["Karel Čapek","Jaroslav Hašek","Ivan Olbracht","Vladislav Vančura"],c:0},
{cat:"📚 Literatura",q:"Jak se jmenuje kouzelný svět v Letopisech Narnie?",a:["Narnie","Středozemě","Hogwarts","Čarosvět"],c:0},
{cat:"📚 Literatura",q:"Kdo je autorem Romea a Julie?",a:["William Shakespeare","Charles Dickens","Jane Austen","Oscar Wilde"],c:0},
{cat:"📚 Literatura",q:"Ve které knize se objevuje postava Dlouhý, Široký a Bystrozraký?",a:["České pohádky (Karel Jaromír Erben)","Kytice","Babička","Pohádky Bratří Grimmů"],c:0},
{cat:"📚 Literatura",q:"Kdo napsal Alenku v říši divů?",a:["Lewis Carroll","J. M. Barrie","Roald Dahl","Hans Christian Andersen"],c:0},
{cat:"📚 Literatura",q:"Jak se jmenuje robot v díle Karla Čapka R.U.R.?",a:["Robot (obecně)","Alquist","Helena","Domin"],c:0},
{cat:"📚 Literatura",q:"Kdo napsal Harryho Pottera?",a:["J. K. Rowlingová","Roald Dahl","C. S. Lewis","J. R. R. Tolkien"],c:0},
{cat:"📚 Literatura",q:"Která kniha začíná slovy 'Kdybych nebyl takový, jaký jsem...'? Ne, jak se jmenuje kniha od Astrid Lindgrenové o zrzavé dívce?",a:["Pipi Dlouhá punčocha","Děti z Bullerbynu","Emil z Lönnebergy","Bratři Lví srdce"],c:0},
{cat:"📚 Literatura",q:"Kdo napsal pohádku Sněhová královna?",a:["Hans Christian Andersen","Bratři Grimmové","Charles Perrault","Oscar Wilde"],c:0},
{cat:"🎨 Umění",q:"Kdo namaloval Monu Lisu?",a:["Leonardo da Vinci","Michelangelo","Raphael","Botticelli"],c:0},
{cat:"🎨 Umění",q:"Ve kterém městě se nachází galerie Louvre?",a:["Paříž","Londýn","Řím","Madrid"],c:0},
{cat:"🎨 Umění",q:"Jak se nazývá umělecký směr s tečkami, který založil Seurat?",a:["Pointilismus","Impresionismus","Kubismus","Fauvismus"],c:0},
{cat:"🎨 Umění",q:"Který umělec je známý obrazy s tající hodinkami?",a:["Salvador Dalí","Pablo Picasso","René Magritte","Andy Warhol"],c:0},
{cat:"🎨 Umění",q:"Jak se jmenuje slavná socha v New Yorku, dar od Francie?",a:["Socha Svobody","Sfinga","Myslitel","David"],c:0},
{cat:"🎨 Umění",q:"Který český malíř je autorem Slovanské epopeje?",a:["Alfons Mucha","Jan Zrzavý","Josef Čapek","Emil Filla"],c:0},
{cat:"🎨 Umění",q:"Co je to freska?",a:["Malba na vlhké omítce","Socha z bronzu","Rytina do kamene","Malba na plátně"],c:0},
{cat:"🎨 Umění",q:"Který umělecký směr reprezentuje Pablo Picasso?",a:["Kubismus","Realismus","Romantismus","Gotika"],c:0},
{cat:"🎨 Umění",q:"Jak se nazývá japonské umění skládání papíru?",a:["Origami","Ikebana","Bonsai","Manga"],c:0},
{cat:"🎨 Umění",q:"Kdo vytvořil sochu Davida ve Florencii?",a:["Michelangelo","Donatello","Bernini","Rodin"],c:0},
{cat:"🎨 Umění",q:"Ve kterém městě se nachází galerie Uffizi?",a:["Florencie","Řím","Benátky","Milán"],c:0},
{cat:"🎨 Umění",q:"Jak se nazývá umělecký styl secese v zahraničí?",a:["Art Nouveau","Art Deco","Bauhaus","Pop Art"],c:0},
{cat:"🎨 Umění",q:"Který malíř si uřízl ucho?",a:["Vincent van Gogh","Paul Gauguin","Claude Monet","Edvard Munch"],c:0},
{cat:"🎨 Umění",q:"Jak se jmenuje obraz Edvarda Muncha zobrazující křičící postavu?",a:["Výkřik","Křik","Zoufalství","Úzkost"],c:0},
{cat:"🎨 Umění",q:"Co je to vitráž?",a:["Obraz z barevného skla","Socha z mramoru","Malba na dřevě","Keramická mozaika"],c:0},
{cat:"🎨 Umění",q:"Který architekt navrhl chrám Sagrada Família v Barceloně?",a:["Antoni Gaudí","Le Corbusier","Frank Lloyd Wright","Zaha Hadid"],c:0},
{cat:"🎨 Umění",q:"Jak se nazývá technika malby vodovými barvami?",a:["Akvarel","Olej","Tempera","Pastel"],c:0}
];
  var sh=allQ.slice().sort(function(){return Math.random()-0.5});
  var qs=[];
  for(var i=0;i<15&&i<sh.length;i++){
    var it=sh[i],cor=it.a[it.c],sa=it.a.slice().sort(function(){return Math.random()-0.5});
    qs.push({cat:it.cat,q:it.q,a:sa,c:sa.indexOf(cor)});
  }
  return qs;
}
