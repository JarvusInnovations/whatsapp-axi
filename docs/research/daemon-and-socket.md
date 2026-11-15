# Daemon lifecycle and local socket: options

Research notes for the spec author; not a spec. Compiled 2026-11-14.

Marks: **[verified]** = read in the cited doc or source; **[inferred]** = reasoned from
verified facts or general knowledge, not checked against a primary source; **[unknown]** =
not established.

This file lists options and trade-offs only. It makes no decisions.

---

## 1. Socket location

### Linux: `$XDG_RUNTIME_DIR`

- The XDG Base Directory spec says the directory MUST be owned by the user, MUST have mode
  0700, and its lifetime MUST be bound to the user being logged in: created at first login,
  removed when the user fully logs out. [verified]
  <https://specifications.freedesktop.org/basedir/latest/>
- If it is unset, applications "should fall back to a replacement directory with similar
  capabilities" and print a warning. The spec names no specific fallback. [verified] (same link)
- Files in it MAY be cleaned up periodically. To avoid that, touch the access time at least
  every 6 hours, or set the sticky bit on the file. [verified] (same link)
- `pam_systemd` creates `/run/user/$UID` at first login and removes it with all contents when
  the user's last concurrent session ends. [verified]
  <https://www.freedesktop.org/software/systemd/man/latest/pam_systemd.html>
