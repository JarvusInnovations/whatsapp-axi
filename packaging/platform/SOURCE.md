# Source of whatsapp-axid ${version}

`bin/whatsapp-axid` in this package is distributed under the GNU General Public License version 3
only ([LICENSE](LICENSE)).

The complete corresponding source is the repository
<https://github.com/JarvusInnovations/whatsapp-axi> at the tag `v${version}`
(<https://github.com/JarvusInnovations/whatsapp-axi/tree/v${version}>): the `daemon/` directory,
whose `go.mod` and `go.sum` fix every dependency, plus the dependency versions listed in
[NOTICES](NOTICES). The dependencies' sources are available from the Go module proxy at those
versions.

This binary was built with ${goversion} by:

```sh
git clone https://github.com/JarvusInnovations/whatsapp-axi.git
cd whatsapp-axi && git checkout v${version}
cd daemon
CGO_ENABLED=0 GOOS=${goos} GOARCH=${goarch} go build -trimpath -buildvcs=false \
  -ldflags "-s -w -X main.version=${version} -X github.com/JarvusInnovations/whatsapp-axi/daemon/internal/runner.LibraryVersion=${library}" \
  -o whatsapp-axid ./cmd/whatsapp-axid
```
