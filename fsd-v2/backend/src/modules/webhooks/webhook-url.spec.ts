import { assertSafeIP, validateWebhookTargetURL } from './webhook-url';

describe('webhook SSRF address rules', () => {
  describe('assertSafeIP', () => {
    it('rejects RFC1918 / loopback / link-local IPv4', () => {
      for (const ip of ['10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1', '169.254.169.254', '0.0.0.0']) {
        expect(() => assertSafeIP(ip)).toThrow();
      }
    });

    it('rejects cloud-metadata IPs', () => {
      expect(() => assertSafeIP('169.254.169.254')).toThrow();
      expect(() => assertSafeIP('fd00:ec2::254')).toThrow();
    });

    it('rejects IPv6 loopback / ULA / link-local', () => {
      for (const ip of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1']) {
        expect(() => assertSafeIP(ip)).toThrow();
      }
    });

    it('rejects IPv4-mapped IPv6 that tunnels a blocked v4 (the rebinding fix)', () => {
      // dotted form
      expect(() => assertSafeIP('::ffff:169.254.169.254')).toThrow();
      expect(() => assertSafeIP('::ffff:127.0.0.1')).toThrow();
      expect(() => assertSafeIP('::ffff:10.0.0.1')).toThrow();
      // hex form of 127.0.0.1 (0x7f00:0001)
      expect(() => assertSafeIP('::ffff:7f00:0001')).toThrow();
      // hex form of 169.254.169.254 (0xa9fe:a9fe)
      expect(() => assertSafeIP('::ffff:a9fe:a9fe')).toThrow();
    });

    it('allows public IPv4 and IPv6', () => {
      expect(() => assertSafeIP('8.8.8.8')).not.toThrow();
      expect(() => assertSafeIP('2001:4860:4860::8888')).not.toThrow();
      // a public address that happens to be IPv4-mapped
      expect(() => assertSafeIP('::ffff:8.8.8.8')).not.toThrow();
    });
  });

  describe('validateWebhookTargetURL', () => {
    it('rejects non-https and userinfo', async () => {
      await expect(validateWebhookTargetURL('http://8.8.8.8/hook')).rejects.toThrow();
      await expect(validateWebhookTargetURL('https://user:pw@8.8.8.8/hook')).rejects.toThrow();
    });

    it('rejects private IP literals and blocked hostnames', async () => {
      await expect(validateWebhookTargetURL('https://10.0.0.1/hook')).rejects.toThrow();
      await expect(validateWebhookTargetURL('https://localhost/hook')).rejects.toThrow();
      await expect(validateWebhookTargetURL('https://169.254.169.254/latest')).rejects.toThrow();
    });

    it('accepts a public IP-literal https target', async () => {
      await expect(validateWebhookTargetURL('https://8.8.8.8/hook')).resolves.toBeUndefined();
    });
  });
});
