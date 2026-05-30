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
  // Hard expiry. NIST 800-53 (IA-5) forbids non-expiring credentials, so
  // every issued token carries an expiry; `resolveBearer` rejects once it
  // passes. Nullable only for rows minted before this column existed —
  // those are treated as already-expired by the auth check.
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt?: Date;
  @Column({ default: true }) active!: boolean;
}
