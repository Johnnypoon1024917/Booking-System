# FSD MRBS — Backup, Restore, and Disaster Recovery

Audience: operators running the production deployment.
Scope: Postgres + integration secrets + audit chain.

## Backup strategy

| Tier | Tool | Frequency | Retention | Where |
| --- | --- | --- | --- | --- |
| Daily logical | `scripts/backup.sh` (pg_dump -Fc, AES-256-encrypted) | 02:30 UTC | 30 days | `$BACKUP_DIR/daily` |
| Weekly logical | same script | Sundays, kept aside | 8 weeks | `$BACKUP_DIR/weekly` |
| Off-site copy | `aws s3 sync` (or equivalent) | hourly | 1 year | object storage with object-lock |
| WAL / PITR | `pg_basebackup` + `wal-g` (recommended) | continuous | 14 days | object storage |
| Application state | `tar` of `/var/lib/mrbs/integration-secrets` | weekly | 8 weeks | object storage |

The encrypted dump format keeps backups inside the same trust boundary as the
ciphertext columns in the database (which are AES-GCM sealed with
`INTEGRATION_SECRET_KEY`). The passphrase used to encrypt the dump itself
(`BACKUP_PASSPHRASE`) MUST be stored in the corporate KMS / Vault, not on the
backup host.

## RPO / RTO targets

* RPO: 15 minutes (with WAL archiving). Pure daily-dump fallback: 24 h.
* RTO: 2 hours for a full single-region restore. Tested quarterly.

## Restore — full database

```
# 1. Decrypt the dump.
BACKUP_PASSPHRASE='...' openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -pass env:BACKUP_PASSPHRASE \
    -in mrbs-20260524T023000Z.dump.enc \
    -out mrbs-20260524T023000Z.dump

# 2. Verify integrity.
sha256sum -c mrbs-20260524T023000Z.dump.enc.sha256

# 3. Restore into an empty database.
createdb -U mrbs_admin fsd_mrbs_restore
pg_restore --jobs=4 --no-owner --no-privileges \
    --dbname=fsd_mrbs_restore mrbs-20260524T023000Z.dump

# 4. Verify the audit hash chain.
psql -d fsd_mrbs_restore -c "SELECT verify_audit_chain();"
```

`verify_audit_chain()` is a stored procedure (added as part of the audit
hardening rollout) that walks `audit_entries` per tenant and recomputes
each row's hash from its predecessor; any mismatch raises `EXCEPTION`.

## Restore — point in time (PITR)

1. Start a fresh Postgres data dir from the latest base backup.
2. Stage WAL segments from object storage into `pg_wal/`.
3. Set `recovery_target_time = '2026-05-25 09:14:00 UTC'` in
   `postgresql.auto.conf`.
4. Start Postgres in standby; promote when the target is reached.

## Tabletop exercise schedule

Quarterly. Document each run in `docs/dr-drills/YYYY-Qn.md` with: actor,
data set, RPO achieved, RTO achieved, deviations from runbook.

## Off-site copy

`aws s3 sync $BACKUP_DIR s3://<bucket>/mrbs/ --storage-class STANDARD_IA \
  --metadata-directive REPLACE --server-side-encryption aws:kms \
  --ssekms-key-id <kms-key-arn>` — paired with object-lock policy of 35
days in compliance mode to defeat ransomware that compromises the
backup host.

## Failure modes covered

* Single-tenant data corruption → selective `pg_restore --table` from the
  latest daily dump into a staging DB, manual diff and replay.
* Region outage → WAL archive in second region, promote read replica.
* Encryption key loss → the dump is useless without `BACKUP_PASSPHRASE`;
  the row-level integration secrets are useless without
  `INTEGRATION_SECRET_KEY`. Both keys MUST be replicated through the KMS
  / Vault redundancy plan.
