// Command whatsapp-axid is the per-account daemon of whatsapp-axi.
//
// This is a skeleton: it proves the module builds against whatsmeow. The daemon's
// behaviour is defined by specs/ (in progress) and is not implemented yet.
package main

import (
	"fmt"
	"io"
	"os"

	"go.mau.fi/whatsmeow"
)

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "0.0.0-dev"

// newClient is referenced so whatsmeow stays a real, compiled dependency of the skeleton.
var newClient = whatsmeow.NewClient

func run(args []string, stdout io.Writer) int {
	if len(args) == 1 && (args[0] == "version" || args[0] == "--version") {
		fmt.Fprintln(stdout, version)
		return 0
	}
	fmt.Fprintln(stdout, "whatsapp-axid: skeleton build; the daemon is not implemented yet (see specs/)")
	return 2
}

func main() {
	_ = newClient
	os.Exit(run(os.Args[1:], os.Stdout))
}
