'use strict';
const config = require('./config');
const { createApp } = require('./app');

const app = createApp();
app.listen(config.port, () => {
  console.log(`TrustVault listening on port ${config.port} (${config.env})`);
});
