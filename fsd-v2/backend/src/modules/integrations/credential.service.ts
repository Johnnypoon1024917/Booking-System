import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { IntegrationCredential, RoomMailbox } from './credential.entity';

// CredentialService — encrypted storage for third-party API secrets.
//
// Envelope format is identical to v1's src/infrastructure/integration/secret.go:
//
//   "enc:v1:" + base64( nonce(12) || ciphertext || gcm_tag(16) )
//
// The 32-byte AES key comes from INTEGRATION_SECRET_KEY (base64). In dev
// we fall back to an ephemeral key when ALLOW_DEV_INTEGRATION_EPHEMERAL=true
// so contributors can boot without provisioning. Mirrors v1's `obf:` /
// legacy plaintext fallbacks on the Reveal path so existing rows keep
// decrypting after a stack swap.
const ENVELOPE_PREFIX = 'enc:';
const LEGACY_XOR_PREFIX = 'obf:';
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_VERSION = 'v1';

@Injectable()
export class CredentialService implements OnModuleInit {
  private readonly log = new Logger(CredentialService.name);
  private key!: Buffer;

  constructor(
    @InjectRepository(IntegrationCredential)
    private readonly repo: Repository<IntegrationCredential>,
    @InjectRepository(RoomMailbox)
    private readonly mailboxes: Repository<RoomMailbox>,
  ) {}

  onModuleInit() {
    this.key = this.loadKey();
  }

  // --- key bootstrap ------------------------------------------------------

