import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Persisted WebAuthn credential. Mirrors v1's webauthn_credentials
// table (see migration in v1's init.sql). `publicKey` is the raw
// COSE-encoded public key (base64-url string), `counter` is the
// authenticator sign-count for clone detection.
@Entity('webauthn_credentials')
@Index(['tenantId', 'credentialId'], { unique: true })
export class WebauthnCredential {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  // Base64-url encoded credential ID — used as the lookup key when an
  // authenticator presents an assertion.
  @Column({ name: 'credential_id', type: 'text' }) credentialId!: string;
  @Column({ name: 'public_key', type: 'text' }) publicKey!: string;
  @Column({ type: 'bigint', default: 0 }) counter!: number;
  @Column({ nullable: true }) aaguid?: string;
  @Column({ default: 'Passkey' }) nickname!: string;
  @Column({ name: 'transports', type: 'text', array: true, default: () => "'{}'" })
  transports!: string[];
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt?: Date;
}

// Short-lived registration / authentication challenge. Deleted on use
// — TTL enforced by createdAt comparison.
@Entity('webauthn_challenges')
export class WebauthnChallenge {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid', nullable: true }) tenantId?: string;
  @Column({ name: 'user_id', type: 'uuid', nullable: true }) userId?: string;
  // base64url-encoded challenge
  @Column({ type: 'text' }) challenge!: string;
  // 'register' | 'login'
  @Column() purpose!: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
