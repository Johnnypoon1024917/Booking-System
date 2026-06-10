import { MigrationInterface, QueryRunner } from 'typeorm';

// Database-level backstop against double-booking an EXCLUSIVE resource — a
// Postgres GIST EXCLUDE constraint that rejects any two overlapping active
// bookings on the same resource. The application already serializes this with a
// pessimistic row lock + tstzrange overlap check (BookingsService.lockResources
// /assertNoConflict); this constraint guarantees it at the storage layer too, so
// no future code path (an import, an admin tool, a missed lock) can slip an
// overlap through.
//
// Pods (booking_mode='shared') tolerate concurrent bookings up to capacity, so
// they are EXEMPT via the WHERE clause — the constraint only binds exclusive
// bookings. Cancelled / No Show rows are likewise excluded so a freed slot can
// be rebooked.
//
// NOTE: btree_gist must be creatable by the connecting role (as uuid-ossp
// already is). If the app runs as a least-privileged non-superuser, pre-create
// the extension during DB provisioning. If the table already holds overlapping
// exclusive bookings, resolve them before this migration can apply.
export class BookingOverlapConstraint1780994200000 implements MigrationInterface {
  name = 'BookingOverlapConstraint1780994200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    // Backfill booking_mode on existing rows from their resource so pods aren't
    // caught by the constraint (new rows are set at create time).
    await queryRunner.query(`
      UPDATE "bookings" b SET "booking_mode" = 'shared'
      FROM "resources" r
      WHERE b."resource_id" = r."id" AND r."booking_mode" = 'shared'
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" ADD CONSTRAINT "booking_no_overlap"
      EXCLUDE USING gist (
        "resource_id" WITH =,
        tstzrange("start_time", "end_time", '[)') WITH &&
      )
      WHERE ("booking_mode" <> 'shared' AND "status" NOT IN ('Cancelled', 'No Show'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "booking_no_overlap"`);
    // Leave the btree_gist extension in place — other objects may rely on it.
  }
}
