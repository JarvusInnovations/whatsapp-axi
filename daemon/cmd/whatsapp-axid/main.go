// Command whatsapp-axid is the per-account daemon of whatsapp-axi (specs/daemon.md).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"go.mau.fi/whatsmeow/store/sqlstore"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client/wa"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/runner"
)

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "0.0.0-dev"

const usage = `usage: whatsapp-axid <subcommand> [flags]
subcommands:
  run --account <name> [--log-level debug|info|warn|error]   run the account's daemon in the foreground
  init --account <name>                                       create the account's files with default settings
  remove --account <name>                                     delete the account's config and state
  version                                                     print the daemon and library versions
`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "version", "--version", "-v":
		if len(rest) > 0 {
			fmt.Fprintf(stderr, "whatsapp-axid version: unexpected argument %q\n", rest[0])
			return 2
		}
		fmt.Fprintf(stdout, "whatsapp-axid %s\n%s %s\n", version, runner.LibraryModule, runner.Library())
		return 0
	case "-h", "--help", "help":
		fmt.Fprint(stdout, usage)
		return 0
	case "run", "init", "remove":
	default:
		fmt.Fprintf(stderr, "whatsapp-axid: unknown subcommand %q\n%s", sub, usage)
		return 2
	}

	fs := flag.NewFlagSet("whatsapp-axid "+sub, flag.ContinueOnError)
	fs.SetOutput(stderr)
	account := fs.String("account", "", "account name")
	level := "info"
	if sub == "run" {
		fs.StringVar(&level, "log-level", "info", "debug, info, warn or error")
	}
	if err := fs.Parse(rest); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "whatsapp-axid %s: unexpected argument %q\n", sub, fs.Arg(0))
		return 2
	}
	if *account == "" {
		fmt.Fprintf(stderr, "whatsapp-axid %s: --account is required\n", sub)
		return 2
	}

	switch sub {
	case "init":
		l, err := runner.Init(*account, nil)
		if err != nil {
			fmt.Fprintf(stderr, "whatsapp-axid init: %v\n", err)
			return 1
		}
		fmt.Fprintf(stdout, "created account %s\nsettings: %s\nstate: %s\n", *account, l.SettingsFile(), l.StateDir())
		return 0
	case "remove":
		if _, err := runner.Remove(*account, nil); err != nil {
			fmt.Fprintf(stderr, "whatsapp-axid remove: %v\n", err)
			return 1
		}
		fmt.Fprintf(stdout, "removed account %s\n", *account)
		return 0
	}

	var lv slog.Level
	if err := lv.UnmarshalText([]byte(strings.ToUpper(level))); err != nil {
		fmt.Fprintf(stderr, "whatsapp-axid run: --log-level must be debug, info, warn or error\n")
		return 2
	}
	err := runner.Run(ctx, runner.Options{
		Account: *account, Version: version, Log: stderr, Level: lv,
		NewClient: func(s *sqlstore.Container, hasSession bool, log *slog.Logger) client.Client {
			return wa.New(s, hasSession, log)
		},
	})
	if err != nil {
		fmt.Fprintf(stderr, "whatsapp-axid run: %v\n", err)
		return 1
	}
	return 0
}
