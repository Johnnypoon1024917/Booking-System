import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// IntegrationCredential mirrors v1's integration_credentials row. Secret
// columns are stored as the "enc:<ver>:<b64>" envelope produced by
// CredentialService.obfuscate — never plaintext. Reveal happens just-
// in-time inside services that need to call the remote API.
@Entity('integration_credentials')
@Index(['tenantId', 'provider'], { unique: true })
export class IntegrationCredential {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;

  // 'microsoft' | 'google' | 'zoom' | 'teams-bot'.
  @Column({ type: 'varchar', length: 32 }) provider!: string;

  // Microsoft-specific. For Google these are blank and the service-account
  // JSON lives in clientSecret.
  @Column({ name: 'azure_tenant_id', type: 'varchar', length: 128, default: '' })
  azureTenantID!: string;
  @Column({ name: 'client_id', type: 'varchar', length: 256, default: '' })
  clientID!: string;

  // Encrypted envelope. Reveal returns the plaintext secret (or a JSON
  // blob in the Google service-account case).
  @Column({ name: 'client_secret', type: 'text', default: '' })
  clientSecret!: string;

  @Column({ name: 'is_active', default: true }) isActive!: boolean;

  // Last "test connection" result, surfaced in the admin UI.
  @Column({ name: 'last_test_ok', type: 'boolean', nullable: true })
  lastTestOk?: boolean | null;
  @Column({ name: 'last_test_error', type: 'text', default: '' })
  lastTestError!: string;
  @Column({ name: 'last_tested_at', type: 'timestamptz', nullable: true })
  lastTestedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}

// RoomMailbox maps a v2 resource to a Microsoft 365 room mailbox UPN.
// Drives outbound Outlook sync and the Graph subscription lifecycle.
@Entity('integration_room_mailboxes')
@Index(['resourceId'], { unique: true })
export class RoomMailbox {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'resource_id', type: 'uuid' }) resourceId!: string;
  @Column({ name: 'mailbox_upn', type: 'varchar', length: 255 }) mailboxUPN!: string;
  @Column({ name: 'display_name', type: 'varchar', length: 255, default: '' })
  displayName!: string;
  @Column({ name: 'is_active', default: true }) isActive!: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
