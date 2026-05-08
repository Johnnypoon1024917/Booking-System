package usecase

import "fmt"

// MaskMeetingURL replaces dynamic links with the FSD static redirect service [cite: 375]
func MaskMeetingURL(dynamicURL string) string {
	if dynamicURL == "" {
		return ""
	}
	// Logic to mask dynamic Zoom/Teams URLs [cite: 375]
	return fmt.Sprintf("https://ess.hkfsd.hksarg/redirect?target=%s", dynamicURL)
}
