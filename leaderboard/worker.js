/**
 * Wick and the Dark Station: global leaderboard API
 * Runs on Cloudflare Workers with a D1 (SQLite) database bound as "DB".
 *
 * How scores are protected:
 *  - The player's program (their blocks) is sent with every score.
 *  - This server replays the program with the SAME game engine the game uses.
 *    A score is accepted only if the program really reaches the switch,
 *    and the block count is counted here, not trusted from the player.
 *  - Time, hints and retries are reported by the player's device (honor system),
 *    but they are clamped to sensible ranges.
 *
 * Endpoints
 *   GET  /top?board=total|1..5      top 50 (send header x-pid to be marked as "you")
 *   POST /submit                    { pid, name, lang, runs:[{i,main,fn,hints,fails,sec}] }
 *   POST /delete                    { pid }            remove my own scores
 *   POST /admin/remove              header x-admin-token, body { pid } or { name }
 */

/* ===== game engine (copied from the game, do not edit) ===== */
const ORDER = ['en','ar','fr','es','pt','de','it','tr','ru','zh','ja','ko'];

var CHAPTERS = [
  { grid:['      ','S...  ','   .  ','   G  '], par:6, palette:['forward','left','right'], sp:'nww' },
  { grid:['S.    ',' ..   ','  ..  ','   .. ','    ..','     G'], par:5, palette:['forward','left','right','repeat'], sp:'nw' },
  { grid:['############','S..P..P..P.G','############'], par:4, cond:'puddle', palette:['forward','left','right','jump','repeat','until','if'], sp:'nww' },
  { grid:['S.         ',' ...       ','   ....    ','      .....','          G'], par:7, useVar:true, palette:['forward','left','right','repeat','set','add','forwardn'], sp:'nww' },
  { grid:['##############','##...#...#...#','S..X...X...X.G'], par:12, cond:'crate', useFn:true, palette:['forward','left','right','repeat','until','if','call'], sp:'nww' }
];
var CODES = ['forward()\nturn_right()\nforward()','for _ in range(5):\n    forward()\n    turn_right()','if puddle_ahead():\n    jump()\nelse:\n    forward()','n = 1\nforward(n)\nn = n + 1','def detour():\n    turn_left()\n    forward()\n\ndetour()'];
var DIRS = [[0,-1],[1,0],[0,1],[-1,0]];
var SKINS = [
  {l:['#2f5964','#183840'], d:['#d6e6e1','#6f9a9b']},
  {l:['#c4492f','#7a2616'], d:['#ff9d85','#c4573f']},
  {l:['#2f8a5b','#175034'], d:['#9be3bd','#4aa57a']},
  {l:['#6b4bb3','#3b2670'], d:['#c7b2ff','#7f64cc']},
  {l:['#b57a0b','#6b4400'], d:['#ffd27a','#c99a2e']},
  {l:['#c43d7a','#7a1b48'], d:['#ffa6cc','#d0679a']}
];
function parseGrid(rows){
  var h = rows.length, w = rows[0].length, g = [], start = null;
  for(var y=0;y<h;y++){
    g.push([]);
    for(var x=0;x<w;x++){
      var c = rows[y].charAt(x) || ' ';
      if(c==='S'){ start = {x:x,y:y}; c = '.'; }
      g[y].push(c);
    }
  }
  return {w:w,h:h,g:g,start:start};
}
CHAPTERS.forEach(function(c){ c.parsed = parseGrid(c.grid); c.startRot = 90; });

/* ================================================================
   Engine: runs a program one action at a time (a generator)
   ================================================================ */
