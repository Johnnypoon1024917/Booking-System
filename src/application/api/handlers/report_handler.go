package handlers

import (
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/user"
)

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
