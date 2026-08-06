import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config({ path: './.env.local' });
const { replayDecision, summariseReplay, REPLAY_OUTCOME } = await import('./wouldTradeReplay.js');
const c = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT)||3306 });
const [dec] = await c.query(
  `SELECT id,strategy,symbol,timeframe,direction,order_type,entry_price,stop_loss,
          take_profit_1,take_profit_3,status,risk_amount,created_at,expires_at
     FROM mt5_auto_trades WHERE fill_price IS NULL AND entry_price IS NOT NULL
       AND stop_loss IS NOT NULL AND take_profit_1 IS NOT NULL ORDER BY created_at`);
console.log(`replaying ${dec.length} never-traded decisions...\n`);
// candle cache per symbol+tf
const cache = new Map();
async function bars(sym, tf, fromIso){
  const k = sym+tf;
  if(!cache.has(k)){
    const [r]=await c.query(`SELECT candle_time, high, low FROM mt5_candles WHERE symbol=? AND timeframe=? ORDER BY candle_time ASC`,[sym,tf]);
    cache.set(k, r.map(x=>({ts:Date.parse(x.candle_time), high:+x.high, low:+x.low})));
  }
  const all=cache.get(k); const from=Date.parse(fromIso);
  const i=all.findIndex(b=>b.ts>=from);
  return i<0? [] : all.slice(i, i+400);
}
const out=[];
for(const d of dec){
  const b = await bars(d.symbol, d.timeframe, d.created_at);
  out.push({ ...d, ...replayDecision(d, b) });
}
const s = summariseReplay(out, {riskPerTrade:80});
console.log('=== IF EVERY NEVER-TRADED DECISION HAD BEEN TAKEN ===');
console.log(`  replayed      ${s.replayed}`);
console.log(`  settled       ${s.settled}   (win ${s.wins} / loss ${s.losses})`);
console.log(`  NEVER FILLED  ${s.neverFilled}   <- price never reached the entry`);
console.log(`  still open    ${s.stillOpen}   no data ${s.noData}   invalid ${s.invalid}`);
console.log(`  win rate      ${s.winRate!==null?(s.winRate*100).toFixed(1)+'%':'—'}`);
console.log(`  expectancy    ${s.expectancyR}R per settled trade`);
console.log(`  net           ${s.netR}R  = $${s.estimatedProfit} at a constant $80 risk`);
console.log('\n=== by original status ===');
for(const st of [...new Set(out.map(x=>x.status))]){
  const g=out.filter(x=>x.status===st); const gs=summariseReplay(g,{riskPerTrade:80});
  console.log('  '+st.padEnd(12)+String(gs.replayed).padStart(4)+'  settled '+String(gs.settled).padStart(3)
    +'  neverFilled '+String(gs.neverFilled).padStart(3)
    +'  exp '+String(gs.expectancyR).padStart(7)+'R  net $'+String(gs.estimatedProfit).padStart(8));
}
console.log('\n=== by order type ===');
for(const ot of [...new Set(out.map(x=>x.order_type))]){
  const g=out.filter(x=>x.order_type===ot); const gs=summariseReplay(g,{riskPerTrade:80});
  console.log('  '+String(ot).padEnd(14)+String(gs.replayed).padStart(4)+'  fillRate '+(gs.fillRate*100).toFixed(0)+'%  exp '+String(gs.expectancyR).padStart(7)+'R');
}
await c.end();
