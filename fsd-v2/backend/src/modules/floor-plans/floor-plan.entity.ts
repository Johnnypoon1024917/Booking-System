import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Mirrors v1 domain/floorplan. Admin-drawn floor plans backing the
// interactive floor view. Pins are SPA-owned blobs:
//   [{ resourceId, x, y, ... }, ...]
// Keeping pins/shapes as JSONB means no migration when the SPA adds
// new drawing primitives.
@Entity('floor_plans')
@Index(['tenantId', 'name'])
export class FloorPlan {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column() name!: string;
  // URL to the uploaded background image; uploads are handled by the
  // existing static-asset pipeline (see frontend AdminFloorPlans.tsx).
  @Column({ name: 'image_url', default: '' }) imageUrl!: string;
  @Column({ type: 'jsonb', default: () => "'[]'" }) shapes!: unknown[];
  @Column({ type: 'jsonb', default: () => "'[]'" }) pins!: unknown[];
  @Column({ name: 'is_default', default: false }) isDefault!: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