- With lingering enabled, the user manager runs from boot and survives logout. The runtime dir
  then stays in place because the manager holds it open. [inferred: loginctl says the manager
  is "kept around after logouts" (verified,
  <https://www.freedesktop.org/software/systemd/man/latest/loginctl.html>); that the directory
  persists with it is general systemd behaviour, not quoted]
- `$XDG_RUNTIME_DIR` is often unset in `ssh` sessions without PAM/logind, in `su`/`sudo -u`
  shells, in cron and in containers. [inferred]
- Fallback options when unset:
  - (a) `/run/user/$(id -u)` if it exists and is owned by the user with mode 0700. [inferred]
  - (b) a per-user directory under `$XDG_STATE_HOME` / `~/.local/state/<app>/`. It is
    persistent and not tmpfs, so stale sockets survive reboot (see section 4). [inferred]
  - (c) `/tmp/<app>-$UID/`, created 0700 and checked for ownership on every start. `/tmp` is
    shared, so an attacker can pre-create the directory. [inferred]

### macOS

- macOS has no `$XDG_RUNTIME_DIR`. [inferred: not set by the OS; general knowledge]
- `$TMPDIR` is a per-user directory under `/var/folders/...`, owned by the user with mode 0700.
  The OS may purge it. It is long (about 50 characters), which matters for the path limit
  below. [inferred]
- `~/Library/Application Support/<app>/` is persistent and user-owned. It contains a space,
  which is harmless to `bind()` but awkward in shell examples. [inferred]
- `~/Library/Caches/<app>/` is also user-owned. The system may clear it. [inferred]
- launchd can create the socket itself through the plist `Sockets` key (`SockPathName`,
  `SockPathMode`; plists have no octal, so the mode is written in decimal). [verified]
  <https://keith.github.io/xcode-man-pages/launchd.plist.5.html>

### Path length (`sun_path`)

- Linux: `sun_path` is 108 bytes, including the NUL. [verified]
  <https://man7.org/linux/man-pages/man7/unix.7.html>
- macOS / XNU: `char sun_path[104]`. [verified]
  <https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h>
- `$TMPDIR` plus `<app>/<account>.sock` can come close to 104 bytes if the account id is a
  phone number or a long label. Options: a short fixed filename per instance, a hash of the
  account id, or `chdir` and bind to a relative path. Go's `net` returns an error when the
  path is too long. [inferred]
- Linux also has abstract sockets (`@name`), which are not on the filesystem, but the man page
  calls them "a nonportable Linux extension" [verified] (unix(7)). They have no file
  permissions, so peer-credential checks are the only access guard. [inferred]

## 2. Permissions and peer credentials

- **Linux:** "connecting to a stream socket object requires write permission on that socket."
  The same page warns that some BSD-derived systems ignore this and "portable programs should
  not rely on this feature for security." [verified] (unix(7))
- **macOS (current XNU):** `unp_connect()` calls
  `vnode_authorize(vp, NULL, KAUTH_VNODE_WRITE_DATA, ctx)` on the socket vnode, so modern
  macOS does enforce write permission on the socket file for connect. [verified]
  <https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c>
  (around L1345). The "BSD ignores socket mode" folklore refers to older systems. FreeBSD
  unix(4) also says the target of `connect(2)` "must be writable". [verified]
  <https://man.freebsd.org/cgi/man.cgi?query=unix&sektion=4>
- Defence in depth either way: a 0700 parent directory blocks path lookup by other users
  whatever the file mode. [inferred: standard Unix directory traversal semantics]
- **Creation race:** Go's `net.Listen("unix", path)` creates the file with mode `0777 &^ umask`
  and has no mode parameter. Options: bind inside an already-0700 directory (the race is then
  moot), set `syscall.Umask(0077)` around the bind (process-wide, so it affects other
  goroutines), or `chmod` after the bind (a short window). [inferred]
- **Peer credentials:**
  - Linux `SO_PEERCRED` returns the connected peer's pid/uid/gid on AF_UNIX stream sockets.
    [verified] (unix(7)). In Go: `unix.GetsockoptUcred(fd, unix.SOL_SOCKET, unix.SO_PEERCRED)`
    in `golang.org/x/sys/unix` (`syscall_linux.go`). [verified, x/sys v0.49.0 source]
  - macOS `LOCAL_PEERCRED` (level `SOL_LOCAL` = 0) returns a `struct xucred`. XNU also exposes
    `LOCAL_PEERPID` and `LOCAL_PEERTOKEN` (audit token). [verified] (xnu `bsd/sys/un.h`). In
    Go: `unix.GetsockoptXucred(fd, unix.SOL_LOCAL, unix.LOCAL_PEERCRED)` (`syscall_darwin.go`).
    [verified, x/sys v0.49.0 source]. `getpeereid(3)` is the libc wrapper; x/sys has no
    `Getpeereid` function. [verified by grep of x/sys v0.49.0]
  - Getting the fd from a Go `*net.UnixConn` means `conn.SyscallConn()` then `Control(func(fd
    uintptr){...})`. [inferred]
  - Typical policy: reject any peer whose uid is not the daemon's euid. [inferred]

## 3. Stale socket cleanup

Options, not exclusive: [inferred for all]

- **Probe then unlink:** at start, `connect()` to the existing path. On `ECONNREFUSED`, unlink
  and bind. If the connect succeeds, another daemon is live, so exit with "already running".
- **Lock file:** take `flock()` on `<name>.lock` next to the socket. Holding the lock means
  you own the socket path, so unlinking is safe. The kernel releases the lock on crash.
- **Unlink on clean shutdown:** necessary but not sufficient, because SIGKILL or a crash
  skips it.
- **tmpfs location** (`$XDG_RUNTIME_DIR`): reboot clears it for free. A persistent location
  does not.
- **Socket activation:** the supervisor owns the path (section 6). systemd `RemoveOnStop=`
  defaults to off and the man page advises against it in most cases. [verified]
  <https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html>

## 4. Supervision: systemd user units (Linux)

- **Template units:** `name@.service` is instantiated as `name@<instance>.service`. `%i` is
  the instance string and `%I` is the same string with escaping undone. `%t` is
  `$XDG_RUNTIME_DIR` for user managers and `%h` is the home directory. `DefaultInstance=`
  sets the instance used when the bare template is enabled. User units load from
  `~/.config/systemd/user`. [verified]
  <https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html>
  - Per-account instance: `whatsapp-axi@<account>.service`. The account id must survive
    `systemd-escape`, since phone numbers containing `+` or `-` are escaped. [inferred]
- **Lingering:** `loginctl enable-linger <user>` spawns the user manager at boot and keeps it
  "around after logouts", so users who are not logged in can run long-running services.
  [verified] (loginctl link above)
- **Without lingering:** the user's `user@.service` manager starts with the first session and
  stops when the last session ends. `/run/user/$UID` is removed at that point. [verified]
  (pam_systemd link above). `KillUserProcesses=` in logind.conf defaults to yes, though
  distributions often override it, and it kills the session scope on logout. [verified]
  <https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html>.
  The upshot: on a headless box the daemon dies at the end of the ssh session that started
  it. [inferred]
- **`systemctl --user` from ssh, cron or sudo:** the client finds the manager through
  `$XDG_RUNTIME_DIR` (`$XDG_RUNTIME_DIR/systemd/private` or the user bus at
  `$XDG_RUNTIME_DIR/bus`). When the variable is unset it fails with "Failed to connect to
  bus". The usual fix is `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, which only works if the
  manager is running, so it needs lingering or another session. `systemctl --user -M
  <user>@` is an alternative on newer systemd. [inferred: well-known behaviour, man page not
  quoted]
- **Logging:** a service's stdout/stderr go to the journal by default, readable with
  `journalctl --user -u 'whatsapp-axi@*'`. Some distributions without persistent journald
  storage do not keep per-user journals readable by the user. [inferred]
- **Directories:** `RuntimeDirectory=` resolves under `$XDG_RUNTIME_DIR` (`$RUNTIME_DIRECTORY`)
  and `StateDirectory=` under `$XDG_STATE_HOME` (`$STATE_DIRECTORY`) in user units.
  [verified] <https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html>
- **Sandboxing in user units:** "some sandboxing functionality is generally not available in
  user services". Settings that need filesystem namespacing, such as `ProtectSystem=`, are
  unavailable because the kernel feature needs privilege. Most namespacing settings work only
  together with `PrivateUsers=`, which needs unprivileged user namespaces. `ProtectHome=` and
  `PrivateTmp=` implicitly enable `PrivateUsers=` in user instances. `ProtectProc=` is not
  supported in user instances. [verified] (systemd.exec link). Whether
  `MemoryDenyWriteExecute=`, `SystemCallFilter=`, `RestrictAddressFamilies=` and
  `NoNewPrivileges=` work in user units: [unknown, not read]. They are seccomp/prctl based,
  which does not need privilege, so they probably do. [inferred]
  - Hosts that disable unprivileged user namespaces (some hardened distros, AppArmor
    restrictions on recent Ubuntu) can make units with `PrivateUsers=` fail to start.
    [inferred]
- **Restart policy:** `Restart=` accepts `no` (the default), `on-success`, `on-failure`,
  `on-abnormal`, `on-watchdog`, `on-abort` and `always`. `RestartSec=` defaults to 100ms.
  Restarts are subject to `StartLimitIntervalSec=`/`StartLimitBurst=`. `Type=notify` expects
  `READY=1`, and `WatchdogSec=` expects periodic `WATCHDOG=1`. [verified]
  <https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html>
  - A whatsmeow session that WhatsApp logs out (unpaired) should probably exit with a code
    that does not loop-restart (`RestartPreventExitStatus=`). [inferred]

## 5. Supervision: launchd (macOS)

- **Agents vs daemons:** agents are per-user and "run only while that user is logged in".
  They live in `~/Library/LaunchAgents` and are owned by the user. Daemons are system-level,
  live in `/Library/LaunchDaemons` and are owned by root. [verified]
  <https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html>
- **Required keys:** `Label` and `ProgramArguments`. The process must not daemonize: no
  `fork()`/`daemon()`, stay in the foreground, handle SIGTERM. [verified] (same link)
- **`KeepAlive`:** a boolean, or a dictionary with `SuccessfulExit`, `Crashed` and other
  keys, ORed together. `RunAtLoad` defaults to false. `StandardOutPath`/`StandardErrorPath`
  redirect output to files, which launchd creates. The default throttle is one spawn per 10s
  (`ThrottleInterval`). [verified] <https://keith.github.io/xcode-man-pages/launchd.plist.5.html>
- **Loading:** `launchctl bootstrap gui/<uid> <plist>` and `launchctl bootout gui/<uid>/<label>`.
  `gui/<uid>` exists only after a GUI login. `user/<uid>` "can exist without a logged-in
  user". `kickstart -k` restarts a job. `launchctl print` output is explicitly not an API.
  [verified] <https://keith.github.io/xcode-man-pages/launchctl.1.html>
- **Headless Mac (no GUI login):** a LaunchAgent in `gui/<uid>` will not run. Options: enable
  auto-login, bootstrap into `user/<uid>` (some agent features are unavailable there:
  [unknown] which ones affect a network daemon), or a LaunchDaemon with `UserName=` (needs
  root to install). [inferred]
- **Logs:** launchd has no journald equivalent for a plain stdout. Options are files via
  `StandardErrorPath` (rotation is the app's problem) or `os_log` through cgo. [inferred]
- **Per-account instances:** launchd has no templates, so you need one plist per account
  (`<reverse-dns>.whatsapp-axi.<account>`), generated by the CLI. [inferred]

## 6. Framing / protocol shortlist

| Option | Go side | Node side | Streaming (`follow`) | Debuggability | CLI dependency weight |
| --- | --- | --- | --- | --- | --- |
| Line-delimited JSON (custom) | stdlib `bufio` + `encoding/json` [inferred] | `net.connect({path})` + `readline` [inferred] | Natural: server keeps writing lines | `socat - UNIX-CONNECT:<path>` then type JSON [inferred] | None |
| JSON-RPC 2.0 | `golang.org/x/exp/jsonrpc2` ("minimal implementation of the JSON RPC 2 spec") [verified, source header]; `github.com/sourcegraph/jsonrpc2` [verified, README] | `vscode-jsonrpc` 10.0.0 (no deps, ~228 KB unpacked); `json-rpc-2.0` 1.8.1 (no deps, ~59 KB) [verified, npm registry] | Server-to-client notifications | socat, with a hand-typed envelope [inferred] | Small |
| gRPC over UDS | `unix:` and `unix-abstract:` resolvers in grpc-go (`internal/resolver/unix`) [verified] | `@grpc/grpc-js` registers a `unix` resolver (`resolver-uds.ts`) [verified]; 1.14.7 is ~2.5 MB unpacked plus `@grpc/proto-loader` [verified, npm registry] | Server streaming RPCs, first-class | Needs `grpcurl -unix` and protos/reflection [inferred] | Heavy; codegen or proto loading |
| HTTP/1.1 over UDS | `http.Serve(unixListener, mux)` [inferred: standard] | `http.request({socketPath})` [verified, Node `doc/api/http.md`]; also `undici` Agent `socketPath` [inferred] | NDJSON chunked response or SSE | `curl --unix-socket <path> http://x/...` [verified: curl `--unix-socket` flag] | None (Node built-in `http`) |

Cross-cutting notes: [inferred for all]

- **Versioning/handshake:** whatever the framing, the first exchange can carry
  `{protocol: N, daemon_version, cli_version}`. On a mismatch the CLI fails with a structured
  "restart daemon / upgrade" error. HTTP can use a path prefix (`/v1/`); JSON-RPC can use a
  `hello` method; gRPC has package versioning in the proto.
- **Streaming:** `follow`-style commands want server push with backpressure. NDJSON over a raw
  socket or a chunked HTTP response both give this with zero dependencies. JSON-RPC notifications
  need the client to multiplex responses and notifications.
- **Concurrency:** HTTP and gRPC multiplex per request out of the box. Line-JSON needs request
  ids if one connection carries several in-flight calls; one connection per command avoids that.
- **Bundling:** if the CLI ships as a single bundled `.mjs`, gRPC's size and dynamic proto
  loading are the main cost. Built-in `http`/`net` add nothing.

## 7. CLI behaviour when the daemon is down

| Option | Pros | Cons |
| --- | --- | --- |
| Structured error plus fix command (`{error:"daemon_not_running", account, fix:"whatsapp-axi daemon start <account>"}`) | Predictable; agent-friendly; no hidden processes | One extra step for the user [inferred] |
| Read-only commands read the SQLite/state files directly | Works while the daemon is down | Two code paths; WAL/locking contention with a live daemon; the Node CLI would need its own SQLite driver; schema coupling to whatsmeow tables [inferred] |
| Auto-start (spawn a detached daemon) | Seamless first use | Escapes the supervisor (no restart, logs go nowhere); races if two CLIs spawn at once (needs the lock file from section 3); a surprise long-lived process [inferred] |
| Socket activation: systemd `.socket` unit | The supervisor owns the path and permissions; the daemon starts on first connect | `SocketMode=` defaults to 0666 and `DirectoryMode=` to 0755, so both must be tightened; `Accept=no` hands the listening fd to one service via `sd_listen_fds`. [verified] (systemd.socket link). But a WhatsApp client must stay connected to receive messages, so on-demand start alone loses messages until first use [inferred] |
| Socket activation: launchd `Sockets` | Same idea on macOS | The daemon must check in for the fd (`launch_activate_socket`, a C API, so cgo from Go: [inferred]); same always-connected caveat [inferred] |

## Implications for the spec (not decisions)

1. Lingering is the hinge on Linux. Without `enable-linger` the daemon, and
   `$XDG_RUNTIME_DIR` with its socket, vanish when the last session ends. The spec should
   say whether setup checks or enables lingering, and how `systemctl --user` is reached from
   ssh/cron.
2. macOS enforces socket file write permission on connect in current XNU (verified in
   source), so the "directory is the only guard" assumption is outdated. A 0700 directory
   plus a uid check via `LOCAL_PEERCRED` / `SO_PEERCRED` is still the robust combination,
   and both are reachable from `golang.org/x/sys/unix` without cgo.
3. The 104-byte macOS `sun_path` limit and the long `$TMPDIR` mean the socket filename should
   not embed a raw account id without a length check or hash.
4. LaunchAgents in `gui/<uid>` do not run on a Mac that nobody has logged into graphically.
   If headless Macs are in scope, the spec has to choose among auto-login, `user/<uid>` or a
   LaunchDaemon.
5. Socket activation fits the "the CLI connects" half but not the "the daemon must stay
   connected to WhatsApp" half. On-demand start is at most a complement to an always-on
   unit.
6. HTTP-over-UDS and NDJSON both give streaming plus curl/socat debugging with no
   CLI dependencies. gRPC brings the strongest schema and the heaviest bundle.
