import { it } from 'vitest';
import { createTestEnv } from './helpers';
it('dbg', async () => {
  const env = await createTestEnv();
  const o = await env.setupOwner('owner@example.com');
  const r = await o.client.post(`/api/w/${o.workspaceId}/connectors`, { provider: 'slack', mode: 'incoming_webhook', webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX', channelLabel: '#sales' });
  console.log('STATUS', r.status, r.raw);
  console.log(env.logs.filter(l => l.includes('"level":50')).join('\n').slice(0, 2000));
  await env.close();
});
