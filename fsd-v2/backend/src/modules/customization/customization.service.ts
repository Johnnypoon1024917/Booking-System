import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customization, defaultCustomization } from './customization.entity';

@Injectable()
export class CustomizationService {
  constructor(@InjectRepository(Customization) private readonly repo: Repository<Customization>) {}

  async get(tenantId: string) {
    const row = await this.repo.findOne({ where: { tenantId } });
    return { ...defaultCustomization, ...(row?.data ?? {}) };
  }

  async save(tenantId: string, data: Record<string, any>) {
    // Sanitise custom_fields[].options the same way v1 does on save —
    // trim, drop blanks. The SPA leaves them raw so Enter is usable
    // in the textarea (see Admin.vue comment in v1).
    if (Array.isArray(data.custom_fields)) {
      for (const f of data.custom_fields) {
        if (f.type === 'select' && Array.isArray(f.options)) {
          f.options = f.options.map((s: string) => (s || '').trim()).filter(Boolean);
        }
      }
    }
    const merged = { ...defaultCustomization, ...data };
    // Cast the JSONB payload — TypeORM's DeepPartial chokes on the
    // union of optional defaults vs incoming patch, which is fine
    // because we control the merged shape ourselves.
    await this.repo.upsert(
      { tenantId, data: merged as unknown as Record<string, any> },
      ['tenantId'],
    );
    return merged;
  }
}
