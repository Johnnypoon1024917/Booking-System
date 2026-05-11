package handlers

import (
	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/user"
	"net/http"
	"time"
)

type ReportHandler struct {
	reportUC *usecase.GenerateReportUseCase
}

func NewReportHandler(reportUC *usecase.GenerateReportUseCase) *ReportHandler {
	return &ReportHandler{reportUC: reportUC}
}

func (h *ReportHandler) ExportUsageReport(w http.ResponseWriter, r *http.Request) {
	// Security: Only System Admins and Security Admins can export reports
	role := r.Context().Value("role").(string)
	if role != user.RoleSystemAdmin && role != user.RoleSecurityAdmin {
		http.Error(w, "Forbidden: Insufficient privileges to export reports", http.StatusForbidden)
		return
	}

	start := r.URL.Query().Get("start")
	end := r.URL.Query().Get("end")

	csvData, err := h.reportUC.GenerateUsageCSV(r.Context(), start, end)
	if err != nil {
		http.Error(w, "Failed to generate report", http.StatusInternalServerError)
		return
	}

	// Set headers for file download
	filename := "fsd_usage_report_" + time.Now().Format("20060102") + ".csv"
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename="+filename)

	w.Write(csvData)
}
