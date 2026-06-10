import { MigrationInterface, QueryRunner } from 'typeorm';

// Structured delegation tracking on approval_steps. Previously a chain-step
// delegation was recorded only as free text in `reason` ("Delegated X → Y"),
// which the UI couldn't reliably surface and admins couldn't track. These
// columns make the delegate (and who delegated, and when) first-class so the
// approvals UI can show "delegated to X by Y" and the booking never silently
// disappears from the original approver's inbox.
//
// All three columns are nullable with no default — an undelegated step simply
// leaves them NULL, so this is a non-destructive additive migration.
export class ApprovalStepDelegation1780994300000 implements MigrationInterface {
  name = 'ApprovalStepDelegation1780994300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "approval_steps" ADD COLUMN IF NOT EXISTS "delegated_to" uuid`);
    await queryRunner.query(`ALTER TABLE "approval_steps" ADD COLUMN IF NOT EXISTS "delegated_by" uuid`);
    await queryRunner.query(`ALTER TABLE "approval_steps" ADD COLUMN IF NOT EXISTS "delegated_at" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "approval_steps" DROP COLUMN IF EXISTS "delegated_at"`);
    await queryRunner.query(`ALTER TABLE "approval_steps" DROP COLUMN IF EXISTS "delegated_by"`);
    await queryRunner.query(`ALTER TABLE "approval_steps" DROP COLUMN IF EXISTS "delegated_to"`);
  }
}
