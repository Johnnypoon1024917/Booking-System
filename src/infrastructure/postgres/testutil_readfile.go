package postgres

import "os"

// readFile is a tiny shim around os.ReadFile so the column-count test
// can pull the source of booking_repo.go at runtime without importing
// the testing package into production code. Defined in its own file so
// the production build doesn't carry the test-only helper.
//
// Lives in a _test-adjacent_ file (named *_readfile.go, not _test.go)
// because go test from the package root can't import another file's
// internals if it's `*_test.go` in a sibling sub-package. Keeping it
// in the same package — but trivially small — satisfies both build
// modes without leaking surface area to production callers.
func readFile(name string) ([]byte, error) {
	return os.ReadFile(name)
}