function Fail(key, hit){ this.key = key; this.hit = hit || null; }
function Win(){}
function tileAt(grid,x,y){ if(x<0||y<0||x>=grid.w||y>=grid.h) return ' '; return grid.g[y][x]; }
function dirOf(ctx){ return (((ctx.rot/90)%4)+4)%4; }
function newCtx(level, fnList){
  var s = level.parsed.start;
  return {level:level, grid:level.parsed, x:s.x, y:s.y, rot:level.startRot, n:null, ticks:0, stack:[], fn:fnList, zap:false, check:null, errNode:null};
}
function ahead(ctx,k){ var d = DIRS[dirOf(ctx)]; return {x:ctx.x+d[0]*k, y:ctx.y+d[1]*k}; }
function needVar(ctx){ if(ctx.n===null) throw new Fail('e_var'); }
function* moveOne(ctx,node){
  var p = ahead(ctx,1), t = tileAt(ctx.grid,p.x,p.y);
  if(t===' ') throw new Fail('e_edge');
  if(t==='#') throw new Fail('e_wall', p);
  if(t==='X') throw new Fail('e_crate', p);
  ctx.x = p.x; ctx.y = p.y;
  if(t==='P'){ ctx.zap = true; throw new Fail('e_puddle', p); }
  if(t==='G') throw new Win();
  yield {id:node.id};
}
function* doForward(ctx,node,k){ for(var i=0;i<k;i++){ yield* moveOne(ctx,node); } }
function* doJump(ctx,node){
  var m = ahead(ctx,1), l = ahead(ctx,2);
  var tm = tileAt(ctx.grid,m.x,m.y), tl = tileAt(ctx.grid,l.x,l.y);
  if(tm==='#'||tm==='X') throw new Fail('e_jmid', m);
  if(tl===' ') throw new Fail('e_jedge');
  if(tl==='#') throw new Fail('e_jwall', l);
  if(tl==='X') throw new Fail('e_jcrate', l);
  ctx.x = l.x; ctx.y = l.y;
  if(tl==='P'){ ctx.zap = true; throw new Fail('e_jpuddle', l); }
  if(tl==='G') throw new Win();
  yield {id:node.id};
}
function checkCond(ctx,cond){
  var p = ahead(ctx,1), t = tileAt(ctx.grid,p.x,p.y);
  if(cond==='puddle') return t==='P';
  if(cond==='crate') return t==='X';
  return false;
}
function* execList(list,ctx){ for(var i=0;i<list.length;i++){ yield* execNode(list[i],ctx); } }
function* execNode(node,ctx){
  if(++ctx.ticks>4000) throw new Fail('e_many');
  ctx.stack.push(node.id);
  try{
    switch(node.type){
      case 'forward': yield* doForward(ctx,node,1); break;
      case 'forwardn': needVar(ctx); yield* doForward(ctx,node,Math.min(ctx.n,60)); break;
      case 'jump': yield* doJump(ctx,node); break;
      case 'left': ctx.rot -= 90; yield {id:node.id}; break;
      case 'right': ctx.rot += 90; yield {id:node.id}; break;
      case 'set': ctx.n = node.k; yield {id:node.id}; break;
      case 'add': needVar(ctx); ctx.n += 1; yield {id:node.id}; break;
      case 'repeat':
        for(var i=0;i<node.count;i++){ yield* execList(node.body,ctx); }
        break;
      case 'until': {
        if(node.body.length===0) throw new Fail('e_untilempty');
        var seen = {}, guard = 0;
        while(true){
          var key = ctx.x+','+ctx.y+','+((((ctx.rot%360)+360)%360))+','+ctx.n;
          if(seen[key] || ++guard>400) throw new Fail('e_loop');
          seen[key] = true;
          yield* execList(node.body,ctx);
        }
      }
      case 'if': {
        var res = checkCond(ctx,node.cond);
        ctx.check = {id:node.id, cond:node.cond, res:res};
        yield {id:node.id, check:true};
        yield* execList(res ? node.body : node.elseBody, ctx);
        break;
      }
      case 'call':
        if(ctx.fn.length===0) throw new Fail('e_fnempty');
        yield {id:node.id};
        yield* execList(ctx.fn,ctx);
        break;
    }
  }catch(e){
    if(e instanceof Fail && !ctx.errNode) ctx.errNode = node.id;
    throw e;
  }finally{
    ctx.stack.pop();
  }
}
function simulate(level, main, fn){
  var ctx = newCtx(level, fn||[]), gen = execList(main,ctx), steps = 0;
  try{
    while(true){
      var r = gen.next();
      if(r.done) return {result:'done', ctx:ctx, steps:steps};
      if(++steps>6000) return {result:'timeout', ctx:ctx, steps:steps};
    }
  }catch(e){
    if(e instanceof Win) return {result:'won', ctx:ctx, steps:steps};
    if(e instanceof Fail) return {result:'fail', msg:e.key, ctx:ctx, steps:steps};
    throw e;
  }
}
function scoreFor(par, used, sec, hints, fails){
  var eff = Math.max(-300, Math.min(400, (par-used)*100));
  var speed = Math.max(0, Math.round(300-Math.max(0,sec-par*6)*3));
  var h = hints*100, r = Math.min(250, fails*25);
  var total = Math.max(100, 1000+eff+speed-h-r); total = Math.round(total/5)*5;
  return {total:total, eff:eff, speed:speed, hints:h, retries:r};
}

