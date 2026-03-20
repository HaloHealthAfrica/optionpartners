const db = require('../src/config/database');
db.query("SELECT strategy, direction, contract_type FROM strategy_trade_recipe WHERE strategy LIKE 'reversal%'")
  .then(r => { console.log('Recipes:', r.rows); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
