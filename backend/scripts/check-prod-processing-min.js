const{Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
(async()=>{
var r=await p.query("SELECT status,indicator_source,raw_payload->>'ticker' as t,raw_payload->>'symbol' as s,substring(error_message,1,80) as err FROM webhook_events WHERE received_at>NOW()-INTERVAL '60 minutes' ORDER BY received_at DESC LIMIT 20");
console.log("EVENTS("+r.rows.length+"):");r.rows.forEach(function(e){console.log(" "+e.status+" | "+(e.indicator_source||"?")+" | "+(e.t||e.s||"?")+" | "+(e.err||"-"))});
r=await p.query("SELECT symbol,direction,strategy,intelligence_score as sc,allowed,substring(rejection_reason,1,60) as rej FROM intelligence_verdicts WHERE created_at>NOW()-INTERVAL '60 minutes' ORDER BY created_at DESC LIMIT 20");
console.log("VERDICTS("+r.rows.length+"):");r.rows.forEach(function(v){console.log(" "+(v.allowed?"OK":"NO")+" | "+v.symbol+" | "+v.direction+" | "+v.strategy+" | sc="+v.sc+" | "+(v.rej||"-"))});
r=await p.query("SELECT symbol,strategy,gate,substring(reason,1,70) as rsn FROM signal_rejections WHERE created_at>NOW()-INTERVAL '60 minutes' ORDER BY created_at DESC LIMIT 20");
console.log("REJECTIONS("+r.rows.length+"):");r.rows.forEach(function(x){console.log(" "+x.gate+" | "+(x.symbol||"?")+" | "+x.strategy+" | "+x.rsn)});
r=await p.query("SELECT symbol,side,contract_type,strategy,status,indicator_source FROM sim_orders WHERE created_at>NOW()-INTERVAL '60 minutes' ORDER BY created_at DESC LIMIT 10");
console.log("ORDERS("+r.rows.length+"):");r.rows.forEach(function(o){console.log(" "+o.status+" | "+o.symbol+" | "+o.side+" | "+o.contract_type+" | "+o.strategy+" | "+o.indicator_source)});
r=await p.query("SELECT symbol,direction,setup,score,entry,target,stop FROM strat_alerts WHERE created_at>NOW()-INTERVAL '60 minutes' ORDER BY created_at DESC LIMIT 10");
console.log("STRAT_ALERTS("+r.rows.length+"):");r.rows.forEach(function(a){console.log(" "+a.symbol+" | "+a.direction+" | "+a.setup+" | sc="+a.score+" | E="+a.entry+" T="+a.target+" S="+a.stop)});
await p.end()})().catch(function(e){console.error(e.message);process.exit(1)});
