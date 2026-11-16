import { config } from './config.js';
import { createApp } from './app.js';

const { server, db } = createApp();

server.listen(config.port, () => {
  console.log(`\n  TableX is running →  ${config.appUrl}`);
  console.log(`  Super Admin login →  ${config.superAdmin.phone} (password from SUPERADMIN_PASSWORD)\n`);
});

const shutdown = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
