package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"fsd-mrbs/src/domain/tenant"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// MockTenantRepository is a mock implementation for testing
type MockTenantRepository struct {
	Tenant       *tenant.Tenant
	SetContextErr error
}

func (m *MockTenantRepository) GetByID(ctx context.Context, id uuid.UUID) (*tenant.Tenant, error) {
	return m.Tenant, nil
}

func (m *MockTenantRepository) GetByName(ctx context.Context, name string) (*tenant.Tenant, error) {
	return m.Tenant, nil
}

func (m *MockTenantRepository) SetTenantContext(ctx context.Context, tenantID uuid.UUID) error {
	return m.SetContextErr
}

// TestTenantMiddleware_ExtractsTenantID tests that tenant_id is extracted from JWT claims
func TestTenantMiddleware_ExtractsTenantID(t *testing.T) {
	// Create a test tenant ID
	testTenantID := uuid.New()
	testUserID := uuid.New().String()

	// Create a valid JWT token with tenant_id
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":       testUserID,
		"tenant_id": testTenantID.String(),
		"role":      "General User",
		"grade":     "SDO",
		"exp":       time.Now().Add(time.Hour).Unix(),
	})
	tokenString, err := token.SignedString(JwtSecretKey)
	if err != nil {
		t.Fatalf("Failed to sign token: %v", err)
	}

	// Create a mock tenant repository
	mockRepo := &MockTenantRepository{
		Tenant: &tenant.Tenant{
			ID:     testTenantID,
			Name:   "test-tenant",
			Status: tenant.StatusActive,
		},
	}

	// Create the middleware with mock
	tm := &TenantMiddleware{
		tenantRepo: mockRepo,
	}

	// Create a test handler that captures the context
	var capturedTenantID uuid.UUID
	var capturedOK bool
	testHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedTenantID, capturedOK = GetTenantID(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	// Create the request
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rec := httptest.NewRecorder()

	// Execute
	tm.Middleware(testHandler).ServeHTTP(rec, req)

	// Assert
	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !capturedOK {
		t.Error("Expected tenant ID to be present in context")
	}
	if capturedTenantID != testTenantID {
		t.Errorf("Expected tenant ID %s, got %s", testTenantID, capturedTenantID)
	}
}

// TestTenantMiddleware_RejectsSuspendedTenant tests that suspended tenants are rejected
func TestTenantMiddleware_RejectsSuspendedTenant(t *testing.T) {
	testTenantID := uuid.New()
	testUserID := uuid.New().String()

	// Create a valid JWT token
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":       testUserID,
		"tenant_id": testTenantID.String(),
		"role":      "General User",
		"exp":       time.Now().Add(time.Hour).Unix(),
	})
	tokenString, _ := token.SignedString(JwtSecretKey)

	// Create a mock tenant repository with suspended tenant
	mockRepo := &MockTenantRepository{
		Tenant: &tenant.Tenant{
			ID:     testTenantID,
			Name:   "test-tenant",
			Status: tenant.StatusSuspended,
		},
	}

	// Create the middleware with mock
	tm := &TenantMiddleware{
		tenantRepo: mockRepo,
	}

	// Create a test handler (should not be called)
	testHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Handler should not be called for suspended tenant")
	})

	// Create the request
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rec := httptest.NewRecorder()

	// Execute
	tm.Middleware(testHandler).ServeHTTP(rec, req)

	// Assert - should be forbidden
	if rec.Code != http.StatusForbidden {
		t.Errorf("Expected status 403 for suspended tenant, got %d", rec.Code)
	}
}

// TestTenantMiddleware_RejectsDeletedTenant tests that deleted tenants are rejected
func TestTenantMiddleware_RejectsDeletedTenant(t *testing.T) {
	testTenantID := uuid.New()
	testUserID := uuid.New().String()

	// Create a valid JWT token
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":       testUserID,
		"tenant_id": testTenantID.String(),
		"role":      "General User",
		"exp":       time.Now().Add(time.Hour).Unix(),
	})
	tokenString, _ := token.SignedString(JwtSecretKey)

	// Create a mock tenant repository with deleted tenant
	mockRepo := &MockTenantRepository{
		Tenant: &tenant.Tenant{
			ID:     testTenantID,
			Name:   "test-tenant",
			Status: tenant.StatusDeleted,
		},
	}

	// Create the middleware with mock
	tm := &TenantMiddleware{
		tenantRepo: mockRepo,
	}

	// Create a test handler (should not be called)
	testHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Handler should not be called for deleted tenant")
	})

	// Create the request
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rec := httptest.NewRecorder()

	// Execute
	tm.Middleware(testHandler).ServeHTTP(rec, req)

	// Assert - should be forbidden
	if rec.Code != http.StatusForbidden {
		t.Errorf("Expected status 403 for deleted tenant, got %d", rec.Code)
	}
}

