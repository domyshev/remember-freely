package seed

import "embed"

// Files contains only an empty library. Question packs are installed separately.
//
//go:embed *.json
var Files embed.FS
