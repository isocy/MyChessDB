//go:build testhooks

package main

// Only compiled with `-tags testhooks` (the automated tests). Lets a test
// trust a stand-in engine and point downloads at a local server. None of
// this exists in the binaries users install.

import "os"

func testTrusted(hash string) bool    { return hash != "" && os.Getenv("MYCHESSDB_TEST_TRUST") == hash }
func testOverride(name string) string { return os.Getenv(name) }
