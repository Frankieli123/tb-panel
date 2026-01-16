import dotenv from 'dotenv';

dotenv.config();

void (async () => {
  await import('./agentMain.js');
})();
