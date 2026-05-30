package usecase

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"

	"fsd-mrbs/src/domain/report"

	"github.com/xuri/excelize/v2"
)

// neutralize defangs strings that would otherwise be interpreted as a
// formula by Excel / Google Sheets / LibreOffice when a CSV or XLSX export
// is opened. Cells starting with =, +, -, @, tab, or CR are prefixed with a
// single quote so the spreadsheet treats them as literal text. Without this
// guard, a booking note like `=cmd|'/C calc'!A0` executes on open.
func neutralize(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}

func neutralizeRow(in []string) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[i] = neutralize(v)
	}
	return out
}

type GenerateReportUseCase struct {
	repo report.ReportRepository
}

func NewGenerateReportUseCase(repo report.ReportRepository) *GenerateReportUseCase {
	return &GenerateReportUseCase{repo: repo}
}

// GenerateUsageCSV creates a downloadable CSV file buffer.
func (uc *GenerateReportUseCase) GenerateUsageCSV(ctx context.Context, start, end string) ([]byte, error) {
	data, err := uc.repo.GetUsageData(ctx, start, end)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	writer := csv.NewWriter(&buf)
	writer.Write([]string{"Resource Name", "Total Bookings", "Total Hours Utilised", "Peak Time"})
	for _, row := range data {
		writer.Write(neutralizeRow([]string{
			row.ResourceName,
			fmt.Sprintf("%d", row.TotalBookings),
			fmt.Sprintf("%.2f", row.TotalHours),
			row.PeakTime,
		}))
	}
	writer.Flush()
	return buf.Bytes(), nil
}

// GenerateUsageXLSX produces an Excel workbook with a "Usage" sheet,
// styled headers and a usable column-width default. This satisfies the
// FSD requirement that all reports must be exportable to Excel or CSV.
func (uc *GenerateReportUseCase) GenerateUsageXLSX(ctx context.Context, start, end string) ([]byte, error) {
	data, err := uc.repo.GetUsageData(ctx, start, end)
	if err != nil {
		return nil, err
	}

	f := excelize.NewFile()
	defer f.Close()

	const sheet = "Usage"
	idx, err := f.NewSheet(sheet)
	if err != nil {
		return nil, err
	}
	f.SetActiveSheet(idx)
	f.DeleteSheet("Sheet1")

	headerStyle, _ := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "FFFFFF"},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{"002147"}, Pattern: 1},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center"},
	})

	headers := []string{"Resource Name", "Total Bookings", "Total Hours Utilised", "Peak Time"}
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		f.SetCellValue(sheet, cell, h)
		f.SetCellStyle(sheet, cell, cell, headerStyle)
	}

	for r, row := range data {
		f.SetCellValue(sheet, fmt.Sprintf("A%d", r+2), neutralize(row.ResourceName))
		f.SetCellValue(sheet, fmt.Sprintf("B%d", r+2), row.TotalBookings)
		f.SetCellValue(sheet, fmt.Sprintf("C%d", r+2), row.TotalHours)
		f.SetCellValue(sheet, fmt.Sprintf("D%d", r+2), neutralize(row.PeakTime))
	}

	f.SetColWidth(sheet, "A", "A", 32)
	f.SetColWidth(sheet, "B", "D", 22)

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// GetDashboard returns the aggregated dashboard payload for the tenant,
// scoped by the caller's role (own bookings / managed region / tenant-wide).
func (uc *GenerateReportUseCase) GetDashboard(ctx context.Context, tenantID, start, end string, filter report.DashboardFilter) (report.DashboardData, error) {
	return uc.repo.GetDashboard(ctx, tenantID, start, end, filter)
}

// GetReportTable returns one report type as a generic headers+rows table
// (used for the on-screen preview).
func (uc *GenerateReportUseCase) GetReportTable(ctx context.Context, tenantID, reportType, start, end string) (report.ReportTable, error) {
	return uc.repo.GetReportTable(ctx, tenantID, reportType, start, end)
}

// GenerateReportCSV renders any report type to CSV.
func (uc *GenerateReportUseCase) GenerateReportCSV(ctx context.Context, tenantID, reportType, start, end string) ([]byte, error) {
	tbl, err := uc.repo.GetReportTable(ctx, tenantID, reportType, start, end)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	w.Write(tbl.Headers)
	for _, row := range tbl.Rows {
		w.Write(neutralizeRow(row))
	}
	w.Flush()
	return buf.Bytes(), nil
}

// GenerateReportXLSX renders any report type to a styled Excel workbook,
// satisfying the FSD requirement that every report exports to Excel.
func (uc *GenerateReportUseCase) GenerateReportXLSX(ctx context.Context, tenantID, reportType, start, end string) ([]byte, error) {
	tbl, err := uc.repo.GetReportTable(ctx, tenantID, reportType, start, end)
	if err != nil {
		return nil, err
	}

	f := excelize.NewFile()
	defer f.Close()
	const sheet = "Report"
	idx, err := f.NewSheet(sheet)
	if err != nil {
		return nil, err
	}
	f.SetActiveSheet(idx)
	f.DeleteSheet("Sheet1")

	headerStyle, _ := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "FFFFFF"},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{"002147"}, Pattern: 1},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center"},
	})
	for i, h := range tbl.Headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		f.SetCellValue(sheet, cell, h)
		f.SetCellStyle(sheet, cell, cell, headerStyle)
	}
	for ri, row := range tbl.Rows {
		for ci, val := range row {
			cell, _ := excelize.CoordinatesToCellName(ci+1, ri+2)
			f.SetCellValue(sheet, cell, neutralize(val))
		}
	}
	if n := len(tbl.Headers); n > 0 {
		last, _ := excelize.ColumnNumberToName(n)
		f.SetColWidth(sheet, "A", last, 24)
	}

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
