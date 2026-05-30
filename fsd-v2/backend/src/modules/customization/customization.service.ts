import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customization, defaultCustomization } from './customization.entity';

@Injectable()
export class CustomizationService {
  constructor(@InjectRepository(Customization) private readonly repo: Repository<Customization>) {}

  async get(tenantId: string) {
    const row = await this.repo.findOne({ where: { tenantId } });
    // _version is the OCC token the SPA must echo back on save. It's surfaced
    // alongside the (default-merged) config, not stored inside the JSONB blob.
    return { ...defaultCustomization, ...(row?.data ?? {}), _version: row?.version ?? 0 };
  }

  async save(tenantId: string, data: Record<string, any>) {
    // _version is a transport-only OCC token — pull it out and never persist it
    // into the JSONB document (the column is the source of truth).
    const { _version: expectedVersion, ...incoming } = data;

    // Sanitise custom_fields[].options the same way v1 does on save —
    // trim, drop blanks. The SPA leaves them raw so Enter is usable
    // in the textarea (see Admin.vue comment in v1).
    if (Array.isArray(incoming.custom_fields)) {
      for (const f of incoming.custom_fields) {
        if (f.type === 'select' && Array.isArray(f.options)) {
          f.options = f.options.map((s: string) => (s || '').trim()).filter(Boolean);
        }
      }
    }
    // Defence-in-depth for cost centers: split on commas AND newlines, trim and
    // de-dupe, so a comma-pasted list from any client (not just our SPA) can't
    // persist a single mega-code that breaks the booking flow's allow-list.
    if (Array.isArray(incoming.cost_centers)) {
      incoming.cost_centers = [...new Set(
        incoming.cost_centers
          .flatMap((s: string) => String(s ?? '').split(/[\n,]+/))
          .map((s: string) => s.trim())
          .filter(Boolean),
      )];
    }
    const merged = { ...defaultCustomization, ...incoming };

    // OCC + write run in one transaction holding a row lock so the version
    // compare and the increment can't race a concurrent save.
    return this.repo.manager.transaction(async (m) => {
      const r = m.getRepository(Customization);
      const row = await r.findOne({ where: { tenantId }, lock: { mode: 'pessimistic_write' } });
      // Only enforce when the client supplied a version (older callers that
      // don't participate in OCC still work — they just can't detect a clash).
      if (row && expectedVersion !== undefined && row.version !== expectedVersion) {
        throw new ConflictException(
          'Settings were changed by another administrator. Please reload and try again.',
        );
      }
      const nextVersion = (row?.version ?? 0) + 1;
      // Cast the JSONB payload — TypeORM's DeepPartial chokes on the union of
      // optional defaults vs incoming patch, which is fine because we control
      // the merged shape ourselves.
      const payload = merged as unknown as Record<string, any>;
      if (row) {
        row.data = payload;
        row.version = nextVersion;
        await r.save(row);
      } else {
        await r.save(r.create({ tenantId, data: payload, version: nextVersion }));
      }
      return { ...merged, _version: nextVersion };
    });
  }
}
