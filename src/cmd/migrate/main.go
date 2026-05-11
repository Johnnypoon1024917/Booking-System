// Package main provides a CLI tool for running database migrations.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

func main() {
	// Define command-line flags
	action := flag.String("action", "up", "Migration action: up, down, reset, version")
	dbURL := flag.String("db-url", getEnvOrDefault("DB_DSN", "postgres://mrbs_admin:SecurePass123!@localhost:5432/fsd_mrbs?sslmode=disable"), "Database connection URL")
	migrationsPath := flag.String("path", "file://src/infrastructure/postgres/migrations", "Path to migration files")
	flag.Parse()

	// Create migrate instance
	m, err := migrate.New(*migrationsPath, *dbURL)
	if err != nil {
		fmt.Printf("Error creating migrate instance: %v\n", err)
		os.Exit(1)
	}

	// Execute the requested action
	switch *action {
	case "up":
		fmt.Println("Running migrations up...")
		if err := m.Up(); err != nil && err != migrate.ErrNoChange {
			fmt.Printf("Error running migrations: %v\n", err)
			os.Exit(1)
		}
		version, dirty, _ := m.Version()
		fmt.Printf("Migration complete. Version: %d, dirty: %v\n", version, dirty)

	case "down":
		fmt.Println("Rolling back last migration...")
		if err := m.Steps(-1); err != nil && err != migrate.ErrNoChange {
			fmt.Printf("Error rolling back migration: %v\n", err)
			os.Exit(1)
		}
		version, dirty, _ := m.Version()
		fmt.Printf("Rollback complete. Version: %d, dirty: %v\n", version, dirty)

	case "drop":
		fmt.Println("Dropping all migrations...")
		if err := m.Drop(); err != nil {
			fmt.Printf("Error dropping migrations: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("All migrations dropped.")

	case "reset":
		fmt.Println("Resetting database...")
		if err := m.Drop(); err != nil {
			fmt.Printf("Warning during drop: %v\n", err)
		}
		// Create new migrate instance for reset (Drop closes the connection)
		m, err = migrate.New(*migrationsPath, *dbURL)
		if err != nil {
			fmt.Printf("Error recreating migrate instance: %v\n", err)
			os.Exit(1)
		}
		if err := m.Up(); err != nil && err != migrate.ErrNoChange {
			fmt.Printf("Error running migrations: %v\n", err)
			os.Exit(1)
		}
		version, dirty, _ := m.Version()
		fmt.Printf("Reset complete. Version: %d, dirty: %v\n", version, dirty)

	case "version":
		version, dirty, err := m.Version()
		if err != nil {
			fmt.Printf("Error getting version: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Current migration version: %d, dirty: %v\n", version, dirty)

	case "force":
		if flag.NArg() < 1 {
			fmt.Println("Usage: migrate -action force <version>")
			os.Exit(1)
		}
		var version int
		if _, err := fmt.Sscanf(flag.Arg(0), "%d", &version); err != nil {
			fmt.Printf("Error parsing version: %v\n", err)
			os.Exit(1)
		}
		if err := m.Force(version); err != nil {
			fmt.Printf("Error forcing version: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Forced version to %d\n", version)

	default:
		fmt.Printf("Unknown action: %s\n", *action)
		fmt.Println("Available actions: up, down, drop, reset, version, force")
		os.Exit(1)
	}

	// Close migrate instance
	sourceErr, dbErr := m.Close()
	if sourceErr != nil {
		fmt.Printf("Error closing migration source: %v\n", sourceErr)
	}
	if dbErr != nil {
		fmt.Printf("Error closing database: %v\n", dbErr)
	}

	fmt.Println("Migration operation completed successfully.")
}

// getEnvOrDefault returns the value of an environment variable or a default value.
func getEnvOrDefault(key, defaultValue string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return defaultValue
}
