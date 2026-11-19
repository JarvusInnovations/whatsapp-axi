package runner

import (
	"strings"
	"testing"
)

// TestConfirmRequiredAtTheSocket: a settings change that widens what the account reads or
// loosens a send safeguard is refused without confirm: true, whoever sends it; tightening and
// no-ops need nothing (specs/conventions.md "The gate inventory").
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
		`{"retain_days":91}`,
		`{"retain_days":0}`,
		`{"operators":["+15550100001"]}`,
		`{"send":{"per_hour":61},"confirm":false}`,
	}
	for _, body := range loosening {
		e := d.wantError("PATCH", "/v1/settings", body, 409, "CONFIRM_REQUIRED")
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
	for _, body := range loosening[:len(loosening)-1] {
		d.patch(strings.TrimSuffix(body, "}") + `,"confirm":true}`)
	}
	// Tightening, a no-op and unrelated settings need nothing.
	for _, body := range []string{
		`{"send":{"per_hour":10,"per_minute":2,"same_text_chats":1,"max_file_mb":5,"first_contact":"refuse"}}`,
		`{"dm_from":"operators","scope":"tagged","chats":{"` + group + `":"none"}}`,
		`{"scope":"tagged"}`,
		`{"presence":false,"read_receipts":"off"}`,
		`{"retain_days":30}`,
		`{"operators":[]}`,
	} {
		d.patch(body)
	}
	d.wantError("PATCH", "/v1/settings", `{"confirm":"yes"}`, 400, "VALIDATION_ERROR")
}

// TestWideningJudgedByEffect: a scope change is gated when any chat's effective scope widens,
// whatever value was asked for; removing an override that narrows, and any tightening, is not
// (specs/conventions.md "Widening is judged by effect, not by the value asked for").
func TestWideningJudgedByEffect(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	gated := func(body, want string) {
		t.Helper()
		e := d.wantError("PATCH", "/v1/settings", body, 409, "CONFIRM_REQUIRED")
		if !strings.Contains(e["message"].(string), want) {
			t.Fatalf("%s: %v", body, e)
		}
		d.patch(strings.TrimSuffix(body, "}") + `,"confirm":true}`)
	}
	// The account's scope raised one step: dm-only to tagged.
	d.patch(`{"scope":"dm-only"}`)
	gated(`{"scope":"tagged"}`, "scope tagged")
	// A chat's override raised from none to tagged.
	d.patch(`{"chats":{"` + group + `":"none"}}`)
	gated(`{"chats":{"`+group+`":"tagged"}}`, "chats."+group+" tagged")
	// An override of none removed under account scope full.
	gated(`{"scope":"full"}`, "scope full")
	d.patch(`{"chats":{"` + group + `":"none"}}`)
	gated(`{"chats":{"`+group+`":null}}`, "chats."+group+" default (full)")
	// Removing an override that narrows, and every tightening, needs nothing.
	d.patch(`{"scope":"tagged"}`)
	gated(`{"chats":{"`+group+`":"full"}}`, "chats."+group+" full")
	for _, body := range []string{
		`{"chats":{"` + group + `":null}}`,
		`{"chats":{"` + group + `":"tagged"}}`,
		`{"chats":{"` + group + `":"none"}}`,
		`{"scope":"dm-only"}`,
	} {
		d.patch(body)
	}
	// Removing none under dm-only still widens that chat (none to dm-only), so it is gated.
	gated(`{"chats":{"`+group+`":null}}`, "default (dm-only)")
	// Raising a chat above the account's scope is gated; lowering it back is not.
	gated(`{"chats":{"`+group+`":"tagged"}}`, "chats."+group+" tagged")
	d.patch(`{"chats":{"` + group + `":null}}`)
}
