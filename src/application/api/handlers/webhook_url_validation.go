package handlers

import "fsd-mrbs/src/infrastructure/safehttp"

// ValidateWebhookTargetURL is a thin handler-facing alias for the shared
// SSRF allowlist. It returns nil when the URL is safe to persist.
func ValidateWebhookTargetURL(raw string) error {
	return safehttp.ValidateExternalURL(raw)
}
