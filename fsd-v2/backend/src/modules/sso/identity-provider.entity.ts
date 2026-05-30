import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Pluggable identity provider record. One tenant can have many
// providers (e.g. corporate Azure AD + a partner SAML). The SPA's
// login page lists `enabled` providers; the SSO controller dispatches
// by `kind`. `config` holds the kind-specific shape — see v1's
// infrastructure/auth/{ldap,oauth2,saml}_provider.go for the field
// list each kind expects.
export type ProviderKind = 'saml' | 'oauth2' | 'ldap';

@Entity('identity_providers')
@Index(['tenantId', 'slug'], { unique: true })
export class IdentityProvider {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  // URL-safe identifier used in /sso/{kind}/init?provider=<slug>
  @Column() slug!: string;
  @Column() name!: string;
  @Column({ type: 'varchar' }) kind!: ProviderKind;
  @Column({ default: true }) enabled!: boolean;
  // Provider-specific config. For SAML: { entryPoint, issuer, cert }.
  // For OAuth2: { clientId, clientSecret, authorizeUrl, tokenUrl,
  // userInfoUrl, scope, callbackUrl }. For LDAP: { url, bindDN,
  // bindPassword, searchBase, searchFilter }.
  @Column({ type: 'jsonb', default: () => "'{}'" }) config!: Record<string, any>;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}

// Server-side state for in-flight SSO exchanges. Persisted so a
// multi-replica deploy survives the redirect round-trip.
@Entity('sso_state')
export class SsoState {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // The opaque token included in the IdP request — `state` for OAuth2,
  // `RelayState` for SAML.
  @Column({ unique: true }) state!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'provider_id', type: 'uuid' }) providerId!: string;
  @Column() kind!: string;
  @Column({ nullable: true }) nonce?: string;
  @Column({ nullable: true }) verifier?: string;
  @Column({ name: 'redirect_after', nullable: true }) redirectAfter?: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
