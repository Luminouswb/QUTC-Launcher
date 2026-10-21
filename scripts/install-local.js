'use strict';

/**
 * 兼容旧命令，等价于 node scripts/setup.js。
 */

const { main } = require('./setup');

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
