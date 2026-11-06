// Package importer provides the same validated import implementation to the API and CLI.
package importer

import _ "embed"

//go:embed content.py
var Script []byte
