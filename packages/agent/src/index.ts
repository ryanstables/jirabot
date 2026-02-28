import { createInngestServer } from './inngest.js';

const PORT = Number(process.env['PORT'] ?? '3001');

const server = createInngestServer(PORT);

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
