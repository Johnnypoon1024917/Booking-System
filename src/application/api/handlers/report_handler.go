package handlers

import (
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/domain/report"
	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/auditlog"
)

// validReportTypes is the allow-list of report identifiers; anything else
// is rejected before being interpolated into a download filename. This
// closes the "type param is concatenated into Content-Disposition" finding.
var validReportTypes = map[string]struct{}{
	"summary": {}, "noshow": {}, "staff": {}, "usage": {},
	"audit": {}, "medical": {}, "addl": {},
}

func normalizeReportType(raw string) string {
	rt := strings.ToLower(strings.TrimSpace(raw))
	if rt == "" {
		return "summary"
	}
	if _, ok := validReportTypes[rt]; !ok {
		return ""
	}
	return rt
}

// reportRange resolves the start/end query params, defaulting to the last
// 30 days so the dashboard and previews always have a sensible window.
func reportRange(r *http.Request) (string, string) {
	start := r.URL.Query().Get("start")
	end := r.URL.Query().Get("end")
	if end == "" {
		end = time.Now().Format("2006-01-02")
	}
	if start == "" {
		start = time.Now().AddDate(0, 0, -30).Format("2006-01-02")
	}
	return start, end
}

func (h *ReportHandler) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	role, _ := r.Context().Value("role").(string)
	if role == "" {
		role, _ = r.Context().Value("userRole").(string)
	}
	if role != user.RoleSystemAdmin && role != user.RoleSecurityAdmin {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return false
	}
	return true
}

type ReportHandler struct {
	reportUC *usecase.GenerateReportUseCase
}

func NewReportHandler(reportUC *usecase.GenerateReportUseCase) *ReportHandler {
	return &ReportHandler{reportUC: reportUC}
}

// ExportUsageReport returns the usage report as either CSV (default) or
// XLSX based on the `format` query parameter (csv|xlsx). Excel export is
// required by the FSD spec (R39/R40).
func (h *ReportHandler) ExportUsageReport(w http.ResponseWriter, r *http.Request) {
	role, _ := r.Context().Value("role").(string)
	if role == "" {
		role, _ = r.Context().Value("userRole").(string)
	}
	if role != user.RoleSystemAdmin && role != user.RoleSecurityAdmin {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	format := strings.ToLower(r.URL.Query().Get("format"))
	start := r.URL.Query().Get("start")
	end := r.URL.Query().Get("end")
	stamp := time.Now().Format("20060102")

	switch format {
	case "xlsx", "excel":
		data, err := h.reportUC.GenerateUsageXLSX(r.Context(), start, end)
		if err != nil {
			http.Error(w, "Report Generation Failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
		w.Header().Set("Content-Disposition", "attachment; filename=usage_report_"+stamp+".xlsx")
		w.Write(data)
	default:
		data, err := h.reportUC.GenerateUsageCSV(r.Context(), start, end)
		if err != nil {
			http.Error(w, "Report Generation Failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", "attachment; filename=usage_report_"+stamp+".csv")
		w.Write(data)
	}
}

// Dashboard returns the aggregated dashboard payload (FSD spec p.9):
// room utilisation, utilisation by department, statistics, no-show table.
//
// Scoping rules:
//   • System Admin / Security Admin / Secretary → tenant-wide ("all")
//   • Room Admin                                → restricted to the
//     regions in their JWT region_access claim ("region")
//   • Everyone else (General User)              → only their own bookings ("mine")
//
// This is enforced server-side; the SPA does not (and cannot) widen its
// own scope by changing query params.
func (h *ReportHandler) Dashboard(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	start, end := reportRange(r)

	role, _ := r.Context().Value("userRole").(string)
	uid, _ := r.Context().Value("userID").(string)
	regions, _ := r.Context().Value("userRegions").([]string)

	filter := report.DashboardFilter{}
	switch role {
	case user.RoleSystemAdmin, user.RoleSecurityAdmin, user.RoleSecretary:
		filter.Scope = report.DashboardScopeAll
	case user.RoleRoomAdmin:
		filter.Scope = report.DashboardScopeRegion
		filter.Regions = regions
		// Fall back to "mine" if a Room Admin has no regions assigned —
		// otherwise the WHERE clause is dropped and they'd see everything.
		if len(filter.Regions) == 0 {
			filter.Scope = report.DashboardScopeMine
			filter.UserID = uid
		}
	default:
		filter.Scope = report.DashboardScopeMine
		filter.UserID = uid
	}

	data, err := h.reportUC.GetDashboard(r.Context(), tid.String(), start, end, filter)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

// ReportData returns one report type as JSON (headers+rows) for the
// on-screen preview. ?type=summary|noshow|staff|usage|audit|medical|addl
func (h *ReportHandler) ReportData(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdmin(w, r) {
		return
	}
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	start, end := reportRange(r)
	rt := strings.ToLower(r.URL.Query().Get("type"))
	tbl, err := h.reportUC.GetReportTable(r.Context(), tid.String(), rt, start, end)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, tbl)
}

// ExportReport downloads any report type as CSV or XLSX.
// ?type=...&format=csv|xlsx&start=&end=
func (h *ReportHandler) ExportReport(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdmin(w, r) {
		return
	}
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	start, end := reportRange(r)
	rt := normalizeReportType(r.URL.Query().Get("type"))
	if rt == "" {
		http.Error(w, "unknown report type", http.StatusBadRequest)
		return
	}
	format := strings.ToLower(r.URL.Query().Get("format"))
	stamp := time.Now().Format("20060102")

	switch format {
	case "xlsx", "excel":
		data, err := h.reportUC.GenerateReportXLSX(r.Context(), tid.String(), rt, start, end)
		if err != nil {
			auditlog.Failure(r, audit.ActionDataExported, "report", rt, err.Error())
			http.Error(w, "Report Generation Failed", http.StatusInternalServerError)
			return
		}
		auditlog.Record(r, auditlog.Event{
			Action:       audit.ActionDataExported,
			Severity:     audit.SeverityWarning,
			TargetEntity: "report",
			TargetID:     rt,
			Next:         map[string]interface{}{"format": "xlsx", "start": start, "end": end, "bytes": len(data)},
		})
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
		w.Header().Set("Content-Disposition", "attachment; filename="+rt+"_report_"+stamp+".xlsx")
		w.Write(data)
	default:
		data, err := h.reportUC.GenerateReportCSV(r.Context(), tid.String(), rt, start, end)
		if err != nil {
			auditlog.Failure(r, audit.ActionDataExported, "report", rt, err.Error())
			http.Error(w, "Report Generation Failed", http.StatusInternalServerError)
			return
		}
		auditlog.Record(r, auditlog.Event{
			Action:       audit.ActionDataExported,
			Severity:     audit.SeverityWarning,
			TargetEntity: "report",
			TargetID:     rt,
			Next:         map[string]interface{}{"format": "csv", "start": start, "end": end, "bytes": len(data)},
		})
		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", "attachment; filename="+rt+"_report_"+stamp+".csv")
		w.Write(data)
	}
}
