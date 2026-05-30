// Package api hosts the OpenAPI 3.1 specification served at /api/openapi.json
// and the Swagger UI shell served at /api/docs. Keeping the spec in code
// (rather than a static yaml) means refactoring a route refactors the spec
// in lockstep — no drift.
package api

import (
	"encoding/json"
	"net/http"
)

// Spec returns a freshly-built OpenAPI 3.1 document. Build cost is trivial.
func Spec() map[string]any {
	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       "FSD MRBS Platform API",
			"version":     "1.0.0",
			"description": "Multi-tenant resource booking platform. FSD is one tenant; all customer-facing strings, branding, holidays, and workflow rules are tenant-driven.",
		},
		"servers": []map[string]any{
			{"url": "/api/v1", "description": "v1 API"},
		},
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"bearerAuth": map[string]any{
					"type":         "http",
					"scheme":       "bearer",
					"bearerFormat": "JWT",
				},
			},
			"schemas": map[string]any{
				"Resource": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":               map[string]any{"type": "string", "format": "uuid"},
						"name":             map[string]any{"type": "string"},
						"asset_type":       map[string]any{"type": "string", "enum": []string{"Room", "Vehicle", "Equipment", "Top Management"}},
						"region":           map[string]any{"type": "string"},
						"location":         map[string]any{"type": "string"},
						"capacity":         map[string]any{"type": "integer"},
						"requires_approval": map[string]any{"type": "boolean"},
						"is_restricted":    map[string]any{"type": "boolean"},
					},
				},
				"BookingRequest": map[string]any{
					"type":     "object",
					"required": []string{"resource_id", "start_time", "end_time"},
					"properties": map[string]any{
						"resource_id":  map[string]any{"type": "string", "format": "uuid"},
						"start_time":   map[string]any{"type": "string", "format": "date-time"},
						"end_time":     map[string]any{"type": "string", "format": "date-time"},
						"title":        map[string]any{"type": "string", "description": "Meeting subject. Shown on calendars to roles allowed by the resource's details ACL."},
						"meeting_url":  map[string]any{"type": "string"},
						"is_private":   map[string]any{"type": "boolean", "description": "Outlook-style privacy flag. When true, only owner + System Admin see organiser/subject; everyone else sees 'Reserved'."},
						"custom_data":  map[string]any{"type": "object"},
					},
				},
				"FreeBusyRequest": map[string]any{
					"type":     "object",
					"required": []string{"subjects", "start_time", "end_time"},
					"properties": map[string]any{
						"subjects": map[string]any{
							"type":        "array",
							"description": "Mix of resource UUIDs and user emails/usernames. Max 100.",
							"maxItems":    100,
							"items":       map[string]any{"type": "string"},
						},
						"start_time": map[string]any{"type": "string", "format": "date-time"},
						"end_time":   map[string]any{"type": "string", "format": "date-time"},
					},
				},
				"FreeBusyResponse": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"subjects": map[string]any{
							"type": "array",
							"items": map[string]any{
								"type": "object",
								"properties": map[string]any{
									"id":   map[string]any{"type": "string"},
									"kind": map[string]any{"type": "string", "enum": []string{"user", "resource"}},
									"intervals": map[string]any{
										"type": "array",
										"items": map[string]any{
											"type": "object",
											"properties": map[string]any{
												"start_time": map[string]any{"type": "string", "format": "date-time"},
												"end_time":   map[string]any{"type": "string", "format": "date-time"},
												"status":     map[string]any{"type": "string", "enum": []string{"busy", "tentative"}},
											},
										},
									},
								},
							},
						},
					},
				},
				"Customization": map[string]any{
					"type": "object",
					"description": "Tenant-driven product configuration: branding, locale, layout, custom fields, workflow rules.",
				},
			},
		},
		"security": []map[string]any{{"bearerAuth": []string{}}},
		"paths": map[string]any{
			"/login": map[string]any{
				"post": map[string]any{
					"summary":  "AD/SSO login",
					"security": []any{},
					"responses": map[string]any{
						"200": map[string]any{"description": "JWT bundle"},
						"401": map[string]any{"description": "Bad credentials"},
					},
				},
			},
			"/bookings/search": map[string]any{
				"get": map[string]any{
					"summary": "Search available resources",
					"parameters": []map[string]any{
						{"name": "location", "in": "query", "schema": map[string]any{"type": "string"}},
						{"name": "date", "in": "query", "schema": map[string]any{"type": "string", "format": "date"}},
						{"name": "start_time", "in": "query", "schema": map[string]any{"type": "string"}},
						{"name": "end_time", "in": "query", "schema": map[string]any{"type": "string"}},
					},
					"responses": map[string]any{
						"200": map[string]any{"description": "List of resources"},
					},
				},
			},
			"/bookings": map[string]any{
				"post": map[string]any{
					"summary": "Create booking",
					"requestBody": map[string]any{
						"required": true,
						"content": map[string]any{
							"application/json": map[string]any{"schema": map[string]any{"$ref": "#/components/schemas/BookingRequest"}},
						},
					},
					"responses": map[string]any{
						"201": map[string]any{"description": "Created"},
						"409": map[string]any{"description": "Conflict / approval required"},
					},
				},
			},
			"/bookings/busy": map[string]any{
				"get": map[string]any{
					"summary":     "Tenant-wide busy intervals (PII-free)",
					"description": "Returns blocking time ranges across every resource the caller can see, with no organiser or subject. Use for calendar greying-out. Free/busy follows resource visibility one-for-one; details require an admin grant. See domain/booking/visibility.go for the policy.",
					"parameters": []map[string]any{
						{"name": "date", "in": "query", "schema": map[string]any{"type": "string", "format": "date"}, "description": "Single date to query; defaults to today + upcoming."},
					},
					"responses": map[string]any{
						"200": map[string]any{
							"description": "Array of busy intervals",
							"content": map[string]any{
								"application/json": map[string]any{
									"schema": map[string]any{
										"type": "array",
										"items": map[string]any{
											"type": "object",
											"properties": map[string]any{
												"resource_id": map[string]any{"type": "string", "format": "uuid"},
												"start_time":  map[string]any{"type": "string", "format": "date-time"},
												"end_time":    map[string]any{"type": "string", "format": "date-time"},
												"status":      map[string]any{"type": "string", "enum": []string{"Confirmed", "Pending Approval", "Checked In"}},
											},
										},
									},
								},
							},
						},
					},
				},
			},
			"/freebusy": map[string]any{
				"post": map[string]any{
					"summary":     "Federated free/busy probe",
					"description": "Scheduling-assistant compatible endpoint. Same wire shape as Microsoft Graph getSchedule and Google Calendar freeBusy.query so external connectors can drop in unchanged. Accepts a mix of resource UUIDs and user emails/usernames (up to 100); returns busy/tentative intervals only, never PII. Unknown subjects are silently dropped (no enumeration via 404 timing). Caller may probe a resource only if domain/booking/visibility.ResourceVisible would return true.",
					"requestBody": map[string]any{
						"required": true,
						"content": map[string]any{
							"application/json": map[string]any{
								"schema": map[string]any{"$ref": "#/components/schemas/FreeBusyRequest"},
								"example": map[string]any{
									"subjects":   []string{"aeca9d2b-6341-4072-8dda-2957110470db", "alice@fsd.gov.hk"},
									"start_time": "2026-05-27T09:00:00+08:00",
									"end_time":   "2026-05-27T18:00:00+08:00",
								},
							},
						},
					},
					"responses": map[string]any{
						"200": map[string]any{
							"description": "Busy intervals grouped per subject",
							"content": map[string]any{
								"application/json": map[string]any{
									"schema": map[string]any{"$ref": "#/components/schemas/FreeBusyResponse"},
								},
							},
						},
						"400": map[string]any{"description": "Invalid window or subjects list"},
					},
				},
			},
			"/admin/holidays": map[string]any{
				"post": map[string]any{
					"summary": "Register tenant holiday",
					"responses": map[string]any{"201": map[string]any{"description": "Created"}},
				},
			},
			"/admin/holidays/sync-hk": map[string]any{
				"post": map[string]any{
					"summary":     "Import HK public holidays from gov.hk feed",
					"description": "Idempotent. Pulls the official ICS feed and inserts new dates. Locale query param: en | zh-Hant | zh-Hans.",
					"responses": map[string]any{"200": map[string]any{"description": "{imported, skipped}"}},
				},
			},
			"/admin/customization": map[string]any{
				"get": map[string]any{
					"summary": "Get tenant customization document",
					"responses": map[string]any{"200": map[string]any{"description": "Customization"}},
				},
				"put": map[string]any{
					"summary": "Replace tenant customization document",
					"responses": map[string]any{"200": map[string]any{"description": "Customization"}},
				},
			},
			"/reports/usage": map[string]any{
				"get": map[string]any{
					"summary": "Export usage report (CSV/XLSX)",
					"parameters": []map[string]any{
						{"name": "format", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"csv", "xlsx"}}},
						{"name": "start", "in": "query", "schema": map[string]any{"type": "string", "format": "date"}},
						{"name": "end", "in": "query", "schema": map[string]any{"type": "string", "format": "date"}},
					},
					"responses": map[string]any{"200": map[string]any{"description": "Binary download"}},
				},
			},
			"/checkin/{token}": map[string]any{
				"get": map[string]any{
					"summary":  "QR check-in",
					"security": []any{},
					"parameters": []map[string]any{
						{"name": "token", "in": "path", "required": true, "schema": map[string]any{"type": "string"}},
					},
					"responses": map[string]any{"200": map[string]any{"description": "Checked in"}},
				},
			},
			"/realtime": map[string]any{
				"get": map[string]any{
					"summary":     "WebSocket — booking & broadcast event stream",
					"description": "Upgrade to WebSocket. Auth via ?token=<jwt>. Events: booking.created, booking.updated, booking.cancelled, weather.signal, broadcast.",
					"responses":   map[string]any{"101": map[string]any{"description": "Switching Protocols"}},
				},
			},

			// ----- Booking lifecycle -----
			"/bookings/{id}": map[string]any{
				"get": map[string]any{
					"summary":   "Fetch one booking",
					"parameters": []map[string]any{{"name": "id", "in": "path", "required": true, "schema": map[string]any{"type": "string", "format": "uuid"}}},
					"responses": map[string]any{"200": map[string]any{"description": "Booking"}},
				},
				"put": map[string]any{
					"summary":   "Update booking time / meeting URL (owner or admin)",
					"parameters": []map[string]any{{"name": "id", "in": "path", "required": true, "schema": map[string]any{"type": "string", "format": "uuid"}}},
					"responses": map[string]any{"200": map[string]any{"description": "Updated"}, "409": map[string]any{"description": "Conflict"}},
				},
				"delete": map[string]any{
					"summary":   "Cancel booking (owner or admin)",
					"parameters": []map[string]any{
						{"name": "id", "in": "path", "required": true, "schema": map[string]any{"type": "string", "format": "uuid"}},
						{"name": "reason", "in": "query", "schema": map[string]any{"type": "string"}},
					},
					"responses": map[string]any{"204": map[string]any{"description": "Cancelled"}},
				},
			},
			"/me/bookings": map[string]any{
				"get": map[string]any{
					"summary":   "List my upcoming + recent bookings",
					"responses": map[string]any{"200": map[string]any{"description": "Booking[]"}},
				},
			},

			// ----- Approvals -----
			"/approvals": map[string]any{
				"get": map[string]any{
					"summary":   "List bookings awaiting my approval",
					"responses": map[string]any{"200": map[string]any{"description": "Booking[]"}},
				},
			},
			"/approvals/{id}/approve": map[string]any{
				"post": map[string]any{
					"summary":   "Approve a pending booking",
					"parameters": []map[string]any{{"name": "id", "in": "path", "required": true, "schema": map[string]any{"type": "string", "format": "uuid"}}},
					"responses": map[string]any{"200": map[string]any{"description": "Approved"}, "409": map[string]any{"description": "Wrong state"}},
				},
			},
			"/approvals/{id}/reject": map[string]any{
				"post": map[string]any{
					"summary":   "Reject a pending booking",
					"parameters": []map[string]any{{"name": "id", "in": "path", "required": true, "schema": map[string]any{"type": "string", "format": "uuid"}}},
					"requestBody": map[string]any{
						"required": true,
						"content": map[string]any{
							"application/json": map[string]any{"schema": map[string]any{
								"type": "object", "required": []string{"reason"},
								"properties": map[string]any{"reason": map[string]any{"type": "string"}},
							}},
						},
					},
					"responses": map[string]any{"200": map[string]any{"description": "Rejected"}},
				},
			},

			// ----- Admin: resources -----
			"/admin/resources": map[string]any{
				"get":  map[string]any{"summary": "List resources", "responses": map[string]any{"200": map[string]any{"description": "Resource[]"}}},
				"post": map[string]any{"summary": "Create resource", "responses": map[string]any{"201": map[string]any{"description": "Resource"}}},
			},
			"/admin/resources/{id}": map[string]any{
				"get":    map[string]any{"summary": "Get resource (with children)", "responses": map[string]any{"200": map[string]any{"description": "Resource + children"}}},
				"put":    map[string]any{"summary": "Update resource", "responses": map[string]any{"200": map[string]any{"description": "Resource"}}},
				"delete": map[string]any{"summary": "Soft-delete (set is_active=false)", "responses": map[string]any{"204": map[string]any{"description": "Deactivated"}}},
			},
			"/admin/resources/{id}/split": map[string]any{
				"post": map[string]any{
					"summary":     "Convert resource into a parent + N child sub-resources",
					"description": "Used to model basketball↔badminton splits. Creates N children sharing the parent's location and region.",
					"requestBody": map[string]any{
						"required": true,
						"content": map[string]any{
							"application/json": map[string]any{"schema": map[string]any{
								"type": "object",
								"required": []string{"child_count"},
								"properties": map[string]any{
									"child_count":     map[string]any{"type": "integer", "minimum": 2, "maximum": 10},
									"child_capacity":  map[string]any{"type": "integer"},
									"child_names":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
									"child_equipment": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
								},
							}},
						},
					},
					"responses": map[string]any{"201": map[string]any{"description": "Parent + Children created"}},
				},
			},

			// ----- Admin: users / departments / holidays -----
			"/admin/users":             map[string]any{"get": map[string]any{"summary": "List users"}, "post": map[string]any{"summary": "Create user"}},
			"/admin/users/{id}":        map[string]any{"get": map[string]any{"summary": "Get user"}, "put": map[string]any{"summary": "Update user"}, "delete": map[string]any{"summary": "Deactivate user"}},
			"/admin/departments":       map[string]any{"get": map[string]any{"summary": "List departments"}, "post": map[string]any{"summary": "Create department"}},
			"/admin/departments/{id}":  map[string]any{"put": map[string]any{"summary": "Update department"}, "delete": map[string]any{"summary": "Delete department"}},
			"/admin/holidays/import-ics": map[string]any{
				"post": map[string]any{
					"summary":     "Bulk import holidays from an .ics file (multipart upload)",
					"description": "Upload an iCalendar file (e.g. corporate calendar export). Idempotent per (tenant, date).",
					"responses":   map[string]any{"200": map[string]any{"description": "{imported, skipped}"}},
				},
			},
		},
	}
}

// SpecHandler serves the spec as JSON.
func SpecHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=60")
	_ = json.NewEncoder(w).Encode(Spec())
}

// SwaggerUIHandler returns a small HTML shell that pulls the Swagger UI
// assets from a public CDN and points them at /api/openapi.json. Hosting
// the assets ourselves is a future hardening step.
func SwaggerUIHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(swaggerHTML))
}

const swaggerHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>API — Booking Platform</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger',
      deepLinking: true,
      persistAuthorization: true
    });
  </script>
</body>
</html>`