/* ===== end of game engine ===== */

const COLS = { total:'total', 1:'s1', 2:'s2', 3:'s3', 4:'s4', 5:'s5' };
const hits = new Map();   // best-effort rate limit per isolate

function cors(env){
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-pid,x-admin-token',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store'
  };
}
function json(env, status, data){
  return new Response(JSON.stringify(data), { status, headers: { ...cors(env), 'Content-Type': 'application/json' } });
}
function bad(msg){ const e = new Error(msg); e.status = 422; return e; }
function int(v, lo, hi){ v = Math.floor(Number(v)); if(!isFinite(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }

function cleanName(raw, pid){
  let n = String(raw == null ? '' : raw).normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n || ('Player ' + pid.slice(0, 4));
}
function cleanList(list, level, depth, counter){
  if(!Array.isArray(list) || depth > 6) throw bad('program');
  return list.map(function(n){
    if(!n || typeof n !== 'object') throw bad('node');
    if(++counter.n > 80) throw bad('too many blocks');
    const type = String(n.type);
    if(level.palette.indexOf(type) < 0) throw bad('block not allowed here');
    const o = { id: 's' + counter.n, type: type };
    if(type === 'repeat'){ o.count = int(n.count, 1, 20); o.body = cleanList(n.body, level, depth+1, counter); }
    else if(type === 'until'){ o.body = cleanList(n.body, level, depth+1, counter); }
    else if(type === 'if'){
      if(!level.cond) throw bad('if not allowed');
      o.cond = level.cond; o.body = cleanList(n.body, level, depth+1, counter); o.elseBody = cleanList(n.elseBody, level, depth+1, counter);
    }
    else if(type === 'set'){ o.k = int(n.k, 0, 9); }
    return o;
  });
}
function count(list){ let c = 0; list.forEach(function(n){ c++; if(n.body) c += count(n.body); if(n.elseBody) c += count(n.elseBody); }); return c; }

function verifyRun(run){
  const i = int(run && run.i, 0, 4), level = CHAPTERS[i], counter = { n: 0 };
  const main = cleanList(run.main, level, 0, counter);
  const fn = level.useFn ? cleanList(run.fn || [], level, 0, counter) : [];
  const sim = simulate(level, main, fn);
  if(sim.result !== 'won') throw bad('solution does not reach the switch (chapter ' + (i+1) + ')');
  const blocks = count(main) + count(fn);
  const sec = Math.max(Math.max(3, blocks * 1.2), Math.min(3600, Number(run.sec) || 3600));
  const hints = int(run.hints, 0, 2), fails = int(run.fails, 0, 60);
  return { i, score: scoreFor(level.par, blocks, sec, hints, fails).total, blocks };
}

async function submit(req, env){
  const raw = await req.text();
  if(raw.length > 40000) throw bad('too large');
  let body; try{ body = JSON.parse(raw); }catch(e){ throw bad('json'); }
  const pid = String(body.pid || '');
  if(!/^[a-f0-9]{16,64}$/.test(pid)) throw bad('pid');
  if(!Array.isArray(body.runs) || !body.runs.length || body.runs.length > 5) throw bad('runs');
  const lang = ORDER.indexOf(body.lang) > -1 ? body.lang : 'en';
  const name = cleanName(body.name, pid);
  const seen = {}, scores = {};
  body.runs.forEach(function(r){
    const v = verifyRun(r);
    if(seen[v.i]) throw bad('duplicate chapter'); seen[v.i] = 1; scores[v.i] = v.score;
  });
  const old = await env.DB.prepare('SELECT s1,s2,s3,s4,s5 FROM players WHERE pid = ?').bind(pid).first();
  const best = [1,2,3,4,5].map(function(k, idx){
    const prev = old ? Number(old['s'+k]) || 0 : 0;
    return Math.max(prev, scores[idx] || 0);
  });
  const total = best.reduce(function(a,b){ return a+b; }, 0);
  await env.DB.prepare(
    'INSERT INTO players (pid,name,lang,s1,s2,s3,s4,s5,total,updated) VALUES (?,?,?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(pid) DO UPDATE SET name=excluded.name, lang=excluded.lang, s1=excluded.s1, s2=excluded.s2, s3=excluded.s3, s4=excluded.s4, s5=excluded.s5, total=excluded.total, updated=excluded.updated'
  ).bind(pid, name, lang, best[0], best[1], best[2], best[3], best[4], total, Math.floor(Date.now()/1000)).run();
  const above = await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE total > ?').bind(total).first();
  return { ok: true, total, best, rank: (above ? above.n : 0) + 1 };
}

async function top(url, req, env){
  const b = url.searchParams.get('board') || 'total', col = COLS[b];
  if(!col) throw bad('board');
  const me = req.headers.get('x-pid') || '';
  const rows = (await env.DB.prepare('SELECT pid,name,lang,' + col + ' AS score FROM players WHERE ' + col + ' > 0 ORDER BY ' + col + ' DESC, updated ASC LIMIT 50').bind().all()).results || [];
  const entries = rows.map(function(r, i){ return { rank: i+1, name: r.name, score: r.score, lang: r.lang, you: !!me && r.pid === me }; });
  const out = { board: b, entries };
  if(me && /^[a-f0-9]{16,64}$/.test(me) && !entries.some(function(e){ return e.you; })){
    const mine = await env.DB.prepare('SELECT ' + col + ' AS score FROM players WHERE pid = ?').bind(me).first();
    if(mine && mine.score > 0){
      const above = await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE ' + col + ' > ?').bind(mine.score).first();
      out.me = { rank: (above ? above.n : 0) + 1, score: mine.score };
    }
  }
  return out;
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    try{
      if(req.method === 'POST'){
        const ip = req.headers.get('cf-connecting-ip') || 'x', now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
        if(now - h.t > 60000){ h.n = 0; h.t = now; }
        if(++h.n > 30) return json(env, 429, { error: 'slow down' });
        hits.set(ip, h);
        if(hits.size > 5000) hits.clear();
      }
      if(url.pathname === '/top' && req.method === 'GET') return json(env, 200, await top(url, req, env));
      if(url.pathname === '/submit' && req.method === 'POST') return json(env, 200, await submit(req, env));
      if(url.pathname === '/delete' && req.method === 'POST'){
        let b; try{ b = JSON.parse(await req.text()); }catch(e){ throw bad('json'); }
        if(!/^[a-f0-9]{16,64}$/.test(String(b.pid || ''))) throw bad('pid');
        await env.DB.prepare('DELETE FROM players WHERE pid = ?').bind(String(b.pid)).run();
        return json(env, 200, { ok: true });
      }
      if(url.pathname === '/admin/remove' && req.method === 'POST'){
        if(!env.ADMIN_TOKEN || req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json(env, 401, { error: 'unauthorized' });
        let b; try{ b = JSON.parse(await req.text()); }catch(e){ throw bad('json'); }
        if(b.pid) await env.DB.prepare('DELETE FROM players WHERE pid = ?').bind(String(b.pid)).run();
        else if(b.name) await env.DB.prepare('DELETE FROM players WHERE name = ?').bind(String(b.name)).run();
        else throw bad('pid or name');
        return json(env, 200, { ok: true });
      }
      if(url.pathname === '/') return json(env, 200, { ok: true, service: 'wick-leaderboard' });
      return json(env, 404, { error: 'not found' });
    }catch(e){
      return json(env, e.status || 500, { error: e.status ? e.message : 'server error' });
    }
  }
};
