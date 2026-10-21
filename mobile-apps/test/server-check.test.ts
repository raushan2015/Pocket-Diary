import { describe, it, expect } from 'vitest';
import { probeServer } from '@/services/api/server-check';
import { ApiClient } from '@/services/api/client';
import { MockHttpTransport } from './helpers/mock-transport';

describe('Server probe & capability discovery', () => {
  it('detects a modern Pocket Diary instance with system capabilities', async () => {
    const transport = new MockHttpTransport().on('/api/v1/system/info', () =>
      MockHttpTransport.json(200, {
        name: 'pocket-diary',
        version: '1.0.0',
        apiPrefix: '/api/v1',
        capabilities: { memoClientId: true },
      }),
    );

    const api = new ApiClient({ baseUrl: 'https://notes.example.com', transport });
    const res = await probeServer(api);

    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.info?.name).toBe('pocket-diary');
      expect(res.info?.capabilities.memoClientId).toBe(true);
    }
  });

  it('falls back to /health for legacy Pocket Diary servers', async () => {
    const transport = new MockHttpTransport()
      .on('/api/v1/system/info', () => MockHttpTransport.json(404, { error: 'Not Found' }))
      .on('/health', () => MockHttpTransport.json(200, { status: 'ok', timestamp: Date.now() }));

    const api = new ApiClient({ baseUrl: 'https://legacy-notes.example.com', transport });
    const res = await probeServer(api);

    expect(res.status).toBe('legacy-ok');
    if (res.status === 'legacy-ok') {
      expect(res.info).toBeNull();
    }
  });

  it('rejects wrong product name as incompatible', async () => {
    const transport = new MockHttpTransport().on('/api/v1/system/info', () =>
      MockHttpTransport.json(200, {
        name: 'other-app',
        version: '2.0.0',
        apiPrefix: '/api',
        capabilities: {},
      }),
    );

    const api = new ApiClient({ baseUrl: 'https://other.example.com', transport });
    const res = await probeServer(api);

    expect(res.status).toBe('incompatible');
    if (res.status === 'incompatible') {
      expect(res.code).toBe('parse');
    }
  });

  it('detects HTML responses (e.g. web frontends or portal logins) as not-json', async () => {
    const transport = new MockHttpTransport()
      .on('/api/v1/system/info', () => MockHttpTransport.html(200))
      .on('/health', () => MockHttpTransport.html(200));

    const api = new ApiClient({ baseUrl: 'https://webpage.example.com', transport });
    const res = await probeServer(api);

    expect(res.status).toBe('incompatible');
    if (res.status === 'incompatible') {
      expect(res.code).toBe('not-json');
    }
  });

  it('surfaces network failures as unreachable', async () => {
    const transport = new MockHttpTransport().on(/./, () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9999');
    });

    const api = new ApiClient({ baseUrl: 'http://localhost:9999', transport });
    const res = await probeServer(api);

    expect(res.status).toBe('unreachable');
    if (res.status === 'unreachable') {
      expect(res.code).toBe('network');
    }
  });

  it('detects servers that demand auth before identifying themselves as incompatible', async () => {
    const transport = new MockHttpTransport().on('/api/v1/system/info', () =>
      MockHttpTransport.json(401, { error: 'Unauthorized', message: 'Sign-in required' }),
    );

    const api = new ApiClient({ baseUrl: 'https://auth-wall.example.com', transport });
    const res = await probeServer(api);

    expect(res.status).toBe('incompatible');
    if (res.status === 'incompatible') {
      expect(res.code).toBe('auth-required');
    }
  });
});
