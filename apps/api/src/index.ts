import { Hono } from 'hono';

const app = new Hono();

app.get('/api/health', (c) => c.json({ status: 'ok' as const }));

export default app;
