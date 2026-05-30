import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn,
} from 'typeorm';

// SCIM provisioning token. The plaintext token is shown ONCE on issue
// then only the bcrypt hash is stored (defence-in-depth — even a DB
// dump can't replay provisioning). `prefix` is a non-secret display
// shard so admins can recognise their token in the list.
@Entity('scim_tokens')
@Index(['tokenHash'], { unique: true })
export class ScimToken {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column() name!: string;
  @Column() prefix!: string;
  @Column({ name: 'token_hash' }) tokenHash!: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt?: Date;
  @Column({ default: true }) active!: boolean;
}
