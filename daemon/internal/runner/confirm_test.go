package runner

import (
	"strings"
	"testing"
)

// TestConfirmRequiredAtTheSocket: a settings change that widens what the account reads or
// loosens a send safeguard is refused without confirm: true, whoever sends it; tightening and
// no-ops need nothing (specs/cli.md "What needs --confirm").
func TestConfirmRequiredAtTheSocket(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	loosening := []string{
		`{"scope":"full"}`,
		`{"chats":{"` + group + `":"full"}}`,
		`{"dm_from":"anyone"}`,
		`{"send":{"first_contact":"allow"}}`,
		`{"send":{"per_hour":61}}`,
		`{"send":{"per_minute":11}}`,
		`{"send":{"same_text_chats":4}}`,
		`{"send":{"max_file_mb":65}}`,
		`{"send":{"per_hour":61},"confirm":false}`,
	}
	for _, body := range loosening {
		e := d.wantError("PATCH", "/v1/settings", body, 409, "confirm_required")
		if !strings.Contains(e["message"].(string), "confirm: true") {
			t.Fatalf("%s: %v", body, e)
		}
	}
	// Nothing was written by a refused change.
	var s struct {
		Settings struct {
			Scope  string `json:"scope"`
			DMFrom string `json:"dm_from"`
			Send   struct {
				PerHour      int    `json:"per_hour"`
				FirstContact string `json:"first_contact"`
			} `json:"send"`
		} `json:"settings"`
	}
	d.get("/v1/settings", &s)
	if s.Settings.Scope != "tagged" || s.Settings.DMFrom != "operators" || s.Settings.Send.PerHour != 60 || s.Settings.Send.FirstContact != "refuse" {
		t.Fatalf("a refused change was written: %+v", s.Settings)
	}
	// With confirm each goes through.
	for _, body := range loosening[:8] {
		d.patch(strings.TrimSuffix(body, "}") + `,"confirm":true}`)
	}
	// Tightening, a no-op and unrelated settings need nothing.
	for _, body := range []string{
		`{"send":{"per_hour":10,"per_minute":2,"same_text_chats":1,"max_file_mb":5,"first_contact":"refuse"}}`,
		`{"dm_from":"operators","scope":"tagged","chats":{"` + group + `":"none"}}`,
		`{"scope":"tagged"}`,
		`{"presence":false,"read_receipts":"off"}`,
	} {
		d.patch(body)
	}
	d.wantError("PATCH", "/v1/settings", `{"confirm":"yes"}`, 400, "bad_request")
}
