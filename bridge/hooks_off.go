//go:build !testhooks

package main

// Release builds have no test hooks: these always answer "no".

func testTrusted(hash string) bool    { return false }
func testOverride(name string) string { return "" }
