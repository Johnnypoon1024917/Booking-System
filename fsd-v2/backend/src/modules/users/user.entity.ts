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
  // Preferred language for system communications (emails + push). One of
  // 'en' | 'zh-Hant' | 'zh-Hans'; see notifications.i18n. Defaults to English
  // and is coerced to a supported locale at send time, so legacy rows and
  // unexpected values degrade gracefully.
  @Column({ type: 'varchar', length: 16, default: 'en' }) locale!: string;
  @Column({ name: 'is_active', default: true }) isActive!: boolean;

  // Line manager — drives dynamic approval routing (approver_type 'manager':
  // "route to the requester's manager"). Self-referential FK by id, nullable
  // (top of the org chart / not yet mapped). Maintained via the user admin form.
  @Column({ name: 'manager_id', type: 'uuid', nullable: true }) managerId?: string;
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

  // Per-user iCal feed token. A stored random secret (not derived from the
  // JWT signing key) so it can be ROTATED — the public ICS feed URL ends up
  // in third-party calendar-server logs, so a leaked URL must be revocable.
  // select:false so it never rides along on user list/detail responses.
  // Indexed so the feed lookup is O(1) instead of scanning every tenant user.
  @Index()
  @Column({ name: 'ics_feed_token', nullable: true, select: false })
  icsFeedToken?: string;

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
