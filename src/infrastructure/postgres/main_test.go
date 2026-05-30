package postgres

import (
	"os"
	"testing"
)

// TestMain bootstraps the test environment. The postgres package
// transitively imports infrastructure/integration, which calls
// loadKMSProvider() at package init and fails fatally when no
// INTEGRATION_SECRET_KEY is configured. CI obviously won't have a real
// key, so we flip the ephemeral-key escape hatch here.
//
// Same idea for JWT — anything that touches presentation/api/middleware
// at boot will refuse to start without a signing secret. We set both
// to known-test sentinels so a test failure is always about THIS test,
// never about misconfigured env.
//
// IMPORTANT: this only affects the `postgres` test binary. Production
// builds still demand real values — see kms/kms.go and middleware/auth.go.
func TestMain(m *testing.M) {
	os.Setenv("ALLOW_DEV_INTEGRATION_EPHEMERAL", "true")
	os.Setenv("ALLOW_DEV_JWT_EPHEMERAL_KEY", "true")
	os.Exit(m.Run())
}