  private loadKey(): Buffer {
    const raw = process.env.INTEGRATION_SECRET_KEY;
    if (raw) {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === 32) return decoded;
      if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
        return Buffer.from(raw, 'hex');
      }
      throw new Error('INTEGRATION_SECRET_KEY must be base64- or hex-encoded 32 bytes');
    }
    if (
      String(process.env.ALLOW_DEV_INTEGRATION_EPHEMERAL).toLowerCase() === 'true' ||
      process.env.NODE_ENV === 'test'
    ) {
      this.log.warn(
        'INTEGRATION_SECRET_KEY not set — using ephemeral key. Stored ciphertext will be unrecoverable on restart.',
      );
      return crypto.randomBytes(32);
    }
    throw new Error(
      'INTEGRATION_SECRET_KEY is required (set ALLOW_DEV_INTEGRATION_EPHEMERAL=true for local dev)',
    );
  }

  // --- envelope encode / decode ------------------------------------------

  // obfuscate seals plaintext into the "enc:v1:<b64>" envelope. Empty
  // strings round-trip as empty so optional credential fields stay empty
  // in the DB (no spurious envelope bytes for a Google integration that
  // doesn't use clientId, etc).
  obfuscate(plaintext: string): string {
    if (!plaintext) return '';
    const nonce = crypto.randomBytes(NONCE_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: TAG_LEN });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const sealed = Buffer.concat([nonce, encrypted, tag]);
    return `${ENVELOPE_PREFIX}${KEY_VERSION}:${sealed.toString('base64')}`;
  }

  // reveal accepts:
  //   - "enc:<ver>:<b64>" — versioned AES-GCM envelope
  //   - "obf:<b64>"       — legacy rotating-XOR (pre-Phase 0)
  //   - anything else     — returned unchanged (legacy plaintext rows)
  reveal(stored: string): string {
    if (!stored) return '';
    if (stored.startsWith(ENVELOPE_PREFIX)) {
      const rest = stored.slice(ENVELOPE_PREFIX.length);
      const colon = rest.indexOf(':');
      if (colon < 0) throw new Error('malformed enc envelope');
      // Version not used yet — single key today — but kept for parity
      // with v1's rotation story.
      const b64 = rest.slice(colon + 1);
      const raw = Buffer.from(b64, 'base64');
      if (raw.length < NONCE_LEN + TAG_LEN) throw new Error('ciphertext too short');
      const nonce = raw.subarray(0, NONCE_LEN);
      const tag = raw.subarray(raw.length - TAG_LEN);
      const ct = raw.subarray(NONCE_LEN, raw.length - TAG_LEN);
      // Enforce the expected 16-byte GCM tag length (AUD-029): without an
      // explicit authTagLength Node accepts shorter forged tags, weakening the
      // integrity guarantee. Reject anything that isn't exactly TAG_LEN.
      if (tag.length !== TAG_LEN) throw new Error('invalid auth tag length');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce, { authTagLength: TAG_LEN });
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString('utf8');
    }
    if (stored.startsWith(LEGACY_XOR_PREFIX)) {
      const raw = Buffer.from(stored.slice(LEGACY_XOR_PREFIX.length), 'base64');
      const out = Buffer.alloc(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw[i] ^ this.key[i % this.key.length];
      return out.toString('utf8');
    }
    return stored;
  }

  // --- CRUD ---------------------------------------------------------------

  async list(tenantId: string) {
    const rows = await this.repo.find({ where: { tenantId }, order: { provider: 'ASC' } });
    // Never leak the encrypted blob to admin clients — the UI only needs
    // metadata + a "configured" flag.
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      azureTenantID: r.azureTenantID,
      clientID: r.clientID,
      hasSecret: !!r.clientSecret,
      isActive: r.isActive,
      lastTestOk: r.lastTestOk,
      lastTestError: r.lastTestError,
      lastTestedAt: r.lastTestedAt,
      updatedAt: r.updatedAt,
    }));
  }

  async get(tenantId: string, provider: string) {
    const row = await this.repo.findOne({ where: { tenantId, provider } });
    if (!row) throw new NotFoundException('credentials not configured');
    return row;
  }

  // getDecrypted is the workhorse for outbound API calls. Returns null
  // when the integration isn't configured so callers can no-op cleanly.
  async getDecrypted(tenantId: string, provider: string) {
    const row = await this.repo.findOne({ where: { tenantId, provider } });
    if (!row || !row.isActive) return null;
    return {
      ...row,
      clientSecret: row.clientSecret ? this.reveal(row.clientSecret) : '',
    };
  }

  async save(
    tenantId: string,
    provider: string,
    input: { azureTenantID?: string; clientID?: string; clientSecret?: string; isActive?: boolean },
  ) {
    const existing = await this.repo.findOne({ where: { tenantId, provider } });
    const payload: Partial<IntegrationCredential> = {
      tenantId,
      provider,
      azureTenantID: input.azureTenantID ?? existing?.azureTenantID ?? '',
      clientID: input.clientID ?? existing?.clientID ?? '',
      isActive: input.isActive ?? existing?.isActive ?? true,
    };
    // Empty / omitted secret on update means "keep the existing one" —
    // matches v1's admin UI which never echoes the secret back.
    if (input.clientSecret) payload.clientSecret = this.obfuscate(input.clientSecret);
    else if (!existing) payload.clientSecret = '';

    if (existing) {
      await this.repo.update({ id: existing.id }, payload);
      return this.repo.findOneByOrFail({ id: existing.id });
    }
    return this.repo.save(this.repo.create(payload));
  }

  async delete(tenantId: string, provider: string) {
    await this.repo.delete({ tenantId, provider });
  }

  async updateTestResult(tenantId: string, provider: string, ok: boolean, error: string) {
    await this.repo.update(
      { tenantId, provider },
      { lastTestOk: ok, lastTestError: error, lastTestedAt: new Date() },
    );
  }

  // --- mailbox map --------------------------------------------------------

  listMailboxes(tenantId: string) {
    return this.mailboxes.find({ where: { tenantId }, order: { mailboxUPN: 'ASC' } });
  }

  mailboxForResource(resourceId: string) {
    return this.mailboxes.findOne({ where: { resourceId } });
  }

  async saveMailbox(
    tenantId: string,
    input: { resourceId: string; mailboxUPN: string; displayName?: string; isActive?: boolean },
  ) {
    const existing = await this.mailboxes.findOne({ where: { resourceId: input.resourceId } });
    if (existing) {
      await this.mailboxes.update(
        { id: existing.id },
        {
          mailboxUPN: input.mailboxUPN,
          displayName: input.displayName ?? existing.displayName,
          isActive: input.isActive ?? true,
        },
      );
      return this.mailboxes.findOneByOrFail({ id: existing.id });
    }
    return this.mailboxes.save(
      this.mailboxes.create({
        tenantId,
        resourceId: input.resourceId,
        mailboxUPN: input.mailboxUPN,
        displayName: input.displayName ?? '',
        isActive: input.isActive ?? true,
      }),
    );
  }

  async deleteMailbox(resourceId: string) {
    const existing = await this.mailboxes.findOne({ where: { resourceId } });
    if (!existing) return null;
    await this.mailboxes.delete({ id: existing.id });
    return existing;
  }
}