// TestTenantMiddleware_MissingTenantID tests rejection when tenant_id is missing
func TestTenantMiddleware_MissingTenantID(t *testing.T) {
	testUserID := uuid.New().String()

	// Create a JWT token without tenant_id
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":  testUserID,
		"role": "General User",
		"exp":  time.Now().Add(time.Hour).Unix(),
	})
	tokenString, _ := token.SignedString(JwtSecretKey)

	// Create the middleware with mock
	tm := &TenantMiddleware{
		tenantRepo: &MockTenantRepository{},
	}

	// Create a test handler (should not be called)
	testHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Handler should not be called for missing tenant ID")
	})

	// Create the request
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rec := httptest.NewRecorder()

	// Execute
	tm.Middleware(testHandler).ServeHTTP(rec, req)

	// Assert - should be unauthorized
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("Expected status 401 for missing tenant ID, got %d", rec.Code)
	}
}

// TestTenantMiddleware_SystemAdminBypass tests that System Admins can bypass tenant check
func TestTenantMiddleware_SystemAdminBypass(t *testing.T) {
	testUserID := uuid.New().String()

	// Create a JWT token for System Admin without tenant_id
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":  testUserID,
		"role": "System Admin",
		"exp":  time.Now().Add(time.Hour).Unix(),
	})
	tokenString, _ := token.SignedString(JwtSecretKey)

	// Create the middleware with mock
	tm := &TenantMiddleware{
		tenantRepo: &MockTenantRepository{},
	}

	// Create a test handler that captures the context
	handlerCalled := false
	testHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		w.WriteHeader(http.StatusOK)
	})

	// Create the request
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rec := httptest.NewRecorder()

	// Execute
	tm.Middleware(testHandler).ServeHTTP(rec, req)

	// Assert - handler should be called
	if !handlerCalled {
		t.Error("Handler should be called for System Admin without tenant_id")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200 for System Admin, got %d", rec.Code)
	}
}

// TestTenantMiddleware_ExtractsAllClaims tests that all claims are extracted
func TestTenantMiddleware_ExtractsAllClaims(t *testing.T) {
	testTenantID := uuid.New()
	testUserID := uuid.New().String()

	// Create a JWT token with all claims
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":       testUserID,
		"tenant_id": testTenantID.String(),
		"role":      "Room Admin",
		"grade":     "SDO",
		"regions":   []interface{}{"North", "South"},
		"exp":       time.Now().Add(time.Hour).Unix(),
	})
	tokenString, _ := token.SignedString(JwtSecretKey)

	// Create a mock tenant repository
	mockRepo := &MockTenantRepository{
		Tenant: &tenant.Tenant{
			ID:     testTenantID,
			Name:   "test-tenant",
			Status: tenant.StatusActive,
		},
	}

	// Create the middleware with mock
	tm := &TenantMiddleware{
		tenantRepo: mockRepo,
	}

	// Variables to capture extracted values
	var (
		capturedUserID   string
		capturedRole     string
		capturedGrade    string
		capturedRegions  []string
	)

	// Create a test handler that captures the context
	testHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if userID, ok := GetUserID(ctx); ok {
			capturedUserID = userID
		}
		if role, ok := GetUserRole(ctx); ok {
			capturedRole = role
		}
		if grade, ok := GetUserGrade(ctx); ok {
			capturedGrade = grade
		}
		if regions, ok := GetUserRegions(ctx); ok {
			capturedRegions = regions
		}
		w.WriteHeader(http.StatusOK)
	})

	// Create the request
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rec := httptest.NewRecorder()

	// Execute
	tm.Middleware(testHandler).ServeHTTP(rec, req)

	// Assert
	if capturedUserID != testUserID {
		t.Errorf("Expected user ID %s, got %s", testUserID, capturedUserID)
	}
	if capturedRole != "Room Admin" {
		t.Errorf("Expected role 'Room Admin', got %s", capturedRole)
	}
	if capturedGrade != "SDO" {
		t.Errorf("Expected grade 'SDO', got %s", capturedGrade)
	}
	if len(capturedRegions) != 2 || capturedRegions[0] != "North" || capturedRegions[1] != "South" {
		t.Errorf("Expected regions [North, South], got %v", capturedRegions)
	}
}
