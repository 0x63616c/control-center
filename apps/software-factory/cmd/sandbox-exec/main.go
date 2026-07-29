// Command sandbox-exec is the sandbox image's exec wrapper, and one half of a
// contract with internal/clients/k8s (see shimPath in exec.go).
//
// It exists because pods/exec never reports the remote PID, and no argv-only
// coreutils trick recovers one: env and setsid exec-replace themselves so no
// tag survives in the process's cmdline, and pkill -f against the joined argv is
// ambiguous exactly when it matters — two attempts of the same stage. This shim
// is the only mechanism that yields a specific PID without a shell.
//
// Two modes, both argv-only:
//
//	sandbox-exec --pidfile P -- ARGV...   run ARGV, recording its PID in P
//	sandbox-exec --kill P                 stop the process P names
//
// Run mode forwards stdin/stdout/stderr untouched and exits with the child's
// own status, because that status is the stage's success signal end to end.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"time"
)

// Exit statuses the shim produces for its OWN failures.
//
// They are deliberately in the sysexits/shell range rather than 1 or 2, so a
// shim failure is unlikely to be mistaken for a child's. It cannot be made
// unambiguous — a child may exit with any status — which is why every one of
// these is accompanied by a line on stderr, and why the k8s client retains
// stderr on both paths.
const (
	exitUsage     = 64  // the shim was invoked wrongly.
	exitInternal  = 125 // the shim itself failed; the child's status is unknown.
	exitCannotRun = 126 // ARGV was found but could not be executed.
	exitNotFound  = 127 // ARGV[0] does not exist.
)

// defaultGrace is how long --kill waits between SIGTERM and SIGKILL.
//
// It is a contract with the caller's timeout, not a free choice: killExec in
// internal/clients/k8s bounds the kill exec at 2×its own killGrace (5s by
// default), so a grace at or above that budget would have the exec cancelled
// out from under the escalation and leave the group alive. Changing either side
// means changing both.
const defaultGrace = 5 * time.Second

// pidfileWait is how long --kill will wait for a pidfile that has not appeared
// yet.
//
// Run mode writes the pidfile immediately after fork, but "immediately" is not
// "atomically with", and cancellation can arrive inside that window. Without
// this the kill would report success having done nothing.
const pidfileWait = 2 * time.Second

func main() {
	os.Exit(dispatch(os.Args[1:], os.Stderr))
}

// dispatch parses argv and runs the mode it names. It is separated from main so
// tests exercise the real entry path rather than a paraphrase of it.
func dispatch(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("sandbox-exec", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprint(stderr, "usage:\n"+
			"  sandbox-exec --pidfile P [--grace D] -- ARGV...\n"+
			"  sandbox-exec --kill P [--grace D]\n")
	}
	pidfile := fs.String("pidfile", "", "run mode: file to record the child's PID in")
	killPath := fs.String("kill", "", "kill mode: pidfile naming the process group to stop")
	grace := fs.Duration("grace", defaultGrace, "kill mode: delay between SIGTERM and SIGKILL")

	if err := fs.Parse(args); err != nil {
		return exitUsage
	}

	switch {
	case *pidfile != "" && *killPath != "":
		fmt.Fprintln(stderr, "sandbox-exec: --pidfile and --kill are different modes; pass one")
		return exitUsage
	case *pidfile != "":
		argv := fs.Args()
		if len(argv) == 0 {
			fmt.Fprintln(stderr, "sandbox-exec: --pidfile needs a command after --")
			return exitUsage
		}
		return run(*pidfile, argv, stderr)
	case *killPath != "":
		if len(fs.Args()) > 0 {
			fmt.Fprintln(stderr, "sandbox-exec: --kill takes no command")
			return exitUsage
		}
		return kill(*killPath, *grace, stderr)
	default:
		fs.Usage()
		return exitUsage
	}
}
