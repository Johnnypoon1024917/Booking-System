// Package postgres provides database connection and migration utilities.
package postgres

import (
	"embed"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

// MigrationsFS is the embedded filesystem containing migration files.
// This should be set by the application using this package.
var MigrationsFS embed.FS

// MigrationConfig holds the configuration for running migrations.
type MigrationConfig struct {
	// DatabaseURL is the PostgreSQL connection string.
	DatabaseURL string
	// MigrationsFS is the embedded filesystem containing migration files.
	MigrationsFS embed.FS
	// MigrationsPath is the path within the embedded filesystem to the migration files.
	MigrationsPath string
}

// RunMigrations executes all pending database migrations.
func RunMigrations(cfg MigrationConfig) error {
	// Create migration source from embedded filesystem
	source, err := iofs.New(cfg.MigrationsFS, cfg.MigrationsPath)
	if err != nil {
		return fmt.Errorf("failed to create migration source: %w", err)
	}

	// Create migrate instance
	m, err := migrate.NewWithSourceInstance("iofs", source, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("failed to create migrate instance: %w", err)
	}

	// Run migrations
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("failed to run migrations: %w", err)
	}

	// Get migration version
	version, dirty, err := m.Version()
	if err != nil {
		return fmt.Errorf("failed to get migration version: %w", err)
	}

	fmt.Printf("Migration successful. Current version: %d, dirty: %v\n", version, dirty)
	return nil
}

// RollbackMigration rolls back the last applied migration.
func RollbackMigration(cfg MigrationConfig) error {
	// Create migration source from embedded filesystem
	source, err := iofs.New(cfg.MigrationsFS, cfg.MigrationsPath)
	if err != nil {
		return fmt.Errorf("failed to create migration source: %w", err)
	}

	// Create migrate instance
	m, err := migrate.NewWithSourceInstance("iofs", source, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("failed to create migrate instance: %w", err)
	}

	// Rollback one migration
	if err := m.Steps(-1); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("failed to rollback migration: %w", err)
	}

	// Get migration version
	version, dirty, err := m.Version()
	if err != nil {
		return fmt.Errorf("failed to get migration version: %w", err)
	}

	fmt.Printf("Rollback successful. Current version: %d, dirty: %v\n", version, dirty)
	return nil
}

// ResetDatabase rolls back all migrations and re-applies them.
func ResetDatabase(cfg MigrationConfig) error {
	// Create migration source from embedded filesystem
	source, err := iofs.New(cfg.MigrationsFS, cfg.MigrationsPath)
	if err != nil {
		return fmt.Errorf("failed to create migration source: %w", err)
	}

	// Create migrate instance
	m, err := migrate.NewWithSourceInstance("iofs", source, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("failed to create migrate instance: %w", err)
	}

	// Drop all migrations
	if err := m.Drop(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("failed to drop database: %w", err)
	}

	// Run all migrations
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("failed to run migrations: %w", err)
	}

	// Get migration version
	version, dirty, err := m.Version()
	if err != nil {
		return fmt.Errorf("failed to get migration version: %w", err)
	}

	fmt.Printf("Reset successful. Current version: %d, dirty: %v\n", version, dirty)
	return nil
}

// MigrationStatus returns the current migration status.
func MigrationStatus(cfg MigrationConfig) (uint, bool, error) {
	// Create migration source from embedded filesystem
	source, err := iofs.New(cfg.MigrationsFS, cfg.MigrationsPath)
	if err != nil {
		return 0, false, fmt.Errorf("failed to create migration source: %w", err)
	}

	// Create migrate instance
	m, err := migrate.NewWithSourceInstance("iofs", source, cfg.DatabaseURL)
	if err != nil {
		return 0, false, fmt.Errorf("failed to create migrate instance: %w", err)
	}

	// Get migration version
	version, dirty, err := m.Version()
	if err != nil {
		return 0, false, fmt.Errorf("failed to get migration version: %w", err)
	}

	return version, dirty, nil
}
