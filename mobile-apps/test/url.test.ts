import { describe, it, expect } from 'vitest';
import { normalizeServerUrl } from '@/utils/url';

describe('Server URL normalization & security policy', () => {
  it('rejects empty input', () => {
    const res = normalizeServerUrl('   ');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('empty');
  });

  it('normalizes public domains to HTTPS by default', () => {
    const res = normalizeServerUrl('notes.example.com');
    expect(res.ok).toBe(true);
    expect(res.normalized).toBe('https://notes.example.com');
    expect(res.origin).toBe('https://notes.example.com');
    expect(res.requiresAcknowledgement).toBe(false);
  });

  it('strips trailing slashes from path', () => {
    const res = normalizeServerUrl('https://diary.mycompany.org/api/v1///');
    expect(res.ok).toBe(true);
    expect(res.normalized).toBe('https://diary.mycompany.org/api/v1');
  });

  it('permits plain HTTP on loopback development hosts without warning', () => {
    const localhost = normalizeServerUrl('http://localhost:3000');
    expect(localhost.ok).toBe(true);
    expect(localhost.insecureAllowed).toBe(true);
    expect(localhost.requiresAcknowledgement).toBe(false);

    const ip = normalizeServerUrl('127.0.0.1:8080');
    expect(ip.ok).toBe(true);
    expect(ip.normalized).toBe('http://127.0.0.1:8080');
    expect(ip.insecureAllowed).toBe(true);

    const emu = normalizeServerUrl('http://10.0.2.2:3000');
    expect(emu.ok).toBe(true);
    expect(emu.insecureAllowed).toBe(true);
  });

  it('permits plain HTTP on LAN RFC1918 IPs only with explicit acknowledgement', () => {
    const lan = normalizeServerUrl('http://192.168.1.150:8080');
    expect(lan.ok).toBe(true);
    expect(lan.insecureAllowed).toBe(true);
    expect(lan.requiresAcknowledgement).toBe(true);

    const lan10 = normalizeServerUrl('10.1.2.3:4000');
    expect(lan10.ok).toBe(true);
    expect(lan10.normalized).toBe('http://10.1.2.3:4000');
    expect(lan10.requiresAcknowledgement).toBe(true);
  });

  it('rejects plain HTTP for non-loopback, non-private public servers', () => {
    const res = normalizeServerUrl('http://pocketdiary.cloud');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('https-required');
  });

  it('rejects non-http(s) schemes', () => {
    const res = normalizeServerUrl('ftp://notes.example.com');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('scheme');
  });
});
