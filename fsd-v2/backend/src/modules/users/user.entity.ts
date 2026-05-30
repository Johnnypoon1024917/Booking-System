import {
  Column, CreateDateColumn, Entity, Index, JoinTable,
  ManyToMany, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';
import { Department } from '../departments/department.entity';

@Entity('users')
@Index(['tenantId', 'username'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column() username!: string;
  // Notification address. Nullable because legacy/LDAP users may not have
  // one synced yet; the notification outbox falls back to `username` when
  // it parses as an email and otherwise skips email delivery for that user.
  @Column({ nullable: true }) email?: string;
  @Column({ name: 'password_hash', select: false }) passwordHash!: string;
  // Force the user to set a new password on next login (admin-issued
  // initial passwords). Cleared once they complete the change.
  @Column({ name: 'must_change_password', default: false }) mustChangePassword!: boolean;
  @Column({ nullable: true }) dn?: string;
  @Column() role!: string;
  @Column({ nullable: true }) grade?: string;
  @Column({ name: 'is_active', default: true }) isActive!: boolean;
  // Region access stored as a Postgres text[]. TypeORM serialises a
  // string[] into the array literal automatically.
  @Column({ name: 'region_access', type: 'text', array: true, default: () => "'{}'" })
  regionAccess!: string[];

  // MFA TOTP — see modules/mfa. mfaSecret is select:false so it never
  // leaks via list endpoints. mfaEnabled flips only after the user
  // verifies a code against the pending secret.
  @Column({ name: 'mfa_enabled', default: false }) mfaEnabled!: boolean;
  @Column({ name: 'mfa_secret', nullable: true, select: false }) mfaSecret?: string;
  @Column({ name: 'mfa_enrolled_at', type: 'timestamptz', nullable: true })
  mfaEnrolledAt?: Date;

  // Federated identity provenance — set by the SSO module on first
  // login so subsequent logins resolve to the same row.
  @Column({ name: 'sso_provider', nullable: true }) ssoProvider?: string;
  @Column({ name: 'sso_subject', nullable: true }) ssoSubject?: string;

  // user_departments join — many-to-many to mirror the v1 migration 032
  // semantics (one user → many departments).
  @ManyToMany(() => Department, { cascade: false })
  @JoinTable({
    name: 'user_departments',
    joinColumn: { name: 'user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'department_id', referencedColumnName: 'id' },
  })
  departments!: Department[];

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
