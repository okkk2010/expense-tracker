import { createApp } from './app.js';

const port = Number(process.env.PORT || 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const app = await createApp({ logger: true });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
try {
  await app.listen({ host: process.env.HOST || '127.0.0.1', port });
} catch (error) {
  app.log.error({ message: error.message }, '서버를 시작하지 못했습니다.');
  await app.close();
  process.exitCode = 1;
}
